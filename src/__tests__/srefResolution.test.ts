/**
 * SREF Resolution Tests
 * =====================
 * Tests for the StyleVault --sref <numeric-code> resolution block
 * in POST /api/jobs/imagine. We test the logic by invoking the route
 * handler with a fully mocked environment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that touch these modules
// ---------------------------------------------------------------------------

vi.mock("@/lib/env", () => ({
  env: {
    COMFY_HTTP_URL: "http://127.0.0.1:8188",
    COMFY_ROOT: "/tmp/comfy",
    COMFY_DEFAULT_CHECKPOINT: "test_model.safetensors",
    STYLEVAULT_API_URL: "http://127.0.0.1:8000",
    CIVITAI_API_URL: "https://civitai.com/api/v1",
    CIVITAI_API_KEY: "",
    NODE_ENV: "test",
  },
}));

vi.mock("@/lib/db", () => ({
  insertPrompt: vi.fn(),
  insertRun: vi.fn(),
  insertJob: vi.fn(),
}));

vi.mock("@/lib/comfy/runs", () => ({
  addActiveRun: vi.fn(),
}));

vi.mock("@/lib/comfy/http", () => ({
  queuePrompt: vi.fn().mockResolvedValue({ prompt_id: "mock-prompt-id" }),
  fetchAvailableCheckpoints: vi
    .fn()
    .mockResolvedValue(["test_model.safetensors"]),
  ComfyAPIError: class ComfyAPIError extends Error {},
}));

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn().mockResolvedValue(
      JSON.stringify({
        "1": {
          class_type: "CheckpointLoaderSimple",
          inputs: { ckpt_name: "test.safetensors" },
        },
        "2": { class_type: "CLIPTextEncode", inputs: { text: "" } },
        "3": { class_type: "KSampler", inputs: {} },
      }),
    ),
  },
}));

vi.mock("@/lib/oj/engine", () => ({
  buildImagineRuns: vi.fn().mockReturnValue([
    {
      run_id: "run-1",
      nodeMap: {},
      nodeCount: 3,
      jobs: [
        {
          index: 0,
          seed: 42,
          prompt_id: undefined,
          status: "pending",
          prompt: "test",
        },
      ],
    },
  ]),
  extractWorkflowsFromRuns: vi
    .fn()
    .mockReturnValue([{ runId: "run-1", jobIndex: 0, workflow: {}, seed: 42 }]),
  resolveSvEngine: (sv: unknown) => {
    if (sv === 3 || sv === 4 || sv === 5) return sv;
    if (sv === 2) return 2;
    const s = typeof sv === "string" ? sv.trim().toLowerCase() : "";
    if (s === "3" || s === "4" || s === "5") return Number(s);
    return s === "2" || s === "ostris" || s === "image" ? 2 : 1;
  },
}));

vi.mock("@/lib/oj/discovery", () => ({
  discoverT2ISlots: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/comfy/workflows", () => ({
  loadWorkflowFromSelection: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(prompt: string): NextRequest {
  return new NextRequest("http://localhost:3000/api/jobs/imagine", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      client_id: "test-client",
      batch_size: 1,
    }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sref numeric code resolution via StyleVault", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("numeric code triggers SV fetch to /styles/by-code/<code>", async () => {
    // SV returns representatives
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          representatives: [
            {
              source_path: "/images/a.jpg",
              sha256: "aaa",
              thumb_url: "",
              score: 0.9,
            },
          ],
          style_name: "anime",
        }),
        { status: 200 },
      ),
    );

    const { POST } = await import("@/app/api/jobs/imagine/route");
    await POST(makeRequest("portrait --sref 1234567890"));

    const svCall = fetchSpy.mock.calls.find(
      ([url]: [unknown]) =>
        typeof url === "string" && url.includes("/styles/by-code/1234567890"),
    );
    expect(svCall).toBeDefined();
    expect(svCall![0]).toContain(
      "http://127.0.0.1:8000/styles/by-code/1234567890",
    );
  });

  it("SV returns representatives → source_paths extracted into srefParams", async () => {
    const reps = [
      { source_path: "/img/a.jpg", sha256: "a", thumb_url: "", score: 1 },
      { source_path: "/img/b.jpg", sha256: "b", thumb_url: "", score: 0.8 },
    ];

    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ representatives: reps, style_name: "test" }),
        { status: 200 },
      ),
    );

    // Capture the parseResult.params passed to buildImagineRuns
    const { buildImagineRuns } = await import("@/lib/oj/engine");
    const buildSpy = vi.mocked(buildImagineRuns);

    const { POST } = await import("@/app/api/jobs/imagine/route");
    await POST(makeRequest("portrait --sref 1234567890"));

    const [parseResult] = buildSpy.mock.calls[buildSpy.mock.calls.length - 1];
    const srefParams = (parseResult.params as any).srefParams;

    expect(srefParams).toBeDefined();
    expect(srefParams.items).toHaveLength(2);
    expect(srefParams.items[0].value).toBe("/img/a.jpg");
    expect(srefParams.items[1].value).toBe("/img/b.jpg");
    expect(srefParams.items[0].type).toBe("url");
  });

  it("multiple numeric codes concatenate their resolved representative items", async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes("/styles/by-code/111111")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              representatives: [
                { source_path: "/img/one-a.jpg", sha256: "one-a" },
                { source_path: "/img/one-b.jpg", sha256: "one-b" },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      if (url.includes("/styles/by-code/222222")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              representatives: [
                { source_path: "/img/two-a.jpg", sha256: "two-a" },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ representatives: [] }), { status: 404 }),
      );
    });

    const { buildImagineRuns } = await import("@/lib/oj/engine");
    const buildSpy = vi.mocked(buildImagineRuns);

    const { POST } = await import("@/app/api/jobs/imagine/route");
    await POST(makeRequest("portrait --sref 111111 222222"));

    const [parseResult] = buildSpy.mock.calls[buildSpy.mock.calls.length - 1];
    const srefParams = (parseResult.params as any).srefParams;

    expect(srefParams.items.map((item: any) => item.value)).toEqual([
      "/img/one-a.jpg",
      "/img/one-b.jpg",
      "/img/two-a.jpg",
    ]);
    expect(srefParams.items.map((item: any) => item.weight)).toEqual([1, 1, 1]);
  });

  it("CODE::WEIGHT multiplies each representative item's weight for that code", async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes("/styles/by-code/111111")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              representatives: [
                { source_path: "/img/weighted-a.jpg", sha256: "wa" },
                { source_path: "/img/weighted-b.jpg", sha256: "wb" },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      if (url.includes("/styles/by-code/222222")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              representatives: [
                { source_path: "/img/plain-a.jpg", sha256: "pa" },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ representatives: [] }), { status: 404 }),
      );
    });

    const { buildImagineRuns } = await import("@/lib/oj/engine");
    const buildSpy = vi.mocked(buildImagineRuns);

    const { POST } = await import("@/app/api/jobs/imagine/route");
    await POST(makeRequest("portrait --sref 111111::2 222222"));

    const [parseResult] = buildSpy.mock.calls[buildSpy.mock.calls.length - 1];
    const srefParams = (parseResult.params as any).srefParams;

    expect(srefParams.items.map((item: any) => item.value)).toEqual([
      "/img/weighted-a.jpg",
      "/img/weighted-b.jpg",
      "/img/plain-a.jpg",
    ]);
    expect(srefParams.items.map((item: any) => item.weight)).toEqual([2, 2, 1]);
  });

  it("SV unreachable: numeric code gets the clear rejection, not a 502", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

    const { POST } = await import("@/app/api/jobs/imagine/route");
    const res = await POST(makeRequest("portrait --sref 1234567890"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe("style_codes_unavailable");
  });

  it("SV returns empty representatives → srefParams NOT set", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ representatives: [], style_name: null }), {
        status: 200,
      }),
    );

    const { buildImagineRuns } = await import("@/lib/oj/engine");
    const buildSpy = vi.mocked(buildImagineRuns);

    const { POST } = await import("@/app/api/jobs/imagine/route");
    await POST(makeRequest("portrait --sref 1234567890"));

    const [parseResult] = buildSpy.mock.calls[buildSpy.mock.calls.length - 1];
    expect((parseResult.params as any).srefParams).toBeUndefined();
  });

  it("non-numeric sref (URL) → SV NOT called", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const { POST } = await import("@/app/api/jobs/imagine/route");
    await POST(makeRequest("portrait --sref https://example.com/style.jpg"));

    const svCall = fetchSpy.mock.calls.find(
      ([url]: [unknown]) =>
        typeof url === "string" && url.includes("/styles/by-code/"),
    );
    expect(svCall).toBeUndefined();
  });

  it("single random keeps existing StyleVault list + representatives behavior", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: 7, style_name: "Random style", codes: ["5555555555"] },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            representatives: [
              { source_path: "/img/random-a.jpg", sha256: "random-a" },
            ],
          }),
          { status: 200 },
        ),
      );

    const { buildImagineRuns } = await import("@/lib/oj/engine");
    const buildSpy = vi.mocked(buildImagineRuns);

    const { POST } = await import("@/app/api/jobs/imagine/route");
    await POST(makeRequest("portrait --sref random"));

    const calls = fetchSpy.mock.calls as Array<[string, ...unknown[]]>;
    expect(calls.some(([url]) => url.includes("/styles?limit=1000"))).toBe(
      true,
    );
    expect(
      calls.some(([url]) => url.includes("/styles/7/representatives?limit=8")),
    ).toBe(true);

    const [parseResult] = buildSpy.mock.calls[buildSpy.mock.calls.length - 1];
    expect(parseResult.params.sref).toBe("5555555555");
    const srefParams = (parseResult.params as any).srefParams;
    expect(srefParams.items[0].value).toBe("/img/random-a.jpg");
  });

  it("junk sref tokens are skipped with a warning while valid tokens still resolve", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          representatives: [
            { source_path: "/img/valid-a.jpg", sha256: "valid-a" },
          ],
        }),
        { status: 200 },
      ),
    );

    try {
      const { buildImagineRuns } = await import("@/lib/oj/engine");
      const buildSpy = vi.mocked(buildImagineRuns);

      const { POST } = await import("@/app/api/jobs/imagine/route");
      const res = await POST(makeRequest("portrait --sref junk 111111"));
      const body = await res.json();

      expect(body.ok).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Skipping unrecognized --sref token: junk"),
      );

      const [parseResult] = buildSpy.mock.calls[buildSpy.mock.calls.length - 1];
      const srefParams = (parseResult.params as any).srefParams;
      expect(srefParams.items).toHaveLength(1);
      expect(srefParams.items[0].value).toBe("/img/valid-a.jpg");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

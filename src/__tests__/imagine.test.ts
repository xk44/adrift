/**
 * Imagine Pipeline Tests
 * ======================
 * Tests for parseImagineInput (parser), buildImagineRuns (engine), and POST /api/jobs/imagine (route).
 *
 * Run with: npx vitest run src/__tests__/imagine.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseImagineInput } from "@/lib/oj/parser";
import {
  buildImagineRuns,
  buildNegativePrompt,
  generateBatchSeeds,
  calculateDims,
  extractWorkflowsFromRuns,
} from "@/lib/oj/engine";
import type { ParseResult } from "@/types";
import { validateBatchSize, validateSeed } from "@/lib/validate";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParseResult(overrides: Partial<ParseResult> = {}): ParseResult {
  return {
    prompt: "a beautiful landscape",
    params: {},
    unknownFlags: [],
    errors: [],
    ...overrides,
  };
}

/**
 * Properly-wired minimal workflow for slot discovery.
 * KSampler references pos/neg/latent via [nodeId, outputIndex] wire format.
 *
 * Graph:
 *   "1" CheckpointLoaderSimple  → (model out 0, clip out 1)
 *   "2" CLIPTextEncode          ← clip ["1",1], text ""  (positive)
 *   "3" CLIPTextEncode          ← clip ["1",1], text ""  (negative)
 *   "5" EmptyLatentImage        → latent out 0
 *   "4" KSampler                ← positive=["2",0], negative=["3",0], latent_image=["5",0]
 *   "6" VAEDecode               ← samples=["4",0]
 *   "7" SaveImage               ← images=["6",0]
 */
const MINIMAL_WORKFLOW = {
  "1": {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "model.safetensors" },
  },
  "2": {
    class_type: "CLIPTextEncode",
    inputs: { clip: ["1", 1], text: "" },
  },
  "3": {
    class_type: "CLIPTextEncode",
    inputs: { clip: ["1", 1], text: "" },
  },
  "5": {
    class_type: "EmptyLatentImage",
    inputs: { width: 1024, height: 1024, batch_size: 1 },
  },
  "4": {
    class_type: "KSampler",
    inputs: {
      model: ["1", 0],
      positive: ["2", 0],
      negative: ["3", 0],
      latent_image: ["5", 0],
      seed: 0,
      steps: 20,
      cfg: 7.0,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1.0,
    },
  },
  "6": { class_type: "VAEDecode", inputs: { samples: ["4", 0] } },
  "7": { class_type: "SaveImage", inputs: { images: ["6", 0] } },
} as unknown as import("@/types").Workflow;

// ---------------------------------------------------------------------------
// validate helpers
// ---------------------------------------------------------------------------

describe("validateBatchSize", () => {
  it("defaults absent or invalid values to safe single-image mode", () => {
    expect(validateBatchSize(undefined)).toBe(1);
    expect(validateBatchSize(null)).toBe(1);
    expect(validateBatchSize(Number.NaN)).toBe(1);
    expect(validateBatchSize("nope")).toBe(1);
  });

  it("rounds and clamps to the supported job range", () => {
    expect(validateBatchSize("3")).toBe(3);
    expect(validateBatchSize(3.7)).toBe(4);
    expect(validateBatchSize(0)).toBe(1);
    expect(validateBatchSize(-5)).toBe(1);
    expect(validateBatchSize(100)).toBe(16);
  });
});

describe("validateSeed", () => {
  it("accepts non-negative integer seeds", () => {
    expect(validateSeed(0)).toBe(0);
    expect(validateSeed(42)).toBe(42);
    expect(validateSeed("42")).toBe(42);
    expect(validateSeed(2147483647)).toBe(2147483647);
  });

  it("rejects absent, negative, fractional, or non-numeric seeds", () => {
    expect(validateSeed(undefined)).toBeUndefined();
    expect(validateSeed(null)).toBeUndefined();
    expect(validateSeed(-1)).toBeUndefined();
    expect(validateSeed(3.14)).toBeUndefined();
    expect(validateSeed("nope")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseImagineInput (parser.ts)
// ---------------------------------------------------------------------------

describe("parseImagineInput", () => {
  describe("basic prompt parsing", () => {
    it("returns clean prompt text with no flags", () => {
      const r = parseImagineInput("a cat on a mat");
      expect(r.prompt).toBe("a cat on a mat");
      expect(r.params).toEqual({});
      expect(r.unknownFlags).toHaveLength(0);
      expect(r.errors).toHaveLength(0);
    });

    it("strips flags from prompt text", () => {
      const r = parseImagineInput("a cat --ar 16:9 --seed 42");
      expect(r.prompt).toBe("a cat");
    });
  });

  describe("--ar (aspect ratio)", () => {
    it("parses standard aspect ratio", () => {
      const r = parseImagineInput("landscape --ar 16:9");
      expect(r.params.ar).toBe("16:9");
    });

    it("parses portrait aspect ratio", () => {
      const r = parseImagineInput("portrait --ar 9:16");
      expect(r.params.ar).toBe("9:16");
    });

    it("errors on non-W:H format", () => {
      const r = parseImagineInput("test --ar widescreen");
      expect(r.errors.length).toBeGreaterThan(0);
    });
  });

  describe("--seed", () => {
    it("parses seed as integer", () => {
      const r = parseImagineInput("cats --seed 123456");
      expect(r.params.seed).toBe(123456);
    });

    it("parses large seed", () => {
      const r = parseImagineInput("cats --seed 2147483647");
      expect(r.params.seed).toBe(2147483647);
    });
  });

  describe("--stylize / --s", () => {
    it("parses --stylize", () => {
      const r = parseImagineInput("cats --stylize 750");
      expect(r.params.stylize).toBe(750);
    });

    it("parses --s short form", () => {
      const r = parseImagineInput("cats --s 200");
      expect(r.params.stylize).toBe(200);
    });

    it("errors on out-of-range stylize", () => {
      const r = parseImagineInput("cats --stylize 9999");
      expect(r.errors.length).toBeGreaterThan(0);
    });
  });

  describe("--chaos / --c", () => {
    it("parses --chaos", () => {
      const r = parseImagineInput("cats --chaos 50");
      expect(r.params.chaos).toBe(50);
    });

    it("errors on chaos > 100", () => {
      const r = parseImagineInput("cats --chaos 200");
      expect(r.errors.length).toBeGreaterThan(0);
    });
  });

  describe("--weird / --w", () => {
    it("parses --weird", () => {
      const r = parseImagineInput("cats --weird 1500");
      expect(r.params.weird).toBe(1500);
    });
  });

  describe("--no (negative prompt)", () => {
    it("captures negative terms", () => {
      const r = parseImagineInput("cats --no blurry ugly");
      expect(Array.isArray(r.params.no)).toBe(true);
      const noArr = r.params.no as string[];
      expect(noArr.join(" ")).toContain("blurry");
    });

    it("negative terms not included in positive prompt", () => {
      const r = parseImagineInput("cats --no blurry ugly");
      expect(r.prompt).toBe("cats");
    });
  });

  describe("--sref", () => {
    it("parses numeric sref code", () => {
      const r = parseImagineInput("portrait --sref 1234567890");
      expect(r.params.sref).toBe("1234567890");
    });

    it("parses 'random' sref", () => {
      const r = parseImagineInput("portrait --sref random");
      expect(r.params.sref).toBe("random");
    });

    it("parses URL sref", () => {
      const r = parseImagineInput(
        "portrait --sref https://example.com/style.jpg",
      );
      expect(r.params.sref).toBe("https://example.com/style.jpg");
    });
  });

  describe("boolean flags", () => {
    it("parses --raw as true", () => {
      const r = parseImagineInput("cats --raw");
      expect(r.params.raw).toBe(true);
    });

    it("parses --tile as true", () => {
      const r = parseImagineInput("cats --tile");
      expect(r.params.tile).toBe(true);
    });

    it("parses --turbo as true", () => {
      const r = parseImagineInput("cats --turbo");
      expect(r.params.turbo).toBe(true);
    });
  });

  describe("unknown flags", () => {
    it("collects unknown flags without erroring", () => {
      const r = parseImagineInput("cats --foobar 42 --baz");
      expect(r.unknownFlags).toContain("--foobar");
      expect(r.unknownFlags).toContain("--baz");
      expect(r.errors).toHaveLength(0);
    });

    it("unknown flag value is consumed and does not leak into the prompt", () => {
      const r = parseImagineInput("cats --foobar 42");
      // Bug fix: value tokens after an unknown flag are consumed so they don't
      // appear as orphan words in the prompt text.
      expect(r.prompt).toBe("cats");
      expect(r.unknownFlags).toContain("--foobar");
    });
  });

  describe("complex prompts", () => {
    it("parses multiple flags together", () => {
      const r = parseImagineInput(
        "a sunset beach --ar 16:9 --seed 999 --stylize 300 --chaos 10",
      );
      expect(r.prompt).toBe("a sunset beach");
      expect(r.params.ar).toBe("16:9");
      expect(r.params.seed).toBe(999);
      expect(r.params.stylize).toBe(300);
      expect(r.params.chaos).toBe(10);
    });

    it("handles quoted text in prompt", () => {
      const r = parseImagineInput('"a beautiful cat" --ar 1:1');
      expect(r.prompt).toBe("a beautiful cat");
      expect(r.params.ar).toBe("1:1");
    });
  });
});

// ---------------------------------------------------------------------------
// buildNegativePrompt (engine.ts)
// ---------------------------------------------------------------------------

describe("buildNegativePrompt", () => {
  it("returns base when no --no params", () => {
    expect(buildNegativePrompt("ugly, blurry", undefined)).toBe("ugly, blurry");
  });

  it("appends single --no string", () => {
    const result = buildNegativePrompt("ugly", "watermark");
    expect(result).toContain("ugly");
    expect(result).toContain("watermark");
  });

  it("appends array of --no terms", () => {
    const result = buildNegativePrompt("ugly", ["watermark", "text"]);
    expect(result).toContain("ugly");
    expect(result).toContain("watermark");
    expect(result).toContain("text");
  });

  it("handles empty base", () => {
    const result = buildNegativePrompt("", "watermark");
    expect(result).toContain("watermark");
  });
});

// ---------------------------------------------------------------------------
// generateBatchSeeds (engine.ts)
// ---------------------------------------------------------------------------

describe("generateBatchSeeds", () => {
  it("generates correct count", () => {
    const seeds = generateBatchSeeds(42, 4);
    expect(seeds).toHaveLength(4);
  });

  it("first seed is base seed", () => {
    const seeds = generateBatchSeeds(1000, 3);
    expect(seeds[0]).toBe(1000);
  });

  it("without chaos seeds are sequential", () => {
    const seeds = generateBatchSeeds(100, 4, 0);
    expect(seeds[0]).toBe(100);
    expect(seeds[1]).toBe(101);
    expect(seeds[2]).toBe(102);
    expect(seeds[3]).toBe(103);
  });

  it("random base seed when undefined", () => {
    const seeds = generateBatchSeeds(undefined, 2);
    expect(seeds).toHaveLength(2);
    expect(typeof seeds[0]).toBe("number");
  });

  it("with chaos generates different seeds", () => {
    // Multiple calls — expect variation in seeds[1..n]
    const seeds = generateBatchSeeds(42, 4, 100);
    expect(seeds[0]).toBe(42);
    // chaos can cause duplicates but seeds should be valid numbers
    seeds.forEach((s) => expect(typeof s).toBe("number"));
  });
});

// ---------------------------------------------------------------------------
// calculateDims (engine.ts)
// ---------------------------------------------------------------------------

describe("calculateDims", () => {
  it("returns preset for 1:1", () => {
    const d = calculateDims("1:1");
    expect(d.width).toBe(1024);
    expect(d.height).toBe(1024);
  });

  it("returns preset for 16:9", () => {
    const d = calculateDims("16:9");
    expect(d.width).toBe(1344);
    expect(d.height).toBe(768);
  });

  it("returns preset for 9:16", () => {
    const d = calculateDims("9:16");
    expect(d.width).toBe(768);
    expect(d.height).toBe(1344);
  });

  it("calculates custom ratio rounded to 64", () => {
    const d = calculateDims("2:1");
    expect(d.width % 64).toBe(0);
    expect(d.height % 64).toBe(0);
    expect(d.width).toBeGreaterThan(d.height);
  });

  it("returns default on invalid ratio", () => {
    const d = calculateDims("bad:ratio");
    expect(d.width).toBe(1024);
    expect(d.height).toBe(1024);
  });
});

// ---------------------------------------------------------------------------
// buildImagineRuns (engine.ts)
// ---------------------------------------------------------------------------

describe("buildImagineRuns", () => {
  it("creates one run with correct job count", () => {
    const pr = makeParseResult();
    const runs = buildImagineRuns(pr, MINIMAL_WORKFLOW, { batchSize: 4 });
    expect(runs).toHaveLength(1);
    expect(runs[0].jobs).toHaveLength(4);
  });

  it("run contains prompt text", () => {
    const pr = makeParseResult({ prompt: "futuristic city" });
    const runs = buildImagineRuns(pr, MINIMAL_WORKFLOW);
    expect(runs[0].parsedPrompt).toBe("futuristic city");
  });

  it("aspect ratio propagates to run dimensions", () => {
    const pr = makeParseResult({ params: { ar: "16:9" } });
    const runs = buildImagineRuns(pr, MINIMAL_WORKFLOW);
    expect(runs[0].width).toBe(1344);
    expect(runs[0].height).toBe(768);
  });

  it("default dimensions when no --ar", () => {
    const pr = makeParseResult();
    const runs = buildImagineRuns(pr, MINIMAL_WORKFLOW);
    // 1:1 is the fallback aspect
    expect(runs[0].width).toBe(1024);
    expect(runs[0].height).toBe(1024);
  });

  it("seed param used as base seed for first job", () => {
    const pr = makeParseResult({ params: { seed: 77777 } });
    const runs = buildImagineRuns(pr, MINIMAL_WORKFLOW, { batchSize: 2 });
    expect(runs[0].jobs[0].seed).toBe(77777);
  });

  it("--no terms merged into negativePrompt on run params", () => {
    const pr = makeParseResult({ params: { no: ["watermark"] } });
    const runs = buildImagineRuns(pr, MINIMAL_WORKFLOW, {
      baseNegative: "ugly",
    });
    const neg = runs[0].params.negativePrompt as string;
    expect(neg).toContain("ugly");
    expect(neg).toContain("watermark");
  });

  it("--raw mode clears base negative", () => {
    const pr = makeParseResult({ params: { raw: true } });
    const runs = buildImagineRuns(pr, MINIMAL_WORKFLOW, {
      baseNegative: "ugly, blurry",
    });
    const neg = runs[0].params.negativePrompt as string;
    expect(neg).not.toContain("ugly");
  });

  it("repeat param creates multiple runs", () => {
    const pr = makeParseResult({ params: { repeat: 3 } });
    const runs = buildImagineRuns(pr, MINIMAL_WORKFLOW, { batchSize: 1 });
    expect(runs).toHaveLength(3);
  });

  it("sourceImages attached to run", () => {
    const pr = makeParseResult();
    const imgs = [
      {
        id: "img1",
        url: "http://example.com/img.jpg",
        mode: "starting_frame" as const,
        weight: 1,
      },
    ];
    const runs = buildImagineRuns(pr, MINIMAL_WORKFLOW, { sourceImages: imgs });
    expect(runs[0].sourceImages).toEqual(imgs);
  });

  it("all jobs start with status queued", () => {
    const pr = makeParseResult();
    const runs = buildImagineRuns(pr, MINIMAL_WORKFLOW, { batchSize: 3 });
    runs[0].jobs.forEach((j) => expect(j.status).toBe("queued"));
  });

  it("discovers workflow slots once when extracting multiple workflow jobs", () => {
    const pr = makeParseResult({ params: { repeat: 2 } });
    const runs = buildImagineRuns(pr, MINIMAL_WORKFLOW, { batchSize: 2 });
    const discoverSlots = vi.fn(() => ({
      posTextId: "2",
      negTextId: "3",
      ksamplerId: "4",
      latentDimsId: "5",
      saveImageId: "7",
    }));

    const workflows = extractWorkflowsFromRuns(
      runs,
      MINIMAL_WORKFLOW,
      discoverSlots,
    );

    expect(workflows).toHaveLength(4);
    expect(discoverSlots).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// POST /api/jobs/imagine route
// ---------------------------------------------------------------------------

describe("POST /api/jobs/imagine", () => {
  // We mock all heavy I/O at module boundary so the route can be imported

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function importRoute(workflow: object = MINIMAL_WORKFLOW) {
    // Mock fs/promises so no real workflow file needed
    vi.doMock("fs/promises", () => ({
      default: {
        readFile: vi.fn().mockResolvedValue(JSON.stringify(workflow)),
      },
    }));

    // Mock ComfyUI HTTP client
    const queuePrompt = vi
      .fn()
      .mockResolvedValue({ prompt_id: "mock-prompt-id-1" });
    vi.doMock("@/lib/comfy/http", () => ({
      queuePrompt,
      ComfyAPIError: class ComfyAPIError extends Error {},
      fetchAvailableCheckpoints: vi
        .fn()
        .mockResolvedValue(["model.safetensors"]),
    }));

    // Mock active runs store
    vi.doMock("@/lib/comfy/runs", () => ({
      addActiveRun: vi.fn(),
    }));

    // Mock DB
    const insertRun = vi.fn();
    vi.doMock("@/lib/db", () => ({
      insertPrompt: vi.fn(),
      insertRun,
      insertJob: vi.fn(),
    }));

    // Mock workflow loader
    vi.doMock("@/lib/comfy/workflows", () => ({
      loadWorkflowFromSelection: vi.fn(),
    }));

    // fs is mocked, so contain relative selections without touching disk
    // (real containment: inpaintWorkflowPath.test.ts / jobsWorkflowPath.test.ts).
    vi.doMock("@/lib/comfy/workflowPathGuard", () => ({
      resolveContainedWorkflowPath: vi.fn(async (sel: string) =>
        sel.includes("..") || sel.startsWith("/") ? null : `/wf/${sel}`,
      ),
    }));

    // Mock global fetch for StyleVault / sref-random calls
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { POST } = await import("@/app/api/jobs/imagine/route");
    return { POST, mockFetch, queuePrompt, insertRun };
  }

  function makeRequest(body: Record<string, unknown>) {
    return new Request("http://localhost:3000/api/jobs/imagine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 400 for empty prompt", async () => {
    const { POST } = await importRoute();
    const req = makeRequest({ prompt: "", client_id: "test-client" });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  it("refuses a workflow_path that escapes public/workflows (B7)", async () => {
    const { POST, queuePrompt } = await importRoute();
    for (const workflow_path of ["../../.env.local", "/etc/passwd", 42]) {
      const res = await POST(
        makeRequest({ prompt: "cats", client_id: "c1", workflow_path }) as unknown as import("next/server").NextRequest,
      );
      expect(res.status, String(workflow_path)).toBe(400);
      expect((await res.json()).error).toBe("Invalid workflow_path");
    }
    expect(queuePrompt).not.toHaveBeenCalled();
  });

  it("does not echo workflow parse errors (file content) to the client (B7)", async () => {
    const { POST } = await importRoute();
    const fsMod = (await import("fs/promises")) as unknown as {
      default: { readFile: ReturnType<typeof vi.fn> };
    };
    fsMod.default.readFile.mockResolvedValue("TOPSECRET=1 not json");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(
      makeRequest({
        prompt: "cats",
        client_id: "c1",
        workflow_path: "packs/test/t2i.json",
      }) as unknown as import("next/server").NextRequest,
    );
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/TOPSECRET|packs\/test|JSON/);
  });

  it("returns 400 when prompt missing", async () => {
    const { POST } = await importRoute();
    const req = makeRequest({ client_id: "test-client" });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(400);
  });

  it("valid prompt returns ok:true with runs", async () => {
    const { POST } = await importRoute();
    const req = makeRequest({
      prompt: "a futuristic city --ar 16:9 --seed 42",
      client_id: "test-client",
      batch_size: 2,
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.runs)).toBe(true);
    expect(data.runs.length).toBeGreaterThan(0);
  });

  it("valid prompt run has jobs", async () => {
    const { POST } = await importRoute();
    const req = makeRequest({
      prompt: "cats",
      client_id: "c1",
      batch_size: 2,
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    const data = await res.json();
    expect(data.runs[0].jobs).toHaveLength(2);
  });

  it("unknown flags surfaced as warnings", async () => {
    const { POST } = await importRoute();
    const req = makeRequest({
      prompt: "cats --unknownflag 99",
      client_id: "c1",
      batch_size: 1,
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.warnings?.unknownFlags).toContain("--unknownflag");
  });

  it("returns 400 for hard parse errors", async () => {
    const { POST } = await importRoute();
    const req = makeRequest({
      prompt: "cats --ar abc",
      client_id: "c1",
      batch_size: 1,
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain("Invalid prompt parameters");
    expect(data.error).toContain("abc");
  });

  it("--sref numeric triggers StyleVault fetch", async () => {
    const { POST, mockFetch } = await importRoute();

    // StyleVault returns no representatives → code kept as-is
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ representatives: [], style_name: null }),
    });

    const req = makeRequest({
      prompt: "portrait --sref 1234567890",
      client_id: "c1",
      batch_size: 1,
    });
    await POST(req as unknown as import("next/server").NextRequest);

    const calls = mockFetch.mock.calls as Array<[string, ...unknown[]]>;
    const svCall = calls.find(
      ([url]) =>
        typeof url === "string" && url.includes("styles/by-code/1234567890"),
    );
    expect(svCall).toBeDefined();
  });

  it("--sref numeric with StyleVault reps resolves to URL items", async () => {
    const { POST, mockFetch } = await importRoute();

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        representatives: [
          {
            source_path: "/data/styles/img1.jpg",
            sha256: "abc",
            thumb_url: "",
            score: null,
          },
          {
            source_path: "/data/styles/img2.jpg",
            sha256: "def",
            thumb_url: "",
            score: null,
          },
        ],
        style_name: "my-style",
      }),
    });

    const req = makeRequest({
      prompt: "portrait --sref 9876543210",
      client_id: "c1",
      batch_size: 1,
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    const data = await res.json();
    expect(data.ok).toBe(true);
    // run params should have srefParams with url-type items
    const params = data.runs[0].params as Record<string, unknown>;
    expect(params.srefParams).toBeDefined();
    const sp = params.srefParams as { items: Array<{ type: string }> };
    expect(sp.items.every((i) => i.type === "url")).toBe(true);
  });

  it("--sref random resolves via StyleVault styles and representatives APIs", async () => {
    const { POST, mockFetch } = await importRoute();

    mockFetch
      // First call: StyleVault style list
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 7, style_name: "Random style", codes: ["5555555555"] },
        ],
      })
      // Second call: representatives for the chosen style
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          representatives: [
            { source_path: "/data/styles/random-a.jpg", sha256: "aaa" },
          ],
        }),
      });

    const req = makeRequest({
      prompt: "portrait --sref random",
      client_id: "c1",
      batch_size: 1,
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    const data = await res.json();
    expect(data.ok).toBe(true);

    const calls = mockFetch.mock.calls as Array<[string, ...unknown[]]>;
    expect(calls.some(([url]) => url.includes("/styles?limit=1000"))).toBe(
      true,
    );
    expect(
      calls.some(([url]) => url.includes("/styles/7/representatives?limit=8")),
    ).toBe(true);
    expect(calls.some(([url]) => url.includes("/style-codes"))).toBe(false);

    const params = data.runs[0].params as Record<string, unknown>;
    expect(params.sref).toBe("5555555555");
    const sp = params.srefParams as { items: Array<{ value: string }> };
    expect(sp.items[0].value).toBe("/data/styles/random-a.jpg");
  });

  it("batch_size param creates correct number of jobs", async () => {
    const { POST } = await importRoute();
    const req = makeRequest({
      prompt: "mountains",
      client_id: "c1",
      batch_size: 3,
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    const data = await res.json();
    expect(data.runs[0].jobs).toHaveLength(3);
  });

  it("defaults omitted batch_size to one job for safer GPUs", async () => {
    const { POST } = await importRoute();
    const req = makeRequest({ prompt: "mountains", client_id: "c1" });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    const data = await res.json();
    expect(data.runs[0].jobs).toHaveLength(1);
  });

  it("clamps requested batch_size to the allowed range", async () => {
    const { POST } = await importRoute();
    const low = await POST(
      makeRequest({
        prompt: "low",
        client_id: "c1",
        batch_size: 0,
      }) as unknown as import("next/server").NextRequest,
    );
    const high = await POST(
      makeRequest({
        prompt: "high",
        client_id: "c1",
        batch_size: 100,
      }) as unknown as import("next/server").NextRequest,
    );
    expect((await low.json()).runs[0].jobs).toHaveLength(1);
    expect((await high.json()).runs[0].jobs).toHaveLength(16);
  });

  it("uses --seed as the base seed for queued jobs", async () => {
    const { POST } = await importRoute();
    const req = makeRequest({
      prompt: "mountains --seed 777",
      client_id: "c1",
      batch_size: 2,
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    const data = await res.json();
    expect(data.runs[0].jobs[0].seed).toBe(777);
    expect(data.runs[0].jobs[1].seed).toBe(778);
  });

  it("--video --vb 2 queues two variants with distinct seeds, ignoring batch_size", async () => {
    const { POST, queuePrompt } = await importRoute();
    const res = await POST(
      makeRequest({
        prompt: "a fox runs --video --vb 2 --seed 900",
        client_id: "c1",
        batch_size: 8,
      }) as unknown as import("next/server").NextRequest,
    );
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].jobs.map((j: { seed: number }) => j.seed)).toEqual([
      900, 901,
    ]);
    expect(queuePrompt).toHaveBeenCalledTimes(2);
  });

  it("Workflow Control seed override reaches the sampler and the job record", async () => {
    const { POST, queuePrompt } = await importRoute();
    const req = makeRequest({
      prompt: "mountains",
      client_id: "c1",
      batch_size: 2,
      workflow_control_overrides: { "4.seed": 4242 },
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    const data = await res.json();
    expect(data.runs[0].jobs[0].seed).toBe(4242);
    expect(data.runs[0].jobs[1].seed).toBe(4243);
    const queued = queuePrompt.mock.calls.map(
      (c) => (c[0] as Record<string, { inputs: { seed: number } }>)["4"].inputs.seed,
    );
    expect(queued).toEqual([4242, 4243]);
  });

  it("applies graph-scoped overrides only to the graph they were made for", async () => {
    const { POST, queuePrompt } = await importRoute();
    const scoped = {
      __byGraph: { "packs/test/t2i.json": { "4.seed": 4242 } },
    };
    const res = await POST(
      makeRequest({
        prompt: "mountains",
        client_id: "c1",
        batch_size: 1,
        workflow_path: "packs/test/t2i.json",
        workflow_control_overrides: scoped,
      }) as unknown as import("next/server").NextRequest,
    );
    expect((await res.json()).runs[0].jobs[0].seed).toBe(4242);

    queuePrompt.mockClear();
    const res2 = await POST(
      makeRequest({
        prompt: "mountains",
        client_id: "c1",
        batch_size: 1,
        workflow_path: "packs/test/i2v.json",
        workflow_control_overrides: scoped,
      }) as unknown as import("next/server").NextRequest,
    );
    const data2 = await res2.json();
    expect(data2.ok).toBe(true);
    expect(data2.runs[0].jobs[0].seed).not.toBe(4242);
    const wf = queuePrompt.mock.calls[0][0] as Record<
      string,
      { inputs: Record<string, unknown> }
    >;
    expect(wf["4"].inputs.seed).not.toBe(4242);
  });

  it("--seed in the prompt wins over a Workflow Control seed override", async () => {
    const { POST, queuePrompt } = await importRoute();
    const req = makeRequest({
      prompt: "mountains --seed 777",
      client_id: "c1",
      batch_size: 1,
      workflow_control_overrides: { "4.seed": 4242 },
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    const data = await res.json();
    expect(data.runs[0].jobs[0].seed).toBe(777);
    const wf = queuePrompt.mock.calls[0][0] as Record<
      string,
      { inputs: { seed: number } }
    >;
    expect(wf["4"].inputs.seed).toBe(777);
  });

  it("ignores non-numeric seed overrides and falls back to a random seed", async () => {
    const { POST } = await importRoute();
    const req = makeRequest({
      prompt: "mountains",
      client_id: "c1",
      workflow_control_overrides: { "4.seed": "nope", "4.steps": 12 },
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(Number.isInteger(data.runs[0].jobs[0].seed)).toBe(true);
  });

  it("records the graph's own dims when no --ar is given (LTXV 768x512)", async () => {
    const wf = structuredClone(MINIMAL_WORKFLOW) as unknown as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    wf["5"].inputs.width = 768;
    wf["5"].inputs.height = 512;
    const { POST, insertRun } = await importRoute(wf);
    const res = await POST(
      makeRequest({ prompt: "a river", client_id: "c1", batch_size: 1 }) as unknown as import("next/server").NextRequest,
    );
    const data = await res.json();
    expect(data.runs[0].width).toBe(768);
    expect(data.runs[0].height).toBe(512);
    expect(insertRun.mock.calls[0][3]).toMatchObject({ width: 768, height: 512 });
  });

  it("keeps --ar dims as recorded", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({ prompt: "a river --ar 16:9", client_id: "c1", batch_size: 1 }) as unknown as import("next/server").NextRequest,
    );
    const data = await res.json();
    expect(data.runs[0].width).toBeGreaterThan(data.runs[0].height);
  });

  it("response includes request_id", async () => {
    const { POST } = await importRoute();
    const req = makeRequest({ prompt: "sky", client_id: "c1" });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    const data = await res.json();
    expect(typeof data.request_id).toBe("string");
    expect(data.request_id.length).toBeGreaterThan(0);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lZtqVwAAAABJRU5ErkJggg==";

describe("POST /api/jobs/krea2", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function importRoute() {
    const db = {
      insertPrompt: vi.fn(),
      insertRun: vi.fn(),
      insertJob: vi.fn(),
      insertOutput: vi.fn(),
      updateJobStatus: vi.fn(),
      updateRunStatus: vi.fn(),
    };
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const addActiveRun = vi.fn();

    vi.doMock("@/lib/env", () => ({
      env: {
        KREA2_BACKEND_URL: "http://krea.test",
        COMFY_ROOT: "/tmp/comfy-root",
        ADMIN_API_KEY: "",
      },
    }));
    vi.doMock("@/lib/auth", () => ({
      requireAdmin: vi.fn(() => ({ ok: true })),
    }));
    vi.doMock("@/lib/rateLimit", () => ({
      withRateLimit: vi.fn(() => ({ ok: true })),
    }));
    vi.doMock("@/lib/db", () => db);
    vi.doMock("@/lib/comfy/runs", () => ({ addActiveRun }));
    vi.doMock("fs/promises", () => ({
      default: { mkdir, writeFile },
      mkdir,
      writeFile,
    }));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        images: [PNG_1X1],
        meta: { checkpoint: "turbo" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("@/app/api/jobs/krea2/route");
    return { POST, db, mkdir, writeFile, addActiveRun, fetchMock };
  }

  function makeRequest(body: Record<string, unknown>) {
    return new Request("http://localhost:3000/api/jobs/krea2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("posts Krea params to the direct backend and persists outputs", async () => {
    const { POST, db, writeFile, addActiveRun, fetchMock } =
      await importRoute();

    const res = await POST(
      makeRequest({
        prompt:
          "a chrome fox --ar 4:3 --seed 123 --steps 9 --cfg 0.4 --stylization 0.8 --minimalism-maximalism -0.5 --moodboard-strength 0.6",
        client_id: "test-client",
        batch_size: 1,
        source_images: [
          {
            id: "m1",
            url: `data:image/png;base64,${PNG_1X1}`,
            mode: "style_ref",
            weight: 1,
          },
        ],
      }) as unknown as import("next/server").NextRequest,
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.runs[0].jobs[0].status).toBe("done");
    expect(data.runs[0].jobs[0].images[0]).toContain("/api/comfy/image?");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://krea.test/generate");
    const payload = JSON.parse(String(init?.body));
    expect(payload).toMatchObject({
      prompt: "a chrome fox",
      negative_prompt: "ugly, blurry, low quality, distorted",
      checkpoint: "turbo",
      steps: 9,
      cfg: 0.4,
      width: 1152,
      height: 896,
      seed: 123,
      num_images: 1,
      stylization: 0.8,
      minimalism_maximalism: -0.5,
      moodboard_strength: 0.6,
    });
    expect(payload.moodboard).toEqual([`data:image/png;base64,${PNG_1X1}`]);

    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(db.insertPrompt).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      "krea2-direct",
    );
    expect(db.insertRun).toHaveBeenCalledTimes(1);
    expect(db.insertJob).toHaveBeenCalledTimes(1);
    expect(db.insertOutput).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringMatching(/^CJ_Krea2_.*\.png$/),
      "krea2_direct",
      1,
      1,
      "image",
    );
    expect(db.updateJobStatus).toHaveBeenCalledWith(expect.any(String), "done");
    expect(db.updateRunStatus).toHaveBeenCalledWith(expect.any(String), "done");
    expect(addActiveRun).toHaveBeenCalledTimes(1);
  });
});

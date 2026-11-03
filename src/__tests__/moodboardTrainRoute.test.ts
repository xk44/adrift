import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs/promises";
import os from "os";
import path from "path";

const fetchMock = vi.fn();
const MANIFEST_FILES = new Set(["metadata.jsonl", "dataset.json"]);

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/moodboards/board-id/train", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function loadRoute(cwd: string, kreaRoot: string) {
  vi.resetModules();
  vi.stubEnv("KREA_MOODBOARDS_DIR", kreaRoot);
  vi.stubEnv("STYLEVAULT_API_URL", "http://stylevault.test");
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.stubGlobal("fetch", fetchMock);
  return import("@/app/api/moodboards/[id]/train/route");
}

async function writeMoodboards(cwd: string, moodboards: unknown[]) {
  await fs.mkdir(path.join(cwd, "data"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, "data/moodboards.json"),
    JSON.stringify({ version: 1, moodboards }, null, 2),
    "utf-8",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("POST /api/moodboards/[id]/train", () => {
  it("returns 404 on unknown id", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-train-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    await fs.mkdir(cwd);
    await fs.mkdir(kreaRoot);
    await writeMoodboards(cwd, []);
    const { POST } = await loadRoute(cwd, kreaRoot);

    const res = await POST(request({ trigger_word: "ohwx" }), params("missing"));

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 on an empty board", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-train-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    await fs.mkdir(cwd);
    await fs.mkdir(kreaRoot);
    await writeMoodboards(cwd, [{ id: "empty", name: "Empty", images: [] }]);
    const { POST } = await loadRoute(cwd, kreaRoot);

    const res = await POST(request({ trigger_word: "ohwx" }), params("empty"));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("materializes Krea images and posts the training job to StyleVault", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-train-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    const boardDir = path.join(kreaRoot, "01_Test_images");
    const previousRunDir = path.join(cwd, "data/moodboard-training/board-id/previous-run");
    await fs.mkdir(cwd);
    await fs.mkdir(boardDir, { recursive: true });
    await fs.mkdir(previousRunDir, { recursive: true });
    await fs.writeFile(path.join(boardDir, "image.png"), Buffer.from([1, 2, 3]));
    await fs.writeFile(path.join(boardDir, "second.jpg"), Buffer.from([4, 5, 6]));
    for (const extra of ["c.png", "d.png", "e.png"])
      await fs.writeFile(path.join(boardDir, extra), Buffer.from([7]));
    await fs.writeFile(path.join(previousRunDir, "keep.txt"), "keep", "utf-8");
    await writeMoodboards(cwd, [
      {
        id: "board-id",
        name: "Test Board",
        images: [
          {
            url: "/api/moodboards/krea?board=01_Test_images&file=image.png",
            weight: 1,
          },
          {
            url: "/api/moodboards/krea?board=../bad&file=missing.png",
            weight: 1,
          },
          {
            url: "/api/moodboards/krea?board=01_Test_images&file=second.jpg",
            weight: 1,
          },
          { url: "/api/moodboards/krea?board=01_Test_images&file=gone.png", weight: 1 },
          ...["c.png", "d.png", "e.png"].map((f) => ({
            url: `/api/moodboards/krea?board=01_Test_images&file=${f}`,
            weight: 1,
          })),
        ],
      },
    ]);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ job_id: 123, status: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { POST } = await loadRoute(cwd, kreaRoot);

    const res = await POST(
      request({ trigger_word: "ohwx", steps: 1000, lr: 0.0001 }),
      params("board-id"),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      job_id: 123,
      status: "queued",
      materialized: 5,
      skipped: 2,
      warning: "2 of 7 images were skipped (missing or unreadable); training on 5.",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://stylevault.test/training/jobs");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      backend: "musubi-tuner",
      model_family: "krea2",
      run_name: "moodboard-test-board",
      params: { auto_caption: true, trigger_word: "ohwx", steps: 1000, lr: 0.0001 },
    });
    expect(path.dirname(body.dataset.images_dir)).toBe(
      path.join(cwd, "data/moodboard-training/board-id"),
    );
    expect(path.basename(body.dataset.images_dir)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    await expect(fs.access(path.join(previousRunDir, "keep.txt"))).resolves.toBeUndefined();
    const all = await fs.readdir(body.dataset.images_dir);
    expect(all).toEqual(expect.arrayContaining(["metadata.jsonl", "dataset.json"]));
    const files = all.filter((f) => !MANIFEST_FILES.has(f));
    expect(files).toHaveLength(5);
    expect(files.map((file) => file.slice(0, 4)).sort()).toEqual([
      "0001",
      "0003",
      "0005",
      "0006",
      "0007",
    ]);
    expect(files.some((file) => file.endsWith(".png"))).toBe(true);
    expect(files.some((file) => file.endsWith(".jpg"))).toBe(true);
  });

  it.each([
    ["moss_image", "ai-toolkit"],
    ["krea2", "musubi-tuner"],
    [undefined, "musubi-tuner"],
  ])("routes model_family %s to backend %s", async (family, backend) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-train-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    const boardDir = path.join(kreaRoot, "01_Test_images");
    await fs.mkdir(cwd);
    await fs.mkdir(boardDir, { recursive: true });
    await fs.writeFile(path.join(boardDir, "image.png"), Buffer.from([1, 2, 3]));
    await writeMoodboards(cwd, [
      {
        id: "board-id",
        name: "Test Board",
        images: [{ url: "/api/moodboards/krea?board=01_Test_images&file=image.png", weight: 1 }],
      },
    ]);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ job_id: 7, status: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { POST } = await loadRoute(cwd, kreaRoot);
    const res = await POST(
      request({ trigger_word: "ohwx", ...(family ? { model_family: family } : {}) }),
      params("board-id"),
    );
    expect(res.status).toBe(200);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ backend, model_family: family ?? "krea2" });
    expect(body.params.model_family).toBeUndefined();
  });

  it("rejects an unknown model_family", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-train-"));
    const cwd = path.join(tmp, "app");
    await fs.mkdir(cwd);
    await writeMoodboards(cwd, []);
    const { POST } = await loadRoute(cwd, path.join(tmp, "krea"));
    const res = await POST(
      request({ trigger_word: "ohwx", model_family: "sdxl" }),
      params("board-id"),
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["unreachable", () => fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")), "StyleVault is unreachable (is the training server running?)"],
    [
      "rejecting",
      () =>
        fetchMock.mockResolvedValueOnce(
          new Response(JSON.stringify({ detail: "no GPU" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      "no GPU",
    ],
  ])("discards the materialized copy and 502s when StyleVault is %s", async (_label, arrange, error) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-train-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    const boardDir = path.join(kreaRoot, "01_Test_images");
    await fs.mkdir(cwd);
    await fs.mkdir(boardDir, { recursive: true });
    await fs.writeFile(path.join(boardDir, "image.png"), Buffer.from([1, 2, 3]));
    await writeMoodboards(cwd, [
      {
        id: "board-id",
        name: "Test Board",
        images: [{ url: "/api/moodboards/krea?board=01_Test_images&file=image.png", weight: 1 }],
      },
    ]);
    arrange();
    const { POST } = await loadRoute(cwd, kreaRoot);

    const res = await POST(request({ trigger_word: "ohwx" }), params("board-id"));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const imagesDir = JSON.parse(init.body as string).dataset.images_dir;
    await expect(fs.access(imagesDir)).rejects.toThrow();
    await expect(fs.access(path.join(cwd, "data/moodboard-training/board-id"))).rejects.toThrow();
  });

  it("copies absolute paths only when they resolve inside trusted moodboard roots", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-train-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    const uploadDir = path.join(cwd, "data/moodboard-uploads");
    const uploaded = path.join(uploadDir, "uploaded.png");
    await fs.mkdir(cwd);
    await fs.mkdir(kreaRoot);
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.writeFile(uploaded, Buffer.from([1, 2, 3]));
    await writeMoodboards(cwd, [
      {
        id: "board-id",
        name: "Uploads",
        images: [{ url: uploaded, weight: 1 }],
      },
    ]);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ job_id: 123, status: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { POST } = await loadRoute(cwd, kreaRoot);

    const res = await POST(request({ trigger_word: "ohwx" }), params("board-id"));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const files = (await fs.readdir(body.dataset.images_dir)).filter(
      (f) => !MANIFEST_FILES.has(f),
    );
    expect(files).toHaveLength(1);
    expect(files[0].startsWith("0001-")).toBe(true);
  });

  it("rejects arbitrary absolute image paths", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-train-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    const outside = path.join(tmp, "outside.png");
    await fs.mkdir(cwd);
    await fs.mkdir(kreaRoot);
    await fs.writeFile(outside, Buffer.from([1, 2, 3]));
    await writeMoodboards(cwd, [
      {
        id: "board-id",
        name: "Outside",
        images: [{ url: outside, weight: 1 }],
      },
    ]);
    const { POST } = await loadRoute(cwd, kreaRoot);

    const res = await POST(request({ trigger_word: "ohwx" }), params("board-id"));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: "No moodboard images could be materialized",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("training param limits + dataset minimum", () => {
  it.each([
    [{ steps: 10 }, "Validation: steps must be 100–50000 (got 10)"],
    [{ resolution: 1000 }, "Validation: resolution must be 512–2048, multiple of 64 (got 1000)"],
    [{ resolution: 4096 }, "Validation: resolution must be 512–2048, multiple of 64 (got 4096)"],
    [{ rank: 512 }, "Validation: rank must be 1–256 (got 512)"],
    [{ lr: 0.5 }, "Validation: lr must be 0.000001–0.01 (got 0.5)"],
  ])("400s on %o before touching the dataset", async (bad, error) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-train-"));
    const cwd = path.join(tmp, "app");
    await fs.mkdir(cwd);
    await writeMoodboards(cwd, [
      { id: "board-id", name: "B", images: [{ url: "/x.png", weight: 1 }] },
    ]);
    const { POST } = await loadRoute(cwd, path.join(tmp, "krea"));

    const res = await POST(request({ trigger_word: "ohwx", ...bad }), params("board-id"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hard-fails when too few images survive materialization", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-train-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    const boardDir = path.join(kreaRoot, "01_Test_images");
    await fs.mkdir(cwd);
    await fs.mkdir(boardDir, { recursive: true });
    await fs.writeFile(path.join(boardDir, "a.png"), Buffer.from([1]));
    await fs.writeFile(path.join(boardDir, "b.png"), Buffer.from([2]));
    const url = (file: string) =>
      `/api/moodboards/krea?board=01_Test_images&file=${file}`;
    await writeMoodboards(cwd, [
      {
        id: "board-id",
        name: "Sparse",
        images: ["a.png", "b.png", "gone1.png", "gone2.png", "gone3.png", "gone4.png"].map(
          (f) => ({ url: url(f), weight: 1 }),
        ),
      },
    ]);
    const { POST } = await loadRoute(cwd, kreaRoot);

    const res = await POST(request({ trigger_word: "ohwx" }), params("board-id"));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      materialized: 2,
      skipped: 4,
      error:
        "Only 2 of 6 images could be read; at least 5 are needed to train (4 missing or unreadable).",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const runDirs = await fs
      .readdir(path.join(cwd, "data/moodboard-training/board-id"))
      .catch(() => []);
    expect(runDirs).toEqual([]);
  });
});

describe("training run versioning + history", () => {
  async function seedBoard(
    cwd: string,
    kreaRoot: string,
    extra: Record<string, unknown> = {},
  ) {
    const boardDir = path.join(kreaRoot, "01_Test_images");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(boardDir, { recursive: true });
    await fs.writeFile(path.join(boardDir, "image.png"), Buffer.from([1, 2, 3]));
    await writeMoodboards(cwd, [
      {
        id: "board-id",
        name: "Test Board",
        images: [
          {
            url: "/api/moodboards/krea?board=01_Test_images&file=image.png",
            weight: 1,
          },
        ],
        ...extra,
      },
    ]);
  }

  function queuedResponse(jobId = 7) {
    return new Response(JSON.stringify({ job_id: jobId, status: "queued" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("derives the next version from recorded runs and suffixes run_name", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-train-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    await seedBoard(cwd, kreaRoot, {
      trainingRuns: [
        {
          jobId: "1",
          runName: "moodboard-test-board",
          version: 1,
          triggerWord: "ohwx",
          startedAt: "2026-07-01T00:00:00Z",
          status: "done",
        },
      ],
    });
    fetchMock.mockResolvedValueOnce(queuedResponse());
    const { POST } = await loadRoute(cwd, kreaRoot);

    const res = await POST(request({ trigger_word: "ohwx" }), params("board-id"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: 2, run_name: "moodboard-test-board-v2" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).run_name).toBe("moodboard-test-board-v2");
  });

  it("honors an explicit version and kind prefix, and records the run", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-train-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    await seedBoard(cwd, kreaRoot, { kind: "character" });
    fetchMock.mockResolvedValueOnce(queuedResponse(42));
    const { POST } = await loadRoute(cwd, kreaRoot);

    const res = await POST(
      request({ trigger_word: "my_oc", version: 3 }),
      params("board-id"),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      version: 3,
      run_name: "character-test-board-v3",
    });
    const db = JSON.parse(
      await fs.readFile(path.join(cwd, "data/moodboards.json"), "utf-8"),
    );
    expect(db.moodboards[0].trainingRuns).toHaveLength(1);
    expect(db.moodboards[0].trainingRuns[0]).toMatchObject({
      jobId: "42",
      version: 3,
      triggerWord: "my_oc",
      status: "queued",
    });
  });

  it("GET returns recorded runs and refreshes live statuses from StyleVault", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-train-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    await seedBoard(cwd, kreaRoot, {
      trainingRuns: [
        {
          jobId: "5",
          runName: "moodboard-test-board",
          version: 1,
          triggerWord: "ohwx",
          startedAt: "2026-07-01T00:00:00Z",
          status: "running",
        },
      ],
    });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ status: "done", output_lora_path: "/runs/x/lora.safetensors" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { GET } = await loadRoute(cwd, kreaRoot);

    const res = await GET(
      new NextRequest("http://localhost:3000/api/moodboards/board-id/train"),
      params("board-id"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextVersion).toBe(2);
    expect(body.runs[0]).toMatchObject({
      jobId: "5",
      status: "done",
      outputLoraPath: "/runs/x/lora.safetensors",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://stylevault.test/training/jobs/5",
      expect.anything(),
    );
  });

  it("GET serves recorded history when StyleVault is unreachable", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-train-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    await seedBoard(cwd, kreaRoot, {
      trainingRuns: [
        {
          jobId: "5",
          runName: "moodboard-test-board",
          version: 1,
          triggerWord: "ohwx",
          startedAt: "2026-07-01T00:00:00Z",
          status: "running",
        },
      ],
    });
    fetchMock.mockRejectedValueOnce(new Error("down"));
    const { GET } = await loadRoute(cwd, kreaRoot);

    const res = await GET(
      new NextRequest("http://localhost:3000/api/moodboards/board-id/train"),
      params("board-id"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runs[0]).toMatchObject({ jobId: "5", status: "running" });
  });
});

describe("caption sidecars at materialize time", () => {
  it("writes trigger-prefixed sidecars for stored captions and passes caption_ext to SV", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-train-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    const boardDir = path.join(kreaRoot, "01_Test_images");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(boardDir, { recursive: true });
    await fs.writeFile(path.join(boardDir, "a.png"), Buffer.from([1]));
    await fs.writeFile(path.join(boardDir, "b.png"), Buffer.from([2]));
    await writeMoodboards(cwd, [
      {
        id: "board-id",
        name: "Cap Board",
        images: [
          {
            url: "/api/moodboards/krea?board=01_Test_images&file=a.png",
            weight: 1,
            caption: "a fox in the snow",
          },
          {
            url: "/api/moodboards/krea?board=01_Test_images&file=b.png",
            weight: 1,
            // no caption -> no sidecar, auto-caption fills it SV-side
          },
        ],
      },
    ]);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ job_id: 1, status: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { POST } = await loadRoute(cwd, kreaRoot);

    const res = await POST(
      request({ trigger_word: "ohwx", caption_ext: "caption" }),
      params("board-id"),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ materialized: 2, captioned: 1 });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.dataset.caption_ext).toBe(".caption");
    expect(body.params.caption_ext).toBe(".caption");
    const files = await fs.readdir(body.dataset.images_dir);
    const sidecars = files.filter((file) => file.endsWith(".caption"));
    expect(sidecars).toHaveLength(1);
    const text = await fs.readFile(
      path.join(body.dataset.images_dir, sidecars[0]!),
      "utf-8",
    );
    expect(text).toBe("ohwx, a fox in the snow");
    // Sidecar shares the image stem so trainers pair them up.
    expect(files).toContain(sidecars[0]!.replace(/\.caption$/, ".png"));
  });

  it("does not double-prefix when the caption already contains the trigger word", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-train-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    const boardDir = path.join(kreaRoot, "01_Test_images");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(boardDir, { recursive: true });
    await fs.writeFile(path.join(boardDir, "a.png"), Buffer.from([1]));
    await writeMoodboards(cwd, [
      {
        id: "board-id",
        name: "Cap Board",
        images: [
          {
            url: "/api/moodboards/krea?board=01_Test_images&file=a.png",
            weight: 1,
            caption: "ohwx style painting",
          },
        ],
      },
    ]);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ job_id: 1, status: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { POST } = await loadRoute(cwd, kreaRoot);

    const res = await POST(request({ trigger_word: "ohwx" }), params("board-id"));

    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const files = await fs.readdir(body.dataset.images_dir);
    const sidecar = files.find((file) => file.endsWith(".txt"))!;
    const text = await fs.readFile(
      path.join(body.dataset.images_dir, sidecar),
      "utf-8",
    );
    expect(text).toBe("ohwx style painting");
  });
  it("threads board caption knobs into params, metadata.jsonl and dataset.json", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-train-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    const boardDir = path.join(kreaRoot, "01_Test_images");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(boardDir, { recursive: true });
    await fs.writeFile(path.join(boardDir, "a.png"), Buffer.from([1]));
    await fs.writeFile(path.join(boardDir, "b.png"), Buffer.from([2]));
    await writeMoodboards(cwd, [
      {
        id: "board-id",
        name: "Knob Board",
        kind: "style",
        captionSettings: {
          triggerWord: "zkstyle",
          dropoutRate: 0.1,
          shuffle: true,
          keepTokens: 1,
        },
        images: [
          {
            url: "/api/moodboards/krea?board=01_Test_images&file=a.png",
            weight: 1,
            caption: "ink wash, mountains",
          },
          { url: "/api/moodboards/krea?board=01_Test_images&file=b.png", weight: 1 },
        ],
      },
    ]);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ job_id: 9, status: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { POST } = await loadRoute(cwd, kreaRoot);

    // No trigger_word in the request: the board's saved one is used.
    const res = await POST(request({}), params("board-id"));

    expect(res.status).toBe(200);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.params).toMatchObject({
      trigger_word: "zkstyle",
      caption_dropout_rate: 0.1,
      shuffle_caption: true,
      keep_tokens: 1,
    });
    const dir = body.dataset.images_dir as string;
    const jsonl = (await fs.readFile(path.join(dir, "metadata.jsonl"), "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(jsonl).toHaveLength(1);
    expect(jsonl[0].text).toBe("zkstyle, ink wash, mountains");
    expect(jsonl[0].file_name).toMatch(/^0001-.*\.png$/);
    await expect(fs.access(path.join(dir, jsonl[0].file_name))).resolves.toBeUndefined();
    const manifest = JSON.parse(await fs.readFile(path.join(dir, "dataset.json"), "utf-8"));
    expect(manifest).toMatchObject({
      board_id: "board-id",
      kind: "style",
      trigger_word: "zkstyle",
      caption_dropout_rate: 0.1,
      shuffle_caption: true,
      keep_tokens: 1,
    });
    expect(manifest.images).toHaveLength(2);
  });

  it("omits knob params when the board has none, and 400s without any trigger", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-train-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    const boardDir = path.join(kreaRoot, "01_Test_images");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(boardDir, { recursive: true });
    await fs.writeFile(path.join(boardDir, "a.png"), Buffer.from([1]));
    await writeMoodboards(cwd, [
      {
        id: "board-id",
        name: "Plain",
        images: [{ url: "/api/moodboards/krea?board=01_Test_images&file=a.png", weight: 1 }],
      },
    ]);
    const { POST } = await loadRoute(cwd, kreaRoot);

    const missing = await POST(request({}), params("board-id"));
    expect(missing.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      fs.access(path.join(cwd, "data/moodboard-training/board-id")),
    ).rejects.toThrow();

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ job_id: 2, status: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const res = await POST(request({ trigger_word: "ohwx" }), params("board-id"));
    expect(res.status).toBe(200);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.params.caption_dropout_rate).toBeUndefined();
    expect(body.params.shuffle_caption).toBeUndefined();
    expect(body.params.keep_tokens).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs/promises";
import os from "os";
import path from "path";

const fetchMock = vi.fn();

function request(body: unknown): NextRequest {
  return new NextRequest(
    "http://localhost:3000/api/moodboards/board-id/caption",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
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
  return import("@/app/api/moodboards/[id]/caption/route");
}

async function seed(cwd: string, kreaRoot: string, images: unknown[]) {
  const boardDir = path.join(kreaRoot, "01_Test_images");
  await fs.mkdir(path.join(cwd, "data"), { recursive: true });
  await fs.mkdir(boardDir, { recursive: true });
  await fs.writeFile(path.join(boardDir, "a.png"), Buffer.from([1]));
  await fs.writeFile(path.join(boardDir, "b.png"), Buffer.from([2]));
  await fs.writeFile(
    path.join(cwd, "data/moodboards.json"),
    JSON.stringify(
      {
        version: 1,
        moodboards: [{ id: "board-id", name: "Board", images }],
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function svCaption(caption: string) {
  return new Response(
    JSON.stringify({ caption, model: "omnitag", model_version: "1" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
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

describe("POST /api/moodboards/[id]/caption", () => {
  it("captions only images without captions and persists results", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-cap-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    await seed(cwd, kreaRoot, [
      {
        url: "/api/moodboards/krea?board=01_Test_images&file=a.png",
        weight: 1,
        caption: "already captioned",
        captionSource: "manual",
      },
      {
        url: "/api/moodboards/krea?board=01_Test_images&file=b.png",
        weight: 1,
      },
    ]);
    fetchMock.mockResolvedValueOnce(svCaption("a blue bird"));
    const { POST } = await loadRoute(cwd, kreaRoot);

    const res = await POST(request({}), params("board-id"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, captioned: 1, failed: 0 });
    expect(body.images[0].caption).toBe("already captioned");
    expect(body.images[1]).toMatchObject({
      caption: "a blue bird",
      captionSource: "omnitag",
    });
    // one SV call, with raw bytes
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("http://stylevault.test/caption/image?");

    // persisted
    const db = JSON.parse(
      await fs.readFile(path.join(cwd, "data/moodboards.json"), "utf-8"),
    );
    expect(db.moodboards[0].images[1].caption).toBe("a blue bird");
  });

  it("only_missing=false recaptions everything; indices narrows targets", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-cap-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    await seed(cwd, kreaRoot, [
      {
        url: "/api/moodboards/krea?board=01_Test_images&file=a.png",
        weight: 1,
        caption: "old caption",
      },
      {
        url: "/api/moodboards/krea?board=01_Test_images&file=b.png",
        weight: 1,
      },
    ]);
    fetchMock.mockResolvedValueOnce(svCaption("fresh caption"));
    const { POST } = await loadRoute(cwd, kreaRoot);

    const res = await POST(
      request({ only_missing: false, indices: [0] }),
      params("board-id"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.captioned).toBe(1);
    expect(body.images[0].caption).toBe("fresh caption");
    expect(body.images[1].caption).toBeUndefined();
  });

  it("fails with 502 when StyleVault produces nothing", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-cap-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    await seed(cwd, kreaRoot, [
      {
        url: "/api/moodboards/krea?board=01_Test_images&file=a.png",
        weight: 1,
      },
    ]);
    fetchMock.mockRejectedValue(new Error("down"));
    const { POST } = await loadRoute(cwd, kreaRoot);

    const res = await POST(request({}), params("board-id"));

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, failed: 1 });
  });

  it("attaches captions by image url, not array index, across a concurrent reorder", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-cap-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    const urlA = "/api/moodboards/krea?board=01_Test_images&file=a.png";
    const urlB = "/api/moodboards/krea?board=01_Test_images&file=b.png";
    const dbPath = path.join(cwd, "data/moodboards.json");
    await seed(cwd, kreaRoot, [
      { url: urlA, weight: 1 }, // index 0 — the only target
      { url: urlB, weight: 1, caption: "b's own caption" },
    ]);

    // Simulate a board edit landing WHILE captioning runs: reorder the images
    // on disk so a is now index 1. An index-keyed write-back would put a's
    // caption onto b; url-keying must still target a.
    fetchMock.mockImplementationOnce(async () => {
      const db = JSON.parse(await fs.readFile(dbPath, "utf-8"));
      db.moodboards[0].images = [
        { url: urlB, weight: 1, caption: "b's own caption" },
        { url: urlA, weight: 1 },
      ];
      await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf-8");
      return svCaption("a's caption");
    });

    const { POST } = await loadRoute(cwd, kreaRoot);
    const res = await POST(request({}), params("board-id"));

    expect(res.status).toBe(200);
    const db = JSON.parse(await fs.readFile(dbPath, "utf-8"));
    const byUrl = Object.fromEntries(
      db.moodboards[0].images.map((im: { url: string }) => [im.url, im]),
    );
    expect(byUrl[urlA].caption).toBe("a's caption"); // right image
    expect(byUrl[urlB].caption).toBe("b's own caption"); // untouched
  });

  it("404s on unknown board", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-cap-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    await seed(cwd, kreaRoot, []);
    const { POST } = await loadRoute(cwd, kreaRoot);

    const res = await POST(request({}), params("missing"));

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

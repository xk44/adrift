import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Readable } from "stream";

const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
}));
const createReadStreamMock = vi.hoisted(() => vi.fn());

vi.mock("fs/promises", () => ({ default: fsMock }));
vi.mock("fs", () => ({ createReadStream: createReadStreamMock }));

type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

function request(query: string, init: NextRequestInit = {}): NextRequest {
  return new NextRequest(`http://localhost:3000/api/moodboards/krea${query}`, init);
}

async function loadRoute(root: string | null = "/tmp/krea-moodboards") {
  vi.resetModules();
  vi.doMock("@/lib/env", () => ({
    env: {
      ADMIN_API_KEY: "",
      NODE_ENV: "test",
    },
  }));
  if (root !== null) vi.stubEnv("KREA_MOODBOARDS_DIR", root);
  return import("@/app/api/moodboards/krea/route");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  createReadStreamMock.mockImplementation(() =>
    Readable.from([Buffer.from([1, 2, 3])]),
  );
});

describe("GET /api/moodboards/krea", () => {
  it("falls back to the downscaled WebP mirror when the PNG is absent", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    fsMock.realpath
      .mockResolvedValueOnce("/tmp/krea-moodboards")
      .mockRejectedValueOnce(enoent)
      .mockResolvedValueOnce("/tmp/krea-moodboards")
      .mockResolvedValueOnce("/tmp/krea-moodboards/01_Test_images/image.webp");
    fsMock.stat.mockResolvedValue({ size: 3 });
    const { GET } = await loadRoute("/tmp/krea-moodboards");

    const res = await GET(request("?board=01_Test_images&file=image.png"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(createReadStreamMock).toHaveBeenCalledWith(
      "/tmp/krea-moodboards/01_Test_images/image.webp",
    );
  });

  it("returns 404 when neither the PNG nor its WebP mirror exists", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    fsMock.realpath.mockImplementation(async (p: string) => {
      if (p === "/tmp/krea-moodboards") return p;
      throw enoent;
    });
    const { GET } = await loadRoute("/tmp/krea-moodboards");

    const res = await GET(request("?board=01_Test_images&file=image.png"));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "File not found" });
    expect(createReadStreamMock).not.toHaveBeenCalled();
  });

  it("rejects traversal and invalid paths before touching the filesystem", async () => {
    const { GET } = await loadRoute();
    const badQueries = [
      "?board=../01_Test_images&file=image.png",
      `?board=${encodeURIComponent("/tmp/01_Test_images")}&file=image.png`,
      "?board=01_Test_images&file=../secret.png",
      `?board=01_Test_images&file=${encodeURIComponent("/etc/passwd")}`,
      "?board=01_Test_images&file=image.svg",
      `?board=01_Test_images&file=${encodeURIComponent("bad\u0000.png")}`,
    ];

    for (const query of badQueries) {
      const res = await GET(request(query));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false });
    }

    expect(fsMock.realpath).not.toHaveBeenCalled();
    expect(fsMock.stat).not.toHaveBeenCalled();
    expect(createReadStreamMock).not.toHaveBeenCalled();
  });

  it("rejects a valid-looking file whose real path escapes the Krea root", async () => {
    fsMock.realpath
      .mockResolvedValueOnce("/tmp/krea-moodboards")
      .mockResolvedValueOnce("/tmp/outside/image.png");
    const { GET } = await loadRoute("/tmp/krea-moodboards");

    const res = await GET(request("?board=01_Test_images&file=image.png"));

    // Escapes resolve to "not found" (no existence oracle), never served.
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(fsMock.stat).not.toHaveBeenCalled();
    expect(createReadStreamMock).not.toHaveBeenCalled();
  });

  it("serves valid Krea image files with immutable caching", async () => {
    fsMock.realpath
      .mockResolvedValueOnce("/tmp/krea-moodboards")
      .mockResolvedValueOnce("/tmp/krea-moodboards/01_Test_images/image.png");
    fsMock.stat.mockResolvedValue({ size: 3 });
    const { GET } = await loadRoute("/tmp/krea-moodboards");

    const res = await GET(request("?board=01_Test_images&file=image.png"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe("3");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    await expect(res.arrayBuffer()).resolves.toHaveProperty("byteLength", 3);
    expect(fsMock.stat).toHaveBeenCalledWith(
      "/tmp/krea-moodboards/01_Test_images/image.png",
    );
    expect(createReadStreamMock).toHaveBeenCalledWith(
      "/tmp/krea-moodboards/01_Test_images/image.png",
    );
  });

  it("serves uploaded moodboard images as streams with content length", async () => {
    fsMock.stat.mockResolvedValue({ size: 3 });
    const { GET } = await import("@/app/api/moodboards/upload/route");

    const res = await GET(
      new NextRequest("http://localhost:3000/api/moodboards/upload?file=image.png"),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe("3");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    await expect(res.arrayBuffer()).resolves.toHaveProperty("byteLength", 3);
    expect(createReadStreamMock).toHaveBeenCalledWith(
      expect.stringContaining("data/moodboard-uploads/image.png"),
    );
  });

  it("returns CORS headers for OPTIONS", async () => {
    const { OPTIONS } = await loadRoute();

    const res = await OPTIONS();

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  });
});

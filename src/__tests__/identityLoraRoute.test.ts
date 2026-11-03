import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs/promises";
import os from "os";
import path from "path";

const fetchMock = vi.fn();

async function loadRoute(cwd: string) {
  vi.resetModules();
  vi.stubEnv("STYLEVAULT_API_URL", "http://stylevault.test");
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.stubGlobal("fetch", fetchMock);
  return import("@/app/api/identity-lora/route");
}

async function tmpApp(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-identity-"));
  const cwd = path.join(tmp, "app");
  await fs.mkdir(path.join(cwd, "data"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, "data/moodboards.json"),
    JSON.stringify({ version: 1, moodboards: [] }),
    "utf-8",
  );
  return cwd;
}

function get(): NextRequest {
  return new NextRequest("http://localhost:3000/api/identity-lora");
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/identity-lora", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const photos = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    url: `/api/moodboards/upload?file=p${i}.png`,
    caption: i === 0 ? "zxana person, smiling" : undefined,
  }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GET /api/identity-lora", () => {
  it("says the trainer is not configured when StyleVault is down", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const { GET } = await loadRoute(await tmpApp());
    const res = await GET(get());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.configured).toBe(false);
    expect(body.error).toMatch(/^Trainer not configured: .*unreachable/);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://stylevault.test/training/backends",
      expect.anything(),
    );
  });

  it("says not configured when no backend is installed", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        backends: [
          { name: "musubi-tuner", installed: false, model_families: ["krea2"] },
        ],
      }),
    );
    const { GET } = await loadRoute(await tmpApp());
    const body = await (await GET(get())).json();
    expect(body.configured).toBe(false);
    expect(body.error).toMatch(/no trainer backend/);
  });

  it("lists the trainable families of installed backends", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        backends: [
          { name: "musubi-tuner", installed: true, model_families: ["krea2"] },
          {
            name: "ai-toolkit",
            installed: false,
            model_families: ["moss_image"],
          },
        ],
      }),
    );
    const { GET } = await loadRoute(await tmpApp());
    const body = await (await GET(get())).json();
    expect(body).toEqual({ ok: true, configured: true, families: ["krea2"] });
  });
});

describe("POST /api/identity-lora", () => {
  it("rejects fewer than 10 photos", async () => {
    const { POST } = await loadRoute(await tmpApp());
    const res = await POST(post({ name: "Identity: Ana", images: photos(9) }));
    expect(res.status).toBe(400);
  });

  it("rejects more than 30 photos", async () => {
    const { POST } = await loadRoute(await tmpApp());
    const res = await POST(post({ name: "Identity: Ana", images: photos(31) }));
    expect(res.status).toBe(400);
  });

  it("rejects photos that were not uploaded through Adrift", async () => {
    const { POST } = await loadRoute(await tmpApp());
    const images = photos(10);
    images[3] = { url: "/etc/passwd", caption: undefined };
    const res = await POST(post({ name: "Identity: Ana", images }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/uploaded/);
  });

  it("creates a character board with captions and never calls the trainer", async () => {
    const cwd = await tmpApp();
    const { POST } = await loadRoute(cwd);
    const res = await POST(post({ name: "Identity: Ana", images: photos(30) }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.moodboard.kind).toBe("character");
    expect(body.moodboard.images).toHaveLength(30);
    expect(body.moodboard.images[0]).toMatchObject({
      caption: "zxana person, smiling",
      captionSource: "manual",
    });
    expect(body.moodboard.images[1].caption).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    const saved = JSON.parse(
      await fs.readFile(path.join(cwd, "data/moodboards.json"), "utf-8"),
    );
    expect(saved.moodboards[0].name).toBe("Identity: Ana");
  });
});

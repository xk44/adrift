/**
 * Civitai seed route validation/auth regression tests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Readable } from "stream";

const fsPromisesMock = {
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn(),
  rename: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
};

const fsMock = {
  statSync: vi.fn(),
  createReadStream: vi.fn(),
};

vi.mock("fs/promises", () => fsPromisesMock);
vi.mock("fs", () => fsMock);
vi.mock("@/lib/civitaiConfig", () => ({
  getCivitaiApiKey: vi.fn().mockResolvedValue("civitai-test-key"),
}));

type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

function request(path: string, init: NextRequestInit = {}): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, init);
}

function postRequest(body?: unknown, token?: string, extraHeaders: Record<string, string> = {}): NextRequest {
  return request("/api/civitai/seed", {
    method: "POST",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function loadRoute(adminApiKey = "admin-key") {
  vi.resetModules();
  vi.doMock("@/lib/env", () => ({
    env: {
      ADMIN_API_KEY: adminApiKey,
      COMFY_ROOT: "/tmp/adrift-test-comfyui",
      COMFY_HTTP_URL: "http://127.0.0.1:8188",
      COMFY_DEFAULT_CHECKPOINT: "",
      CIVITAI_API_URL: "https://civitai.com/api/v1",
      CIVITAI_API_KEY: "",
      CIVITAI_API_KEY_ENCRYPTED: "",
      SECRETS_PASSPHRASE: "",
      STYLEVAULT_API_URL: "http://127.0.0.1:8000",
      NODE_ENV: "test",
    },
  }));
  return import("@/app/api/civitai/seed/route");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fsPromisesMock.mkdir.mockResolvedValue(undefined);
  fsPromisesMock.readFile.mockRejectedValue(new Error("missing cache"));
  fsPromisesMock.writeFile.mockResolvedValue(undefined);
  fsPromisesMock.rename.mockResolvedValue(undefined);
  fsPromisesMock.rm.mockResolvedValue(undefined);
  fsPromisesMock.readdir.mockResolvedValue([]);
  fsMock.statSync.mockReturnValue({ mtimeMs: 1, size: 11 });
  fsMock.createReadStream.mockImplementation(() => Readable.from(["model-bytes"]));
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        id: 101,
        modelId: 202,
        name: "v1",
        trainedWords: ["trigger"],
        files: [{ name: "model.safetensors", primary: true, hashes: {} }],
        model: { name: "Model", type: "LORA" },
      }),
    }),
  );
});

describe("/api/civitai/seed validation and auth", () => {
  it("requires admin auth when ADMIN_API_KEY is configured", async () => {
    const { POST } = await loadRoute("admin-key");

    const res = await POST(postRequest({ targetDir: "loras" }));

    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(await res.json()).toMatchObject({ ok: false, error: "Unauthorized" });
    expect(fsPromisesMock.readdir).not.toHaveBeenCalled();
  });

  it("rejects wrong bearer tokens", async () => {
    const { POST } = await loadRoute("admin-key");

    const res = await POST(postRequest({ targetDir: "loras" }, "wrong-key"));

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error: "Unauthorized" });
    expect(fsPromisesMock.readdir).not.toHaveBeenCalled();
  });

  it("preserves no-key local dev mode while still validating targetDir", async () => {
    const { POST } = await loadRoute("");

    const res = await POST(postRequest({ targetDir: "../etc" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(fsPromisesMock.readdir).not.toHaveBeenCalled();
  });

  it("rejects traversal, unknown, and non-string targetDir values", async () => {
    const { POST } = await loadRoute();

    const traversal = await POST(postRequest({ targetDir: "../../etc" }, "admin-key"));
    const absolute = await POST(postRequest({ targetDir: "/etc" }, "admin-key"));
    const unknown = await POST(postRequest({ targetDir: "custom_models" }, "admin-key"));
    const nonString = await POST(postRequest({ targetDir: 123 }, "admin-key"));

    expect(traversal.status).toBe(400);
    expect(await traversal.json()).toMatchObject({ ok: false, error: expect.stringContaining("targetDir must be one of") });
    expect(absolute.status).toBe(400);
    expect(await absolute.json()).toMatchObject({ ok: false, error: expect.stringContaining("targetDir must be one of") });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ ok: false, error: expect.stringContaining("targetDir must be one of") });
    expect(nonString.status).toBe(400);
    expect(await nonString.json()).toMatchObject({ ok: false, error: "Missing targetDir" });
    expect(fsPromisesMock.readdir).not.toHaveBeenCalled();
  });

  it("defaults to loras when body is omitted", async () => {
    const { POST } = await loadRoute("admin-key");

    const res = await POST(postRequest(undefined, "admin-key"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, models: [], scanned: 0 });
    expect(fsPromisesMock.readdir).toHaveBeenCalledWith("/tmp/adrift-test-comfyui/models/loras");
  });

  it("rate limits expensive seed scans", async () => {
    const { POST } = await loadRoute("");
    const ip = `10.0.0.${Math.floor(Math.random() * 200) + 1}`;
    const statuses: number[] = [];

    for (let i = 0; i < 6; i += 1) {
      const res = await POST(postRequest({ targetDir: "loras" }, undefined, { "x-forwarded-for": ip }));
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
    const limited = await POST(postRequest({ targetDir: "loras" }, undefined, { "x-forwarded-for": ip }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  it("hashes allowed model files, looks up Civitai, and atomically saves cache", async () => {
    fsPromisesMock.readdir.mockResolvedValue(["model.safetensors", "note.txt"]);
    const { POST } = await loadRoute("admin-key");

    const res = await POST(postRequest({ targetDir: "loras" }, "admin-key"));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, scanned: 1, matched: 1 });
    expect(data.models[0]).toMatchObject({
      civitaiModelId: 202,
      civitaiVersionId: 101,
      modelName: "Model",
      versionName: "v1",
      filename: "model.safetensors",
      localPath: "/tmp/adrift-test-comfyui/models/loras/model.safetensors",
      trainedWords: ["trigger"],
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/model-versions/by-hash/"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer civitai-test-key" }) }),
    );
    expect(fsPromisesMock.writeFile).toHaveBeenCalledWith(
      expect.stringContaining(".adrift-hashes."),
      expect.stringContaining("model.safetensors"),
      "utf8",
    );
    expect(fsPromisesMock.rename).toHaveBeenCalledWith(
      expect.stringContaining(".adrift-hashes."),
      "/tmp/adrift-test-comfyui/models/.adrift-hashes.json",
    );
  });

  it("reuses hashes from the pre-rename cache file when the new one is missing", async () => {
    const root = "/tmp/adrift-test-comfyui/models";
    const legacyCache = `${root}/.comfyjourney-hashes.json`; // legacy-name
    fsPromisesMock.readdir.mockResolvedValue(["model.safetensors"]);
    fsPromisesMock.readFile.mockImplementation(async (file: string) => {
      if (file === legacyCache) {
        return JSON.stringify({
          [`${root}/loras/model.safetensors`]: { hash: "legacyhash", mtime: 1, size: 11 },
        });
      }
      throw new Error("missing cache");
    });
    const { POST } = await loadRoute("admin-key");

    const res = await POST(postRequest({ targetDir: "loras" }, "admin-key"));

    expect(res.status).toBe(200);
    expect(fsPromisesMock.readFile).toHaveBeenCalledWith(`${root}/.adrift-hashes.json`, "utf8");
    expect(fsMock.createReadStream).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/model-versions/by-hash/legacyhash"),
      expect.anything(),
    );
  });
});

/**
 * Style preview route validation/auth regression tests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import path from "path";

const fsMock = {
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
};

vi.mock("fs/promises", () => ({ default: fsMock }));

const fetchHistoryMock = vi.fn();
const fetchImageMock = vi.fn();

const EMPTY_CACHE = { version: 1, previews: {}, pendingJobs: [] };
const SEEDED_CACHE = {
  version: 1,
  previews: {
    "123456": {
      url: "/previews/123456.png",
      generatedAt: 1700000000000,
      prompt: "seed prompt --sref 123456",
    },
  },
  pendingJobs: [
    {
      id: "job-1",
      code: "234567",
      status: "queued",
      prompt: "queued prompt --sref 234567",
      createdAt: 1700000001000,
    },
  ],
};

type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];
let cacheFileContent = JSON.stringify(EMPTY_CACHE);

function request(path: string, init: NextRequestInit = {}): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, init);
}

function postRequest(body: unknown, token?: string): NextRequest {
  return request("/api/style/preview", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function loadRoute(adminApiKey = "") {
  vi.resetModules();
  vi.doMock("@/lib/env", () => ({
    env: {
      ADMIN_API_KEY: adminApiKey,
      COMFY_HTTP_URL: "http://127.0.0.1:8188",
      COMFY_ROOT: "/tmp/adrift-test-comfyui",
      COMFY_DEFAULT_CHECKPOINT: "",
      CIVITAI_API_URL: "https://civitai.com/api/v1",
      CIVITAI_API_KEY: "",
      CIVITAI_API_KEY_ENCRYPTED: "",
      SECRETS_PASSPHRASE: "",
      STYLEVAULT_API_URL: "http://127.0.0.1:8000",
      NODE_ENV: "test",
    },
  }));
  vi.doMock("@/lib/comfy/http", () => ({
    fetchHistory: fetchHistoryMock,
    fetchImage: fetchImageMock,
  }));
  return import("@/app/api/style/preview/route");
}

function seedCache(cache: unknown): void {
  cacheFileContent = JSON.stringify(cache);
  fsMock.readFile.mockImplementation(async () => cacheFileContent);
}

async function flushBackgroundWork(iterations = 20): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

async function waitForBackgroundWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await flushBackgroundWork();
}

beforeEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.clearAllMocks();
  cacheFileContent = JSON.stringify(EMPTY_CACHE);
  fsMock.mkdir.mockResolvedValue(undefined);
  fsMock.writeFile.mockImplementation(async (file, content) => {
    if (path.basename(String(file)).startsWith(".style_previews.")) {
      cacheFileContent = String(content);
    }
  });
  fsMock.rename.mockResolvedValue(undefined);
  fsMock.rm.mockResolvedValue(undefined);
  fsMock.readFile.mockImplementation(async () => cacheFileContent);
  fetchHistoryMock.mockResolvedValue({
    prompt: [0, "prompt-1", {}, {}],
    outputs: {
      "9": {
        images: [
          {
            filename: "ComfyUI_00001_.png",
            subfolder: "",
            type: "output",
          },
        ],
      },
    },
    status: { completed: true, status_str: "success" },
  });
  fetchImageMock.mockResolvedValue(Buffer.from("preview-image"));
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        ok: true,
        runs: [{ jobs: [{ prompt_id: "prompt-1" }] }],
      }),
    }),
  );
});

describe("/api/style/preview validation and auth", () => {
  it("requires admin auth for POST when ADMIN_API_KEY is configured", async () => {
    const { POST } = await loadRoute("admin-key");

    const res = await POST(postRequest({ code: "123456" }));

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: "Unauthorized",
    });
    expect(fsMock.writeFile).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed POST bodies before queueing previews", async () => {
    const { POST } = await loadRoute();

    const missingCode = await POST(postRequest({}));
    const invalidCode = await POST(postRequest({ code: "abc123" }));
    const longPrompt = await POST(
      postRequest({ code: "123456", prompt: "x".repeat(10_001) }),
    );
    const nonObject = await POST(
      request("/api/style/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["not-object"]),
      }),
    );

    expect(missingCode.status).toBe(400);
    expect(await missingCode.json()).toMatchObject({
      ok: false,
      error: "Missing code",
    });
    expect(invalidCode.status).toBe(400);
    expect(await invalidCode.json()).toMatchObject({
      ok: false,
      error: "Style code must be 6-12 digits",
    });
    expect(longPrompt.status).toBe(400);
    expect(await longPrompt.json()).toMatchObject({
      ok: false,
      error: "Prompt exceeds maximum length of 10000 characters",
    });
    expect(nonObject.status).toBe(400);
    expect(await nonObject.json()).toMatchObject({
      ok: false,
      error: "body must be an object",
    });
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("sanitizes valid preview requests, clamps size, and writes atomically", async () => {
    const { POST } = await loadRoute("admin-key");

    const res = await POST(
      postRequest(
        {
          code: " 123456 ",
          prompt: " portrait\u0000 test ",
          size: 99999,
          force: "yes",
        },
        "admin-key",
      ),
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, queued: true });
    expect(data.job.code).toBe("123456");
    expect(data.job.prompt).toBe(
      "portrait test --sref 123456 --sw 500 --ar 1:1",
    );
    expect(fsMock.writeFile).toHaveBeenCalled();
    expect(fsMock.rename).toHaveBeenCalled();
    const saved = JSON.parse(String(fsMock.writeFile.mock.calls[0][1]));
    expect(saved.pendingJobs[0]).toMatchObject({
      code: "123456",
      status: "queued",
    });
    await waitForBackgroundWork();
  });

  it("passes bearer auth to the internal imagine call when admin auth is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true, runs: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    fsMock.readFile.mockImplementation(async () => {
      const lastWrite = fsMock.writeFile.mock.calls.at(-1);
      return lastWrite ? String(lastWrite[1]) : JSON.stringify(EMPTY_CACHE);
    });
    const { POST } = await loadRoute("admin-key");

    await POST(postRequest({ code: "123456", force: true }, "admin-key"));
    await waitForBackgroundWork();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/jobs/imagine"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer admin-key" }),
      }),
    );
  });

  it("self-POSTs to 127.0.0.1 with X-Requested-With in no-key mode (passes CSRF)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true, runs: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    fsMock.readFile.mockImplementation(async () => {
      const lastWrite = fsMock.writeFile.mock.calls.at(-1);
      return lastWrite ? String(lastWrite[1]) : JSON.stringify(EMPTY_CACHE);
    });
    const { POST } = await loadRoute();

    await POST(postRequest({ code: "234567", force: true }));
    await waitForBackgroundWork();

    const call = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/jobs/imagine"));
    expect(call).toBeTruthy();
    expect(String(call![0])).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/jobs\/imagine$/);
    expect(call![1].headers).toMatchObject({ "X-Requested-With": "XMLHttpRequest" });
    expect(call![1].headers.Authorization).toBeUndefined();
  });

  it("polls ComfyUI history, writes the preview file, and caches the real URL", async () => {
    const { GET, POST } = await loadRoute();

    const res = await POST(postRequest({ code: "345678", force: true }));
    const data = await res.json();
    await waitForBackgroundWork();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({ ok: true, queued: true });
    expect(fetchHistoryMock).toHaveBeenCalledWith("prompt-1");
    expect(fetchImageMock).toHaveBeenCalledWith(
      "ComfyUI_00001_.png",
      "",
      "output",
    );
    expect(fsMock.mkdir).toHaveBeenCalledWith(
      expect.stringContaining("data/style-previews"),
      { recursive: true },
    );
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("data/style-previews/345678.png"),
      Buffer.from("preview-image"),
    );

    const status = await GET(
      request(`/api/style/preview?jobId=${encodeURIComponent(data.job.id)}`),
    );
    expect(await status.json()).toMatchObject({
      ok: true,
      job: {
        id: data.job.id,
        code: "345678",
        status: "done",
        previewUrl: "/api/style/preview?image=345678",
      },
      preview: {
        url: "/api/style/preview?image=345678",
        prompt: data.job.prompt,
      },
    });
  });

  it("marks preview jobs as error when ComfyUI history polling times out", async () => {
    vi.useFakeTimers();
    fetchHistoryMock.mockResolvedValue(null);
    const { GET, POST } = await loadRoute();

    const res = await POST(postRequest({ code: "456789", force: true }));
    const data = await res.json();
    await vi.advanceTimersByTimeAsync(120_000);
    await flushBackgroundWork();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({ ok: true, queued: true });
    expect(fetchImageMock).not.toHaveBeenCalled();
    expect(fsMock.writeFile).not.toHaveBeenCalledWith(
      expect.stringContaining("data/style-previews/456789.png"),
      expect.any(Buffer),
    );

    const status = await GET(
      request(`/api/style/preview?jobId=${encodeURIComponent(data.job.id)}`),
    );
    expect(await status.json()).toMatchObject({
      ok: true,
      job: {
        id: data.job.id,
        code: "456789",
        status: "error",
        error: "Preview generation timed out",
      },
    });
  });

  it("returns cached previews without queueing unless force is true", async () => {
    seedCache(SEEDED_CACHE);
    const { POST } = await loadRoute();

    const res = await POST(postRequest({ code: "123456" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      cached: true,
      preview: {
        ...SEEDED_CACHE.previews["123456"],
        url: "/api/style/preview?image=123456",
      },
    });
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("requires admin auth for GET and validates code format", async () => {
    seedCache(SEEDED_CACHE);
    const { GET } = await loadRoute("admin-key");

    // Unauthenticated GET is rejected
    const noAuth = await GET(request("/api/style/preview?code=123456"));
    expect(noAuth.status).toBe(401);

    // Authenticated GET succeeds
    const ok = await GET(
      request("/api/style/preview?code=123456", {
        headers: { authorization: "Bearer admin-key" },
      }),
    );
    const invalid = await GET(
      request("/api/style/preview?code=not-a-code", {
        headers: { authorization: "Bearer admin-key" },
      }),
    );

    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      ok: true,
      code: "123456",
      hasPreview: true,
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      ok: false,
      error: "Style code must be 6-12 digits",
    });
  });
});

describe("style preview cache durability (2026-09 audit)", () => {
  it("does not overwrite a corrupt cache file with an empty one", async () => {
    fsMock.readFile.mockImplementation(async () => "{ not json");
    const { POST } = await loadRoute();
    const res = await POST(postRequest({ code: "123456" }));
    expect(res.status).toBe(500);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
    expect(fsMock.rename).not.toHaveBeenCalled();
  });

  it("prunes stale finished jobs when queueing a new one", async () => {
    const now = Date.now();
    seedCache({
      version: 1,
      previews: {},
      pendingJobs: [
        { id: "old-done", code: "111111", status: "done", prompt: "p", createdAt: now - 2 * 86_400_000 },
        { id: "old-err", code: "222222", status: "error", prompt: "p", createdAt: now - 2 * 86_400_000 },
        { id: "fresh-done", code: "333333", status: "done", prompt: "p", createdAt: now - 1_000 },
        { id: "active", code: "444444", status: "processing", prompt: "p", createdAt: now - 1_000 },
      ],
    });
    const { POST } = await loadRoute();
    const res = await POST(postRequest({ code: "555555" }));
    expect(res.status).toBe(200);
    const saved = JSON.parse(cacheFileContent) as { pendingJobs: { id: string; code: string }[] };
    const ids = saved.pendingJobs.map((j) => j.id);
    expect(ids).not.toContain("old-done");
    expect(ids).not.toContain("old-err");
    expect(ids).toContain("fresh-done");
    expect(ids).toContain("active");
    expect(saved.pendingJobs.some((j) => j.code === "555555")).toBe(true);
    await waitForBackgroundWork();
  });
});

describe("B13: previews are served from data/ through the authed route", () => {
  it("migrates cached legacy /previews URLs to the authed route", async () => {
    seedCache(SEEDED_CACHE);
    const { GET } = await loadRoute();
    const res = await GET(request("/api/style/preview?code=123456"));
    expect(await res.json()).toMatchObject({
      hasPreview: true,
      preview: { url: "/api/style/preview?image=123456" },
    });
  });

  it("serves the PNG with private cache + nosniff, falling back to the legacy dir", async () => {
    const { GET } = await loadRoute();
    fsMock.readFile.mockImplementation(async (file: unknown) => {
      if (String(file).includes("public/previews/123456.png")) return Buffer.from("png");
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const res = await GET(request("/api/style/preview?image=123456"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("private");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects non-code image params and requires auth", async () => {
    const { GET } = await loadRoute();
    expect((await GET(request("/api/style/preview?image=../../etc"))).status).toBe(400);
    const keyed = await loadRoute("admin-key");
    expect((await keyed.GET(request("/api/style/preview?image=123456"))).status).toBe(401);
  });
});

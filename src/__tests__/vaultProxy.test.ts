/**
 * Vault Proxy Tests
 * =================
 * Unit tests for GET/POST/PUT/DELETE /api/vault/[...path]
 * Verifies proxying behaviour to StyleVault (http://127.0.0.1:8000).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/env", () => ({
  env: {
    STYLEVAULT_API_URL: "http://127.0.0.1:8000",
    COMFY_HTTP_URL: "http://127.0.0.1:8188",
    COMFY_ROOT: "/tmp",
    COMFY_DEFAULT_CHECKPOINT: "",
    CIVITAI_API_URL: "https://civitai.com/api/v1",
    CIVITAI_API_KEY: "",
    NODE_ENV: "test",
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(segments: string[]): {
  params: Promise<{ path: string[] }>;
} {
  return { params: Promise.resolve({ path: segments }) };
}

function makeSVResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("vault proxy — GET", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("proxies GET /api/vault/styles to http://127.0.0.1:8000/styles", async () => {
    fetchSpy.mockResolvedValueOnce(makeSVResponse({ styles: [] }));

    const { GET } = await import("@/app/api/vault/[...path]/route");
    const req = new NextRequest("http://localhost:3000/api/vault/styles");
    await GET(req, makeParams(["styles"]));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [calledUrl] = fetchSpy.mock.calls[0] as [string, ...unknown[]];
    expect(calledUrl).toBe("http://127.0.0.1:8000/styles");
  });

  it("preserves query params in the proxied URL", async () => {
    fetchSpy.mockResolvedValueOnce(makeSVResponse({ styles: [] }));

    const { GET } = await import("@/app/api/vault/[...path]/route");
    const req = new NextRequest(
      "http://localhost:3000/api/vault/styles?limit=10&offset=20",
    );
    await GET(req, makeParams(["styles"]));

    const [calledUrl] = fetchSpy.mock.calls[0] as [string, ...unknown[]];
    expect(calledUrl).toContain("?limit=10&offset=20");
    expect(calledUrl).toBe("http://127.0.0.1:8000/styles?limit=10&offset=20");
  });

  it("returns 502 when SV is unreachable", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const { GET } = await import("@/app/api/vault/[...path]/route");
    const req = new NextRequest("http://localhost:3000/api/vault/styles");
    const res = await GET(req, makeParams(["styles"]));

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/unreachable/i);
  });
});

describe("vault proxy — POST with body", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards POST body to SV", async () => {
    fetchSpy.mockResolvedValueOnce(makeSVResponse({ ok: true }));

    const { POST } = await import("@/app/api/vault/[...path]/route");
    const payload = { name: "my-style", code: "1234567890" };
    const req = new NextRequest("http://localhost:3000/api/vault/styles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await POST(req, makeParams(["styles"]));

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    // Body is streamed through a byte cap, so compare content not identity.
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect(await new Response(init.body as ReadableStream).text()).toBe(
      JSON.stringify(payload),
    );
    expect((init as RequestInit & { duplex?: string }).duplex).toBe("half");
  });

  it("returns upstream status code on success", async () => {
    fetchSpy.mockResolvedValueOnce(makeSVResponse({ ok: true }, 201));

    const { POST } = await import("@/app/api/vault/[...path]/route");
    const req = new NextRequest("http://localhost:3000/api/vault/styles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req, makeParams(["styles"]));
    expect(res.status).toBe(201);
  });
});

describe("vault proxy — HTTP methods forwarded", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["GET", "GET", ["styles", "42"]],
    ["POST", "POST", ["styles", "42"]],
    ["PUT", "PUT", ["moodboards", "42"]],
    ["DELETE", "DELETE", ["moodboards", "42"]],
  ] as const)(
    "%s request forwarded with method=%s",
    async (method, expectedMethod, pathSegs) => {
      fetchSpy.mockResolvedValueOnce(makeSVResponse({ ok: true }));

      const mod = await import("@/app/api/vault/[...path]/route");
      const handler = mod[method as keyof typeof mod] as (
        req: NextRequest,
        ctx: ReturnType<typeof makeParams>,
      ) => Promise<Response>;

      const req = new NextRequest(
        `http://localhost:3000/api/vault/${pathSegs.join("/")}`,
        {
          method,
          ...(method !== "GET" && method !== "DELETE"
            ? { headers: { "Content-Type": "application/json" }, body: "{}" }
            : {}),
        },
      );
      await handler(req, makeParams([...pathSegs]));

      const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toBe(`http://127.0.0.1:8000/${pathSegs.join("/")}`);
      expect(init.method).toBe(expectedMethod);
    },
  );
});

describe("vault proxy — newly-allowed path prefixes", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["umap", "GET", ["umap", "runs"]],
    ["umap", "GET", ["umap", "runs", "1", "points"]],
    ["search", "GET", ["search"]],
    ["assets", "GET", ["assets", "42", "thumb"]],
    ["assets", "POST", ["assets", "42", "rate"]],
    ["lora", "GET", ["lora", "runs"]],
    ["loras", "GET", ["loras", "99"]],
    ["lora", "POST", ["lora", "train"]],
    ["loras", "POST", ["loras", "99", "deploy"]],
  ] as const)(
    "proxies %s %s for path %s",
    async (_label, method, pathSegs) => {
      fetchSpy.mockResolvedValueOnce(makeSVResponse({ ok: true }));

      const mod = await import("@/app/api/vault/[...path]/route");
      const handler =
        method === "GET"
          ? mod.GET
          : mod.POST;

      const url = `http://localhost:3000/api/vault/${pathSegs.join("/")}`;
      const req =
        method === "GET"
          ? new NextRequest(url)
          : new NextRequest(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            });

      const ctx = makeParams([...pathSegs]);
      await handler(req, ctx);

      const [calledUrl] = fetchSpy.mock.calls[0] as [string];
      expect(calledUrl).toBe(
        `http://127.0.0.1:8000/${pathSegs.join("/")}`,
      );
    },
  );

  it("rejects unknown path prefix with 403", async () => {
    const { GET } = await import("@/app/api/vault/[...path]/route");
    const req = new NextRequest("http://localhost:3000/api/vault/forbidden/path");
    const res = await GET(req, makeParams(["forbidden", "path"]));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/not allowed/i);
  });

  it("rejects malformed path segments before proxying", async () => {
    const { GET } = await import("@/app/api/vault/[...path]/route");
    const req = new NextRequest("http://localhost:3000/api/vault/styles/../secret");
    const res = await GET(req, makeParams(["styles", "..", "secret"]));

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects mutating requests to non-mutable prefixes", async () => {
    const { POST } = await import("@/app/api/vault/[...path]/route");
    const req = new NextRequest("http://localhost:3000/api/vault/health", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const res = await POST(req, makeParams(["health"]));

    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

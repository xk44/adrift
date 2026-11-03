import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

function req(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(`http://localhost:3000/api/comfy/${path}`, {
    method: init?.method ?? "GET",
    headers: {
      "x-forwarded-for": `127.0.0.${Math.floor(Math.random() * 200) + 1}`,
      ...(init?.headers as Record<string, string> | undefined),
    },
    body: init?.body,
  });
}

function params(path: string[]) {
  return { params: Promise.resolve({ path }) };
}

describe("catch-all ComfyUI proxy hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
  });

  it("rejects disallowed GET paths before proxying", async () => {
    const { GET } = await import("@/app/api/comfy/[...path]/route");
    const res = await GET(req("interrupt"), params(["interrupt"]));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/not allowed/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects disallowed POST paths before proxying", async () => {
    const { POST } = await import("@/app/api/comfy/[...path]/route");
    const res = await POST(
      req("interrupt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      params(["interrupt"]),
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/not allowed/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unsafe path segments before proxying", async () => {
    const { GET } = await import("@/app/api/comfy/[...path]/route");
    const res = await GET(req(".."), params([".."]));

    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects oversized POST bodies before proxying", async () => {
    const { POST } = await import("@/app/api/comfy/[...path]/route");
    const res = await POST(
      req("prompt", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(11 * 1024 * 1024),
        },
        body: JSON.stringify({ prompt: {} }),
      }),
      params(["prompt"]),
    );

    expect(res.status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects overly long query strings before proxying", async () => {
    const { GET } = await import("@/app/api/comfy/[...path]/route");
    const longQuery = `object_info?x=${"a".repeat(2100)}`;
    const res = await GET(req(longQuery), params(["object_info"]));

    expect(res.status).toBe(414);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows known safe GET paths", async () => {
    const { GET } = await import("@/app/api/comfy/[...path]/route");
    const res = await GET(req("object_info"), params(["object_info"]));

    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8188/object_info",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("allows the prompt POST queue path", async () => {
    const { POST } = await import("@/app/api/comfy/[...path]/route");
    const res = await POST(
      req("prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: {} }),
      }),
      params(["prompt"]),
    );

    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8188/prompt",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("no longer tunnels upload/image (it bypassed safe upload names)", async () => {
    const { POST } = await import("@/app/api/comfy/[...path]/route");
    const res = await POST(
      req("upload/image", { method: "POST", body: "x" }),
      params(["upload", "image"]),
    );
    expect(res.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("caps chunked POST bodies that carry no Content-Length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        // Drain the body like a real upstream would.
        await new Response(init.body).arrayBuffer();
        return new Response("{}", { status: 200 });
      }),
    );
    const { POST } = await import("@/app/api/comfy/[...path]/route");
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= 11) return c.close();
        sent += 1;
        c.enqueue(chunk);
      },
    });
    const request = new NextRequest("http://localhost:3000/api/comfy/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await POST(request, params(["prompt"]));
    expect(res.status).toBe(413);
  });

  it("serves /view of an SVG as an inert sandboxed download", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<svg onload=alert(1)>", {
          status: 200,
          headers: { "content-type": "image/svg+xml" },
        }),
      ),
    );
    const { GET } = await import("@/app/api/comfy/[...path]/route");
    const res = await GET(req("view?filename=x.svg&type=output"), params(["view"]));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("content-disposition")).toBe("attachment");
  });

  it("passes video /view through with its type and range headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("abc", {
          status: 206,
          headers: { "content-type": "video/mp4", "content-range": "bytes 0-2/10" },
        }),
      ),
    );
    const { GET } = await import("@/app/api/comfy/[...path]/route");
    const res = await GET(
      req("view?filename=clip.mp4&subfolder=video&type=output", { headers: { range: "bytes=0-2" } }),
      params(["view"]),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-range")).toBe("bytes 0-2/10");
  });

  it("rejects /view with a traversal filename before fetching", async () => {
    const { GET } = await import("@/app/api/comfy/[...path]/route");
    const res = await GET(req("view?filename=..%2Fsecret.png"), params(["view"]));
    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

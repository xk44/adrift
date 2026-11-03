import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/hf/models/route";

const fetchMock = vi.fn();

function req(query = ""): NextRequest {
  return new NextRequest(`http://localhost:3000/api/hf/models${query}`);
}

function hubResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

describe("GET /api/hf/models", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("proxies a whitelisted query to huggingface.co with no auth", async () => {
    fetchMock.mockResolvedValue(
      hubResponse(
        [{ id: "org/model", likes: 3, downloads: 9, tags: ["lora"] }],
        {
          headers: {
            link: '<https://huggingface.co/api/models?cursor=Y3Vy>; rel="next"',
          },
        },
      ),
    );

    const res = await GET(
      req(
        "?search=flux&sort=likes&pipeline_tag=text-to-image&filter=lora&limit=10",
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=60");
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.nextCursor).toBe("Y3Vy");
    expect(json.items).toEqual([
      expect.objectContaining({
        id: "org/model",
        url: "https://huggingface.co/org/model",
      }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin).toBe("https://huggingface.co");
    expect(u.pathname).toBe("/api/models");
    expect(u.searchParams.get("search")).toBe("flux");
    expect(u.searchParams.get("sort")).toBe("likes");
    expect(u.searchParams.get("direction")).toBe("-1");
    expect(u.searchParams.get("filter")).toBe("lora");
    expect(u.searchParams.get("full")).toBe("true");
    expect(u.searchParams.get("limit")).toBe("10");
    const headers = new Headers(init.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects invalid params with 400 before any upstream call", async () => {
    for (const qs of [
      "?sort=evil",
      "?pipeline_tag=x",
      "?filter=license:mit",
      "?limit=1000",
      "?author=a/b",
    ]) {
      const res = await GET(req(qs));
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 on upstream errors and non-array bodies", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    expect((await GET(req())).status).toBe(502);

    fetchMock.mockResolvedValueOnce(hubResponse({ error: "x" }));
    expect((await GET(req())).status).toBe(502);
  });

  it("returns 504 on upstream timeout", async () => {
    fetchMock.mockRejectedValueOnce(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
    const res = await GET(req());
    expect(res.status).toBe(504);
  });
});

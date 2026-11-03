/**
 * Comfy image proxy validation regression tests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fetchImage } from "@/lib/comfy/http";
import { resetRateLimits } from "@/lib/rateLimit";

function uniqueIp(): string {
  return `10.55.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200) + 1}`;
}

function imageRequest(query: string, ip = uniqueIp()): NextRequest {
  return new NextRequest(`http://localhost:3000/api/comfy/image${query}`, {
    method: "GET",
    headers: {
      origin: "http://localhost:3000",
      "x-forwarded-for": ip,
    },
  });
}

async function loadRoute() {
  return import("@/app/api/comfy/image/route");
}

beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-length": "3" },
      }),
    ),
  );
});

describe("GET /api/comfy/image validation", () => {
  it("rejects missing and unsafe filename values before proxying", async () => {
    const { GET } = await loadRoute();

    const missing = await GET(imageRequest(""));
    const traversal = await GET(imageRequest("?filename=../secret.png"));
    const slash = await GET(imageRequest("?filename=folder/image.png"));
    const backslash = await GET(
      imageRequest(`?filename=${encodeURIComponent("folder\\image.png")}`),
    );

    for (const res of [missing, traversal, slash, backslash]) {
      expect(res.status).toBe(400);
      expect(res.headers.get("access-control-allow-methods")).toBe(
        "GET, OPTIONS",
      );
      expect(await res.json()).toMatchObject({ ok: false });
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects unsafe subfolder and invalid type values", async () => {
    const { GET } = await loadRoute();

    const subfolderTraversal = await GET(
      imageRequest("?filename=image.png&subfolder=../../etc"),
    );
    const emptySegment = await GET(
      imageRequest("?filename=image.png&subfolder=foo//bar"),
    );
    const invalidType = await GET(
      imageRequest("?filename=image.png&type=../../etc"),
    );

    expect(subfolderTraversal.status).toBe(400);
    expect(await subfolderTraversal.json()).toMatchObject({
      ok: false,
      error: "Invalid subfolder",
    });
    expect(emptySegment.status).toBe(400);
    expect(await emptySegment.json()).toMatchObject({
      ok: false,
      error: "Invalid subfolder",
    });
    expect(invalidType.status).toBe(400);
    expect(await invalidType.json()).toMatchObject({
      ok: false,
      error: "Invalid type parameter",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("proxies safe filenames/subfolders and reflects local CORS", async () => {
    const { GET } = await loadRoute();

    const res = await GET(
      imageRequest("?filename=image.png&subfolder=safe/nested&type=output"),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );
    expect(res.headers.get("content-length")).toBe("3");
    expect(res.headers.get("cache-control")).toContain("immutable");
    await expect(res.arrayBuffer()).resolves.toHaveProperty("byteLength", 3);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8188/view?filename=image.png&subfolder=safe%2Fnested&type=output",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("serves AVIF and EXR outputs with their own content types", async () => {
    const { GET } = await loadRoute();
    const avif = await GET(imageRequest("?filename=hdr_00001_.avif"));
    const exr = await GET(
      imageRequest("?filename=m_00001_.exr&subfolder=adrift_master"),
    );
    expect(avif.headers.get("content-type")).toBe("image/avif");
    expect(exr.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("sanitizes Content-Disposition filename quotes", async () => {
    const { GET } = await loadRoute();

    const res = await GET(
      imageRequest(`?filename=${encodeURIComponent('bad"name.png')}`),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      'inline; filename="bad_name.png"',
    );
  });

  it("rate-limits image proxy requests with CORS and Retry-After", async () => {
    const { GET } = await loadRoute();
    const ip = uniqueIp();
    const statuses: number[] = [];

    for (let i = 0; i < 121; i += 1) {
      const res = await GET(imageRequest("?filename=image.png", ip));
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 120).every((status) => status === 200)).toBe(true);
    expect(statuses[120]).toBe(429);
    const limited = await GET(imageRequest("?filename=image.png", ip));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("access-control-allow-methods")).toBe(
      "GET, OPTIONS",
    );
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  it("returns CORS headers for OPTIONS", async () => {
    const { OPTIONS } = await loadRoute();

    const res = await OPTIONS(imageRequest("?filename=image.png"));

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toBe(
      "GET, OPTIONS",
    );
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );
  });
});

describe("fetchImage traversal guard", () => {
  it("rejects traversal inputs before calling ComfyUI", async () => {
    await expect(fetchImage("../secret.png")).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(fetchImage("folder/image.png")).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(fetchImage("image.png", "../secret")).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(fetchImage("image.png", "safe//bad")).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      fetchImage("image.png", "safe", "badtype"),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

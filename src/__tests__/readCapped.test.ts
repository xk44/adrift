/**
 * B9: streamed body caps. Content-Length-only checks are bypassed by chunked
 * bodies (no header), so every capped route must count bytes as they arrive.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import {
  BodyTooLargeError,
  InvalidJsonBodyError,
  readBodyCapped,
  readJsonCapped,
  sniffImageType,
} from "@/lib/net/readCapped";

/** A chunked request: streamed body, no Content-Length header. */
function chunked(url: string, chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let i = 0;
  const pulled = { n: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) {
        pulled.n++;
        c.enqueue(chunks[i++]);
      } else c.close();
    },
  });
  const req = new NextRequest(url, {
    method: "POST",
    headers,
    body,
    duplex: "half",
  });
  expect(req.headers.get("content-length")).toBeNull();
  return { req, pulled };
}

const MB = 1024 * 1024;
const enc = new TextEncoder();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("readBodyCapped / readJsonCapped", () => {
  it("rejects a chunked body over the cap and stops reading", async () => {
    const chunks = Array.from({ length: 20 }, () => new Uint8Array(MB));
    const { req, pulled } = chunked("http://localhost/x", chunks);
    await expect(readBodyCapped(req, 2 * MB)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(pulled.n).toBeLessThan(20);
  });

  it("rejects a declared Content-Length over the cap without reading", async () => {
    const req = new NextRequest("http://localhost/x", {
      method: "POST",
      headers: { "content-length": String(10 * MB) },
      body: "{}",
    });
    await expect(readBodyCapped(req, MB)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("parses JSON under the cap; bad JSON is InvalidJsonBodyError", async () => {
    const ok = chunked("http://localhost/x", [enc.encode('{"a":'), enc.encode("1}")]);
    await expect(readJsonCapped(ok.req, 1024)).resolves.toEqual({ a: 1 });
    const bad = chunked("http://localhost/x", [enc.encode("{nope")]);
    await expect(readJsonCapped(bad.req, 1024)).rejects.toBeInstanceOf(InvalidJsonBodyError);
  });

  it("empty body uses emptyValue when given", async () => {
    const req = chunked("http://localhost/x", []).req;
    await expect(readJsonCapped(req, 10, { emptyValue: {} })).resolves.toEqual({});
  });

  it("sniffs raster magic bytes, rejects SVG/HTML", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(enc.encode("GIF89a......"))).toBe("image/gif");
    expect(sniffImageType(enc.encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(enc.encode("\0\0\0\x1cftypavif"))).toBe("image/avif");
    expect(sniffImageType(enc.encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageType(enc.encode("<html><script>"))).toBeNull();
  });
});

describe("routes enforce streamed caps", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/auth");
    vi.doUnmock("@/lib/rateLimit");
    vi.doUnmock("@/lib/routeGuard");
    vi.doUnmock("@/lib/moodboards");
    vi.doUnmock("@/lib/comfy/http");
  });

  function allowAll() {
    vi.resetModules();
    vi.doMock("@/lib/auth", () => ({ requireAdmin: () => ({ ok: true }) }));
    vi.doMock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
    vi.doMock("@/lib/routeGuard", () => ({ guardRoute: () => ({ ok: true }) }));
  }

  it("comfy/upload: chunked body over the cap is 413 and never uploads", async () => {
    allowAll();
    const upload = vi.fn();
    vi.doMock("@/lib/comfy/http", () => ({ uploadImageToComfy: upload }));
    const { POST } = await import("@/app/api/comfy/upload/route");
    const chunks = Array.from({ length: 50 }, () => new Uint8Array(MB).fill(0x41));
    const { req } = chunked("http://localhost/api/comfy/upload", chunks, {
      "content-type": "application/json",
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(upload).not.toHaveBeenCalled();
  });

  it("style/import: chunked body over 5MB is 413", async () => {
    allowAll();
    const { POST } = await import("@/app/api/style/import/route");
    const chunks = Array.from({ length: 8 }, () => new Uint8Array(MB).fill(0x20));
    const { req } = chunked("http://localhost/api/style/import", chunks);
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  it("user-tools/import: chunked body over the cap is 413", async () => {
    allowAll();
    const { POST } = await import("@/app/api/user-tools/import/route");
    const chunks = Array.from({ length: 40 }, () => new Uint8Array(MB).fill(0x20));
    const { req } = chunked("http://localhost/api/user-tools/import", chunks);
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  it("civitai/seed: chunked body over 1KB is 413", async () => {
    allowAll();
    const { POST } = await import("@/app/api/civitai/seed/route");
    const { req } = chunked("http://localhost/api/civitai/seed", [new Uint8Array(4096).fill(0x20)], {
      "content-type": "application/json",
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  describe("moodboards/upload", () => {
    let dir = "";
    async function load() {
      allowAll();
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-up-"));
      vi.doMock("@/lib/moodboards", () => ({
        MOODBOARD_UPLOAD_DIR: dir,
        uploadUrl: (f: string) => `/api/moodboards/upload?file=${f}`,
      }));
      return (await import("@/app/api/moodboards/upload/route")).POST;
    }
    afterEach(() => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    function multipart(bytes: Uint8Array, type: string) {
      const fd = new FormData();
      fd.append("file", new Blob([bytes as unknown as BlobPart], { type }), "x");
      return new NextRequest("http://localhost/api/moodboards/upload", {
        method: "POST",
        body: fd,
      });
    }

    it("rejects SVG/HTML bytes labelled image/png", async () => {
      const POST = await load();
      const res = await POST(multipart(enc.encode("<svg onload=alert(1)>"), "image/png"));
      expect(res.status).toBe(400);
      expect(fs.readdirSync(dir)).toHaveLength(0);
    });

    it("stores real PNG bytes with the sniffed extension", async () => {
      const POST = await load();
      const res = await POST(multipart(PNG, "image/jpeg"));
      expect(res.status).toBe(200);
      const files = fs.readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/\.png$/);
    });

    it("chunked body over the cap is 413 before multipart parsing", async () => {
      const POST = await load();
      const chunks = Array.from({ length: 16 }, () => new Uint8Array(MB));
      const { req } = chunked("http://localhost/api/moodboards/upload", chunks, {
        "content-type": "multipart/form-data; boundary=xyz",
      });
      const res = await POST(req);
      expect(res.status).toBe(413);
    });
  });
});

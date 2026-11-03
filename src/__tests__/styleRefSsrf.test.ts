import { describe, expect, it } from "vitest";
import { resolveAllowedStyleRefFetchUrl } from "@/lib/validate";
import { readBodyCapped } from "@/lib/util/fetchCap";

const trusted = ["http://127.0.0.1:8188", "http://127.0.0.1:8000"];

describe("resolveAllowedStyleRefFetchUrl", () => {
  it("allows data urls, trusted hosts and public hosts", () => {
    expect(resolveAllowedStyleRefFetchUrl("data:image/png;base64,AA", trusted)).not.toBeNull();
    expect(resolveAllowedStyleRefFetchUrl("http://127.0.0.1:8188/view?filename=a.png", trusted)).not.toBeNull();
    expect(resolveAllowedStyleRefFetchUrl("https://cdn.example.com/a.png", trusted)).not.toBeNull();
  });
  it("blocks private/loopback/metadata/non-http targets", () => {
    for (const u of [
      "http://127.0.0.1:9999/x",
      "http://localhost/x",
      "http://169.254.169.254/latest/meta-data",
      "http://10.0.0.5/x",
      "http://192.168.0.10:3080/x",
      "http://[::1]/x",
      "http://printer.local/x",
      "file:///etc/passwd",
      "ftp://example.com/a",
      "not a url",
    ]) {
      expect(resolveAllowedStyleRefFetchUrl(u, trusted), u).toBeNull();
    }
  });
});

describe("readBodyCapped", () => {
  it("returns body under cap", async () => {
    const buf = await readBodyCapped(new Response(new Uint8Array(10)), 100);
    expect(buf.length).toBe(10);
  });
  it("rejects over-cap streamed body without content-length", async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(60));
        c.enqueue(new Uint8Array(60));
        c.close();
      },
    });
    await expect(readBodyCapped(new Response(stream), 100, "img")).rejects.toThrow("img too large");
  });
  it("rejects declared-oversize", async () => {
    const r = new Response(new Uint8Array(5), { headers: { "content-length": "999" } });
    await expect(readBodyCapped(r, 100)).rejects.toThrow("too large");
  });
});

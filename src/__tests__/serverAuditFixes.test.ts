/**
 * Regression tests for the 2026-09 server-side audit fixes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { rateLimitKey, resetRateLimits, withRateLimit } from "@/lib/rateLimit";

function req(path: string, ip = "10.9.9.9", method = "GET"): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: { origin: "http://localhost:3000", "x-forwarded-for": ip },
  });
}

describe("withRateLimit bucket scoping", () => {
  beforeEach(() => resetRateLimits());

  it("exhausting one route does not 429 a different route", () => {
    const opts = { windowMs: 60_000, max: 2 };
    expect(withRateLimit(req("/api/comfy/image"), opts).ok).toBe(true);
    expect(withRateLimit(req("/api/comfy/image"), opts).ok).toBe(true);
    expect(withRateLimit(req("/api/comfy/image"), opts).ok).toBe(false);
    // Login must still work for the same IP.
    expect(withRateLimit(req("/api/auth/login", undefined, "POST"), { windowMs: 60_000, max: 10 }).ok).toBe(true);
  });

  it("dynamic tails share their route bucket; IPs are isolated", () => {
    const opts = { windowMs: 60_000, max: 1 };
    expect(withRateLimit(req("/api/comfy/history/abc"), opts).ok).toBe(true);
    expect(withRateLimit(req("/api/comfy/history/def"), opts).ok).toBe(false);
    expect(withRateLimit(req("/api/comfy/history/def", "10.1.1.1"), opts).ok).toBe(true);
  });

  it("keys on the last X-Forwarded-For hop (the one the trusted proxy added)", () => {
    const opts = { windowMs: 60_000, max: 5 };
    const a = rateLimitKey(req("/api/x/y", "1.2.3.4, 5.6.7.8"), opts);
    const b = rateLimitKey(req("/api/x/y", "5.6.7.8"), opts);
    expect(a).toBe(b);
  });
});

describe("comfy image proxy Cache-Control", () => {
  beforeEach(() => {
    resetRateLimits();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } }),
      ),
    );
  });

  it("only output files are cached immutable", async () => {
    const { GET } = await import("@/app/api/comfy/image/route");
    const out = await GET(req("/api/comfy/image?filename=a.png&type=output", "10.7.0.1"));
    expect(out.headers.get("cache-control")).toContain("immutable");
    for (const type of ["input", "temp"]) {
      const res = await GET(req(`/api/comfy/image?filename=a.png&type=${type}`, "10.7.0.2"));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
    }
  });
});

describe("vault proxy streamed body cap", () => {
  it("413s a chunked (no Content-Length) body over 2MB", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        // Drain like a real upstream would; the cap errors the stream.
        await new Response(init.body as ReadableStream).arrayBuffer();
        return new Response("{}", { status: 200 });
      }),
    );
    const { POST } = await import("@/app/api/vault/[...path]/route");
    const big = new Uint8Array(3 * 1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < big.length; i += 65536) c.enqueue(big.subarray(i, i + 65536));
        c.close();
      },
    });
    const r = new NextRequest("http://localhost:3000/api/vault/styles", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-forwarded-for": "10.8.0.1" },
      body,
      duplex: "half",
    });
    expect(r.headers.get("content-length")).toBeNull();
    const res = await POST(r, { params: Promise.resolve({ path: ["styles"] }) });
    expect(res.status).toBe(413);
  });
});

describe("moodboard readImageBytes remote fetch (safeFetch)", () => {
  it("reads from the configured ComfyUI and refuses other local targets", async () => {
    const http = await import("http");
    const server = http.createServer((_r, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([7, 8, 9]));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    vi.stubEnv("COMFY_HTTP_URL", base);
    try {
      const { readImageBytes } = await import("@/lib/moodboards/resolve");
      const ok = await readImageBytes({ kind: "remote", url: new URL(`${base}/view?filename=a.png`) });
      expect(ok && [...ok]).toEqual([7, 8, 9]);
      for (const u of ["http://127.0.0.1:1/a.png", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.8/a.png"]) {
        expect(await readImageBytes({ kind: "remote", url: new URL(u) }), u).toBeNull();
      }
    } finally {
      vi.unstubAllEnvs();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });
});

describe("moodboard upload GET filename validation", () => {
  it("rejects backslash / NUL / traversal names", async () => {
    const { GET } = await import("@/app/api/moodboards/upload/route");
    for (const bad of ["..\\..\\secret.png", "a\\b.png", "a\0.png", "../x.png", "x/y.png"]) {
      const res = await GET(req(`/api/moodboards/upload?file=${encodeURIComponent(bad)}`));
      expect(res.status, bad).toBe(400);
    }
  });
});

describe("resolveDbFile legacy fallback", () => {
  it("uses the pre-rename database only while the new one is missing", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const pathMod = await import("path");
    const tmp = fs.mkdtempSync(pathMod.join(os.tmpdir(), "cj-db-legacy-"));
    try {
      const { resolveDbFile } = await import("@/lib/db");
      const fresh = pathMod.join(tmp, "data", "adrift.db");
      const legacy = pathMod.join(tmp, "data", "comfyjourney.db"); // legacy-name
      expect(resolveDbFile(tmp)).toBe(fresh);
      fs.mkdirSync(pathMod.join(tmp, "data"));
      fs.writeFileSync(legacy, "");
      expect(resolveDbFile(tmp)).toBe(legacy);
      fs.writeFileSync(fresh, "");
      expect(resolveDbFile(tmp)).toBe(fresh);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("getDB on a fresh checkout", () => {
  it("creates the gitignored data/ directory before opening SQLite", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const pathMod = await import("path");
    const tmp = fs.mkdtempSync(pathMod.join(os.tmpdir(), "cj-db-"));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    try {
      vi.resetModules();
      const { getDB } = await import("@/lib/db");
      const db = getDB();
      expect(fs.existsSync(pathMod.join(tmp, "data", "adrift.db"))).toBe(true);
      db.close();
    } finally {
      cwd.mockRestore();
      vi.resetModules();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

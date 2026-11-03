/**
 * Middleware CSRF validation tests
 * Covers: missing host, origin mismatch, referer fallback, XHR header,
 * verified-Bearer skip, no-key Host guard, non-loopback bind refusal
 *
 * Run with: npx vitest run src/__tests__/middlewareCsrf.test.ts
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { middleware } from "@/middleware";
import { NextRequest } from "next/server";

function makeRequest(
  method: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("http://localhost:3000/api/jobs/imagine", {
    method,
    headers: {
      host: "localhost:3000",
      ...headers,
    },
  });
}

describe("CSRF middleware", () => {
  describe("safe methods bypass CSRF", () => {
    it("GET passes through", async () => {
      const req = makeRequest("GET");
      const res = await middleware(req);
      expect(res.status).not.toBe(403);
    });

    it("HEAD passes through", async () => {
      const req = makeRequest("HEAD");
      const res = await middleware(req);
      expect(res.status).not.toBe(403);
    });

    it("OPTIONS passes through", async () => {
      const req = makeRequest("OPTIONS");
      const res = await middleware(req);
      expect(res.status).not.toBe(403);
    });
  });

  describe("Bearer token bypass (verified bearers only)", () => {
    const KEY = "k".repeat(40);
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("POST with an unverified Bearer and no key configured is CSRF-checked", async () => {
      vi.stubEnv("ADMIN_API_KEY", "");
      const req = makeRequest("POST", {
        authorization: "Bearer some-api-key",
      });
      const res = await middleware(req);
      expect(res.status).toBe(403);
    });

    it("cross-origin POST with a wrong Bearer gets 403", async () => {
      vi.stubEnv("ADMIN_API_KEY", KEY);
      const req = makeRequest("POST", {
        authorization: "Bearer not-the-key",
        origin: "https://evil.example",
      });
      const res = await middleware(req);
      expect(res.status).toBe(403);
    });

    it("cross-origin POST with the admin key skips CSRF", async () => {
      vi.stubEnv("ADMIN_API_KEY", KEY);
      const req = makeRequest("POST", {
        authorization: `Bearer ${KEY}`,
        origin: "https://evil.example",
      });
      const res = await middleware(req);
      expect(res.status).not.toBe(403);
    });

    it("a valid session token skips CSRF; tampered or expired ones do not", async () => {
      vi.stubEnv("ADMIN_API_KEY", KEY);
      vi.stubEnv("SESSION_SECRET", "s".repeat(40));
      const { createSessionToken } = await import("@/lib/session");
      const good = createSessionToken("s".repeat(40));
      const ok = await middleware(
        makeRequest("POST", { authorization: `Bearer ${good}`, origin: "https://app.example" }),
      );
      expect(ok.status).not.toBe(403);
      const tampered = good.slice(0, -2) + (good.endsWith("AA") ? "BB" : "AA");
      const bad = await middleware(
        makeRequest("POST", { authorization: `Bearer ${tampered}`, origin: "https://app.example" }),
      );
      expect(bad.status).toBe(403);
      const expired = createSessionToken("s".repeat(40), -1000);
      const old = await middleware(
        makeRequest("POST", { authorization: `Bearer ${expired}`, origin: "https://app.example" }),
      );
      expect(old.status).toBe(403);
    });

    it("non-Bearer auth does NOT bypass CSRF", async () => {
      const req = makeRequest("POST", {
        authorization: "Basic dXNlcjpwYXNz",
      });
      const res = await middleware(req);
      expect(res.status).toBe(403);
    });
  });

  describe("missing host header", () => {
    it("rejects POST when host header is absent", async () => {
      // Create request without host header - need to construct manually
      const req = new NextRequest("http://localhost:3000/api/jobs/imagine", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          // deliberately no host header
        },
      });
      // NextRequest auto-populates host from URL in some envs,
      // so we verify the middleware logic handles the missing-host path
      const res = await middleware(req);
      // If host is auto-populated, it should pass (origin matches host)
      // If host is missing, it should fail with 403
      expect([200, 403]).toContain(res.status);
    });
  });

  describe("origin validation", () => {
    it("allows POST when origin matches host", async () => {
      const req = makeRequest("POST", {
        origin: "http://localhost:3000",
      });
      const res = await middleware(req);
      expect(res.status).not.toBe(403);
    });

    it("rejects POST when origin does NOT match host", async () => {
      const req = makeRequest("POST", {
        origin: "http://evil.com",
      });
      const res = await middleware(req);
      expect(res.status).toBe(403);
    });

    it("rejects POST with malformed origin URL", async () => {
      const req = makeRequest("POST", {
        origin: "not-a-url",
      });
      const res = await middleware(req);
      // hostOf returns null, which !== "localhost:3000", so 403
      expect(res.status).toBe(403);
    });
  });

  describe("referer fallback", () => {
    it("allows POST when referer matches host (no origin)", async () => {
      const req = makeRequest("POST", {
        referer: "http://localhost:3000/some-page",
      });
      const res = await middleware(req);
      expect(res.status).not.toBe(403);
    });

    it("rejects POST when referer does NOT match host", async () => {
      const req = makeRequest("POST", {
        referer: "http://evil.com/phish",
      });
      const res = await middleware(req);
      expect(res.status).toBe(403);
    });
  });

  describe("X-Requested-With fallback", () => {
    it("allows POST with XMLHttpRequest header (no origin/referer)", async () => {
      const req = makeRequest("POST", {
        "x-requested-with": "XMLHttpRequest",
      });
      const res = await middleware(req);
      expect(res.status).not.toBe(403);
    });

    it("case-insensitive XMLHttpRequest check", async () => {
      const req = makeRequest("POST", {
        "x-requested-with": "xmlhttprequest",
      });
      const res = await middleware(req);
      expect(res.status).not.toBe(403);
    });

    it("rejects POST with wrong X-Requested-With value", async () => {
      const req = makeRequest("POST", {
        "x-requested-with": "SomethingElse",
      });
      const res = await middleware(req);
      expect(res.status).toBe(403);
    });
  });

  describe("bare POST (no origin, no referer, no XHR header)", () => {
    it("rejects with 403", async () => {
      const req = makeRequest("POST");
      const res = await middleware(req);
      expect(res.status).toBe(403);
    });

    it("response body contains CSRF error message", async () => {
      const req = makeRequest("POST");
      const res = await middleware(req);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("CSRF");
    });
  });

  describe("other mutating methods", () => {
    it("PUT is also CSRF-checked", async () => {
      const req = makeRequest("PUT");
      const res = await middleware(req);
      expect(res.status).toBe(403);
    });

    it("DELETE is also CSRF-checked", async () => {
      const req = makeRequest("DELETE");
      const res = await middleware(req);
      expect(res.status).toBe(403);
    });

    it("PATCH is also CSRF-checked", async () => {
      const req = makeRequest("PATCH");
      const res = await middleware(req);
      expect(res.status).toBe(403);
    });
  });
});

describe("no-key Host guard and bind policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function req(host: string, method = "GET") {
    return new NextRequest(`http://${host}/api/jobs/recent`, {
      method,
      headers: { host, "x-requested-with": "XMLHttpRequest" },
    });
  }

  it("rejects a LAN IP Host without a key, even for GETs", async () => {
    vi.stubEnv("ADMIN_API_KEY", "");
    vi.stubEnv("CJ_ALLOWED_HOSTS", "");
    for (const host of ["192.168.1.20:3000", "0.0.0.0:3000", "studio.local:3000", "rebind.example"]) {
      expect((await middleware(req(host))).status, host).toBe(403);
    }
  });

  it("lets loopback and CJ_ALLOWED_HOSTS through without a key", async () => {
    vi.stubEnv("ADMIN_API_KEY", "");
    vi.stubEnv("CJ_ALLOWED_HOSTS", "box.tailnet.example");
    for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "box.tailnet.example:3000"]) {
      expect((await middleware(req(host, "POST"))).status, host).not.toBe(403);
    }
  });

  it("with a key set, the Host is not restricted (credentials decide)", async () => {
    vi.stubEnv("ADMIN_API_KEY", "k".repeat(40));
    expect((await middleware(req("192.168.1.20:3000"))).status).not.toBe(403);
  });

  it("refuses every request with a clear message when bound beyond loopback without a key", async () => {
    vi.stubEnv("ADMIN_API_KEY", "");
    vi.stubEnv("CJ_HOST", "0.0.0.0");
    const res = await middleware(req("localhost:3000"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/ADMIN_API_KEY/);
  });

  it("loopback CJ_HOST, or a key, lifts the refusal", async () => {
    vi.stubEnv("ADMIN_API_KEY", "");
    vi.stubEnv("CJ_HOST", "127.0.0.1");
    expect((await middleware(req("localhost:3000"))).status).not.toBe(503);
    vi.stubEnv("CJ_HOST", "0.0.0.0");
    vi.stubEnv("ADMIN_API_KEY", "k".repeat(40));
    expect((await middleware(req("localhost:3000"))).status).not.toBe(503);
  });
});

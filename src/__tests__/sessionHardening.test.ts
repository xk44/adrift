/**
 * B11 remainder: absolute session lifetime cap, session generation
 * (sign out everywhere), and login failing closed without a secret.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const SECRET = "test-session-secret-for-hardening";
const DAY = 24 * 60 * 60 * 1000;
let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cj-session-"));
  vi.stubEnv("ADRIFT_RUNTIME_SETTINGS_FILE", path.join(dir, "rt.json"));
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/rateLimit");
  fs.rmSync(dir, { recursive: true, force: true });
});

function payloadOf(token: string) {
  return JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
  );
}

describe("absolute lifetime cap", () => {
  it("refresh keeps the original sign-in time and never passes 30 days", async () => {
    const s = await import("@/lib/session");
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    let token = s.createSessionToken(SECRET, 7 * DAY);
    expect(payloadOf(token).auth).toBe(t0);

    // Refresh near the end of each 7-day token, over and over.
    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(payloadOf(token).exp - 60_000);
      const next = s.refreshSessionToken(token, SECRET, 7 * DAY);
      if (!next) break;
      expect(payloadOf(next).auth).toBe(t0);
      expect(payloadOf(next).exp).toBeLessThanOrEqual(
        t0 + s.MAX_SESSION_LIFETIME_MS,
      );
      token = next;
    }
    vi.setSystemTime(t0 + s.MAX_SESSION_LIFETIME_MS + 1);
    expect(s.verifySessionToken(token, SECRET).valid).toBe(false);
  });

  it("rejects a token whose auth time is older than the cap even if exp is later", async () => {
    const s = await import("@/lib/session");
    const now = Date.now();
    const token = s.createSessionToken(SECRET, 7 * DAY, {
      authAt: now - s.MAX_SESSION_LIFETIME_MS - 1000,
    });
    // exp is clamped to the cap, so it is already in the past.
    expect(s.verifySessionToken(token, SECRET).valid).toBe(false);
  });

  it("edge cap constant matches the node one", async () => {
    const s = await import("@/lib/session");
    const e = await import("@/lib/net/edgeAuth");
    expect(e.EDGE_MAX_SESSION_LIFETIME_MS).toBe(s.MAX_SESSION_LIFETIME_MS);
  });
});

describe("session generation (sign out everywhere)", () => {
  it("bumping the generation voids earlier tokens for node checks", async () => {
    vi.stubEnv("ADMIN_API_KEY", "k".repeat(40));
    vi.stubEnv("SESSION_SECRET", SECRET);
    const s = await import("@/lib/session");
    const rt = await import("@/lib/runtimeSettings");
    const old = s.createSessionToken(SECRET, DAY);
    expect(payloadOf(old).gen).toBe(0);
    expect(s.verifySessionToken(old, SECRET).valid).toBe(true);

    expect(rt.bumpSessionGeneration()).toBe(1);
    const res = s.verifySessionToken(old, SECRET);
    expect(res).toEqual({ valid: false, error: "Invalid signature" });

    const fresh = s.createSessionToken(SECRET, DAY);
    expect(payloadOf(fresh).gen).toBe(1);
    expect(s.verifySessionToken(fresh, SECRET).valid).toBe(true);
  });

  it("generation 1 key is derived, not the raw secret", async () => {
    const s = await import("@/lib/session");
    expect(s.sessionSigningKey(SECRET, 0)).toBe(SECRET);
    expect(s.sessionSigningKey(SECRET, 1)).not.toBe(SECRET);
    expect(s.sessionSigningKey(SECRET, 1)).not.toBe(
      s.sessionSigningKey(SECRET, 2),
    );
    // A gen-1 token re-labelled as gen 0 fails (signature covers the payload).
    const t = s.createSessionToken(SECRET, DAY, { generation: 1 });
    expect(s.verifySessionToken(t, SECRET, { generation: 0 }).valid).toBe(
      false,
    );
  });

  it("edge accepts tokens of any generation it can verify (CSRF skip only)", async () => {
    vi.stubEnv("ADMIN_API_KEY", "k".repeat(40));
    vi.stubEnv("SESSION_SECRET", SECRET);
    const s = await import("@/lib/session");
    const { isVerifiedBearer } = await import("@/lib/net/edgeAuth");
    expect(
      await isVerifiedBearer(
        s.createSessionToken(SECRET, DAY, { generation: 0 }),
      ),
    ).toBe(true);
    expect(
      await isVerifiedBearer(
        s.createSessionToken(SECRET, DAY, { generation: 7 }),
      ),
    ).toBe(true);
    expect(
      await isVerifiedBearer(
        s.createSessionToken("other", DAY, { generation: 7 }),
      ),
    ).toBe(false);
    // Over the absolute cap.
    const old = s.createSessionToken(SECRET, DAY, {
      authAt: Date.now() - 31 * DAY,
    });
    expect(await isVerifiedBearer(old)).toBe(false);
  });

  it("logout?all=1 needs admin, bumps the generation and clears the cookie", async () => {
    const KEY = "k".repeat(40);
    vi.stubEnv("ADMIN_API_KEY", KEY);
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.doMock("@/lib/rateLimit", () => ({
      withRateLimit: () => ({ ok: true }),
    }));
    const { POST } = await import("@/app/api/auth/logout/route");
    const rt = await import("@/lib/runtimeSettings");
    const s = await import("@/lib/session");
    const { requireAdmin } = await import("@/lib/auth");
    const token = s.createSessionToken(SECRET, DAY);

    const denied = await POST(
      new NextRequest("http://localhost/api/auth/logout?all=1", {
        method: "POST",
      }),
    );
    expect(denied.status).toBe(401);
    expect(rt.readSessionGeneration()).toBe(0);

    const ok = await POST(
      new NextRequest("http://localhost/api/auth/logout?all=1", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
    expect(rt.readSessionGeneration()).toBe(1);
    const after = requireAdmin(
      new NextRequest("http://localhost/api/x", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(after.ok).toBe(false);
  });

  it("sanitize drops a bad generation", async () => {
    const rt = await import("@/lib/runtimeSettings");
    expect(
      rt.sanitizeRuntimeSettings({ sessionGeneration: -1 }).sessionGeneration,
    ).toBeUndefined();
    expect(
      rt.sanitizeRuntimeSettings({ sessionGeneration: 1.5 }).sessionGeneration,
    ).toBeUndefined();
    expect(
      rt.sanitizeRuntimeSettings({ sessionGeneration: "3" }).sessionGeneration,
    ).toBeUndefined();
    expect(
      rt.sanitizeRuntimeSettings({ sessionGeneration: 3 }).sessionGeneration,
    ).toBe(3);
  });
});

describe("POST /api/auth/login without a key", () => {
  async function login() {
    vi.doMock("@/lib/rateLimit", () => ({
      withRateLimit: () => ({ ok: true }),
    }));
    const { POST } = await import("@/app/api/auth/login/route");
    return POST(
      new NextRequest("http://localhost/api/auth/login", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
  }

  it("fails closed with a clear error when no secret is set (no dev-secret token)", async () => {
    vi.stubEnv("ADMIN_API_KEY", "");
    vi.stubEnv("SESSION_SECRET", "");
    const res = await login();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.token).toBeUndefined();
    expect(body.error).toMatch(/ADMIN_API_KEY/);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("signs with SESSION_SECRET when one is set", async () => {
    vi.stubEnv("ADMIN_API_KEY", "");
    vi.stubEnv("SESSION_SECRET", SECRET);
    const res = await login();
    expect(res.status).toBe(200);
    const { token } = await res.json();
    const s = await import("@/lib/session");
    expect(s.verifySessionToken(token, SECRET).valid).toBe(true);
    expect(s.verifySessionToken(token, "dev-secret").valid).toBe(false);
  });
});

describe("POST /api/auth/login body cap", () => {
  async function loginWith(body: BodyInit, headers?: HeadersInit) {
    vi.doMock("@/lib/rateLimit", () => ({
      withRateLimit: () => ({ ok: true }),
    }));
    const { POST } = await import("@/app/api/auth/login/route");
    return POST(
      new NextRequest("http://localhost/api/auth/login", {
        method: "POST",
        body,
        headers,
        // a stream body needs half-duplex in Node's fetch Request
        ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
      } as ConstructorParameters<typeof NextRequest>[1]),
    );
  }

  it("rejects an oversized body with 413 before checking the key", async () => {
    vi.stubEnv("ADMIN_API_KEY", "k".repeat(32));
    const res = await loginWith(
      JSON.stringify({ api_key: "x".repeat(8 * 1024) }),
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rejects an oversized chunked body (no Content-Length) with 413", async () => {
    vi.stubEnv("ADMIN_API_KEY", "k".repeat(32));
    const chunk = new TextEncoder().encode("x".repeat(1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ < 8) c.enqueue(chunk);
        else c.close();
      },
    });
    const res = await loginWith(stream);
    expect(res.status).toBe(413);
  });

  it("still accepts a normal-sized login", async () => {
    const key = "k".repeat(32);
    vi.stubEnv("ADMIN_API_KEY", key);
    vi.stubEnv("SESSION_SECRET", SECRET);
    const res = await loginWith(JSON.stringify({ api_key: key }));
    expect(res.status).toBe(200);
    const bad = await loginWith("{not json");
    expect(bad.status).toBe(400);
  });
});

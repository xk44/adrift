/**
 * Session Tests
 * =============
 * JWT-like HMAC-SHA256 session tokens: create, verify, refresh, expiry, tamper resistance.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createSessionToken,
  verifySessionToken,
  refreshSessionToken,
  resolveSessionSecret,
} from "@/lib/session";

const SECRET = "test-session-secret-256bit-key!!";

describe("createSessionToken", () => {
  it("produces a 3-part dot-separated token", () => {
    const token = createSessionToken(SECRET);
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
  });

  it("contains valid base64url parts", () => {
    const token = createSessionToken(SECRET);
    const parts = token.split(".");
    for (const part of parts) {
      expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("embeds sub=admin in payload", () => {
    const token = createSessionToken(SECRET);
    const payloadB64 = token.split(".")[1];
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    );
    expect(payload.sub).toBe("admin");
    expect(payload.iat).toBeTypeOf("number");
    expect(payload.exp).toBeTypeOf("number");
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it("respects custom TTL", () => {
    const ttl = 60_000; // 1 minute
    const token = createSessionToken(SECRET, ttl);
    const payloadB64 = token.split(".")[1];
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    );
    expect(payload.exp - payload.iat).toBe(ttl);
  });
});

describe("verifySessionToken", () => {
  it("verifies a valid token", () => {
    const token = createSessionToken(SECRET);
    const result = verifySessionToken(token, SECRET);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.sub).toBe("admin");
    }
  });

  it("rejects token with wrong secret", () => {
    const token = createSessionToken(SECRET);
    const result = verifySessionToken(token, "wrong-secret-value!!!!!");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe("Invalid signature");
    }
  });

  it("rejects malformed token (2 parts)", () => {
    const result = verifySessionToken("abc.def", SECRET);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe("Malformed token");
    }
  });

  it("rejects malformed token (4 parts)", () => {
    const result = verifySessionToken("a.b.c.d", SECRET);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe("Malformed token");
    }
  });

  it("rejects empty string", () => {
    const result = verifySessionToken("", SECRET);
    expect(result.valid).toBe(false);
  });

  it("rejects tampered payload", () => {
    const token = createSessionToken(SECRET);
    const parts = token.split(".");
    // Modify the payload
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    payload.sub = "hacker";
    parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const tampered = parts.join(".");
    const result = verifySessionToken(tampered, SECRET);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe("Invalid signature");
    }
  });

  it("rejects tampered signature", () => {
    const token = createSessionToken(SECRET);
    const parts = token.split(".");
    parts[2] = "AAAA" + parts[2].slice(4);
    const result = verifySessionToken(parts.join("."), SECRET);
    expect(result.valid).toBe(false);
  });

  it("rejects expired token", () => {
    // TTL=0 means exp===iat, but Date.now() > exp uses strict >, so advance time
    const token = createSessionToken(SECRET, 1);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10);
    const result = verifySessionToken(token, SECRET);
    vi.useRealTimers();
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe("Token expired");
    }
  });

  it("rejects token with negative TTL (already expired)", () => {
    const token = createSessionToken(SECRET, -1000);
    const result = verifySessionToken(token, SECRET);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe("Token expired");
    }
  });
});

describe("refreshSessionToken", () => {
  it("returns null for invalid token", () => {
    expect(refreshSessionToken("garbage.token.here", SECRET)).toBeNull();
  });

  it("returns null when token has plenty of time left", () => {
    const token = createSessionToken(SECRET, 24 * 60 * 60 * 1000);
    // Fresh token has ~100% TTL remaining, way above 25% threshold
    expect(refreshSessionToken(token, SECRET)).toBeNull();
  });

  it("refreshes token in the refresh window (<25% TTL remaining)", () => {
    // Create a token with short TTL and fake the clock so it's near expiry
    const ttl = 10_000; // 10 seconds
    const token = createSessionToken(SECRET, ttl);

    // Advance time to 80% through the TTL (only 20% remaining < 25% threshold)
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + ttl * 0.8);

    const refreshed = refreshSessionToken(token, SECRET, ttl);
    expect(refreshed).not.toBeNull();
    expect(refreshed).not.toBe(token);

    // New token should be valid
    const result = verifySessionToken(refreshed!, SECRET);
    expect(result.valid).toBe(true);

    vi.useRealTimers();
  });

  it("returns null for expired token", () => {
    const ttl = 1000;
    const token = createSessionToken(SECRET, ttl);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + ttl + 1);
    expect(refreshSessionToken(token, SECRET)).toBeNull();
    vi.useRealTimers();
  });
});

describe("resolveSessionSecret", () => {
  const origSession = process.env.SESSION_SECRET;
  const origAdmin = process.env.ADMIN_API_KEY;

  afterEach(() => {
    if (origSession !== undefined) process.env.SESSION_SECRET = origSession;
    else delete process.env.SESSION_SECRET;
    if (origAdmin !== undefined) process.env.ADMIN_API_KEY = origAdmin;
    else delete process.env.ADMIN_API_KEY;
  });

  it("prefers SESSION_SECRET over ADMIN_API_KEY", () => {
    process.env.SESSION_SECRET = "session-val";
    process.env.ADMIN_API_KEY = "admin-val";
    expect(resolveSessionSecret()).toBe("session-val");
  });

  it("falls back to ADMIN_API_KEY", () => {
    delete process.env.SESSION_SECRET;
    process.env.ADMIN_API_KEY = "admin-val";
    expect(resolveSessionSecret()).toBe("admin-val");
  });

  it("returns empty string when nothing is set", () => {
    delete process.env.SESSION_SECRET;
    delete process.env.ADMIN_API_KEY;
    expect(resolveSessionSecret()).toBe("");
  });

  it("trims whitespace", () => {
    process.env.SESSION_SECRET = "  trimmed  ";
    expect(resolveSessionSecret()).toBe("trimmed");
  });
});

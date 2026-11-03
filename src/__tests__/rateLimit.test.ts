/**
 * Rate Limit Tests
 * ================
 * Tests for the in-memory rate limiter in src/lib/rateLimit.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import { rateLimit, resetRateLimits } from "@/lib/rateLimit";

beforeEach(() => {
  resetRateLimits();
});

describe("rateLimit", () => {
  it("allows first request", () => {
    const result = rateLimit("user1", { windowMs: 60000, max: 5 });
    expect(result.ok).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("decrements remaining on each call", () => {
    rateLimit("user1", { windowMs: 60000, max: 5 });
    const r2 = rateLimit("user1", { windowMs: 60000, max: 5 });
    expect(r2.remaining).toBe(3);
    const r3 = rateLimit("user1", { windowMs: 60000, max: 5 });
    expect(r3.remaining).toBe(2);
  });

  it("blocks after max requests", () => {
    const opts = { windowMs: 60000, max: 3 };
    rateLimit("user1", opts);
    rateLimit("user1", opts);
    rateLimit("user1", opts);
    const blocked = rateLimit("user1", opts);
    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("tracks different identifiers independently", () => {
    const opts = { windowMs: 60000, max: 2 };
    rateLimit("user1", opts);
    rateLimit("user1", opts);
    // user1 exhausted
    expect(rateLimit("user1", opts).ok).toBe(false);
    // user2 should still be allowed
    expect(rateLimit("user2", opts).ok).toBe(true);
  });

  it("resets after window expires", () => {
    const opts = { windowMs: 1, max: 1 }; // 1ms window
    rateLimit("user1", opts);
    // Wait for window to expire
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy wait a few ms
    }
    const result = rateLimit("user1", opts);
    expect(result.ok).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it("resetRateLimits clears all state", () => {
    const opts = { windowMs: 60000, max: 1 };
    rateLimit("user1", opts);
    expect(rateLimit("user1", opts).ok).toBe(false);
    resetRateLimits();
    expect(rateLimit("user1", opts).ok).toBe(true);
  });

  it("max of 1 blocks on second request", () => {
    const opts = { windowMs: 60000, max: 1 };
    const r1 = rateLimit("x", opts);
    expect(r1.ok).toBe(true);
    expect(r1.remaining).toBe(0);
    expect(rateLimit("x", opts).ok).toBe(false);
  });
});

describe("clientIdentity (X-Forwarded-For only behind TRUST_PROXY)", () => {
  async function load() {
    const { NextRequest } = await import("next/server");
    const { clientIdentity } = await import("@/lib/rateLimit");
    const req = (h: Record<string, string>) =>
      new NextRequest("http://localhost:3000/api/x", { headers: h });
    return { clientIdentity, req };
  }

  it("ignores spoofable headers when TRUST_PROXY is unset", async () => {
    const prev = process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY;
    try {
      const { clientIdentity, req } = await load();
      expect(clientIdentity(req({ "x-forwarded-for": "9.9.9.9" }))).toBe("direct");
      expect(clientIdentity(req({ "x-real-ip": "8.8.8.8" }))).toBe("direct");
      expect(clientIdentity(req({}))).toBe("direct");
    } finally {
      if (prev !== undefined) process.env.TRUST_PROXY = prev;
    }
  });

  it("uses the last hop (what the trusted proxy saw) when TRUST_PROXY=1", async () => {
    const prev = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = "1";
    try {
      const { clientIdentity, req } = await load();
      expect(
        clientIdentity(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" })),
      ).toBe("203.0.113.9");
      expect(clientIdentity(req({ "x-real-ip": "203.0.113.4" }))).toBe("203.0.113.4");
    } finally {
      if (prev === undefined) delete process.env.TRUST_PROXY;
      else process.env.TRUST_PROXY = prev;
    }
  });
});

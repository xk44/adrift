/**
 * B10: an unauthenticated flood must not lock the owner out — failed-auth
 * callers are counted in their own buckets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const KEY = "k".repeat(40);

async function load() {
  vi.resetModules();
  vi.doMock("@/lib/env", () => ({
    env: { ADMIN_API_KEY: KEY, NODE_ENV: "test" },
  }));
  return import("@/lib/rateLimit");
}

function req(auth?: string) {
  return new NextRequest("http://localhost:3000/api/jobs/imagine", {
    method: "POST",
    headers: { host: "localhost:3000", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
  });
}

beforeEach(() => {
  vi.stubEnv("TRUST_PROXY", "");
  vi.stubEnv("ADMIN_API_KEY", KEY);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/env");
});

describe("withRateLimit auth buckets", () => {
  it("keeps the owner's budget when unauthenticated callers exhaust theirs", async () => {
    const { withRateLimit, resetRateLimits } = await load();
    resetRateLimits();
    const opts = { windowMs: 60_000, max: 3 };
    for (let i = 0; i < 3; i++) expect(withRateLimit(req("wrong"), opts).ok).toBe(true);
    expect(withRateLimit(req("wrong"), opts).ok).toBe(false);
    expect(withRateLimit(req(), opts).ok).toBe(false);
    // The owner still gets through.
    expect(withRateLimit(req(KEY), opts).ok).toBe(true);
  });

  it("still limits authenticated callers", async () => {
    const { withRateLimit, resetRateLimits } = await load();
    resetRateLimits();
    const opts = { windowMs: 60_000, max: 2 };
    expect(withRateLimit(req(KEY), opts).ok).toBe(true);
    expect(withRateLimit(req(KEY), opts).ok).toBe(true);
    expect(withRateLimit(req(KEY), opts).ok).toBe(false);
  });
});

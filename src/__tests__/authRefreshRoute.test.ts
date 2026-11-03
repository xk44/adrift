/** B11: /api/auth/refresh never signs with a fallback secret. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSessionToken } from "@/lib/session";

function post(token?: string) {
  return new NextRequest("http://localhost/api/auth/refresh", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function route() {
  vi.resetModules();
  vi.doMock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
  return (await import("@/app/api/auth/refresh/route")).POST;
}

describe("POST /api/auth/refresh", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.doUnmock("@/lib/rateLimit");
  });

  it("401 when no secret is configured, even for a dev-secret token", async () => {
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("ADMIN_API_KEY", "");
    const POST = await route();
    const forged = createSessionToken("dev-secret", 1000);
    const res = await POST(post(forged));
    expect(res.status).toBe(401);
    expect((await res.json()).token).toBeUndefined();
  });

  it("401 for a missing or invalid token", async () => {
    vi.stubEnv("SESSION_SECRET", "s3cret-for-tests");
    const POST = await route();
    expect((await POST(post())).status).toBe(401);
    expect((await POST(post(createSessionToken("other", 1000)))).status).toBe(401);
  });

  it("refreshes a valid token near expiry, not one early in its life", async () => {
    vi.stubEnv("SESSION_SECRET", "s3cret-for-tests");
    const POST = await route();
    const fresh = await (await POST(post(createSessionToken("s3cret-for-tests")))).json();
    expect(fresh).toMatchObject({ ok: true, refreshed: false });

    vi.useFakeTimers();
    const t0 = Date.now();
    const tok = createSessionToken("s3cret-for-tests", 1000);
    vi.setSystemTime(t0 + 900);
    const body = await (await POST(post(tok))).json();
    expect(body.refreshed).toBe(true);
    expect(typeof body.token).toBe("string");
  });
});

/**
 * #33: the style-preview self-POST to /api/jobs/imagine must pass the
 * middleware in no-key mode (it used to send no Origin/Referer/XRW → 403).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { selfBaseUrl, selfRequestHeaders } from "@/lib/net/selfUrl";
import { middleware } from "@/middleware";

afterEach(() => {
  vi.unstubAllEnvs();
});

function selfPost() {
  const url = new URL(`${selfBaseUrl()}/api/jobs/imagine`);
  // A server-side fetch sends Host from the URL and no Origin/Referer.
  return new NextRequest(url, {
    method: "POST",
    headers: { ...selfRequestHeaders(), host: url.host },
    body: "{}",
  });
}

describe("selfBaseUrl", () => {
  it("uses 127.0.0.1 for default and wildcard binds", () => {
    vi.stubEnv("PORT", "3132");
    vi.stubEnv("CJ_HOST", "");
    expect(selfBaseUrl()).toBe("http://127.0.0.1:3132");
    vi.stubEnv("CJ_HOST", "0.0.0.0");
    expect(selfBaseUrl()).toBe("http://127.0.0.1:3132");
    vi.stubEnv("CJ_HOST", "::");
    expect(selfBaseUrl()).toBe("http://127.0.0.1:3132");
  });

  it("uses 127.0.0.1 under standalone server.js (wildcard HOSTNAME), whatever CJ_HOST says", () => {
    vi.stubEnv("PORT", "3000");
    vi.stubEnv("HOSTNAME", "0.0.0.0");
    vi.stubEnv("CJ_HOST", "10.0.0.5");
    expect(selfBaseUrl()).toBe("http://127.0.0.1:3000");
  });

  it("uses a specific CJ_HOST interface, bracketing IPv6", () => {
    vi.stubEnv("PORT", "3000");
    vi.stubEnv("HOSTNAME", "");
    vi.stubEnv("CJ_HOST", "192.168.1.20");
    expect(selfBaseUrl()).toBe("http://192.168.1.20:3000");
    vi.stubEnv("CJ_HOST", "::1");
    expect(selfBaseUrl()).toBe("http://[::1]:3000");
  });
});

describe("style-preview self-POST passes the middleware", () => {
  it("in no-key mode (X-Requested-With, loopback Host)", async () => {
    vi.stubEnv("ADMIN_API_KEY", "");
    vi.stubEnv("CJ_HOST", "");
    const headers = selfRequestHeaders();
    expect(headers.Authorization).toBeUndefined();
    expect((await middleware(selfPost())).status).not.toBe(403);
  });

  it("with a key (verified bearer), even on a LAN bind", async () => {
    vi.stubEnv("ADMIN_API_KEY", "k".repeat(40));
    vi.stubEnv("CJ_HOST", "192.168.1.20");
    const res = await middleware(selfPost());
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(503);
  });
});

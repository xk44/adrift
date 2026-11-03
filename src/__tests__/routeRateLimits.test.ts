/**
 * #32: rate limits on moodboards/*, describe, nevo/* and h3-warm, plus
 * h3-warm's loopback-only rule. Buckets are pre-filled through the same
 * withRateLimit key the route uses, so the handler must answer 429 before
 * running any of its body (no disk writes, no backend calls, no GPU).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/comfy/warmBackend", () => ({
  warmStatus: vi.fn(async () => ({ enabled: false, starting: false, url: "" })),
  startWarm: vi.fn(async () => ({ enabled: true, starting: true, url: "" })),
  stopWarm: vi.fn(async () => ({ enabled: false, starting: false, url: "" })),
}));

import { resetRateLimits, withRateLimit } from "@/lib/rateLimit";
import { startWarm, stopWarm, warmStatus } from "@/lib/comfy/warmBackend";

type Handler = (req: NextRequest, ctx?: unknown) => Promise<Response> | Response;

const ctx = { params: Promise.resolve({ id: "board-1", job: "job-1" }) };

function req(path: string, method: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: {
      host: "localhost:3000",
      "x-forwarded-for": "127.0.0.1",
      "content-type": "application/json",
      ...headers,
    },
    ...(method === "GET" ? {} : { body: "{}" }),
  });
}

const CASES: [string, string, string, number, () => Promise<unknown>][] = [
  ["/api/moodboards", "GET", "GET", 120, () => import("@/app/api/moodboards/route")],
  ["/api/moodboards", "POST", "POST", 60, () => import("@/app/api/moodboards/route")],
  ["/api/moodboards", "PUT", "PUT", 60, () => import("@/app/api/moodboards/route")],
  ["/api/moodboards", "DELETE", "DELETE", 60, () => import("@/app/api/moodboards/route")],
  ["/api/moodboards/bulk", "POST", "POST", 30, () => import("@/app/api/moodboards/bulk/route")],
  ["/api/moodboards/import-sv", "POST", "POST", 10, () => import("@/app/api/moodboards/import-sv/route")],
  ["/api/moodboards/autosort", "POST", "POST", 10, () => import("@/app/api/moodboards/autosort/route")],
  ["/api/moodboards/krea", "GET", "GET", 600, () => import("@/app/api/moodboards/krea/route")],
  ["/api/moodboards/upload", "GET", "GET", 600, () => import("@/app/api/moodboards/upload/route")],
  ["/api/moodboards/upload", "POST", "POST", 30, () => import("@/app/api/moodboards/upload/route")],
  ["/api/moodboards/board-1/caption", "POST", "POST", 10, () => import("@/app/api/moodboards/[id]/caption/route")],
  ["/api/moodboards/board-1/train", "GET", "GET", 120, () => import("@/app/api/moodboards/[id]/train/route")],
  ["/api/moodboards/board-1/train", "POST", "POST", 5, () => import("@/app/api/moodboards/[id]/train/route")],
  ["/api/describe", "POST", "POST", 20, () => import("@/app/api/describe/route")],
  ["/api/nevo/options", "GET", "GET", 60, () => import("@/app/api/nevo/options/route")],
  ["/api/nevo/search", "POST", "POST", 20, () => import("@/app/api/nevo/search/route")],
  ["/api/nevo/cancel/job-1", "POST", "POST", 30, () => import("@/app/api/nevo/cancel/[job]/route")],
  ["/api/h3-warm", "GET", "GET", 60, () => import("@/app/api/h3-warm/route")],
];

beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
});

describe("route rate limits", () => {
  it.each(CASES)("%s %s → 429 after %#", async (path, method, exportName, max, load) => {
    const mod = (await load()) as Record<string, Handler>;
    for (let i = 0; i < max; i++) {
      expect(withRateLimit(req(path, method), { windowMs: 60_000, max }).ok).toBe(true);
    }
    const res = await mod[exportName](req(path, method), ctx);
    expect(res.status, `${method} ${path} max=${max}`).toBe(429);
  });
});

describe("h3-warm", () => {
  it("refuses non-loopback callers before doing anything", async () => {
    const { GET, POST } = await import("@/app/api/h3-warm/route");
    const lanHost = req("/api/h3-warm", "POST", { host: "192.168.1.20:3000" });
    expect((await POST(lanHost)).status).toBe(403);
    const lanPeer = req("/api/h3-warm", "POST", { "x-forwarded-for": "192.168.1.30" });
    expect((await POST(lanPeer)).status).toBe(403);
    const proxied = req("/api/h3-warm", "GET", { "x-forwarded-for": "127.0.0.1, 10.0.0.9" });
    expect((await GET(proxied)).status).toBe(403);
    expect(startWarm).not.toHaveBeenCalled();
    expect(warmStatus).not.toHaveBeenCalled();
  });

  it("allows starting at most once a minute (backend mocked)", async () => {
    const { POST } = await import("@/app/api/h3-warm/route");
    const on = () =>
      new NextRequest("http://localhost:3000/api/h3-warm", {
        method: "POST",
        headers: { host: "localhost:3000", "x-forwarded-for": "::1" },
        body: JSON.stringify({ on: true }),
      });
    expect((await POST(on())).status).toBe(200);
    expect((await POST(on())).status).toBe(429);
    expect(startWarm).toHaveBeenCalledTimes(1);
    // Stopping is not blocked by the start limit.
    const off = new NextRequest("http://localhost:3000/api/h3-warm", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", "x-forwarded-for": "::ffff:127.0.0.1" },
      body: JSON.stringify({ on: false }),
    });
    expect((await POST(off)).status).toBe(200);
    expect(stopWarm).toHaveBeenCalledTimes(1);
  });
});

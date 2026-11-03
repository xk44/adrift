/**
 * useComfyWS's HTTP reachability probe must use the cheap, unthrottled
 * /api/health (one /system_stats call) and read its `comfyui` field.
 *
 * It used to poll /api/comfy/models: a full /object_info pull with three
 * server-side retries, rate-limited to 20/min. With ComfyUI down the WS
 * fallback polled it until it answered 429, so the status stayed
 * "unreachable" for up to a minute after ComfyUI came back (found by
 * scripts/mock-comfy/crawl.mjs with the backend offline).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(process.cwd(), "src/hooks/useComfyWS.ts"),
  "utf8",
);

function checkReachabilityBody(): string {
  const a = src.indexOf("const checkReachability");
  expect(a).toBeGreaterThanOrEqual(0);
  const b = src.indexOf("}, [setComfyReachable]);", a);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe("useComfyWS reachability probe", () => {
  it("probes /api/health, not the rate-limited model inventory", () => {
    const body = checkReachabilityBody();
    expect(body).toContain('fetch("/api/health"');
    expect(body).not.toContain('fetch("/api/comfy/models"');
  });

  it("treats only comfyui === 'connected' as reachable", () => {
    const body = checkReachabilityBody();
    expect(body).toMatch(/comfyui === "connected"/);
    // /api/health answers 200 even when ComfyUI is down: response.ok alone
    // must not count as reachable.
    expect(body).not.toMatch(/const reachable = response\.ok;/);
  });
});

describe("/api/health stays a cheap liveness probe", () => {
  const route = readFileSync(
    join(process.cwd(), "src/app/api/health/route.ts"),
    "utf8",
  );
  it("is not rate-limited and reports comfyui connected/disconnected", () => {
    expect(route).not.toContain("withRateLimit");
    expect(route).toContain('"connected"');
    expect(route).toContain('"disconnected"');
  });
});

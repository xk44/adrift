/**
 * API CORS header safety.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { apiCorsHeaders } from "@/lib/api";

function request(url: string, origin?: string): Request {
  return new Request(url, {
    headers: origin ? { origin } : {},
  });
}

describe("apiCorsHeaders", () => {
  it("does not emit wildcard allow-origin", () => {
    const headers = apiCorsHeaders(null, "GET, OPTIONS") as Record<string, string>;
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(Object.values(headers)).not.toContain("*");
  });

  it("reflects exact same-origin requests", () => {
    const headers = apiCorsHeaders(
      request("http://127.0.0.1:3000/api/test", "http://127.0.0.1:3000"),
    ) as Record<string, string>;
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://127.0.0.1:3000");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not trust other localhost ports", () => {
    vi.stubEnv("COMFY_HTTP_URL", "http://127.0.0.1:8188");
    for (const origin of ["http://localhost:8188", "http://127.0.0.1:5173", "http://localhost:3001"]) {
      const headers = apiCorsHeaders(
        request("http://127.0.0.1:3000/api/test", origin),
      ) as Record<string, string>;
      expect(headers["Access-Control-Allow-Origin"], origin).toBeUndefined();
    }
  });

  it("allows exactly the configured ComfyUI origin", () => {
    vi.stubEnv("COMFY_HTTP_URL", "http://localhost:8188");
    const headers = apiCorsHeaders(
      request("http://127.0.0.1:3000/api/test", "http://localhost:8188"),
    ) as Record<string, string>;
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:8188");
    const neighbour = apiCorsHeaders(
      request("http://127.0.0.1:3000/api/test", "http://localhost:8189"),
    ) as Record<string, string>;
    expect(neighbour["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("allows extra exact origins from CJ_COMFY_ORIGINS", () => {
    vi.stubEnv("COMFY_HTTP_URL", "http://127.0.0.1:8188");
    vi.stubEnv("CJ_COMFY_ORIGINS", "http://localhost:8188, http://gpu-box:8188");
    const headers = apiCorsHeaders(
      request("http://127.0.0.1:3000/api/test", "http://gpu-box:8188"),
    ) as Record<string, string>;
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://gpu-box:8188");
  });

  it("preflight from a foreign localhost port gets no allow-origin (OPTIONS route)", async () => {
    vi.stubEnv("COMFY_HTTP_URL", "http://127.0.0.1:8188");
    const { OPTIONS } = await import("@/app/api/jobs/imagine/route");
    const { NextRequest } = await import("next/server");
    const res = await OPTIONS(
      new NextRequest("http://127.0.0.1:3000/api/jobs/imagine", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:8188" },
      }),
    );
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects arbitrary cross-site origins", () => {
    const headers = apiCorsHeaders(
      request("http://127.0.0.1:3000/api/test", "https://evil.example"),
    ) as Record<string, string>;
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });
});

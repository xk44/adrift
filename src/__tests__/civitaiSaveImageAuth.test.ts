/**
 * Civitai save-image auth guard.
 */

import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/env", () => ({
  env: {
    ADMIN_API_KEY: "test-admin-key",
    COMFY_ROOT: "/tmp/adrift-test-root",
  },
}));

vi.mock("@/lib/rateLimit", () => ({
  withRateLimit: () => ({ ok: true }),
}));

function makeRequest(headers?: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost/api/civitai/save-image", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ url: "https://evil.example/image.png" }),
  });
}

describe("POST /api/civitai/save-image auth", () => {
  it("requires admin auth when ADMIN_API_KEY is configured", async () => {
    const { POST } = await import("@/app/api/civitai/save-image/route");

    const res = await POST(makeRequest());
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data).toMatchObject({ ok: false, error: "Unauthorized" });
  });

  it("continues to validate the URL after admin auth succeeds", async () => {
    const { POST } = await import("@/app/api/civitai/save-image/route");

    const res = await POST(
      makeRequest({ authorization: "Bearer test-admin-key" }),
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/Civitai image URL/i);
  });
});

/**
 * ComfyUI Manager missing-node install route auth/validation guard.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const queueComfyManagerInstall = vi.fn(async (packIds: string[], options?: { clientId?: string }) => ({
  queued: packIds,
  failed: [],
  comfyBaseUrl: "http://127.0.0.1:8188",
  clientId: options?.clientId,
}));

vi.mock("@/lib/env", () => ({
  env: {
    ADMIN_API_KEY: "test-admin-key",
    COMFY_HTTP_URL: "http://127.0.0.1:8188",
  },
}));

vi.mock("@/lib/rateLimit", () => ({
  withRateLimit: () => ({ ok: true }),
}));

vi.mock("@/lib/comfy/manager", () => ({
  queueComfyManagerInstall,
}));

function makeRequest(
  body: unknown,
  headers?: Record<string, string>,
): NextRequest {
  return new NextRequest("http://localhost/api/comfy/workflows/missing-nodes/install", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/comfy/workflows/missing-nodes/install", () => {
  beforeEach(() => {
    queueComfyManagerInstall.mockClear();
  });

  it("requires admin auth before queueing ComfyUI Manager installs", async () => {
    const { POST } = await import("@/app/api/comfy/workflows/missing-nodes/install/route");

    const res = await POST(makeRequest({ packIds: ["comfyui-kjnodes"] }));
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data).toMatchObject({ ok: false, error: "Unauthorized" });
    expect(queueComfyManagerInstall).not.toHaveBeenCalled();
  });

  it("validates packIds before queueing installs", async () => {
    const { POST } = await import("@/app/api/comfy/workflows/missing-nodes/install/route");

    const res = await POST(
      makeRequest(
        { packIds: ["../bad"], clientId: "client-a" },
        { authorization: "Bearer test-admin-key" },
      ),
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/Invalid node-pack ID/i);
    expect(queueComfyManagerInstall).not.toHaveBeenCalled();
  });

  it("deduplicates valid packIds and forwards a bounded clientId", async () => {
    const { POST } = await import("@/app/api/comfy/workflows/missing-nodes/install/route");

    const res = await POST(
      makeRequest(
        {
          packIds: [
            " comfyui-kjnodes ",
            "comfyui-kjnodes",
            "https://github.com/example/ComfyUI-TestNode",
          ],
          clientId: " workflow-page ",
        },
        { authorization: "Bearer test-admin-key" },
      ),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(queueComfyManagerInstall).toHaveBeenCalledWith(
      ["comfyui-kjnodes", "https://github.com/example/ComfyUI-TestNode"],
      { clientId: "workflow-page" },
    );
  });
});

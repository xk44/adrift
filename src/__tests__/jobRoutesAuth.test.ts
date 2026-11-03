/**
 * Job route auth hardening.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

function postRequest(path: string, token?: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({}),
  });
}

async function loadJobRoutes(adminApiKey: string) {
  vi.resetModules();
  vi.doMock("@/lib/env", () => ({
    env: {
      ADMIN_API_KEY: adminApiKey,
      COMFY_HTTP_URL: "http://127.0.0.1:8188",
      COMFY_ROOT: "/tmp/adrift-test-comfyui",
      COMFY_DEFAULT_CHECKPOINT: "",
      CIVITAI_API_URL: "https://civitai.com/api/v1",
      CIVITAI_API_KEY: "",
      CIVITAI_API_KEY_ENCRYPTED: "",
      SECRETS_PASSPHRASE: "",
      STYLEVAULT_API_URL: "http://127.0.0.1:8000",
      NODE_ENV: "test",
    },
  }));
  vi.doMock("@/lib/rateLimit", () => ({
    withRateLimit: () => ({ ok: true }),
  }));

  const [{ POST: imaginePost }, { POST: inpaintPost }, { POST: actionPost }] =
    await Promise.all([
      import("@/app/api/jobs/imagine/route"),
      import("@/app/api/jobs/inpaint/route"),
      import("@/app/api/jobs/action/route"),
    ]);

  return { imaginePost, inpaintPost, actionPost };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("job route admin auth", () => {
  it("rejects unauthenticated imagine/inpaint/action jobs when ADMIN_API_KEY is configured", async () => {
    const { imaginePost, inpaintPost, actionPost } = await loadJobRoutes("test-admin-key");

    const imagine = await imaginePost(postRequest("/api/jobs/imagine"));
    const inpaint = await inpaintPost(postRequest("/api/jobs/inpaint"));
    const action = await actionPost(postRequest("/api/jobs/action"));

    expect(imagine.status).toBe(401);
    expect(await imagine.json()).toMatchObject({ ok: false, error: "Unauthorized" });
    expect(inpaint.status).toBe(401);
    expect(await inpaint.json()).toMatchObject({ ok: false, error: "Unauthorized" });
    expect(action.status).toBe(401);
    expect(await action.json()).toMatchObject({ ok: false, error: "Unauthorized" });
  });

  it("rejects incorrect bearer tokens", async () => {
    const { imaginePost, inpaintPost, actionPost } = await loadJobRoutes("test-admin-key");

    const imagine = await imaginePost(postRequest("/api/jobs/imagine", "wrong-key"));
    const inpaint = await inpaintPost(postRequest("/api/jobs/inpaint", "wrong-key"));
    const action = await actionPost(postRequest("/api/jobs/action", "wrong-key"));

    expect(imagine.status).toBe(401);
    expect(await imagine.json()).toMatchObject({ ok: false, error: "Unauthorized" });
    expect(inpaint.status).toBe(401);
    expect(await inpaint.json()).toMatchObject({ ok: false, error: "Unauthorized" });
    expect(action.status).toBe(401);
    expect(await action.json()).toMatchObject({ ok: false, error: "Unauthorized" });
  });

  it("allows authenticated requests through to existing validation", async () => {
    const { imaginePost, inpaintPost, actionPost } = await loadJobRoutes("test-admin-key");

    const imagine = await imaginePost(postRequest("/api/jobs/imagine", "test-admin-key"));
    const inpaint = await inpaintPost(postRequest("/api/jobs/inpaint", "test-admin-key"));
    const action = await actionPost(postRequest("/api/jobs/action", "test-admin-key"));

    expect(imagine.status).toBe(400);
    expect(inpaint.status).toBe(400);
    expect(action.status).toBe(400);
  });

  it("preserves no-key local dev mode by falling through to existing validation", async () => {
    const { imaginePost, inpaintPost, actionPost } = await loadJobRoutes("");

    const imagine = await imaginePost(postRequest("/api/jobs/imagine"));
    const inpaint = await inpaintPost(postRequest("/api/jobs/inpaint"));
    const action = await actionPost(postRequest("/api/jobs/action"));

    expect(imagine.status).toBe(400);
    expect(inpaint.status).toBe(400);
    expect(action.status).toBe(400);
  });
});

/** POST /api/jobs/usdz — validation, conversion result mapping, job attach. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ensureUsdz = vi.fn();
const recordOutputOnce = vi.fn();
const findJobIdForOutput = vi.fn();

async function loadRoute(adminKey = "") {
  vi.resetModules();
  vi.doMock("@/lib/env", () => ({
    env: {
      ADMIN_API_KEY: adminKey,
      COMFY_ROOT: "/tmp/cj-comfy",
      COMFY_HTTP_URL: "http://127.0.0.1:8188",
      NODE_ENV: "test",
    },
  }));
  vi.doMock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
  vi.doMock("@/lib/db", () => ({ recordOutputOnce, findJobIdForOutput }));
  vi.doMock("@/lib/mesh/usdz", async (orig) => ({
    ...(await orig<typeof import("@/lib/mesh/usdz")>()),
    ensureUsdz,
  }));
  return (await import("@/app/api/jobs/usdz/route")).POST;
}

function post(body: unknown, token?: string): NextRequest {
  return new NextRequest("http://localhost/api/jobs/usdz", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  ensureUsdz.mockReset();
  recordOutputOnce.mockReset();
  findJobIdForOutput.mockReset();
});

describe("POST /api/jobs/usdz", () => {
  it("requires admin auth when configured", async () => {
    const POST = await loadRoute("secret");
    const res = await POST(post({ filename: "m.glb" }));
    expect(res.status).toBe(401);
    expect(ensureUsdz).not.toHaveBeenCalled();
  });

  it.each([
    [{ filename: "m.png" }],
    [{ filename: "../m.glb" }],
    [{ filename: "m.glb", subfolder: "../x" }],
    [{}],
    ["not json"],
  ])("rejects %j", async (body) => {
    const POST = await loadRoute();
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(ensureUsdz).not.toHaveBeenCalled();
  });

  it("converts, attaches to the producing job and returns a proxy url", async () => {
    ensureUsdz.mockResolvedValue({
      ok: true,
      usdz: { filename: "m.usdz", subfolder: "3d" },
    });
    findJobIdForOutput.mockReturnValue("run1:0");
    const POST = await loadRoute();
    const res = await POST(post({ filename: "m.glb", subfolder: "3d" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.usdz).toEqual({
      filename: "m.usdz",
      subfolder: "3d",
      url: "/api/comfy/image?filename=m.usdz&subfolder=3d&type=output",
    });
    expect(ensureUsdz).toHaveBeenCalledWith("/tmp/cj-comfy/output", {
      filename: "m.glb",
      subfolder: "3d",
    });
    expect(recordOutputOnce).toHaveBeenCalledWith(
      "run1:0",
      "m.usdz",
      "3d",
      "mesh",
    );
  });

  it("maps a missing GLB to 404 and converter failures to 500", async () => {
    const POST = await loadRoute();
    ensureUsdz.mockResolvedValueOnce({ ok: false, error: "GLB not found" });
    expect((await POST(post({ filename: "m.glb" }))).status).toBe(404);
    ensureUsdz.mockResolvedValueOnce({
      ok: false,
      error: "Blender not found (install it or set BLENDER_PATH)",
    });
    const res = await POST(post({ filename: "m.glb" }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).toContain("Blender not found");
    expect(recordOutputOnce).not.toHaveBeenCalled();
  });
});

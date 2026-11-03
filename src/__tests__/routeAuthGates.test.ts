import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

async function importRoutes() {
  vi.resetModules();
  vi.stubEnv("ADMIN_API_KEY", "test-admin-key");
  const [systemRoute, healthRoute] = await Promise.all([
    import("@/app/api/comfy/system/route"),
    import("@/app/api/health/route"),
  ]);
  return { systemRoute, healthRoute };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("GET route auth gates", () => {
  it("requires admin auth for Comfy system details", async () => {
    const { systemRoute } = await importRoutes();

    const res = await systemRoute.GET(
      new NextRequest("http://localhost/api/comfy/system"),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: "Unauthorized",
    });
  });

  it("keeps basic health public but requires admin auth for node inventory", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const { healthRoute } = await importRoutes();

    const publicRes = await healthRoute.GET(
      new NextRequest("http://localhost/api/health"),
    );
    const nodeRes = await healthRoute.GET(
      new NextRequest("http://localhost/api/health?nodes=1"),
    );

    expect(publicRes.status).toBe(200);
    expect(await publicRes.json()).toMatchObject({
      ok: true,
      comfyui: "disconnected",
    });
    expect(nodeRes.status).toBe(401);
    expect(await nodeRes.json()).toMatchObject({
      ok: false,
      error: "Unauthorized",
    });
  });
});

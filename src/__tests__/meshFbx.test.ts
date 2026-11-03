/** GLB → FBX: GET /api/comfy/fbx, the temp-dir converter, and a real Blender run when one is installed. */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { writeGlb } from "@/lib/mesh/meshConvert";
import { convertGlbToFbx, glbBytesToFbx } from "@/lib/mesh/fbx";
import { findBlender } from "@/lib/mesh/usdz";
import { fbxHref, fbxRefFor } from "@/lib/mesh/blenderLinks";

const fetchImageResponse = vi.fn();

async function loadRoute() {
  vi.resetModules();
  vi.doMock("@/lib/env", () => ({
    env: {
      ADMIN_API_KEY: "",
      COMFY_ROOT: "/tmp/cj-comfy",
      COMFY_HTTP_URL: "http://127.0.0.1:8188",
      NODE_ENV: "test",
    },
  }));
  vi.doMock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
  vi.doMock("@/lib/comfy/http", () => ({ fetchImageResponse }));
  return (await import("@/app/api/comfy/fbx/route")).GET;
}

const get = (query: string) =>
  new NextRequest(`http://localhost/api/comfy/fbx?${query}`, {
    headers: { host: "localhost" },
  });

const glb = writeGlb({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]),
});

beforeEach(() => {
  fetchImageResponse.mockReset();
});

describe("FBX links", () => {
  it("picks the first GLB, none for splat-only jobs", () => {
    const ply = { filename: "a.ply", subfolder: "", type: "output" as const };
    const m = { filename: "a_mesh.glb", subfolder: "3d", type: "output" as const };
    expect(fbxRefFor([ply, m])).toEqual(m);
    expect(fbxRefFor([ply])).toBeNull();
    expect(fbxHref(m)).toBe(
      "/api/comfy/fbx?filename=a_mesh.glb&subfolder=3d&type=output",
    );
  });
});

describe("GET /api/comfy/fbx", () => {
  it.each([
    "filename=a.ply&subfolder=3d",
    "filename=a.spz",
    "filename=../a.glb",
    "subfolder=3d",
    "filename=a.glb&subfolder=../up",
    "filename=a.glb&type=secret",
  ])("refuses %s without reading anything", async (query) => {
    const GET = await loadRoute();
    const res = await GET(get(query));
    expect(res.status).toBe(400);
    expect(fetchImageResponse).not.toHaveBeenCalled();
  });

  it("passes a missing GLB through as 404", async () => {
    fetchImageResponse.mockRejectedValue(
      Object.assign(new Error("gone"), { statusCode: 404 }),
    );
    const GET = await loadRoute();
    const res = await GET(get("filename=a.glb&subfolder=3d"));
    expect(res.status).toBe(404);
  });
});

describe("glbBytesToFbx", () => {
  it("returns the converted bytes and removes its temp dir", async () => {
    let seen = "";
    const r = await glbBytesToFbx(new Uint8Array([1, 2, 3]), async (src, dst) => {
      seen = path.dirname(src);
      expect([...fs.readFileSync(src)]).toEqual([1, 2, 3]);
      fs.writeFileSync(dst, "fbx");
      return { ok: true };
    });
    expect(r).toEqual({ ok: true, fbx: Buffer.from("fbx") });
    expect(fs.existsSync(seen)).toBe(false);
  });

  it("reports a failed conversion and still cleans up", async () => {
    let seen = "";
    const r = await glbBytesToFbx(new Uint8Array([1]), async (src) => {
      seen = path.dirname(src);
      return { ok: false, error: "exit 1 glb_to_fbx: no meshes in input" };
    });
    expect(r).toEqual({ ok: false, error: "exit 1 glb_to_fbx: no meshes in input" });
    expect(fs.existsSync(seen)).toBe(false);
  });

  it("says Blender is missing instead of throwing", async () => {
    await expect(
      convertGlbToFbx("/a.glb", "/a.fbx", { blender: null }),
    ).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("Blender not found"),
    });
  });
});

const blender = findBlender();
describe.skipIf(!blender)("real Blender", () => {
  it("writes a binary FBX that re-imports with the same geometry", async () => {
    const r = await glbBytesToFbx(glb);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fbx.subarray(0, 18).toString()).toBe("Kaydara FBX Binary");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cj-fbx-"));
    try {
      const fbx = path.join(dir, "m.fbx");
      const check = path.join(dir, "check.py");
      fs.writeFileSync(fbx, r.fbx);
      fs.writeFileSync(
        check,
        [
          "import bpy, sys",
          "bpy.ops.wm.read_factory_settings(use_empty=True)",
          "bpy.ops.import_scene.fbx(filepath=sys.argv[sys.argv.index('--') + 1])",
          "m = next(o for o in bpy.context.scene.objects if o.type == 'MESH').data",
          "print('COUNTS', len(m.vertices), len(m.polygons))",
        ].join("\n"),
      );
      const out = execFileSync(
        blender!,
        ["-b", "--factory-startup", "-P", check, "--", fbx],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      expect(out).toContain("COUNTS 4 4");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("names the reason when the file is not a model", async () => {
    const r = await glbBytesToFbx(new TextEncoder().encode("not a glb"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("glb_to_fbx:");
  }, 120_000);
});

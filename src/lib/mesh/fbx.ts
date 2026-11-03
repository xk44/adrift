/**
 * GLB → FBX, for apps that take FBX but not glTF (TouchDesigner, Maya, Unreal).
 * Works on bytes in a temp dir rather than next to the output, so it also runs
 * when ComfyUI is on another machine, and leaves nothing to record or clean up.
 * A large mesh converts in seconds. Blender runs where Adrift runs.
 * FBX has no way to hold Gaussian splats: only meshes come through here.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { withLock } from "@/lib/locks";
import { runGlbConvert, type ConvertResult } from "./usdz";

export function convertGlbToFbx(
  glbAbs: string,
  fbxAbs: string,
  opts: { blender?: string | null; script?: string; timeoutMs?: number } = {},
): Promise<ConvertResult> {
  return runGlbConvert("glb_to_fbx", glbAbs, fbxAbs, opts);
}

export async function glbBytesToFbx(
  glb: Uint8Array,
  convert: typeof convertGlbToFbx = convertGlbToFbx,
): Promise<{ ok: true; fbx: Buffer } | { ok: false; error: string }> {
  // Same lock as USDZ: Blender is CPU-heavy, one conversion at a time.
  return withLock("usdz-convert", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "adrift-fbx-"));
    try {
      const glbAbs = path.join(dir, "model.glb");
      const fbxAbs = path.join(dir, "model.fbx");
      await fs.promises.writeFile(glbAbs, glb);
      const result = await convert(glbAbs, fbxAbs);
      if (!result.ok) return { ok: false as const, error: result.error };
      return { ok: true as const, fbx: await fs.promises.readFile(fbxAbs) };
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
}

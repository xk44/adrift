/**
 * GET /api/comfy/fbx?filename=a.glb&subfolder=3d&type=output
 * One output GLB as an FBX download (Blender headless on the computer running
 * Adrift, CPU only, no ComfyUI job). The GLB is read through ComfyUI's /view,
 * so a remote ComfyUI works too.
 */
import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiError, apiOptions } from "@/lib/api";
import { safeStem } from "@/lib/mesh/blenderBundle";
import {
  BundleFetchError,
  loadGlbBytes,
  validateMeshRefs,
} from "@/lib/mesh/blenderBundleServer";
import { glbBytesToFbx } from "@/lib/mesh/fbx";
import { guardRoute } from "@/lib/routeGuard";

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Each call reads a whole model and starts Blender; keep it modest.
  const guard = guardRoute(request, { max: 20 });
  if (!guard.ok) return guard.response;
  const headers = apiCorsHeaders(request, "GET, OPTIONS");

  const q = new URL(request.url).searchParams;
  const ref = validateMeshRefs([
    {
      filename: q.get("filename"),
      subfolder: q.get("subfolder") ?? "",
      type: q.get("type") ?? "output",
    },
  ])?.[0];
  if (!ref || !/\.glb$/i.test(ref.filename)) {
    return apiError(
      "Pass one output .glb (filename, subfolder, type). FBX cannot hold splats: run 3D splat with Mesh on and export that mesh.",
      { status: 400, headers },
    );
  }

  try {
    const result = await glbBytesToFbx(await loadGlbBytes(ref));
    if (!result.ok) {
      const status = result.error.startsWith("Blender not found") ? 503 : 500;
      return apiError(result.error, { status, headers });
    }
    const out = new Headers(headers);
    out.set("Content-Type", "application/octet-stream");
    out.set(
      "Content-Disposition",
      `attachment; filename="${safeStem(ref.filename)}.fbx"`,
    );
    out.set("Content-Length", String(result.fbx.byteLength));
    out.set("Cache-Control", "private, no-store");
    return new NextResponse(new Uint8Array(result.fbx), {
      status: 200,
      headers: out,
    });
  } catch (err) {
    if (err instanceof BundleFetchError)
      return apiError(err.message, { status: err.status, headers });
    const message = err instanceof Error ? err.message : String(err);
    return apiError(`FBX export failed: ${message}`, { status: 500, headers });
  }
}

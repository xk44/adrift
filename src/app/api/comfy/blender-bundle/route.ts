/**
 * GET /api/comfy/blender-bundle?filename=a.glb&subfolder=3d&type=output[&filename=…][&fovx=&fovy=][&aspect=]
 * GET /api/comfy/blender-bundle?layers=<prefix>_layers.json[&res=1280][&aspect=]
 * "Export for Blender": a zip with the job's 3D files (GLB where possible,
 * splat point previews), a generated import_<name>.py and a README; or, for
 * a Layer Split result, its parts as depth-ordered image planes
 * (import_layers.py + layers.glb). Mesh query params repeat once per file,
 * in order (at most 8 files); fovx/fovy add MoGe's source camera.
 */
import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiError, apiOptions } from "@/lib/api";
import { guardRoute } from "@/lib/routeGuard";
import { blenderBundleZip } from "@/lib/mesh/blenderBundle";
import {
  BundleFetchError,
  blenderSourceFromQuery,
  loadBlenderSource,
} from "@/lib/mesh/blenderBundleServer";

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Each call reads and converts whole models; keep it modest.
  const guard = guardRoute(request, { max: 20 });
  if (!guard.ok) return guard.response;
  const headers = apiCorsHeaders(request, "GET, OPTIONS");

  const source = blenderSourceFromQuery(new URL(request.url).searchParams);
  if (!source) {
    return apiError(
      "Pass 1-8 3D output files (filename, subfolder, type) or a Layer Split manifest (layers)",
      { status: 400, headers },
    );
  }

  try {
    const bundle = await loadBlenderSource(source);
    const zip = blenderBundleZip(bundle);
    const out = new Headers(headers);
    out.set("Content-Type", "application/zip");
    out.set(
      "Content-Disposition",
      `attachment; filename="${bundle.name}_blender.zip"`,
    );
    out.set("Content-Length", String(zip.byteLength));
    out.set("Cache-Control", "private, no-store");
    return new NextResponse(new Uint8Array(zip), { status: 200, headers: out });
  } catch (err) {
    if (err instanceof BundleFetchError)
      return apiError(err.message, { status: err.status, headers });
    const message = err instanceof Error ? err.message : String(err);
    return apiError(`Blender export failed: ${message}`, {
      status: 500,
      headers,
    });
  }
}

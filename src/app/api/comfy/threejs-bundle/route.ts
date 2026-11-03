/**
 * GET /api/comfy/threejs-bundle?filename=a.glb&subfolder=3d&type=output[&filename=…]
 * "Export for Three.js": a zip with a job's meshes and splats, a page that shows
 * them and a README with code to load them. Query params repeat once per file
 * (at most 8). Read through ComfyUI's /view, so a remote ComfyUI works too.
 */
import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiError, apiOptions } from "@/lib/api";
import { blenderBundleZip } from "@/lib/mesh/blenderBundle";
import {
  BundleFetchError,
  loadThreejsBundle,
  meshRefsFromQuery,
} from "@/lib/mesh/blenderBundleServer";
import { guardRoute } from "@/lib/routeGuard";

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Each call reads and converts whole models; keep it modest.
  const guard = guardRoute(request, { max: 20 });
  if (!guard.ok) return guard.response;
  const headers = apiCorsHeaders(request, "GET, OPTIONS");

  const refs = meshRefsFromQuery(new URL(request.url).searchParams);
  if (!refs) {
    return apiError("Pass 1-8 3D output files (filename, subfolder, type)", {
      status: 400,
      headers,
    });
  }

  try {
    const bundle = await loadThreejsBundle(refs);
    if (bundle.assets.length === 0) {
      return apiError("None of these files can load in three.js", {
        status: 400,
        headers,
      });
    }
    const zip = blenderBundleZip(bundle);
    const out = new Headers(headers);
    out.set("Content-Type", "application/zip");
    out.set(
      "Content-Disposition",
      `attachment; filename="${bundle.name}_threejs.zip"`,
    );
    out.set("Content-Length", String(zip.byteLength));
    out.set("Cache-Control", "private, no-store");
    return new NextResponse(new Uint8Array(zip), { status: 200, headers: out });
  } catch (err) {
    if (err instanceof BundleFetchError)
      return apiError(err.message, { status: err.status, headers });
    const message = err instanceof Error ? err.message : String(err);
    return apiError(`Three.js export failed: ${message}`, {
      status: 500,
      headers,
    });
  }
}

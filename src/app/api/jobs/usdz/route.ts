/**
 * POST /api/jobs/usdz
 * Export a .usdz next to an output .glb (Blender headless, CPU only — no
 * ComfyUI job). New 3D runs get this automatically when /api/jobs/recent
 * records them; this is the on-demand path for older runs and for retries.
 *
 * Body:  { filename: "mesh_00001_.glb", subfolder?: "3d" }
 * Reply: { ok: true, usdz: { filename, subfolder, url } }
 */
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiError, apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { findJobIdForOutput, recordOutputOnce } from "@/lib/db";
import { env } from "@/lib/env";
import { proxyUrl } from "@/lib/jobs/recentRuns";
import { ensureUsdz, usdzNameFor, validateOutputRef } from "@/lib/mesh/usdz";
import { withRateLimit } from "@/lib/rateLimit";
import { comfyOutputDir } from "@/lib/paths/resolveDirs";

const MAX_BYTES = 4096;

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  // Each call can spawn Blender for seconds; keep it modest.
  const rl = withRateLimit(request, { windowMs: 60_000, max: 10 });
  if (!rl.ok) return rl.response;

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BYTES) {
    return apiError("Payload too large", {
      status: 413,
      headers: apiCorsHeaders(),
    });
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return apiError("Invalid JSON body", {
      status: 400,
      headers: apiCorsHeaders(),
    });
  }

  const ref = validateOutputRef(body.filename, body.subfolder);
  if (!ref || !usdzNameFor(ref.filename)) {
    return apiError("filename must be an output .glb", {
      status: 400,
      headers: apiCorsHeaders(),
    });
  }

  const result = await ensureUsdz(comfyOutputDir(env.COMFY_ROOT), ref);
  if (!result.ok) {
    const status = result.error === "GLB not found" ? 404 : 500;
    return apiError(`USDZ export failed: ${result.error}`, {
      status,
      headers: apiCorsHeaders(),
    });
  }

  // Attach it to the run that produced the GLB so /recent lists it too.
  const jobId = findJobIdForOutput(ref.filename, ref.subfolder);
  if (jobId) {
    recordOutputOnce(
      jobId,
      result.usdz.filename,
      result.usdz.subfolder,
      "mesh",
    );
  }

  return apiOk(
    {
      usdz: {
        ...result.usdz,
        url: proxyUrl(result.usdz.filename, result.usdz.subfolder, "output"),
      },
    },
    { headers: apiCorsHeaders() },
  );
}

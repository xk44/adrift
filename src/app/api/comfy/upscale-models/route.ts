/**
 * GET /api/comfy/upscale-models
 * Read-only: image upscaler weights ComfyUI can load (UpscaleModelLoader
 * model_name options, face-restore/detection files filtered out) for the
 * shared upscale model picker. `available: false` = node missing.
 */

import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiErr, apiError, apiOk } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import { upscaleModelOptionsFromObjectInfo } from "@/lib/upscale/upscaleModels";

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "GET, OPTIONS"),
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(request, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;

  const fresh = request.nextUrl.searchParams.get("fresh") === "1";
  const oi = await getObjectInfoCached(undefined, { fresh });
  if (!oi) {
    apiErr("UpscaleModelsAPI", "ComfyUI unreachable");
    return apiError("ComfyUI is unreachable; upscale models unavailable", {
      status: 503,
    });
  }
  const models = upscaleModelOptionsFromObjectInfo(
    oi as Record<string, unknown>,
  );
  return apiOk({ available: models !== null, models: models ?? [] });
}

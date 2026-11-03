import { NextRequest, NextResponse } from "next/server";

import { apiCorsHeaders, apiError, apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { fetchManagerModels } from "@/lib/comfy/manager";
import { withRateLimit } from "@/lib/rateLimit";

export function OPTIONS(): NextResponse {
  return apiOptions();
}

/** Browse the ComfyUI-Manager external-model catalog. */
export async function GET(request: NextRequest) {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 30 });
  if (!rl.ok) return rl.response;

  const cors = apiCorsHeaders(request);
  const modeParam = new URL(request.url).searchParams.get("mode");
  const mode =
    modeParam === "local" || modeParam === "remote" ? modeParam : "cache";

  try {
    const models = await fetchManagerModels(undefined, mode);
    return apiOk({ models, total: models.length }, { headers: cors });
  } catch (caught) {
    return apiError(
      caught instanceof Error ? caught.message : "Failed to load model catalog",
      { status: 502, headers: cors },
    );
  }
}

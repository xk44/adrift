/**
 * GET /api/comfy/input-specs?classes=KSampler,LoadImage
 * Read-only: returns trimmed object_info input specs (tooltip, advanced,
 * round/step, control_after_generate, upload, remote, V3 dynamic types…)
 * for the requested node classes so the control panel can honor them.
 */

import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiErr, apiError, apiOk } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import { trimObjectInfo, type ObjectInfoIndex } from "@/lib/oj/inputSpec";

const MAX_CLASSES = 200;
const MAX_OPTIONS = 2000;

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

  const classes = (request.nextUrl.searchParams.get("classes") ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && c.length <= 200)
    .slice(0, MAX_CLASSES);
  if (classes.length === 0) {
    return apiError("classes query parameter is required", { status: 400 });
  }

  const fresh = request.nextUrl.searchParams.get("fresh") === "1";
  const oi = await getObjectInfoCached(undefined, { fresh });
  if (!oi) {
    apiErr("InputSpecsAPI", "ComfyUI unreachable");
    return apiError("ComfyUI is unreachable; input options unavailable", {
      status: 503,
    });
  }
  const specs = trimObjectInfo(oi as ObjectInfoIndex, classes, MAX_OPTIONS);
  const missing = classes.filter((c) => !(c in specs));
  return apiOk({ specs, missing });
}

/**
 * GET /api/comfy/remote-options?route=/internal/files/output[&key=...]
 * Read-only proxy for "remote" combo inputs (options fetched from a
 * ComfyUI route at edit time). Only allowlisted GET routes.
 */

import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiErr, apiError, apiOk } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import {
  isAllowedRemoteRoute,
  normalizeRemoteOptions,
} from "@/lib/comfy/comfyLibrary";

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

  const route = request.nextUrl.searchParams.get("route");
  const key = request.nextUrl.searchParams.get("key") ?? undefined;
  if (!isAllowedRemoteRoute(route)) {
    return apiError("route is not an allowed remote-options route", {
      status: 400,
    });
  }
  try {
    const res = await comfyFetch(route, {
      method: "GET",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return apiError(`ComfyUI returned HTTP ${res.status} for ${route}`, {
        status: 502,
      });
    }
    const options = normalizeRemoteOptions(await res.json(), key);
    return apiOk({ route, options });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    apiErr("RemoteOptionsAPI", "Error", message);
    return apiError(`Failed to load options: ${message}`, { status: 502 });
  }
}

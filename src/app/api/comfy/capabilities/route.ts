/**
 * GET /api/comfy/capabilities[?fresh=1]
 *   → { ok, capabilities: ComfyCapabilities }
 *
 * Server-version gates derived from ComfyUI's /features + /system_stats
 * (see lib/comfy/capabilities.ts). Cached 30s server-side.
 */

import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { getComfyCapabilities } from "@/lib/comfy/capabilities";

export function OPTIONS(): NextResponse {
  return apiOptions();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;

  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  const capabilities = await getComfyCapabilities(undefined, { fresh });
  return apiOk({ capabilities: { ...capabilities } });
}

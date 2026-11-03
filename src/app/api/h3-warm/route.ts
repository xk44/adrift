/**
 * H3 warm backend control: keep a dedicated ComfyUI process with MiniMax H3
 * weights resident (~87GB unified memory) for ~52s warm renders instead of
 * 140-160s cold staging per run. Default off; user-toggled from Settings.
 *
 * GET  -> { enabled, starting, url }
 * POST { on: boolean } -> same, after applying the change
 *
 * Loopback-only (Host and forwarding headers), and starting is limited to
 * once a minute: each start spawns a ComfyUI process holding ~87GB.
 */

import { NextRequest, NextResponse } from "next/server";
import { warmStatus, startWarm, stopWarm } from "@/lib/comfy/warmBackend";
import { requireAdmin } from "@/lib/auth";
import { guardRoute, loopbackOnly } from "@/lib/routeGuard";
import { withRateLimit } from "@/lib/rateLimit";
import { apiCorsHeaders, apiError, apiOptions } from "@/lib/api";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const local = loopbackOnly(request);
  if (!local.ok) return local.response;
  const auth = guardRoute(request, { max: 60 });
  if (!auth.ok) return auth.response;
  return NextResponse.json(await warmStatus(), {
    headers: apiCorsHeaders(request),
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const local = loopbackOnly(request);
  if (!local.ok) return local.response;
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  let on: unknown;
  try {
    ({ on } = await request.json());
  } catch {
    return apiError("Invalid JSON body", {
      status: 400,
      headers: apiCorsHeaders(request),
    });
  }
  if (typeof on !== "boolean") {
    return apiError("Body must be { on: boolean }", {
      status: 400,
      headers: apiCorsHeaders(request),
    });
  }
  // Start: 1/min (spawns a large process). Stop stays cheap to retry.
  const limited = withRateLimit(request, { windowMs: 60_000, max: on ? 1 : 10 });
  if (!limited.ok) return limited.response;
  const status = on ? await startWarm() : await stopWarm();
  return NextResponse.json(status, { headers: apiCorsHeaders(request) });
}

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

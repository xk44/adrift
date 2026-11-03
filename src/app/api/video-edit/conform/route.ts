/**
 * POST /api/video-edit/conform
 * Ready a tool result for the timeline (ffmpeg; no ComfyUI job): put the
 * cut's original sound under it and / or re-time it to the edit's rate.
 *
 * Body:  { video: url, audio?: url (the cut), fps?: number (0 = keep) }
 * Reply: { ok: true, url, info: { duration, width, height, fps, hasAudio } }
 */
import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { parseConformRequest } from "@/lib/videoEdit/requests";
import {
  badRequest,
  readJsonBody,
  videoEditErrorResponse,
} from "@/lib/videoEdit/routeHelpers";
import { conformResult } from "@/lib/videoEdit/server";

export const maxDuration = 1200;

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(request, { windowMs: 60_000, max: 20 });
  if (!rl.ok) return rl.response;
  const read = await readJsonBody(request, 8192);
  if (!read.ok) return read.response;
  const parsed = parseConformRequest(read.body);
  if (!parsed.ok) return badRequest(parsed.error);
  try {
    const { url, info } = await conformResult(parsed.value, request.signal);
    return apiOk({ url, info }, { headers: apiCorsHeaders() });
  } catch (e) {
    return videoEditErrorResponse(e);
  }
}

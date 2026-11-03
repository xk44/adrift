/**
 * POST /api/video-edit/derive
 * New media from a clip (ffmpeg; no ComfyUI job): a range played backwards,
 * or one frame held as a still shot.
 *
 * Body:  { op: "reverse", video: url, in, out }
 *      | { op: "freeze", video: url, t, seconds, fps? }
 * Reply: { ok: true, url, info: { duration, width, height, fps, hasAudio } }
 */
import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { parseDeriveRequest } from "@/lib/videoEdit/requests";
import {
  badRequest,
  readJsonBody,
  videoEditErrorResponse,
} from "@/lib/videoEdit/routeHelpers";
import { deriveClip } from "@/lib/videoEdit/server";

export const maxDuration = 600;

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(request, { windowMs: 60_000, max: 30 });
  if (!rl.ok) return rl.response;
  const read = await readJsonBody(request, 8192);
  if (!read.ok) return read.response;
  const parsed = parseDeriveRequest(read.body);
  if (!parsed.ok) return badRequest(parsed.error);
  try {
    const { url, info } = await deriveClip(parsed.value, request.signal);
    return apiOk({ url, info }, { headers: apiCorsHeaders() });
  } catch (e) {
    return videoEditErrorResponse(e);
  }
}

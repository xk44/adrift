/**
 * POST /api/video-edit/probe
 * Duration / size / fps / audio of a gallery or uploaded video (ffprobe; no
 * ComfyUI job).
 *
 * Body:  { url: "/api/comfy/image?filename=..&type=output", audio?: true }
 *        (audio: the file's sound only, for the A2 lane)
 * Reply: { ok: true, info: { duration, width, height, fps, hasAudio } }
 */
import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { parseProbeRequest } from "@/lib/videoEdit/requests";
import {
  badRequest,
  readJsonBody,
  videoEditErrorResponse,
} from "@/lib/videoEdit/routeHelpers";
import { probeAudioSource, probeSource } from "@/lib/videoEdit/server";

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(request, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;
  const read = await readJsonBody(request, 4096);
  if (!read.ok) return read.response;
  const parsed = parseProbeRequest(read.body);
  if (!parsed.ok) return badRequest(parsed.error);
  try {
    const info = parsed.value.audio
      ? await probeAudioSource(parsed.value.ref)
      : await probeSource(parsed.value.ref);
    return apiOk({ info }, { headers: apiCorsHeaders() });
  } catch (e) {
    return videoEditErrorResponse(e);
  }
}

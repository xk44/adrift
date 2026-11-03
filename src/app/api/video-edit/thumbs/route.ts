/**
 * POST /api/video-edit/thumbs
 * Filmstrip sprite (one row of evenly spaced frames) for the timeline.
 *
 * Body:  { url, height?: 16-240, kind?: "strip" | "wave", audio?: true }  (count is
 *        accepted but the server picks the tile count from the source
 *        length: ~2/s, 8-32)
 * Reply: { ok: true, strip: { url, count, tileWidth, tileHeight } }
 *        kind "wave": { ok: true, wave: { url, width, height, duration } | null }
 *        (null = the source has no audio)
 */
import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { parseThumbsRequest } from "@/lib/videoEdit/requests";
import {
  badRequest,
  readJsonBody,
  videoEditErrorResponse,
} from "@/lib/videoEdit/routeHelpers";
import { filmstrip, waveform } from "@/lib/videoEdit/server";

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
  const parsed = parseThumbsRequest(read.body);
  if (!parsed.ok) return badRequest(parsed.error);
  try {
    if (parsed.value.kind === "wave") {
      const wave = await waveform(
        parsed.value.ref,
        parsed.value.height,
        parsed.value.audio,
      );
      return apiOk({ wave }, { headers: apiCorsHeaders() });
    }
    const strip = await filmstrip(parsed.value.ref, parsed.value.height);
    return apiOk({ strip }, { headers: apiCorsHeaders() });
  } catch (e) {
    return videoEditErrorResponse(e);
  }
}

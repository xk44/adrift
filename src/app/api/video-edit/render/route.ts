/**
 * POST /api/video-edit/render
 * Render an edit list with ffmpeg (CPU; no ComfyUI job).
 *
 * Body: { mode: "mp4" | "frame" | "range", edit: EditList,
 *         start?, end?  (timeline seconds; mp4 / range),
 *         t?            (timeline seconds; frame),
 *         save?: bool   (mp4 / frame: add to the gallery, default true),
 *         label?: string }
 * Reply: { ok: true, result: { url, file, kind, width, height, duration,
 *          fps, hasAudio, run?, saveError? } }
 *
 * "range" cuts a piece for a tool run and never touches the gallery.
 */
import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { parseRenderRequest } from "@/lib/videoEdit/requests";
import {
  badRequest,
  readJsonBody,
  videoEditErrorResponse,
} from "@/lib/videoEdit/routeHelpers";
import { render } from "@/lib/videoEdit/server";

export const maxDuration = 1800;

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(request, { windowMs: 60_000, max: 20 });
  if (!rl.ok) return rl.response;
  const read = await readJsonBody(request, 256 * 1024);
  if (!read.ok) return read.response;
  const parsed = parseRenderRequest(read.body);
  if (!parsed.ok) return badRequest(parsed.error);
  try {
    const result = await render(parsed.value, request.signal);
    return apiOk({ result }, { headers: apiCorsHeaders() });
  } catch (e) {
    return videoEditErrorResponse(e);
  }
}

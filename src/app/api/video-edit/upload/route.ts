/**
 * POST /api/video-edit/upload
 * Raw video or audio body (X-Filename: original name) → the editor's work
 * dir. Probed before it is accepted (audio files: their sound only).
 *
 * Reply: { ok: true, url, info: { duration, width, height, fps, hasAudio } }
 */
import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import {
  MAX_UPLOAD_BYTES,
  isAudioExtension,
  uploadExtension,
} from "@/lib/videoEdit/requests";
import { badRequest, videoEditErrorResponse } from "@/lib/videoEdit/routeHelpers";
import { storeUpload } from "@/lib/videoEdit/server";

export const maxDuration = 600;

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(request, { windowMs: 60_000, max: 10 });
  if (!rl.ok) return rl.response;
  let name = request.headers.get("x-filename") ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    return badRequest("bad X-Filename header");
  }
  const ext = uploadExtension(name);
  if (!ext)
    return badRequest(
      "upload a video (mp4, mov, m4v, webm, mkv) or audio file (mp3, wav, flac, ogg, opus, m4a, aac)",
    );
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > MAX_UPLOAD_BYTES) return badRequest("that file is over 1 GB");
  if (!request.body) return badRequest("empty upload");
  try {
    const stored = await storeUpload(
      request.body,
      ext,
      MAX_UPLOAD_BYTES,
      isAudioExtension(ext),
    );
    return apiOk(
      { url: stored.url, info: stored.info },
      { headers: apiCorsHeaders() },
    );
  } catch (e) {
    return videoEditErrorResponse(e);
  }
}

/**
 * GET /api/comfy/output-formats[?fresh=1]
 *   → { ok, image: ImageMasterFormat[], video: VideoMasterFormat[] }
 *
 * Which opt-in master formats (16-bit PNG / EXR / ProRes 4444) the backend can
 * write, read from the cached /object_info. The defaults ("png", "h264") are
 * always listed; the picker hides itself when nothing else is available.
 * Video formats come from the video backend when one is configured.
 */

import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import { preferredVideoBackendUrl } from "@/lib/comfy/backends";
import { detectMasterFormats } from "@/lib/output/saveNodes";

export function OPTIONS(): NextResponse {
  return apiOptions();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;

  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  const main = detectMasterFormats(await getObjectInfoCached(undefined, { fresh }));
  const videoUrl = preferredVideoBackendUrl();
  const video = videoUrl
    ? detectMasterFormats(await getObjectInfoCached(videoUrl, { fresh })).video
    : main.video;
  return apiOk({ image: main.image, video });
}

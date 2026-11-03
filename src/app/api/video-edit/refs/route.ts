/**
 * POST /api/video-edit/refs
 * Register the uploads an open video project uses, so housekeeping keeps
 * them. An empty list releases the project (closed or replaced).
 *
 * Body:  { projectId: "<8-64 chars>", files: ["uploads/<name>.mp4", …] }
 * Reply: { ok: true }
 */
import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { parseRefsRequest, writeProjectRefs } from "@/lib/videoEdit/projectRefs";
import {
  badRequest,
  readJsonBody,
  videoEditErrorResponse,
} from "@/lib/videoEdit/routeHelpers";
import { workRoot } from "@/lib/videoEdit/server";

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(request, { windowMs: 60_000, max: 120 });
  if (!rl.ok) return rl.response;
  const read = await readJsonBody(request, 32 * 1024);
  if (!read.ok) return read.response;
  const parsed = parseRefsRequest(read.body);
  if (!parsed.ok) return badRequest(parsed.error);
  try {
    writeProjectRefs(workRoot(), parsed.value);
    return apiOk({}, { headers: apiCorsHeaders() });
  } catch (e) {
    return videoEditErrorResponse(e);
  }
}

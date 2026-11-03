/**
 * GET /api/tools/sa3-options
 * What the Stable Audio 3 tools can offer on this backend:
 *   → { ok, reachable, loras: string[], quality: boolean }
 * `loras` = LoRAs under models/loras/audio/ (as ComfyUI lists them,
 * "audio/<name>.safetensors"); the picker hides when empty.
 * `quality` = the SA3 Medium base checkpoint (Quality speed) is installed.
 * Read-only: one cached /object_info GET.
 */
import { NextRequest, NextResponse } from "next/server";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import { requireAdmin } from "@/lib/auth";
import { apiCorsHeaders } from "@/lib/api";
import {
  SA3_MEDIUM_BASE_CKPT,
  audioLorasFromObjectInfo,
  checkpointsFromObjectInfo,
} from "@/lib/oj/sa3Params";

const CORS_HEADERS = apiCorsHeaders(null, "GET, OPTIONS");

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const info = await getObjectInfoCached();
  const ckpts = checkpointsFromObjectInfo(info) ?? [];
  return NextResponse.json(
    {
      ok: true,
      reachable: info !== null,
      loras: audioLorasFromObjectInfo(info),
      quality: ckpts.includes(SA3_MEDIUM_BASE_CKPT),
    },
    { headers: CORS_HEADERS },
  );
}

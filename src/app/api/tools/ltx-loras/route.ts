/**
 * GET /api/tools/ltx-loras
 * LTX-named LoRA files the backend lists (LoraLoaderModelOnly / LoraLoader
 * lora_name, as ComfyUI spells them) for the Extra LTX LoRA control:
 *   → { ok, reachable, loras: string[] }
 * The card narrows it per tool (ltxLoraChoices). Read-only: one cached
 * /object_info GET.
 */
import { NextRequest, NextResponse } from "next/server";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import { requireAdmin } from "@/lib/auth";
import { apiCorsHeaders } from "@/lib/api";
import { ltxLorasFromObjectInfo } from "@/lib/oj/ltxCommunityLoras";

const CORS_HEADERS = apiCorsHeaders(null, "GET, OPTIONS");

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const info = await getObjectInfoCached().catch(() => null);
  return NextResponse.json(
    {
      ok: true,
      reachable: info !== null,
      loras: ltxLorasFromObjectInfo(info),
    },
    { headers: CORS_HEADERS },
  );
}

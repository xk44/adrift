/**
 * GET /api/tools
 * Catalog of LoRA edit tools (see docs/tools-api.md). Client-safe fields plus
 * live `installed` (LoRA files present under COMFY_ROOT/models/loras, any
 * subfolder) and `packAvailable` (base workflow + UNET weights present).
 */
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/auth";
import { apiCorsHeaders } from "@/lib/api";
import { getPack } from "@/lib/oj/packs";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import {
  computeAvailability,
  getEditTools,
  installedLorasFor,
  toPublicTool,
} from "@/lib/tools/editTools";

const CORS_HEADERS = apiCorsHeaders(null, "GET, OPTIONS");

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;

  // Unreachable ComfyUI -> null: node classes are not judged (fail open).
  const objectInfo = await getObjectInfoCached().catch(() => null);
  const installed = await installedLorasFor(env.COMFY_ROOT, objectInfo);
  const tools = await Promise.all(
    getEditTools().map(async (tool) =>
      toPublicTool(
        tool,
        await computeAvailability(
          tool,
          env.COMFY_ROOT,
          installed,
          getPack(tool.pack)?.workflows,
          objectInfo,
        ),
      ),
    ),
  );
  return NextResponse.json({ ok: true, tools }, { headers: CORS_HEADERS });
}

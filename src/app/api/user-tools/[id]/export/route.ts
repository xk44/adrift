/**
 * GET /api/user-tools/:id/export -> application/zip
 *
 * The saved tool as an Adrift tool pack (manifest + API workflow + README
 * listing required models and custom nodes). Tools > Import workflow reads
 * it back with the same name, icon and settings.
 */
import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { apiCorsHeaders, apiError, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { getUserTool } from "@/lib/userTools/store";
import { userToolErrorResponse } from "@/lib/userTools/http";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import { buildToolPack, toolPackFileName } from "@/lib/userTools/pack";

type Ctx = { params: Promise<{ id: string }> };

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

export async function GET(
  request: NextRequest,
  { params }: Ctx,
): Promise<NextResponse> {
  const requestId = uuidv4();
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(request, { windowMs: 60_000, max: 30 });
  if (!rl.ok) return rl.response;
  const { id } = await params;
  try {
    const tool = await getUserTool(id);
    if (!tool) {
      return apiError("That tool was not found", {
        status: 404,
        requestId,
        headers: apiCorsHeaders(),
      });
    }
    // object_info only sharpens the README (custom node packs); export still
    // works with ComfyUI offline.
    const objectInfo = (await getObjectInfoCached().catch(
      () => null,
    )) as Record<string, unknown> | null;
    const zip = buildToolPack(tool, { objectInfo });
    const filename = toolPackFileName(tool.name);
    const headers = new Headers(apiCorsHeaders());
    headers.set("Content-Type", "application/zip");
    headers.set("Content-Length", String(zip.length));
    headers.set("Content-Disposition", `attachment; filename="${filename}"`);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Request-Id", requestId);
    return new NextResponse(new Uint8Array(zip), { status: 200, headers });
  } catch (e) {
    return userToolErrorResponse(e, requestId, "export");
  }
}

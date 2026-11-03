/**
 * POST /api/user-tools/import
 * Body: { url: "https://civitai.com/models/..." } | { file: { name, data } }
 *   data = base64 or a data: URL of a .json / .png / .zip workflow file.
 * Reply: { analysis: UserToolAnalysis }  — nothing is saved; the client
 * reviews it and POSTs /api/user-tools to keep it.
 */
import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { apiCorsHeaders, apiError, apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { BodyTooLargeError, readJsonCapped } from "@/lib/net/readCapped";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import { fetchCustomNodeMappings } from "@/lib/comfy/manager";
import { getCivitaiApiKey } from "@/lib/civitaiConfig";
import { analyzeImport } from "@/lib/userTools/service";
import { fetchBackendProfileServer } from "@/lib/models/backendProfileServer";
import { userToolErrorResponse } from "@/lib/userTools/http";

/** 25 MB file as base64 plus JSON overhead. */
const MAX_BYTES = 36 * 1024 * 1024;

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = uuidv4();
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(request, { windowMs: 60_000, max: 10 });
  if (!rl.ok) return rl.response;
  let parsed: unknown;
  try {
    parsed = await readJsonCapped(request, MAX_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      return apiError("That file is too large (max 25 MB)", {
        status: 413,
        requestId,
      });
    }
    parsed = null;
  }
  const body =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  if (!body) return apiError("Invalid JSON body", { status: 400, requestId });
  try {
    const analysis = await analyzeImport(body, {
      objectInfo: () => getObjectInfoCached(),
      mappings: () => fetchCustomNodeMappings(),
      apiKey: () => getCivitaiApiKey(),
      profile: () => fetchBackendProfileServer(),
    });
    return apiOk({ analysis }, { requestId, headers: apiCorsHeaders() });
  } catch (e) {
    return userToolErrorResponse(e, requestId, "import");
  }
}

import { NextRequest, NextResponse } from "next/server";

import { apiCorsHeaders, apiError, apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { queueComfyManagerInstall } from "@/lib/comfy/manager";
import { withRateLimit } from "@/lib/rateLimit";
import { validatePlainObject, validateRequiredString } from "@/lib/validate";

const MAX_PACK_IDS = 20;
const MAX_PACK_ID_CHARS = 300;
const CNR_PACK_ID_RE = /^[a-z0-9][a-z0-9_.-]*$/i;
const GITHUB_PACK_URL_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;

export function OPTIONS(): NextResponse {
  return apiOptions();
}

function validatePackIds(value: unknown): string[] | string {
  if (!Array.isArray(value)) return "packIds must be an array";
  if (value.length === 0) return "No node-pack IDs provided";
  if (value.length > MAX_PACK_IDS)
    return `packIds exceeds maximum of ${MAX_PACK_IDS}`;
  const deduped: string[] = [];
  for (const raw of value) {
    const result = validateRequiredString(raw, "packId", MAX_PACK_ID_CHARS);
    if (!result.ok) return result.error;
    const id = result.text;
    if (!CNR_PACK_ID_RE.test(id) && !GITHUB_PACK_URL_RE.test(id)) {
      return `Invalid node-pack ID: ${id}`;
    }
    if (!deduped.includes(id)) deduped.push(id);
  }
  return deduped.length ? deduped : "No node-pack IDs provided";
}

/** Install one or more node packs via ComfyUI-Manager. Blocklisted packs are
 *  refused at the lib choke point and returned in `blocked` — never queued. */
export async function POST(request: NextRequest) {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 10 });
  if (!rl.ok) return rl.response;

  const cors = apiCorsHeaders(request);
  try {
    const body = validatePlainObject(await request.json(), "body");
    if (typeof body === "string")
      return apiError(body, { status: 400, headers: cors });

    const packIds = validatePackIds(body.packIds);
    if (typeof packIds === "string")
      return apiError(packIds, { status: 400, headers: cors });

    const result = await queueComfyManagerInstall(packIds, {
      clientId: "adrift-manager-tab",
    });
    return apiOk(result, { headers: cors });
  } catch (caught) {
    return apiError(
      caught instanceof Error ? caught.message : "Failed to queue install",
      { status: 500, headers: cors },
    );
  }
}

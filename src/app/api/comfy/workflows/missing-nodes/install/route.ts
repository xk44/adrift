import { NextRequest, NextResponse } from "next/server";

import { apiCorsHeaders, apiError, apiOk } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { queueComfyManagerInstall } from "@/lib/comfy/manager";
import { withRateLimit } from "@/lib/rateLimit";
import { validatePlainObject, validateRequiredString } from "@/lib/validate";

const METHODS = "POST, OPTIONS";
const MAX_PACK_IDS = 20;
const MAX_PACK_ID_CHARS = 300;
const CNR_PACK_ID_RE = /^[a-z0-9][a-z0-9_.-]*$/i;
const GITHUB_PACK_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;

function headers(request: NextRequest) {
  return apiCorsHeaders(request, METHODS);
}

function error(request: NextRequest, message: string, status = 400) {
  return apiError(message, { status, headers: headers(request) });
}

function validatePackIds(value: unknown): string[] | string {
  if (!Array.isArray(value)) return "packIds must be an array";
  if (value.length === 0) return "No installable node-pack IDs provided";
  if (value.length > MAX_PACK_IDS) return `packIds exceeds maximum length of ${MAX_PACK_IDS}`;

  const deduped: string[] = [];
  for (const raw of value) {
    const result = validateRequiredString(raw, "packId", MAX_PACK_ID_CHARS);
    if (!result.ok) return result.error;

    const id = result.text;
    const allowed = CNR_PACK_ID_RE.test(id) || GITHUB_PACK_URL_RE.test(id);
    if (!allowed) return `Invalid node-pack ID: ${id}`;
    if (!deduped.includes(id)) deduped.push(id);
  }

  if (deduped.length === 0) return "No installable node-pack IDs provided";
  return deduped;
}

type ClientIdResult =
  | { ok: true; clientId?: string }
  | { ok: false; error: string };

function validateClientId(value: unknown): ClientIdResult {
  if (value === undefined || value === null || value === "") return { ok: true };
  const result = validateRequiredString(value, "clientId", 200);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, clientId: result.text };
}

export function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: headers(request) });
}

export async function POST(request: NextRequest) {
  const auth = requireAdmin(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401, headers: headers(request) },
    );
  }

  const rl = withRateLimit(request, { windowMs: 60_000, max: 10 });
  if (!rl.ok) {
    return NextResponse.json(await rl.response.json(), {
      status: rl.response.status,
      headers: headers(request),
    });
  }

  try {
    const body = validatePlainObject(await request.json(), "body");
    if (typeof body === "string") return error(request, body);

    const packIds = validatePackIds(body.packIds);
    if (typeof packIds === "string") return error(request, packIds);

    const clientId = validateClientId(body.clientId);
    if (clientId.ok === false) return error(request, clientId.error);

    const result = await queueComfyManagerInstall(packIds, { clientId: clientId.clientId });
    return apiOk(result, { headers: headers(request) });
  } catch (caught) {
    return error(
      request,
      caught instanceof Error ? caught.message : "Failed to queue missing node install",
      500,
    );
  }
}

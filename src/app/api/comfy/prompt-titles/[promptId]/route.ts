/**
 * GET /api/comfy/prompt-titles/[promptId]
 * Node id -> title map for a prompt this server submitted (for error display).
 */

import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiError, apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { validateIdentifier } from "@/lib/validate";
import { getPromptTitles } from "@/lib/comfy/promptTitles";

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ promptId: string }> },
): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(request, { windowMs: 60_000, max: 120 });
  if (!rl.ok) return rl.response;

  const { promptId: raw } = await params;
  const id = validateIdentifier(raw, "promptId", 200);
  if (!id.ok) {
    return apiError(id.error, { status: 400, headers: apiCorsHeaders() });
  }
  return apiOk(
    { titles: getPromptTitles(id.text) ?? {} },
    { headers: apiCorsHeaders() },
  );
}

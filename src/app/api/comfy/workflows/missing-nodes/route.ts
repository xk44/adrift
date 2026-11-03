/**
 * GET /api/comfy/workflows/missing-nodes[?fresh=1]
 *   → { ok, checked, packs: { [packId]: { [kind]: { file, format, missing[] } } },
 *       candidates: { [classType]: [{ id, label, source }] }, missingClassTypes[] }
 *
 * Reports, per workflow pack/mode, which node class_types the graph uses that
 * ComfyUI's /object_info does not know (custom node not installed). UI-format
 * graphs are flagged (format "ui") instead of judged. `fresh=1` refetches
 * /object_info. Candidates come from ComfyUI-Manager's node mappings when
 * Manager is available. GET-only against ComfyUI.
 */

import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { getPackNodeAvailability } from "@/lib/comfy/packNodeAvailability";

export function OPTIONS(): NextResponse {
  return apiOptions();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;

  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  return apiOk({ ...(await getPackNodeAvailability({ fresh })) });
}

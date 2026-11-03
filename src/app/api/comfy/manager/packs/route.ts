import { NextRequest, NextResponse } from "next/server";

import { apiCorsHeaders, apiError, apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { fetchManagerNodePacks } from "@/lib/comfy/manager";
import { blocklistCount } from "@/lib/comfy/nodeBlocklist";
import { withRateLimit } from "@/lib/rateLimit";

export function OPTIONS(): NextResponse {
  return apiOptions();
}

/** Browse the ComfyUI-Manager node-pack catalog, each annotated with its
 *  supply-chain blocklist status. Blocked packs still appear (so the UI can warn)
 *  but their install is refused at the choke point. */
export async function GET(request: NextRequest) {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 30 });
  if (!rl.ok) return rl.response;

  const cors = apiCorsHeaders(request);
  const modeParam = new URL(request.url).searchParams.get("mode");
  const mode =
    modeParam === "local" || modeParam === "remote" ? modeParam : "cache";

  try {
    const packs = await fetchManagerNodePacks(undefined, mode);
    const blockedCount = packs.filter((p) => p.blocked).length;
    return apiOk(
      {
        packs,
        total: packs.length,
        blockedInCatalog: blockedCount,
        blocklistSize: blocklistCount(),
      },
      { headers: cors },
    );
  } catch (caught) {
    return apiError(
      caught instanceof Error
        ? caught.message
        : "Failed to load node-pack catalog",
      { status: 502, headers: cors },
    );
  }
}

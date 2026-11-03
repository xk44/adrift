/**
 * GET /api/nevo/options
 * Proxies the NEvo backend's available objectives / ROIs / i2v families.
 * Returns empty lists (200) when the backend is offline so the UI degrades
 * gracefully instead of throwing.
 */
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { guardRoute } from "@/lib/routeGuard";

export async function GET(req: NextRequest) {
  const auth = guardRoute(req, { max: 60 });
  if (!auth.ok) return auth.response;
  try {
    const r = await fetch(`${env.NEVO_BACKEND_URL}/nevo/options`, {
      cache: "no-store",
      // offline fallback below only helps if a hung backend can't stall us
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) throw new Error(`backend ${r.status}`);
    const data = await r.json();
    // normalize snake_case -> camelCase the store expects
    return NextResponse.json({
      objectives: data.objectives ?? ["brain"],
      rois: data.rois ?? [],
      searchlightCounts: data.searchlight_counts ?? {},
      i2vFamilies: data.i2v_families ?? [],
    });
  } catch {
    return NextResponse.json({
      objectives: ["brain", "aesthetic", "clip"],
      rois: [],
      searchlightCounts: {},
      i2vFamilies: [],
      offline: true,
    });
  }
}

/**
 * POST /api/nevo/cancel/[job]
 * Forwards a cancellation request for a running NEvo search to the backend.
 */
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { guardRoute } from "@/lib/routeGuard";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ job: string }> },
) {
  const auth = guardRoute(req, { max: 30 });
  if (!auth.ok) return auth.response;
  const { job } = await params;
  try {
    const r = await fetch(
      `${env.NEVO_BACKEND_URL}/nevo/cancel/${encodeURIComponent(job)}`,
      {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
      },
    );
    return NextResponse.json(await r.json().catch(() => ({ ok: r.ok })), {
      status: r.ok ? 200 : r.status,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}

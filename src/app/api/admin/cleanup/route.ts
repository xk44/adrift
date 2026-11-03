import { NextRequest, NextResponse } from "next/server";
import { cleanupStaleFiles } from "@/lib/cleanup";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";

export async function POST(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(req, { windowMs: 60_000, max: 5 });
  if (!rl.ok) return rl.response;

  const summary = await cleanupStaleFiles();
  return NextResponse.json({ ok: true, ...summary });
}

import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/auth";
import { listSessions } from "@/lib/sessionRegistry";
import { withRateLimit } from "@/lib/rateLimit";

/**
 * GET /api/auth/devices — the paired devices (lib/sessionRegistry.ts), most
 * recently active first; the caller's own entry has `current: true`.
 * `enabled: false` when no ADMIN_API_KEY is set: sign-in is off, so there are
 * no devices to manage and the UI hides the section.
 */
export async function GET(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;

  if (!env.ADMIN_API_KEY) {
    return NextResponse.json({ ok: true, enabled: false, devices: [] });
  }
  const callerSid = auth.session?.payload.sid;
  const devices = listSessions().map((d) => ({
    sid: d.sid,
    label: d.label,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    current: !!callerSid && d.sid === callerSid,
  }));
  return NextResponse.json(
    { ok: true, enabled: true, devices },
    { headers: { "Cache-Control": "no-store" } },
  );
}

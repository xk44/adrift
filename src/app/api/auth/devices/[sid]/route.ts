import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookie, requireAdmin } from "@/lib/auth";
import { isValidSessionId, removeSession } from "@/lib/sessionRegistry";
import { withRateLimit } from "@/lib/rateLimit";

/**
 * DELETE /api/auth/devices/<sid> — unpair one device. Its session token stops
 * working on the next request. Unpairing your own device signs you out (the
 * session cookie is cleared too).
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ sid: string }> },
) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 20 });
  if (!rl.ok) return rl.response;

  const { sid } = await params;
  if (!isValidSessionId(sid)) {
    return NextResponse.json(
      { ok: false, error: "Unknown device" },
      { status: 404 },
    );
  }
  let removed: boolean;
  try {
    removed = removeSession(sid);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not save data/sessions.json" },
      { status: 500 },
    );
  }
  if (!removed) {
    return NextResponse.json(
      { ok: false, error: "Unknown device" },
      { status: 404 },
    );
  }
  const self = auth.session?.payload.sid === sid;
  const res = NextResponse.json({ ok: true, signedOut: self });
  if (self) clearSessionCookie(res);
  return res;
}

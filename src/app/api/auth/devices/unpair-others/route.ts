import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE_TTL_MS,
  requireAdmin,
  setSessionCookie,
} from "@/lib/auth";
import { bumpSessionGeneration } from "@/lib/runtimeSettings";
import {
  createSessionToken,
  newSessionId,
  resolveSessionSecret,
} from "@/lib/session";
import {
  deviceLabelFromUserAgent,
  isSessionPaired,
  registerSession,
  removeOtherSessions,
} from "@/lib/sessionRegistry";
import { withRateLimit } from "@/lib/rateLimit";

/**
 * POST /api/auth/devices/unpair-others — unpair every device except the
 * caller's, and bump the session generation so old tokens without a device id
 * stop working too. The caller gets a fresh token at the new generation (same
 * device id, same sign-in time) as a cookie and in the body, so it stays
 * signed in. A caller using the raw ADMIN_API_KEY keeps using the key.
 */
export async function POST(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 5 });
  if (!rl.ok) return rl.response;

  const caller = auth.session;
  const secret = resolveSessionSecret();
  // A legacy caller token (no sid) becomes a paired device so it survives.
  let keepSid = caller?.payload.sid;
  const authAt = caller ? (caller.payload.auth ?? caller.payload.iat) : Date.now();
  let removed = 0;
  let generation: number;
  try {
    if (caller && !keepSid) {
      keepSid = newSessionId();
      registerSession({
        sid: keepSid,
        label: deviceLabelFromUserAgent(req.headers.get("user-agent")),
        createdAt: authAt,
        lastSeenAt: Date.now(),
      });
    }
    removed = removeOtherSessions(keepSid);
    generation = bumpSessionGeneration();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not save the session files in data/" },
      { status: 500 },
    );
  }

  if (!caller || !secret || !keepSid || !isSessionPaired(keepSid)) {
    return NextResponse.json({ ok: true, removed });
  }
  const token = createSessionToken(secret, SESSION_COOKIE_TTL_MS, {
    authAt,
    generation,
    sid: keepSid,
  });
  const res = NextResponse.json({ ok: true, removed, token });
  if (caller.via === "cookie") setSessionCookie(res, req, token);
  return res;
}

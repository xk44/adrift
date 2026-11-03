import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  clearSessionCookie,
  readCookie,
  requireAdmin,
} from "@/lib/auth";
import { bumpSessionGeneration } from "@/lib/runtimeSettings";
import { resolveSessionSecret, verifySessionToken } from "@/lib/session";
import { clearSessions, removeSession } from "@/lib/sessionRegistry";
import { withRateLimit } from "@/lib/rateLimit";

/**
 * POST /api/auth/logout — clears the session cookie and unpairs this device
 * (removes the caller's sid from data/sessions.json). Always open: only a
 * token with a valid signature can name the device to remove.
 * POST /api/auth/logout?all=1 — also signs out every device: bumps the
 * session generation (lib/session.ts), which voids all issued session tokens,
 * and empties the device list. Needs admin auth.
 */
export async function POST(req: NextRequest) {
  if (req.nextUrl.searchParams.get("all") === "1") {
    const auth = requireAdmin(req);
    if (!auth.ok) return auth.response;
    const rl = withRateLimit(req, { windowMs: 60_000, max: 5 });
    if (!rl.ok) return rl.response;
    try {
      bumpSessionGeneration();
    } catch {
      return NextResponse.json(
        { ok: false, error: "Could not save data/runtime_settings.json" },
        { status: 500 },
      );
    }
    try {
      clearSessions();
    } catch {
      /* the generation bump already voided every token */
    }
  } else {
    const rl = withRateLimit(req, { windowMs: 60_000, max: 30 });
    if (!rl.ok) return rl.response;
    const secret = resolveSessionSecret();
    const authHeader = req.headers.get("authorization") ?? "";
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (secret) {
      for (const token of [bearer, readCookie(req, SESSION_COOKIE)]) {
        if (!token) continue;
        const res = verifySessionToken(token, secret);
        if (res.valid && typeof res.payload.sid === "string") {
          try {
            removeSession(res.payload.sid);
          } catch {
            return NextResponse.json(
              { ok: false, error: "Could not save data/sessions.json" },
              { status: 500 },
            );
          }
        }
      }
    }
  }
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}

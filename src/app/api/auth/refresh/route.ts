import { NextRequest, NextResponse } from "next/server";
import {
  refreshSessionToken,
  resolveSessionSecret,
  verifyPairedSessionToken,
} from "@/lib/session";
import { touchSession } from "@/lib/sessionRegistry";
import { withRateLimit } from "@/lib/rateLimit";

const unauthorized = (error: string) =>
  NextResponse.json({ ok: false, error }, { status: 401 });

export async function POST(req: NextRequest) {
  const rl = withRateLimit(req, { windowMs: 60_000, max: 20 });
  if (!rl.ok) return rl.response;
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) return unauthorized("Missing Bearer token");

  // No secret configured means no auth is configured: there is nothing to
  // refresh. Never sign with a public fallback constant: any client could
  // forge those tokens.
  const secret = resolveSessionSecret();
  if (!secret) return unauthorized("Session tokens are not configured");

  // Paired check too: an unpaired device cannot refresh its way back in.
  const verified = verifyPairedSessionToken(token, secret);
  if (!verified.valid) {
    return unauthorized("Invalid or expired token");
  }
  // A refresh call marks the device as seen (at most once a minute).
  if (verified.payload.sid) {
    try {
      touchSession(verified.payload.sid, { minIntervalMs: 60_000 });
    } catch {
      /* the activity mark is best-effort */
    }
  }

  const newToken = refreshSessionToken(token, secret);
  if (newToken) {
    return NextResponse.json({ ok: true, refreshed: true, token: newToken });
  }
  return NextResponse.json({ ok: true, refreshed: false });
}

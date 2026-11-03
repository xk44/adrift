import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import {
  createSessionToken,
  newSessionId,
  resolveSessionSecret,
} from "@/lib/session";
import {
  SESSION_COOKIE_TTL_MS,
  safeEqual,
  setSessionCookie,
} from "@/lib/auth";
import {
  deviceLabelFromUserAgent,
  registerSession,
} from "@/lib/sessionRegistry";
import { withRateLimit } from "@/lib/rateLimit";
import { BodyTooLargeError, readJsonCapped } from "@/lib/net/readCapped";

/** `{"api_key": "..."}` needs a few hundred bytes; anything past this is junk. */
const MAX_LOGIN_BODY_BYTES = 4 * 1024;

/**
 * Token in the JSON body (API clients) + httpOnly cookie (browser <img>).
 * Each sign-in is a new paired device (lib/sessionRegistry.ts): only a short
 * label derived from the User-Agent is stored, never the UA itself or the IP.
 */
function sessionResponse(req: NextRequest, secret: string) {
  const sid = newSessionId();
  const now = Date.now();
  try {
    registerSession({
      sid,
      label: deviceLabelFromUserAgent(req.headers.get("user-agent")),
      createdAt: now,
      lastSeenAt: now,
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not save data/sessions.json" },
      { status: 500 },
    );
  }
  const token = createSessionToken(secret, SESSION_COOKIE_TTL_MS, {
    authAt: now,
    sid,
  });
  const res = NextResponse.json({ ok: true, token });
  setSessionCookie(res, req, token);
  return res;
}

export async function POST(req: NextRequest) {
  const rl = withRateLimit(req, { windowMs: 60_000, max: 10 });
  if (!rl.ok) return rl.response;
  let body: unknown;
  try {
    body = await readJsonCapped(req, MAX_LOGIN_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return NextResponse.json(
        { ok: false, error: "Request body too large" },
        { status: 413 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "Invalid JSON" },
      { status: 400 },
    );
  }

  const { api_key } = (body ?? {}) as Record<string, unknown>;
  const configuredKey = env.ADMIN_API_KEY;

  // No admin key: there is nothing to check. Issue a token only when a real
  // SESSION_SECRET exists; never sign with a public fallback constant (anyone
  // could forge those). Fails closed, like /api/auth/refresh.
  if (!configuredKey) {
    const secret = resolveSessionSecret();
    if (!secret) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Sign-in is not set up. Set ADMIN_API_KEY in .env.local and restart.",
        },
        { status: 401 },
      );
    }
    return sessionResponse(req, secret);
  }

  if (typeof api_key !== "string" || !safeEqual(api_key, configuredKey)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const secret = resolveSessionSecret();
  return sessionResponse(req, secret);
}

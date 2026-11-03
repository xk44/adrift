import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import {
  verifyPairedSessionToken,
  resolveSessionSecret,
  type SessionPayload,
} from "@/lib/session";
import { ACTIVE_TOUCH_INTERVAL_MS, touchSession } from "@/lib/sessionRegistry";
import { isTrustedDevHost } from "@/lib/hostGuard";
import { isJudgeMode } from "@/lib/judge/judgePolicy";
import { judgeAuth } from "@/lib/judge/judgeServer";

/**
 * API Route Auth Policy Matrix
 *
 * All routes require admin auth (requireAdmin) unless marked PUBLIC below.
 * This is a single-user admin application — there is no concept of
 * unauthenticated public access to data routes.
 *
 * PUBLIC routes (intentionally no requireAdmin):
 *   GET  /api/health            — basic liveness (?nodes=1 needs auth)
 *   POST /api/auth/login        — login endpoint; rate-limited (10/min)
 *   POST /api/auth/logout       — clears the session cookie; ?all=1 (admin) signs out every device
 *   POST /api/auth/refresh      — JWT refresh; rate-limited (20/min)
 *
 * DEVICE routes (requireAdmin; see lib/sessionRegistry.ts):
 *   GET    /api/auth/devices                — 60/min, list paired devices
 *   DELETE /api/auth/devices/[sid]          — 20/min, unpair one (self = sign out)
 *   POST   /api/auth/devices/unpair-others  — 5/min, unpair the rest + bump gen
 *
 * ADMIN routes (requireAdmin + withRateLimit):
 *   POST   /api/admin/cleanup                        — 5/min
 *   GET    /api/civitai/auth                          — 60/min
 *   PUT    /api/civitai/auth                          — 10/min
 *   PATCH  /api/civitai/auth                          — 15/min
 *   DELETE /api/civitai/auth                          — 10/min
 *   POST   /api/civitai/download                      — 10/min
 *   GET    /api/civitai/hash                          — 60/min
 *   GET    /api/civitai/images                        — 60/min
 *   GET    /api/civitai/models                        — 60/min
 *   GET    /api/civitai/models/[id]                   — 60/min
 *   POST   /api/civitai/save-image                    — 20/min
 *   POST   /api/civitai/seed                          — 5/min
 *   GET    /api/comfy/history/[promptId]               — 120/min
 *   GET    /api/comfy/image                           — 120/min
 *   GET    /api/comfy/models                          — 20/min
 *   GET    /api/comfy/[...path]                       — 60/min
 *   POST   /api/comfy/[...path]                       — 20/min
 *   GET    /api/comfy/progress                        — 30/min
 *   POST   /api/comfy/workflows/missing-nodes/install — 10/min
 *   GET    /api/comfy/workflows                       — 60/min
 *   GET    /api/hf/models                             — 60/min
 *   POST   /api/jobs/action                           — 30/min
 *   POST   /api/jobs/imagine                          — 30/min
 *   POST   /api/jobs/inpaint                          — 15/min
 *   POST   /api/jobs/krea2                            — 12/min
 *   GET    /api/moodboards                            — (no RL, low volume)
 *   POST   /api/moodboards                            — (no RL, low volume)
 *   PUT    /api/moodboards                            — (no RL, low volume)
 *   DELETE /api/moodboards                            — (no RL, low volume)
 *   GET    /api/moodboards/upload                     — (no RL, static files)
 *   POST   /api/moodboards/upload                     — (no RL, low volume)
 *   GET    /api/params                                — (no RL, static data)
 *   GET    /api/style/codes                           — 120/min
 *   POST   /api/style/codes                           — 30/min
 *   DELETE /api/style/codes                           — 15/min
 *   GET    /api/style/export                          — 30/min
 *   POST   /api/style/import                          — 10/min
 *   GET    /api/style/loras                           — 120/min
 *   POST   /api/style/loras                           — 30/min
 *   DELETE /api/style/loras                           — 15/min
 *   PATCH  /api/style/loras                           — 30/min
 *   GET    /api/style/preview                         — 60/min
 *   POST   /api/style/preview                         — 10/min
 *   ALL    /api/vault/[...path]                       — 60/min GET, 20/min mutate
 *
 * OPTIONS handlers: Return CORS preflight responses, no auth required (per spec).
 */

/** Name of the httpOnly session cookie minted by POST /api/auth/login. */
export const SESSION_COOKIE = "cj_session";

/** Browser session lifetime (cookie Max-Age and signed-token exp). */
export const SESSION_COOKIE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function isHttps(req: NextRequest): boolean {
  const proto = req.headers.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim() === "https";
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Set the httpOnly session cookie on a response. */
export function setSessionCookie(
  res: NextResponse,
  req: NextRequest,
  token: string,
): void {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: isHttps(req),
    maxAge: Math.floor(SESSION_COOKIE_TTL_MS / 1000),
  });
}

/** Clear the session cookie on a response. */
export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/** Read one cookie value from the Cookie header (works for any Request). */
export function readCookie(req: NextRequest, name: string): string {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return "";
      }
    }
  }
  return "";
}

/** Constant-time string compare (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

type AuthResult =
  | {
      ok: true;
      /** The verified session token and its payload, when one authenticated the call. */
      session?: { token: string; payload: SessionPayload; via: "bearer" | "cookie" };
    }
  | { ok: false; response: NextResponse };

/**
 * Accepts ANY of: Authorization: Bearer <ADMIN_API_KEY>, Bearer <session
 * token>, or the httpOnly `cj_session` cookie (token minted by /api/auth/login).
 * If ADMIN_API_KEY is unset (dev mode), all requests pass unless the Host
 * header is a foreign DNS name (DNS-rebinding guard, see lib/hostGuard.ts).
 */
function isSafeMethod(req: NextRequest): boolean {
  const m = (req.method || "GET").toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

/** True when Origin (or Referer fallback) matches the request's own origin. */
function sameOrigin(req: NextRequest): boolean {
  const src = req.headers.get("origin") || req.headers.get("referer");
  if (!src) return false;
  try {
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || new URL(req.url).host;
    return new URL(src).host === host;
  } catch {
    return false;
  }
}

export function requireAdmin(req: NextRequest): AuthResult {
  // Judge mode (lib/judge): only a judge cookie on an allowlisted route
  // passes; the admin key and session cookies unlock nothing here.
  if (isJudgeMode()) return judgeAuth(req);

  const apiKey = env.ADMIN_API_KEY;

  // Dev mode — no key configured, allow all, except requests whose Host is
  // a foreign DNS name (DNS rebinding: a web page re-pointed at this server).
  if (!apiKey) {
    let host = req.headers.get("host");
    if (!host) {
      try {
        host = new URL(req.url).host;
      } catch {
        host = null;
      }
    }
    if (isTrustedDevHost(host)) return { ok: true };
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          error:
            "Untrusted Host header. Set ADMIN_API_KEY, or add this hostname to CJ_ALLOWED_HOSTS.",
        },
        { status: 403 },
      ),
    };
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  // Cookie auth on unsafe methods needs a same-origin Origin/Referer: SameSite=Lax
  // still sends the cookie from other ports on the same host (same-site), so a
  // page on another local port could otherwise CSRF a mutation.
  const cookie = isSafeMethod(req) || sameOrigin(req) ? readCookie(req, SESSION_COOKIE) : "";

  // 1. Raw API key match
  if (bearer && safeEqual(bearer, apiKey)) return { ok: true };

  // 2. Signed session token: Bearer (API clients) or httpOnly cookie
  //    (browser, so <img src> loads authenticate without a key in the URL).
  const secret = resolveSessionSecret();
  if (secret) {
    for (const [token, via] of [
      [bearer, "bearer"],
      [cookie, "cookie"],
    ] as const) {
      if (!token) continue;
      const res = verifyPairedSessionToken(token, secret);
      if (!res.valid) continue;
      // Hourly "still active" mark for the device list (no per-request writes).
      if (res.payload.sid) {
        try {
          touchSession(res.payload.sid, {
            minIntervalMs: ACTIVE_TOUCH_INTERVAL_MS,
          });
        } catch {
          /* a failed activity mark never blocks a request */
        }
      }
      return { ok: true, session: { token, payload: res.payload, via } };
    }
  }

  return {
    ok: false,
    response: NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    ),
  };
}

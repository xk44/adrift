/**
 * One-call guard for API routes: per-client rate limit, then requireAdmin.
 * Rate limiting runs first so unauthenticated floods are cheap to refuse;
 * failed-auth callers count in their own buckets (lib/rateLimit authScope),
 * so a flood can't lock the owner out.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { isLoopbackHostname } from "@/lib/net/bindPolicy";
import { hostnameOf } from "@/lib/hostGuard";
import { isJudgeMode } from "@/lib/judge/judgePolicy";

type GuardResult = { ok: true } | { ok: false; response: NextResponse };

export function guardRoute(
  req: NextRequest,
  limit: { max: number; windowMs?: number },
): GuardResult {
  const rl = withRateLimit(req, { windowMs: limit.windowMs ?? 60_000, max: limit.max });
  if (!rl.ok) return rl;
  return requireAdmin(req);
}

/**
 * True when the request comes from this machine: the Host is loopback and
 * every X-Forwarded-For hop (Next fills it with the socket address when the
 * client sent none) is loopback. With the default 127.0.0.1 bind nothing else
 * can connect; on a wider bind this is defence in depth behind ADMIN_API_KEY,
 * since a key holder could forge both headers.
 */
export function isLoopbackRequest(req: NextRequest): boolean {
  // Judge mode: a tunnel connector on this machine makes every judge look
  // local, so "from this computer" proves nothing.
  if (isJudgeMode()) return false;
  const host = req.headers.get("host") ?? req.nextUrl.host;
  if (!host || !isLoopbackHostname(hostnameOf(host))) return false;
  const hops = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return hops.every((h) => isLoopbackHostname(h.replace(/^::ffff:/i, "")));
}

export function loopbackOnly(req: NextRequest): GuardResult {
  if (isLoopbackRequest(req)) return { ok: true };
  return {
    ok: false,
    response: NextResponse.json(
      { ok: false, error: "This control only works from the computer running Adrift." },
      { status: 403 },
    ),
  };
}

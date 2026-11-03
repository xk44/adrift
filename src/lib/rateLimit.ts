import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";

interface BucketEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, BucketEntry>();

// Clean up expired entries every 60s (unref so it doesn't block process exit)
const _cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
}, 60_000);
if (typeof _cleanup === "object" && "unref" in _cleanup) _cleanup.unref();

export function resetRateLimits(): void {
  store.clear();
}

export function rateLimit(
  identifier: string,
  opts: { windowMs: number; max: number },
): { ok: boolean; remaining: number } {
  const now = Date.now();
  const entry = store.get(identifier);

  if (!entry || entry.resetAt <= now) {
    store.set(identifier, { count: 1, resetAt: now + opts.windowMs });
    return { ok: true, remaining: opts.max - 1 };
  }

  if (entry.count >= opts.max) {
    return { ok: false, remaining: 0 };
  }

  entry.count += 1;
  return { ok: true, remaining: opts.max - entry.count };
}

/**
 * Who is calling, for rate-limit buckets. X-Forwarded-For / X-Real-IP are
 * client-controlled unless a reverse proxy you run rewrites them, so they
 * count only with TRUST_PROXY=1 — then the LAST XFF hop (the address that
 * proxy saw) is used. Without it every caller shares one "direct" bucket per
 * route: a spoofed header can't mint fresh buckets.
 */
export function clientIdentity(req: NextRequest): string {
  if (!/^(1|true|yes)$/i.test(process.env.TRUST_PROXY?.trim() ?? "")) {
    return "direct";
  }
  const hops = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return hops[hops.length - 1] || req.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Without TRUST_PROXY every caller shares one identity, so an
 * unauthenticated flood would exhaust the owner's buckets too. Callers that
 * fail auth are counted in their own "unauth"
 * buckets; authenticated calls never pay for them.
 */
function authScope(req: NextRequest): string {
  try {
    return requireAdmin(req).ok ? "" : "unauth:";
  } catch {
    return "unauth:";
  }
}

/**
 * Bucket key for withRateLimit. Scoped per client IP *and* per route+method
 * (+ limit shape) so that e.g. 120/min image polling can't exhaust the 10/min
 * login budget or vice versa.
 */
export function rateLimitKey(
  req: NextRequest,
  opts: { windowMs: number; max: number },
): string {
  const ip = authScope(req) + clientIdentity(req);
  let route = "";
  try {
    // First 3 segments ("api/comfy/history") — dynamic tails like
    // /history/<promptId> or /vault/<...path> share their route's bucket.
    route = new URL(req.url).pathname.split("/").filter(Boolean).slice(0, 3).join("/");
  } catch {
    route = "";
  }
  return `${ip}|${req.method}|${route}|${opts.max}/${opts.windowMs}`;
}

type RateLimitResult = { ok: true } | { ok: false; response: NextResponse };

export function withRateLimit(
  req: NextRequest,
  opts: { windowMs: number; max: number },
): RateLimitResult {
  const result = rateLimit(rateLimitKey(req, opts), opts);

  if (!result.ok) {
    const retryAfter = Math.ceil(opts.windowMs / 1000);
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "Too many requests" },
        {
          status: 429,
          headers: { "Retry-After": String(retryAfter) },
        },
      ),
    };
  }

  return { ok: true };
}

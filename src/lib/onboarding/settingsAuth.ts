/**
 * Who may change (or test) the ComfyUI connection.
 *
 * - ADMIN_API_KEY set: the usual admin check (API key, session token, or the
 *   session cookie, which requireAdmin only honours same-origin on writes).
 * - No ADMIN_API_KEY (dev mode): loopback only. The Host header and any
 *   forwarding headers must be loopback, and a browser request must come from
 *   the same origin. Dev mode already lets every client that can reach the
 *   server use every route, so this is a narrowing, not the boundary: set
 *   ADMIN_API_KEY on any machine others can reach.
 *
 * middleware.ts additionally enforces its CSRF rule on all /api writes.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { isLoopbackHost } from "./comfyUrl";

export type SettingsAuth = { ok: true } | { ok: false; response: NextResponse };

function deny(status: number, error: string): SettingsAuth {
  return {
    ok: false,
    response: NextResponse.json({ ok: false, error }, { status }),
  };
}

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

function hostnameFromHostHeader(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0];
}

/** Browser requests must be same-origin (Origin, else Referer, matches Host). */
export function isSameOrigin(req: NextRequest): boolean {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  const origin = req.headers.get("origin");
  if (origin && origin !== "null") return hostOf(origin) === host;
  if (origin === "null") return false;
  const referer = req.headers.get("referer");
  if (referer) return hostOf(referer) === host;
  return true; // non-browser client (curl); middleware's CSRF rule still applies
}

/** Host and forwarding headers all point at this machine. */
export function isLoopbackRequest(req: NextRequest): boolean {
  const host = req.headers.get("host");
  if (
    !host ||
    !isLoopbackHost(hostnameFromHostHeader(host).replace(/^\[|\]$/g, ""))
  )
    return false;
  const fwd = [
    ...(req.headers.get("x-forwarded-for") ?? "").split(","),
    req.headers.get("x-real-ip") ?? "",
  ]
    .map((s) => s.trim())
    .filter(Boolean);
  return fwd.every((ip) => isLoopbackHost(ip.replace(/^::ffff:/, "")));
}

export function requireSettingsWrite(req: NextRequest): SettingsAuth {
  const admin = requireAdmin(req);
  if (!admin.ok) return admin;
  const bearer = (req.headers.get("authorization") ?? "").startsWith("Bearer ");
  if (!bearer && !isSameOrigin(req))
    return deny(403, "Cross-origin request refused.");
  if (!env.ADMIN_API_KEY && !isLoopbackRequest(req))
    return deny(
      403,
      "Open Adrift on the computer it runs on (localhost) to change this, or set ADMIN_API_KEY.",
    );
  return { ok: true };
}

/**
 * Client-sent X-Forwarded-For / X-Real-IP are lies until a proxy you run
 * rewrites them. Next only fills X-Forwarded-For when it is absent
 * (`??=`), so a remote caller could send `X-Forwarded-For: 127.0.0.1` and
 * pass the loopback checks (routeGuard.isLoopbackRequest,
 * settingsAuth.isLoopbackRequest). Unless TRUST_PROXY is set, every
 * incoming request has X-Forwarded-For replaced with the real socket
 * address and X-Real-IP removed, before Next sees it.
 *
 * Node-only; installed from instrumentation.register().
 */
import type { IncomingMessage } from "http";

export function trustProxy(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes)$/i.test(env.TRUST_PROXY?.trim() ?? "");
}

/** Overwrite forwarding headers with what the socket actually says. */
export function sanitizeForwardedHeaders(req: IncomingMessage): void {
  const remote = req.socket?.remoteAddress ?? "";
  delete req.headers["x-real-ip"];
  if (remote) req.headers["x-forwarded-for"] = remote;
  else delete req.headers["x-forwarded-for"];
  // rawHeaders is what some code paths re-read; drop the client copies.
  const raw = req.rawHeaders;
  if (Array.isArray(raw)) {
    const kept: string[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const name = raw[i].toLowerCase();
      if (name === "x-forwarded-for" || name === "x-real-ip") continue;
      kept.push(raw[i], raw[i + 1]);
    }
    if (remote) kept.push("X-Forwarded-For", remote);
    raw.length = 0;
    raw.push(...kept);
  }
}

const INSTALLED = Symbol.for("adrift.forwardedHeadersInstalled");

type EmitFn = (this: unknown, event: string | symbol, ...args: unknown[]) => boolean;

/**
 * Wrap `emit` on the http and https Server prototypes so "request" and
 * "upgrade" events see sanitized headers. Idempotent. No-op with TRUST_PROXY.
 */
export function installForwardedHeaderGuard(
  protos: Array<{ emit: EmitFn }>,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (trustProxy(env)) return false;
  for (const proto of protos) {
    const tagged = proto as { emit: EmitFn; [INSTALLED]?: boolean };
    if (tagged[INSTALLED]) continue;
    const original = proto.emit;
    proto.emit = function (this: unknown, event: string | symbol, ...args: unknown[]) {
      if ((event === "request" || event === "upgrade") && args[0]) {
        try {
          sanitizeForwardedHeaders(args[0] as IncomingMessage);
        } catch {
          // never break request handling over a header rewrite
        }
      }
      return original.call(this, event, ...args);
    };
    tagged[INSTALLED] = true;
  }
  return true;
}

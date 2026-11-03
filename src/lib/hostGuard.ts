/**
 * DNS-rebinding guard for the no-auth dev mode (ADMIN_API_KEY unset).
 *
 * Without a key every API route is open. A malicious web page can point its
 * own domain at 127.0.0.1 (DNS rebinding); the browser then treats the
 * attacker's page and this server as the same origin, so the CSRF origin
 * check passes and the page can drive the API (queue jobs, download models,
 * install node packs). The tell is the Host header: it carries the
 * attacker's domain name.
 *
 * Trusted Host names: localhost / *.localhost, 127.0.0.0/8 and [::1], plus
 * anything listed in CJ_ALLOWED_HOSTS (comma or space separated hostnames,
 * "*" disables the guard). LAN IPs, *.local names and arbitrary DNS names
 * are rejected until ADMIN_API_KEY is set: an IP-literal Host proves nothing
 * about who is calling (any LAN device can send it), and no-key mode is
 * meant for this machine only.
 */

import { isLoopbackHostname } from "@/lib/net/bindPolicy";

/** Hostname (lowercase, no port, no trailing dot) from a Host header value. */
export function hostnameOf(hostHeader: string): string {
  const raw = hostHeader.trim().toLowerCase();
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end > 0 ? raw.slice(0, end + 1) : raw;
  }
  const colon = raw.lastIndexOf(":");
  const host = colon >= 0 ? raw.slice(0, colon) : raw;
  return host.replace(/\.$/, "");
}

export function isTrustedDevHost(
  hostHeader: string | null | undefined,
  allowList: string | undefined = process.env.CJ_ALLOWED_HOSTS,
): boolean {
  if (!hostHeader) return false;
  const extra = (allowList ?? "")
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
  if (extra.includes("*")) return true;

  const hostname = hostnameOf(hostHeader);
  if (!hostname) return false;
  if (isLoopbackHostname(hostname)) return true;
  return extra.includes(hostname);
}

/**
 * Bind-address policy. Edge-safe (no Node imports): used by middleware,
 * instrumentation and scripts/serve.mjs mirrors the same rule.
 *
 * `npm run dev` / `npm run start` go through scripts/serve.mjs, which binds
 * to CJ_HOST (default 127.0.0.1) and exports CJ_HOST to the server. Binding
 * anywhere else (a LAN IP, 0.0.0.0, ::) makes the API reachable from other
 * machines, so ADMIN_API_KEY becomes mandatory.
 */

const IPV4_LOOPBACK_RE = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Hostname (no port, no brackets) that only ever means this machine. */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    IPV4_LOOPBACK_RE.test(h) ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1" ||
    h === "::ffff:127.0.0.1"
  );
}

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

/**
 * The address the server is exposed on (empty = unknown / not via serve.mjs).
 * CJ_HOST wins (serve.mjs exports it; docker-compose sets it to the published
 * BIND_ADDR). Otherwise a wildcard HOSTNAME — what the standalone server.js
 * binds to, as in the Docker image — counts as "every interface". A
 * non-wildcard HOSTNAME is ignored: shells and containers set it to the
 * machine name.
 */
export function configuredBindHost(): string {
  const cj = process.env.CJ_HOST?.trim();
  if (cj) return cj;
  const h = process.env.HOSTNAME?.trim() ?? "";
  return WILDCARD_HOSTS.has(h) ? h : "";
}

export function hasAdminKey(): boolean {
  return !!process.env.ADMIN_API_KEY?.trim();
}

/** True when the server is bound beyond loopback but no ADMIN_API_KEY is set. */
export function bindRequiresKey(): boolean {
  const host = configuredBindHost();
  return !!host && !isLoopbackHostname(host) && !hasAdminKey();
}

export function bindWithoutKeyMessage(host = configuredBindHost()): string {
  return (
    `Adrift is listening on ${host || "a network address"}, which other devices can reach, ` +
    `but ADMIN_API_KEY is not set. Set ADMIN_API_KEY in .env.local (for example ` +
    `the output of "openssl rand -hex 32"), or start with "npm run dev" / "npm run start" ` +
    `(no CJ_HOST) to stay on 127.0.0.1.`
  );
}

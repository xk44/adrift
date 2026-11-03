/**
 * How a route calls another route on this same server (e.g. style previews
 * queueing through /api/jobs/imagine). Edge-safe.
 *
 * - Base URL: the CJ_HOST address when it names a specific interface (the
 *   server listens only there), else 127.0.0.1. Under the standalone
 *   server.js (Docker) the server binds the wildcard HOSTNAME and CJ_HOST is
 *   only the host-side publish address, so 127.0.0.1 is used. Never "localhost", which can
 *   resolve to ::1 while the server listens on 127.0.0.1.
 * - Headers: X-Requested-With so the CSRF middleware accepts the call in
 *   no-key mode (a server-side fetch sends no Origin/Referer), plus the
 *   admin key as a bearer when one is configured.
 */
export function selfBaseUrl(): string {
  const port = process.env.PORT?.trim() || "3000";
  const hostnameEnv = process.env.HOSTNAME?.trim() ?? "";
  const listensEverywhere = hostnameEnv === "0.0.0.0" || hostnameEnv === "::" || hostnameEnv === "[::]";
  const host = listensEverywhere ? "" : (process.env.CJ_HOST?.trim().replace(/^\[|\]$/g, "") ?? "");
  const wildcard = !host || host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0";
  const h = wildcard ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

export function selfRequestHeaders(
  adminKey: string | undefined = process.env.ADMIN_API_KEY,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
  };
  const key = adminKey?.trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

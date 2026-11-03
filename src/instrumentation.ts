/**
 * Runs once when the Next server boots. Importing env triggers
 * runStartupChecks(), so the "ADMIN_API_KEY not set" warning prints at
 * startup instead of on the first request.
 *
 * It also refuses to boot without ADMIN_API_KEY unless the server is known
 * to listen on loopback only: CJ_HOST (serve.mjs / docker-compose) when set,
 * else the -H flag / Next's origin / a wildcard HOSTNAME (lib/bindHost). A
 * bare `next dev` / `next start` with no -H listens on every interface, so it
 * needs a key (or `npm run dev`, which binds 127.0.0.1).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bindWithoutKeyMessage, configuredBindHost, hasAdminKey, isLoopbackHostname } =
      await import("@/lib/net/bindPolicy");
    if (!hasAdminKey()) {
      const configured = process.env.CJ_HOST?.trim();
      let host: string | null;
      let loopback: boolean;
      if (configured) {
        host = configured;
        loopback = isLoopbackHostname(configured);
      } else {
        const { resolveBindHost } = await import("@/lib/bindHost");
        const bind = resolveBindHost();
        host = bind.host ?? (configuredBindHost() || null);
        loopback = bind.kind === "loopback";
      }
      if (!loopback) {
        console.error(`\n${bindWithoutKeyMessage(host ?? "")}\n`);
        process.exit(1);
      }
    }
    // Drop client-forged X-Forwarded-For / X-Real-IP (unless TRUST_PROXY).
    const http = await import("http");
    const https = await import("https");
    const { installForwardedHeaderGuard } = await import("@/lib/net/forwardedHeaders");
    installForwardedHeaderGuard([
      http.Server.prototype as never,
      https.Server.prototype as never,
    ]);
    await import("@/lib/env");
  }
}

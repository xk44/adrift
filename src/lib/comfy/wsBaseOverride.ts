/**
 * Client-side WebSocket base override, set from the ComfyUI connection the
 * first-run wizard saved (GET /api/settings/comfy-connection).
 *
 * The browser bundle always sees NEXT_PUBLIC_COMFY_WS_BASE (next.config.ts
 * gives it a default), so it cannot tell an explicit setting from the default.
 * The server can: it only returns a `wsBase` when the env var was NOT set
 * explicitly and a URL was saved. An explicit env var therefore still wins.
 *
 * Client-safe, no imports.
 */

let override: string | null = null;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Turn the server-reported ws base into the URL this browser should use.
 * A loopback host means "the machine running Adrift": when the page is opened
 * from another device, swap in the page's hostname (keeping the port), the
 * same way the default ":8188" derivation does.
 */
export function browserWsBase(
  wsBase: string,
  pageHostname?: string,
): string | null {
  let u: URL;
  try {
    u = new URL(wsBase);
  } catch {
    return null;
  }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
  if (pageHostname && LOOPBACK.has(u.hostname) && !LOOPBACK.has(pageHostname)) {
    const host = pageHostname.includes(":")
      ? `[${pageHostname}]`
      : pageHostname;
    u.hostname = host;
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

/** Set (or clear with null) the override. Returns true when it changed. */
export function setComfyWsBaseOverride(wsBase: string | null): boolean {
  const pageHost =
    typeof window !== "undefined" ? window.location.hostname : undefined;
  const next = wsBase ? browserWsBase(wsBase, pageHost) : null;
  if (next === override) return false;
  override = next;
  return true;
}

export function getComfyWsBaseOverride(): string | null {
  return override;
}

/**
 * Validation for the ComfyUI address a user types in the first-run wizard.
 * Pure and client-safe: the wizard uses it for inline hints, the settings
 * route uses it as the authority.
 */

export type ConnectionMode = "local" | "lan" | "wan";

export type ComfyUrlResult =
  { ok: true; url: string; warning?: string } | { ok: false; error: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(h) || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** RFC 1918 / link-local / CGNAT (Tailscale) / .local / IPv6 ULA. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHost(h)) return true;
  if (h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home.arpa"))
    return true;
  if (h.endsWith(".ts.net")) return true; // Tailscale MagicDNS
  if (!h.includes(".") && !h.includes(":")) return true; // bare LAN name
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
}

/**
 * Normalize what someone typed into a ComfyUI base URL.
 * Accepts "192.168.1.20", "192.168.1.20:8188", "box.local:8000",
 * "http://host:8188/", "https://comfy.example.com". A missing scheme means
 * http (https for internet mode); a missing port on plain http means 8188.
 */
export function normalizeComfyUrl(
  input: string,
  mode: ConnectionMode = "lan",
): ComfyUrlResult {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, error: "Enter an address." };
  if (raw.length > 2048)
    return { ok: false, error: "That address is too long." };
  if (/\s/.test(raw))
    return { ok: false, error: "Addresses can't contain spaces." };
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (hasScheme && !/^https?:\/\//i.test(raw))
    return {
      ok: false,
      error: "Use an address that starts with http:// or https://.",
    };
  const withScheme = hasScheme
    ? raw
    : `${mode === "wan" ? "https" : "http"}://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return { ok: false, error: "That doesn't look like an address." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return {
      ok: false,
      error: "Use an address that starts with http:// or https://.",
    };
  if (u.username || u.password)
    return {
      ok: false,
      error:
        "Don't put a username or password in the address. Use the token field instead.",
    };
  if (u.search || u.hash)
    return {
      ok: false,
      error: "Leave out anything after ? or # in the address.",
    };
  if (!u.hostname)
    return { ok: false, error: "The address needs a host name." };
  if (!hasScheme && !u.port && u.protocol === "http:") u.port = "8188";
  const path = u.pathname.replace(/\/+$/, "");
  const url = `${u.protocol}//${u.host}${path}`;

  // Any mode: a public host over plain http leaks prompts and the token,
  // whatever the user called it ("Network" with a public IP included).
  const warning =
    u.protocol === "http:" && !isPrivateHost(u.hostname)
      ? INSECURE_HTTP_WARNING
      : undefined;
  return warning ? { ok: true, url, warning } : { ok: true, url };
}

export const INSECURE_HTTP_WARNING =
  "This address isn't encrypted (http). Anyone on the way can see your prompts and token. Use https.";

/**
 * The warning a save of this address would come back with, or null. The
 * wizard asks for an explicit "I understand" before saving such an address
 * without testing it first.
 */
export function insecureUrlWarning(
  input: string,
  mode: ConnectionMode,
): string | null {
  const r = normalizeComfyUrl(input, mode);
  return r.ok ? (r.warning ?? null) : null;
}

/** A bearer token is optional; when given it must be one printable line. */
export function validateToken(
  token: unknown,
): string | null | { error: string } {
  if (token === undefined || token === null || token === "") return null;
  if (typeof token !== "string") return { error: "The token must be text." };
  const t = token.trim();
  if (!t) return null;
  if (t.length > 4096) return { error: "That token is too long." };
  if (!/^[\x21-\x7e]+$/.test(t))
    return { error: "The token can't contain spaces or special characters." };
  return t;
}

/** The candidates the "This computer" option probes, in order. */
export const LOCAL_PROBE_URLS = [
  "http://127.0.0.1:8188", // ComfyUI (portable / git / start-comfyui.sh)
  "http://127.0.0.1:8000", // ComfyUI Desktop
] as const;

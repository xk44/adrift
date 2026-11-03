/**
 * Single server-side entry point for HTTP calls to ComfyUI.
 *
 * - Prefixes the configured base URL (env COMFY_HTTP_URL, or an explicit
 *   `baseUrl` such as the H3 warm backend).
 * - When env COMFY_BEARER is set, adds `Authorization: Bearer <token>` so
 *   Adrift can talk to a ComfyUI behind an auth-checking reverse proxy.
 * - Extra machines saved in Settings (runtime `comfyInstances`) get only
 *   their own saved token, never the main connection's.
 *
 * The token is read per call (never cached in a client bundle, never logged)
 * and only attached to requests aimed at a configured ComfyUI base: absolute
 * URLs on any other origin go out untouched.
 *
 * WebSocket limitation: the browser connects to ComfyUI's /ws directly
 * (NEXT_PUBLIC_COMFY_WS_BASE) and the token is deliberately never exposed to
 * the client; the server-side WS progress proxy does not send it either. With
 * COMFY_BEARER set, an auth-enforcing proxy must allow /ws without the token
 * (e.g. LAN-only) for live progress to work.
 *
 * Server-side only — do not import from client components.
 */
import { env } from "@/lib/env";
import {
  runtimeComfyToken,
  runtimeInstanceToken,
} from "@/lib/runtimeSettings";

export interface ComfyFetchInit extends RequestInit {
  /** Override the ComfyUI base URL (e.g. the H3 warm backend). */
  baseUrl?: string;
}

/** Configured ComfyUI base URL without a trailing slash. */
export function comfyBaseUrl(): string {
  return env.COMFY_HTTP_URL.replace(/\/+$/, "");
}

/**
 * Bearer token for ComfyUI, if configured. Never log the return value.
 * Env COMFY_BEARER wins; else the token saved with the wizard's connection
 * (only while that saved URL is the one in use).
 */
function comfyBearer(): string | undefined {
  const token = process.env.COMFY_BEARER?.trim() || runtimeComfyToken();
  return token ? token : undefined;
}

export function isComfyAuthConfigured(): boolean {
  return comfyBearer() !== undefined;
}

/**
 * Token for requests to `baseUrl`: the main backend (and the env video host,
 * the warm process, any other base) use the main rule above; a saved extra
 * machine uses its own token or none.
 */
function bearerFor(baseUrl: string): string | undefined {
  const base = baseUrl.replace(/\/+$/, "");
  if (base === comfyBaseUrl()) return comfyBearer();
  const video = process.env.COMFY_VIDEO_HTTP_URL?.trim().replace(/\/+$/, "");
  if (video && base === video) return comfyBearer();
  const inst = runtimeInstanceToken(base);
  return inst.found ? inst.token : comfyBearer();
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Absolute URL for a ComfyUI path ("/object_info", "/view?..."). */
export function comfyUrl(
  path: string,
  baseUrl: string = comfyBaseUrl(),
): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Returns `init` with the ComfyUI Authorization header applied when a token is
 * configured (overriding any caller-supplied Authorization). Without a token
 * the init is returned unchanged.
 */
export function withComfyAuth(
  init: RequestInit = {},
  baseUrl?: string,
): RequestInit {
  const token = baseUrl === undefined ? comfyBearer() : bearerFor(baseUrl);
  if (!token) return init;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

/**
 * fetch() against ComfyUI. `pathOrUrl` is either a path ("/history?max_items=5")
 * resolved against the configured base, or an absolute URL — which only gets
 * the bearer token when its origin matches the configured (or given) base.
 */
export function comfyFetch(
  pathOrUrl: string,
  init: ComfyFetchInit = {},
): Promise<Response> {
  const { baseUrl, ...rest } = init;
  const base = (baseUrl ?? comfyBaseUrl()).replace(/\/+$/, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl)) {
    const target = originOf(pathOrUrl);
    if (target !== null && target === originOf(base))
      return fetch(pathOrUrl, withComfyAuth(rest, base));
    if (target !== null && target === originOf(comfyBaseUrl()))
      return fetch(pathOrUrl, withComfyAuth(rest, comfyBaseUrl()));
    return fetch(pathOrUrl, rest);
  }
  return fetch(comfyUrl(pathOrUrl, base), withComfyAuth(rest, base));
}

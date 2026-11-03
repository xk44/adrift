/**
 * Cross-origin policy for API responses. Edge/client-safe (no Node imports).
 *
 * Allow-Origin is sent only for:
 *  - the app's own origin (same host as the request), and
 *  - the configured ComfyUI origin exactly (the overlay bridge): the origin of
 *    COMFY_HTTP_URL, plus any exact origins in CJ_COMFY_ORIGINS (space or
 *    comma separated) for when the browser reaches ComfyUI under another name.
 * Other localhost ports are NOT trusted: any local web app (or a ComfyUI
 * custom-node frontend on another port) could otherwise read API responses.
 */

function originOf(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function allowedComfyOrigins(): Set<string> {
  const out = new Set<string>();
  const comfy = originOf(process.env.COMFY_HTTP_URL?.trim() || "http://127.0.0.1:8188");
  if (comfy) out.add(comfy);
  for (const raw of (process.env.CJ_COMFY_ORIGINS ?? "").split(/[\s,]+/)) {
    const o = raw ? originOf(raw) : null;
    if (o) out.add(o);
  }
  return out;
}

/**
 * The Origin value to echo in Access-Control-Allow-Origin, or null.
 * `requestHost` is the request's Host header (falls back to the URL host).
 */
export function corsAllowOrigin(
  origin: string | null,
  requestUrl: string,
  requestHost?: string | null,
): string | null {
  if (!origin) return null;
  const o = originOf(origin);
  if (!o) return null;
  try {
    const host = (requestHost || new URL(requestUrl).host).toLowerCase();
    if (new URL(o).host.toLowerCase() === host) return o;
  } catch {
    return null;
  }
  return allowedComfyOrigins().has(o) ? o : null;
}

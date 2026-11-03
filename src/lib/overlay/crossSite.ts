/**
 * Overlay login across hosts. Adrift's session cookie is SameSite=Lax, so a
 * browser only sends it to an Adrift iframe whose parent page (ComfyUI) is the
 * same "site" (same host, ports ignored; or same registrable domain). When
 * ComfyUI is on another site, signing in inside the panel can't stick; the
 * overlay says so and offers Adrift in its own tab instead.
 */

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function siteOf(hostname: string): string {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (IPV4.test(h) || h.includes(":")) return h; // IPs: exact match only
  const labels = h.split(".");
  // Approximation of the registrable domain (no public-suffix list).
  return labels.length <= 2 ? h : labels.slice(-2).join(".");
}

/** Whether two origins are the same site for cookie purposes (approximate). */
export function sameSite(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    if (ua.protocol !== ub.protocol) return false;
    return siteOf(ua.hostname) === siteOf(ub.hostname);
  } catch {
    return false;
  }
}

/**
 * The embedding page's origin: location.ancestorOrigins (Chromium/WebKit),
 * else document.referrer. Null when unknown.
 */
export function parentOrigin(
  loc: { ancestorOrigins?: { length: number; [i: number]: string } },
  referrer: string,
): string | null {
  const ao = loc.ancestorOrigins;
  if (ao && ao.length > 0) return ao[ao.length - 1] || null;
  try {
    return referrer ? new URL(referrer).origin : null;
  } catch {
    return null;
  }
}

/**
 * True when the overlay's login can't carry (parent on another site, or we
 * can't tell). Only meaningful when Adrift is inside an iframe.
 */
export function overlayLoginBlocked(
  selfOrigin: string,
  parent: string | null,
): boolean {
  return parent === null ? true : !sameSite(selfOrigin, parent);
}

export const OVERLAY_LOGIN_NOTICE =
  "Adrift is on a different host than ComfyUI, so its login can't carry into the panel. Open Adrift in its own tab, or serve both over HTTPS / same host.";

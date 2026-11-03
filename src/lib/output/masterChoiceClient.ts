/**
 * Browser side of the master-file choice: kept in the `adrift_master` cookie
 * so every job request (tool, action, create) carries it without each caller
 * threading a new body field. Availability is fetched once and shared.
 */

import {
  MASTER_COOKIE,
  decodeMasterCookie,
  encodeMasterCookie,
  type MasterAvailability,
  type MasterChoice,
} from "@/lib/output/saveNodes";

export function readMasterChoice(cookie: string = safeCookie()): MasterChoice {
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq >= 0 && part.slice(0, eq).trim() === MASTER_COOKIE) {
      return decodeMasterCookie(part.slice(eq + 1).trim()) ?? {};
    }
  }
  return {};
}

/** Cookie string to assign to document.cookie (one year, same-site). */
export function masterCookieString(choice: MasterChoice): string {
  const value = encodeMasterCookie(choice);
  return value
    ? `${MASTER_COOKIE}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax`
    : `${MASTER_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

export function writeMasterChoice(choice: MasterChoice): void {
  try {
    document.cookie = masterCookieString(choice);
  } catch {
    /* cookies blocked: the choice just doesn't stick */
  }
}

function safeCookie(): string {
  try {
    return typeof document === "undefined" ? "" : document.cookie;
  } catch {
    return "";
  }
}

let shared: Promise<MasterAvailability | null> | null = null;

/** GET /api/comfy/output-formats, shared; null when the route fails. */
export function fetchMasterFormats(): Promise<MasterAvailability | null> {
  if (!shared) {
    shared = fetch("/api/comfy/output-formats", { cache: "no-store" })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as
          | (Partial<MasterAvailability> & { ok?: boolean })
          | null;
        if (!res.ok || !data?.ok) return null;
        return {
          image: Array.isArray(data.image) ? data.image : ["png"],
          video: Array.isArray(data.video) ? data.video : ["h264"],
        } as MasterAvailability;
      })
      .catch(() => null)
      .then((r) => {
        if (!r) shared = null; // retry next mount
        return r;
      });
  }
  return shared;
}

/** Test hook. */
export function resetMasterFormatsCache(): void {
  shared = null;
}

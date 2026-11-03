/**
 * Pure helpers for keeping the lightbox and the `?image=<id>` URL param in
 * sync. The hook (`useLightboxUrl`) owns the side effects; these decide what
 * the URL should become so the rules are unit-testable without a DOM.
 */

export const LIGHTBOX_PARAM = "image";

/** Read the lightbox image id from a URL (null when absent/empty). */
export function imageIdFromHref(href: string): string | null {
  try {
    return new URL(href).searchParams.get(LIGHTBOX_PARAM) || null;
  } catch {
    return null;
  }
}

/** `href` with the image param set to `imageId`, or removed when null. */
export function hrefWithImage(href: string, imageId: string | null): string {
  const url = new URL(href);
  if (imageId) {
    url.searchParams.set(LIGHTBOX_PARAM, imageId);
  } else {
    url.searchParams.delete(LIGHTBOX_PARAM);
  }
  return url.toString();
}

export interface LightboxUrlUpdate {
  /** push = new history entry; replace = rewrite the current one. */
  mode: "push" | "replace";
  href: string;
}

/**
 * Decide how the URL should change after the lightbox's current image moved
 * from `prevImageId` to `currentImageId`. Returns null when it already matches.
 *
 * - opening (prev null → id): push, so browser Back closes the lightbox
 * - prev/next navigation (id → other id): replace, no history bloat
 * - closing (id/deep-link → null): push the param-free URL, so a reload never
 *   reopens the image and Forward can bring it back
 */
export function lightboxUrlUpdate(
  href: string,
  prevImageId: string | null,
  currentImageId: string | null,
): LightboxUrlUpdate | null {
  const urlImageId = imageIdFromHref(href);
  if (currentImageId) {
    if (currentImageId === urlImageId) return null;
    return {
      mode: prevImageId === null ? "push" : "replace",
      href: hrefWithImage(href, currentImageId),
    };
  }
  if (!urlImageId) return null;
  return { mode: "push", href: hrefWithImage(href, null) };
}

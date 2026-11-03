/**
 * Pure view helpers for the Profile page (spotlight source, grid caps and
 * per-tab empty-state copy), kept out of the component so they can be tested.
 */

/** Max images rendered per profile grid; the rest live in Organize. */
export const PROFILE_SPOTLIGHT_LIMIT = 30;
export const PROFILE_ARCHIVE_LIMIT = 60;

export type ProfileTab = "spotlight" | "archive" | "following";

export type SpotlightSource = "pinned" | "liked" | "none";

/**
 * Spotlight = pinned images when any are pinned, else liked images as a
 * fallback. `source` tells the UI which one it is showing.
 */
export function profileSpotlight<T extends { id: string; liked?: boolean }>(
  gallery: readonly T[],
  pinned: ReadonlySet<string>,
): { images: T[]; source: SpotlightSource } {
  const pinnedImages = gallery.filter((img) => pinned.has(img.id));
  if (pinnedImages.length > 0)
    return { images: pinnedImages, source: "pinned" };
  const liked = gallery.filter((img) => img.liked);
  if (liked.length > 0) return { images: liked, source: "liked" };
  return { images: [], source: "none" };
}

export interface ProfileEmptyState {
  title: string;
  body: string;
  /** Call-to-action; absent when there is nothing the viewer can do. */
  action?: { label: string; target: "archive" | "create" };
}

/** Empty-state copy for one tab, own profile vs. someone else's. */
export function profileEmptyState(
  tab: ProfileTab,
  opts: { isViewingOther: boolean; handle: string; archiveCount: number },
): ProfileEmptyState {
  const { isViewingOther, handle, archiveCount } = opts;
  if (tab === "spotlight") {
    if (isViewingOther)
      return {
        title: `No spotlights yet from ${handle}`,
        body: `Images pinned by ${handle} will appear here.`,
      };
    return archiveCount > 0
      ? {
          title: "No spotlights yet",
          body: "Pin or like images from your Archive to feature them here.",
          action: { label: "Go to Archive", target: "archive" },
        }
      : {
          title: "No spotlights yet",
          body: "Generate a few images first, then pin your favorites here.",
          action: { label: "Start creating", target: "create" },
        };
  }
  if (tab === "archive") {
    if (isViewingOther)
      return {
        title: "Nothing archived",
        body: `${handle} has no public images.`,
      };
    return {
      title: "No images archived yet",
      body: "Images you generate will appear here.",
      action: { label: "Start creating", target: "create" },
    };
  }
  return {
    title: "Not following anyone",
    body: isViewingOther
      ? `${handle} is not following anyone yet.`
      : "Profiles you follow will appear here.",
  };
}

/** "Showing 60 of 214" hint when a grid is capped; null when all fit. */
export function profileGridOverflow(
  total: number,
  limit: number,
): string | null {
  return total > limit ? `Showing ${limit} of ${total}` : null;
}

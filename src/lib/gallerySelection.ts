import type { GalleryImage, MoodboardImage } from "@/types";
import { audioExt, meshExt } from "@/lib/galleryMedia";
import { mediaDownloadName } from "@/lib/output/downloadName";

/**
 * Pure helpers behind the Create feed's Select mode. Sets are treated as
 * immutable: every op returns a new Set (or the same one when nothing
 * changed, so React/zustand can skip a render).
 */

export type GroupSelectionState = "none" | "some" | "all";

export function toggleId(
  selected: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function addIds(
  selected: ReadonlySet<string>,
  ids: Iterable<string>,
): Set<string> {
  const next = new Set(selected);
  for (const id of ids) next.add(id);
  return next;
}

export function removeIds(
  selected: ReadonlySet<string>,
  ids: Iterable<string>,
): Set<string> {
  const next = new Set(selected);
  for (const id of ids) next.delete(id);
  return next;
}

/**
 * Ids between `anchorId` and `targetId` (inclusive) in feed order. Missing
 * anchor (none yet, or filtered away) degrades to just the target.
 */
export function rangeIds(
  orderedIds: readonly string[],
  anchorId: string | null,
  targetId: string,
): string[] {
  const end = orderedIds.indexOf(targetId);
  if (end === -1) return [];
  const start = anchorId === null ? -1 : orderedIds.indexOf(anchorId);
  if (start === -1) return [targetId];
  const [lo, hi] = start <= end ? [start, end] : [end, start];
  return orderedIds.slice(lo, hi + 1);
}

/** Shift-click: add the anchor→target span to the existing selection. */
export function selectRange(
  selected: ReadonlySet<string>,
  orderedIds: readonly string[],
  anchorId: string | null,
  targetId: string,
): Set<string> {
  return addIds(selected, rangeIds(orderedIds, anchorId, targetId));
}

/** How much of a group (a run or a day) is selected. */
export function groupSelectionState(
  selected: ReadonlySet<string>,
  groupIds: readonly string[],
): GroupSelectionState {
  if (groupIds.length === 0) return "none";
  let hits = 0;
  for (const id of groupIds) if (selected.has(id)) hits += 1;
  if (hits === 0) return "none";
  return hits === groupIds.length ? "all" : "some";
}

/**
 * Group checkbox (run or day): a fully selected group clears, anything else
 * fills the whole group.
 */
export function toggleGroup(
  selected: ReadonlySet<string>,
  groupIds: readonly string[],
): Set<string> {
  return groupSelectionState(selected, groupIds) === "all"
    ? removeIds(selected, groupIds)
    : addIds(selected, groupIds);
}

/** Drop selected ids that are no longer in the feed (filtered / removed). */
export function pruneToIds(
  selected: ReadonlySet<string>,
  orderedIds: readonly string[],
): ReadonlySet<string> {
  if (selected.size === 0) return selected;
  const live = new Set(orderedIds);
  let changed = false;
  const next = new Set<string>();
  for (const id of selected) {
    if (live.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? next : selected;
}

/** Selected ids in feed order (stable for downloads / compare A-B). */
export function selectedInOrder(
  selected: ReadonlySet<string>,
  orderedIds: readonly string[],
): string[] {
  return orderedIds.filter((id) => selected.has(id));
}

/** Image ids per run / per day, following the feed's visual order. */
export function idsOf(images: readonly Pick<GalleryImage, "id">[]): string[] {
  return images.map((img) => img.id);
}

// Bulk actions

/** Like/Unlike target: unlike only when every selected image is liked. */
export function nextLikedValue(
  images: readonly Pick<GalleryImage, "liked">[],
): boolean {
  return !(images.length > 0 && images.every((img) => Boolean(img.liked)));
}

/** Set `liked` on every image in `ids`; untouched entries keep identity. */
export function setLikedByIds<T extends Pick<GalleryImage, "id" | "liked">>(
  gallery: readonly T[],
  ids: ReadonlySet<string>,
  liked: boolean,
): T[] {
  return gallery.map((img) =>
    ids.has(img.id) && Boolean(img.liked) !== liked ? { ...img, liked } : img,
  );
}

/**
 * Move: the image ends up in exactly `folderId` (other user folders are
 * dropped), mirroring a file-manager move rather than a tag add.
 */
export function moveToFolderByIds<
  T extends Pick<GalleryImage, "id" | "folderIds">,
>(gallery: readonly T[], ids: ReadonlySet<string>, folderId: string): T[] {
  return gallery.map((img) => {
    if (!ids.has(img.id)) return img;
    const current = img.folderIds ?? [];
    if (current.length === 1 && current[0] === folderId) return img;
    return { ...img, folderIds: [folderId] };
  });
}

/** Where a download points and what the file should be called. */
export function downloadTarget(
  img: Pick<
    GalleryImage,
    "url" | "videoUrl" | "audioUrl" | "meshUrl" | "seed" | "id"
  > &
    Partial<Pick<GalleryImage, "paramsMap" | "jobIndex">>,
): { href: string; filename: string } | null {
  const href = img.videoUrl || img.audioUrl || img.meshUrl || img.url;
  if (!href) return null;
  const ext = img.videoUrl
    ? ".mp4"
    : img.audioUrl
      ? audioExt(img.audioUrl)
      : img.meshUrl
        ? meshExt(img.meshUrl)
        : ".png";
  return { href, filename: mediaDownloadName(img, href, ext) };
}

/** Only still images can be pinned to a moodboard. */
export function isMoodboardEligible(
  img: Pick<GalleryImage, "url" | "videoUrl" | "audioUrl">,
): boolean {
  return Boolean(img.url) && !img.videoUrl && !img.audioUrl;
}

export interface MoodboardMergeResult {
  images: MoodboardImage[];
  added: number;
  /** Already on the board. */
  duplicates: number;
  /** Dropped because the board hit its size cap. */
  overflow: number;
}

/** Append images to a board, skipping duplicates by URL and honoring the cap. */
export function mergeIntoMoodboard(
  current: readonly MoodboardImage[],
  incoming: readonly Pick<GalleryImage, "url" | "prompt">[],
  max = 20,
): MoodboardMergeResult {
  const images = [...current];
  const seen = new Set(current.map((img) => img.url));
  let added = 0;
  let duplicates = 0;
  let overflow = 0;
  for (const img of incoming) {
    if (!img.url) continue;
    if (seen.has(img.url)) {
      duplicates += 1;
      continue;
    }
    if (images.length >= max) {
      overflow += 1;
      continue;
    }
    seen.add(img.url);
    images.push({
      url: img.url,
      weight: 1,
      ...(img.prompt ? { prompt: img.prompt.slice(0, 2000) } : {}),
    });
    added += 1;
  }
  return { images, added, duplicates, overflow };
}

export interface SelectionIndex {
  /** Every loaded id in feed order: day → run → tile. */
  orderedIds: string[];
  /** Day key → that day's ids in feed order. */
  byDay: Map<string, string[]>;
}

/** Flatten the feed's day/run grouping into the order Select mode walks. */
export function buildSelectionIndex(
  days: readonly {
    date: string;
    rows: readonly { images: readonly Pick<GalleryImage, "id">[] }[];
  }[],
): SelectionIndex {
  const orderedIds: string[] = [];
  const byDay = new Map<string, string[]>();
  for (const day of days) {
    const dayIds: string[] = [];
    for (const row of day.rows) {
      for (const img of row.images) dayIds.push(img.id);
    }
    byDay.set(day.date, dayIds);
    orderedIds.push(...dayIds);
  }
  return { orderedIds, byDay };
}

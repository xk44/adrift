/**
 * Pure helpers for the Create feed toolbar: view density, hover captions,
 * media filter and relative date headers. Kept free of React so they're
 * unit-testable.
 */

export type GalleryViewMode = "grid" | "list" | "thumbs";

export const GALLERY_VIEW_MODES: ReadonlyArray<{
  id: GalleryViewMode;
  label: string;
  hint: string;
}> = [
  {
    id: "grid",
    label: "Grid",
    hint: "Image wall, prompt shows on hover",
  },
  { id: "list", label: "List", hint: "One row per run, prompt beside it" },
  { id: "thumbs", label: "Thumbnails", hint: "Dense wall of small tiles" },
];

/**
 * Stored values keep their keys ("grid" | "list" | "thumbs"), so previously
 * saved choices still parse.
 */
export function parseGalleryViewMode(value: unknown): GalleryViewMode {
  return value === "list" || value === "thumbs" ? value : "grid";
}

/** Grid and Thumbnails flatten every run's tiles into one continuous wall. */
export function isWallViewMode(mode: GalleryViewMode): boolean {
  return mode !== "list";
}

/**
 * Prompt text for hover captions: everything before the first `--flag`,
 * whitespace collapsed. Falls back to the trimmed input if only flags remain.
 */
export function stripPromptFlags(text: string): string {
  const trimmed = text.trim();
  const firstFlag = trimmed.search(/(?:^|\s)--[A-Za-z]/);
  const base = (firstFlag < 0 ? trimmed : trimmed.slice(0, firstFlag))
    .replace(/\s+/g, " ")
    .trim();
  return base || trimmed;
}

/** "+3 more" when a run has images beyond the hovered one, else null. */
export function moreImagesLabel(runImageCount: number): string | null {
  const extra = Math.floor(runImageCount) - 1;
  return extra > 0 ? `+${extra} more` : null;
}

/**
 * Run-level Trash toggle: if every image is already trashed (hidden) the
 * action restores them all, otherwise it trashes the ones still visible.
 * Returns which ids to flip so already-matching images stay untouched.
 */
export function runTrashToggle(
  images: ReadonlyArray<{ id: string; hidden?: boolean }>,
): { restoring: boolean; ids: string[] } {
  const restoring = images.length > 0 && images.every((img) => img.hidden);
  return {
    restoring,
    ids: images
      .filter((img) => Boolean(img.hidden) === restoring)
      .map((img) => img.id),
  };
}

/**
 * One-line prompt-bar preview of a hovered run: caption text followed by up
 * to `maxChips` chip labels ("a red fox · ar 1:1 · seed 7").
 */
export function formatPromptPreview(
  text: string,
  chipLabels: readonly string[],
  maxChips = 5,
): string {
  return [stripPromptFlags(text), ...chipLabels.slice(0, maxChips)]
    .filter((part) => part.trim().length > 0)
    .join(" · ");
}

export type GalleryMediaFilter = "all" | "image" | "video" | "audio" | "3d";

export const GALLERY_MEDIA_FILTERS: ReadonlyArray<{
  id: GalleryMediaFilter;
  label: string;
}> = [
  { id: "all", label: "All" },
  { id: "image", label: "Images" },
  { id: "video", label: "Video" },
  { id: "audio", label: "Audio" },
  { id: "3d", label: "3D" },
];

export interface GalleryMediaFields {
  videoUrl?: string;
  audioUrl?: string;
  meshUrl?: string;
}

/** Same precedence the tiles render with: video > audio > 3D > image. */
export function galleryMediaKind(
  img: GalleryMediaFields,
): Exclude<GalleryMediaFilter, "all"> {
  if (img.videoUrl) return "video";
  if (img.audioUrl) return "audio";
  if (img.meshUrl) return "3d";
  return "image";
}

export function matchesMediaFilter(
  img: GalleryMediaFields,
  filter: GalleryMediaFilter,
): boolean {
  return filter === "all" || galleryMediaKind(img) === filter;
}

/** Local-calendar day key (YYYY-MM-DD) used to group feed rows. */
export function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** "Today" / "Yesterday" / "October 24, 2026" (year dropped when current). */
export function relativeDateLabel(date: Date, now: Date = new Date()): string {
  if (Number.isNaN(date.getTime())) return "Earlier";
  const today = localDayKey(now);
  const key = localDayKey(date);
  if (key === today) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === localDayKey(yesterday)) return "Yesterday";
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Count of non-default filters, for the Filters button badge. */
export function activeFilterCount(opts: {
  likedOnly: boolean;
  media: GalleryMediaFilter;
}): number {
  return (opts.likedOnly ? 1 : 0) + (opts.media !== "all" ? 1 : 0);
}

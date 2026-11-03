import type { GalleryImage } from "@/types";

/**
 * Pure helpers for the image compare wipe-slider (openmodeldb-style).
 * Kept free of DOM/React so the math and selection logic are unit-testable.
 */

/** Convert a pointer x position into a wipe percentage within [0, 100]. */
export function wipePercent(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
): number {
  if (rectWidth <= 0) return 50;
  const pct = ((clientX - rectLeft) / rectWidth) * 100;
  return Math.min(100, Math.max(0, pct));
}

/** Keyboard nudge for the slider handle. */
export function stepPercent(current: number, key: string, step = 5): number {
  if (key === "ArrowLeft") return Math.max(0, current - step);
  if (key === "ArrowRight") return Math.min(100, current + step);
  if (key === "Home") return 0;
  if (key === "End") return 100;
  return current;
}

/** An image qualifies for wipe-compare only when it's a plain still image. */
export function isComparableImage(img: GalleryImage): boolean {
  return Boolean(img.url) && !img.videoUrl && !img.audioUrl && !img.meshUrl;
}

/**
 * Default B-side pick when entering compare mode: the next comparable image
 * after the current one (wrapping), preferring images from the same run
 * (typical A/B: variations or upscale vs original from one grid).
 */
export function pickDefaultCompareTarget(
  images: GalleryImage[],
  currentIndex: number,
): GalleryImage | null {
  const current = images[currentIndex];
  if (!current) return null;
  const n = images.length;
  let fallback: GalleryImage | null = null;
  for (let offset = 1; offset < n; offset++) {
    const candidate = images[(currentIndex + offset) % n];
    if (!isComparableImage(candidate) || candidate.id === current.id) continue;
    if (candidate.runId === current.runId) return candidate;
    if (!fallback) fallback = candidate;
  }
  return fallback;
}

/**
 * The image an action/tool result was made from, for a before/after compare.
 * `jobIndex` is the result's recorded `action_source_job_index`; without it
 * only an unambiguous single-image source qualifies (never guess a grid tile).
 */
export function pickSourceImage(
  sourceImages: GalleryImage[],
  jobIndex: unknown,
  currentId?: string,
): GalleryImage | null {
  const comparable = sourceImages.filter(
    (img) => isComparableImage(img) && img.id !== currentId,
  );
  if (typeof jobIndex === "number" && Number.isInteger(jobIndex)) {
    return comparable.find((img) => img.jobIndex === jobIndex) ?? null;
  }
  return comparable.length === 1 ? comparable[0] : null;
}

/**
 * Aspect ratio for a pending Create tile. Prefers the job's real pixel size
 * (set from the submit response, which already applied model defaults), then
 * the run's `--ar W:H` param, then square.
 */
export interface PendingAspect {
  /** width / height */
  ar: number;
  /** CSS aspect-ratio value */
  aspectRatio: string;
}

const AR_RE = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/;

export function pendingTileAspect(run: {
  width?: number;
  height?: number;
  params?: Record<string, unknown>;
}): PendingAspect {
  const w = Number(run.width);
  const h = Number(run.height);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return { ar: w / h, aspectRatio: `${w} / ${h}` };
  }
  const aspect =
    typeof run.params?.aspect === "string" ? run.params.aspect.trim() : "";
  const m = aspect.match(AR_RE);
  if (m) {
    const aw = parseFloat(m[1]);
    const ah = parseFloat(m[2]);
    if (aw > 0 && ah > 0) return { ar: aw / ah, aspectRatio: `${m[1]} / ${m[2]}` };
  }
  return { ar: 1, aspectRatio: "1 / 1" };
}

/** Live-preview blur: soft early, sharp as sampling finishes. */
export function previewBlur(progress: number): string {
  const p = Math.min(100, Math.max(0, Number.isFinite(progress) ? progress : 0));
  const px = Math.round((1 - p / 100) * 12 * 10) / 10;
  return px > 0 ? `blur(${px}px)` : "none";
}

/**
 * Real pixel size of a loaded image when it disagrees with the stored
 * width/height (missing on some history rows; tools and model snapping can
 * change the output aspect). Null = the stored size is right.
 */
export function naturalSizeOverride(
  naturalWidth: number,
  naturalHeight: number,
  width?: number,
  height?: number,
): { width: number; height: number } | null {
  if (!(naturalWidth > 0 && naturalHeight > 0)) return null;
  const natural = naturalWidth / naturalHeight;
  if (width && height && width > 0 && height > 0) {
    const stored = width / height;
    if (Math.abs(natural - stored) / stored <= 0.02) return null;
  }
  return { width: naturalWidth, height: naturalHeight };
}

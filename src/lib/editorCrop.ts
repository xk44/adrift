/**
 * Crop tool geometry. Rects are in source-image pixels and stay fractional
 * while dragging; `cropPixelRect` rounds once for the readout and the output
 * so the two always agree.
 */
export interface CropSize {
  width: number;
  height: number;
}

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type CropHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const CROP_HANDLES: readonly { id: CropHandle; label: string }[] = [
  { id: "nw", label: "top-left corner" },
  { id: "n", label: "top edge" },
  { id: "ne", label: "top-right corner" },
  { id: "e", label: "right edge" },
  { id: "se", label: "bottom-right corner" },
  { id: "s", label: "bottom edge" },
  { id: "sw", label: "bottom-left corner" },
  { id: "w", label: "left edge" },
];

export const CROP_ASPECTS = [
  { id: "free", label: "Free" },
  { id: "original", label: "Original" },
  { id: "1:1", label: "1:1" },
  { id: "4:5", label: "4:5" },
  { id: "3:4", label: "3:4" },
  { id: "2:3", label: "2:3" },
  { id: "9:16", label: "9:16" },
  { id: "16:9", label: "16:9" },
  { id: "3:2", label: "3:2" },
] as const;

export type CropAspectId = (typeof CROP_ASPECTS)[number]["id"];

/** Smallest crop side, in source pixels. */
export const MIN_CROP = 8;

/** Width / height for a preset; null = unconstrained. */
export function cropAspectRatio(
  id: CropAspectId,
  img: CropSize,
): number | null {
  if (id === "free") return null;
  if (id === "original") return img.width / img.height;
  const [w, h] = id.split(":").map(Number);
  return w / h;
}

export function fullCropRect(img: CropSize): CropRect {
  return { x: 0, y: 0, w: img.width, h: img.height };
}

/** Largest rect with `ratio` that fits the image, centered. */
export function fitAspectRect(img: CropSize, ratio: number | null): CropRect {
  if (!ratio) return fullCropRect(img);
  let w = img.width;
  let h = w / ratio;
  if (h > img.height) {
    h = img.height;
    w = h * ratio;
  }
  return { x: (img.width - w) / 2, y: (img.height - h) / 2, w, h };
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Keep a rect inside the image: shrink to fit, then shift in. */
export function clampCropRect(r: CropRect, img: CropSize): CropRect {
  const w = clamp(r.w, Math.min(MIN_CROP, img.width), img.width);
  const h = clamp(r.h, Math.min(MIN_CROP, img.height), img.height);
  return {
    x: clamp(r.x, 0, img.width - w),
    y: clamp(r.y, 0, img.height - h),
    w,
    h,
  };
}

export function moveCropRect(
  r: CropRect,
  dx: number,
  dy: number,
  img: CropSize,
): CropRect {
  return clampCropRect({ ...r, x: r.x + dx, y: r.y + dy }, img);
}

/**
 * Drag a handle by (dx, dy) source pixels from the rect at drag start. With
 * a ratio, corners keep the opposite corner fixed and edges keep the
 * perpendicular center, shifted back inside the image if needed.
 */
export function resizeCropRect(
  start: CropRect,
  handle: CropHandle,
  dx: number,
  dy: number,
  img: CropSize,
  ratio: number | null,
): CropRect {
  const left = start.x;
  const top = start.y;
  const right = start.x + start.w;
  const bottom = start.y + start.h;
  const hasW = handle.includes("w");
  const hasE = handle.includes("e");
  const hasN = handle.includes("n");
  const hasS = handle.includes("s");
  const minW = Math.min(MIN_CROP, img.width);
  const minH = Math.min(MIN_CROP, img.height);

  if (!ratio) {
    const l = hasW ? clamp(left + dx, 0, right - minW) : left;
    const r = hasE ? clamp(right + dx, left + minW, img.width) : right;
    const t = hasN ? clamp(top + dy, 0, bottom - minH) : top;
    const b = hasS ? clamp(bottom + dy, top + minH, img.height) : bottom;
    return { x: l, y: t, w: r - l, h: b - t };
  }

  const lo = Math.max(minW, minH * ratio);

  if ((hasW || hasE) && (hasN || hasS)) {
    const ax = hasE ? left : right;
    const ay = hasS ? top : bottom;
    const wantW = hasE ? right + dx - ax : ax - (left + dx);
    const wantH = hasS ? bottom + dy - ay : ay - (top + dy);
    const maxW = Math.min(
      hasE ? img.width - ax : ax,
      (hasS ? img.height - ay : ay) * ratio,
    );
    const w = clamp(Math.max(wantW, wantH * ratio), Math.min(lo, maxW), maxW);
    const h = w / ratio;
    return { x: hasE ? ax : ax - w, y: hasS ? ay : ay - h, w, h };
  }

  if (hasW || hasE) {
    const ax = hasE ? left : right;
    const maxW = Math.min(hasE ? img.width - ax : ax, img.height * ratio);
    const wantW = hasE ? right + dx - ax : ax - (left + dx);
    const w = clamp(wantW, Math.min(lo, maxW), maxW);
    const h = w / ratio;
    const cy = top + start.h / 2;
    return {
      x: hasE ? ax : ax - w,
      y: clamp(cy - h / 2, 0, img.height - h),
      w,
      h,
    };
  }

  const ay = hasS ? top : bottom;
  const maxH = Math.min(hasS ? img.height - ay : ay, img.width / ratio);
  const wantH = hasS ? bottom + dy - ay : ay - (top + dy);
  const h = clamp(wantH, Math.min(lo / ratio, maxH), maxH);
  const w = h * ratio;
  const cx = left + start.w / 2;
  return {
    x: clamp(cx - w / 2, 0, img.width - w),
    y: hasS ? ay : ay - h,
    w,
    h,
  };
}

/** Screen-pixel delta → source-pixel delta for an image shown at `display`. */
export function screenDeltaToSource(
  dx: number,
  dy: number,
  display: CropSize,
  img: CropSize,
): { dx: number; dy: number } {
  if (!(display.width > 0) || !(display.height > 0)) return { dx: 0, dy: 0 };
  return {
    dx: (dx * img.width) / display.width,
    dy: (dy * img.height) / display.height,
  };
}

/** Client point → source pixel, for an image drawn in `box` (client rect). */
export function screenToSource(
  pt: { x: number; y: number },
  box: { left: number; top: number; width: number; height: number },
  img: CropSize,
): { x: number; y: number } {
  const d = screenDeltaToSource(pt.x - box.left, pt.y - box.top, box, img);
  return { x: d.dx, y: d.dy };
}

/** Integer source rect actually cut out (what the readout shows). */
export function cropPixelRect(r: CropRect, img: CropSize): CropRect {
  const x = clamp(Math.round(r.x), 0, img.width - 1);
  const y = clamp(Math.round(r.y), 0, img.height - 1);
  return {
    x,
    y,
    w: clamp(Math.round(r.w), 1, img.width - x),
    h: clamp(Math.round(r.h), 1, img.height - y),
  };
}

export function cropOutputSize(r: CropRect, img: CropSize): CropSize {
  const p = cropPixelRect(r, img);
  return { width: p.w, height: p.h };
}

export function isFullCrop(r: CropRect, img: CropSize): boolean {
  const p = cropPixelRect(r, img);
  return p.x === 0 && p.y === 0 && p.w === img.width && p.h === img.height;
}

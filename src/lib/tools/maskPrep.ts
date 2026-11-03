/**
 * Mask-driven image prep for the Qwen 2.1 object-remover and doodle-in tools.
 *
 *   redbox   - outline the mask's bounding box(es) with a red rectangle
 *              (RGB 239,68,68), the convention of the object-remover-bbox LoRA.
 *   scribble - paint the mask's white pixels pure magenta (RGB 255,0,255),
 *              the doodle-in LoRA marker; the mask IS the scribble.
 *
 * Geometry/painting is pure (raw RGB buffers) so it is testable without sharp;
 * the `apply*` wrappers decode/encode with sharp (lazy import, like outpaint.ts).
 */
import { OutpaintError } from "./outpaint";

export const REDBOX_COLOR = { r: 239, g: 68, b: 68 } as const;
export const SCRIBBLE_COLOR = { r: 255, g: 0, b: 255 } as const;

/** Inclusive pixel box. */
export interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Components smaller than this many pixels are treated as speckle. */
const MIN_COMPONENT_PIXELS = 4;
/** Hard cap on boxes drawn (largest components win). */
export const MAX_REDBOXES = 12;

/** Outline thickness: ~0.6% of the short side, at least 3 px. */
export function redBoxStroke(width: number, height: number): number {
  return Math.max(3, Math.round(0.006 * Math.min(width, height)));
}

/**
 * 8-connected components of a binary mask (raw 1-channel, >=128 = set).
 * Returns the bounding box of each component, largest area first. Speckle
 * (< MIN_COMPONENT_PIXELS) is dropped unless nothing else exists.
 */
export function findMaskBoxes(
  mask: Uint8Array,
  width: number,
  height: number,
): PixelBox[] {
  const seen = new Uint8Array(width * height);
  const comps: Array<PixelBox & { area: number }> = [];
  const stack: number[] = [];
  for (let start = 0; start < width * height; start++) {
    if (mask[start] < 128 || seen[start]) continue;
    let x0 = width;
    let y0 = height;
    let x1 = 0;
    let y1 = 0;
    let area = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop() as number;
      const x = i % width;
      const y = (i - x) / width;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width || (dx === 0 && dy === 0)) continue;
          const j = ny * width + nx;
          if (mask[j] >= 128 && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
    }
    comps.push({ x0, y0, x1, y1, area });
  }
  if (comps.length === 0) return [];
  let kept = comps.filter((c) => c.area >= MIN_COMPONENT_PIXELS);
  if (kept.length === 0) kept = comps;
  kept.sort((a, b) => b.area - a.area);
  return kept
    .slice(0, MAX_REDBOXES)
    .map(({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 }));
}

/**
 * The four bars of a rectangle outline around `box`. The outline sits just
 * outside the box (so the object stays uncovered) and is clamped to the image;
 * when the box touches an edge the stroke stays inside the frame.
 */
export function redBoxBars(
  box: PixelBox,
  width: number,
  height: number,
  stroke: number,
): PixelRect[] {
  const x0 = Math.max(0, box.x0 - stroke);
  const y0 = Math.max(0, box.y0 - stroke);
  const x1 = Math.min(width - 1, box.x1 + stroke);
  const y1 = Math.min(height - 1, box.y1 + stroke);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const t = Math.min(stroke, Math.ceil(w / 2), Math.ceil(h / 2));
  return [
    { x: x0, y: y0, w, h: t }, // top
    { x: x0, y: y1 - t + 1, w, h: t }, // bottom
    { x: x0, y: y0, w: t, h }, // left
    { x: x1 - t + 1, y: y0, w: t, h }, // right
  ];
}

function fillRect(
  rgb: Uint8Array,
  width: number,
  rect: PixelRect,
  color: { r: number; g: number; b: number },
): void {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const o = (y * width + x) * 3;
      rgb[o] = color.r;
      rgb[o + 1] = color.g;
      rgb[o + 2] = color.b;
    }
  }
}

/** Draw red outlines for every mask component into `rgb` (in place). */
export function paintRedBoxes(
  rgb: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
): PixelBox[] {
  const boxes = findMaskBoxes(mask, width, height);
  if (boxes.length === 0) {
    throw new OutpaintError("Mask is empty: nothing to box");
  }
  const stroke = redBoxStroke(width, height);
  for (const box of boxes) {
    for (const bar of redBoxBars(box, width, height, stroke)) {
      fillRect(rgb, width, bar, REDBOX_COLOR);
    }
  }
  return boxes;
}

/** Paint every set mask pixel magenta into `rgb` (in place). Returns count. */
export function paintScribble(
  rgb: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
): number {
  let painted = 0;
  for (let i = 0; i < width * height; i++) {
    if (mask[i] >= 128) {
      rgb[i * 3] = SCRIBBLE_COLOR.r;
      rgb[i * 3 + 1] = SCRIBBLE_COLOR.g;
      rgb[i * 3 + 2] = SCRIBBLE_COLOR.b;
      painted++;
    }
  }
  if (painted === 0) {
    throw new OutpaintError("Mask is empty: nothing to draw");
  }
  return painted;
}

// Pixel work (sharp)

type SharpFn = typeof import("sharp");

async function loadSharp(): Promise<SharpFn> {
  const mod = (await import("sharp")) as unknown as { default?: SharpFn };
  return (mod.default ?? (mod as unknown as SharpFn)) as SharpFn;
}

async function decode(
  image: Uint8Array,
  mask: Uint8Array,
): Promise<{
  sharp: SharpFn;
  rgb: Buffer;
  maskRaw: Buffer;
  width: number;
  height: number;
}> {
  const sharp = await loadSharp();
  const { data, info } = await sharp(Buffer.from(image))
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  // White = selected; transparent counts as black; resized to the image.
  const maskRaw = await sharp(Buffer.from(mask))
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .resize(width, height, { fit: "fill" })
    .grayscale()
    .threshold(128)
    .raw()
    .toBuffer();
  return { sharp, rgb: Buffer.from(data), maskRaw, width, height };
}

export interface MaskPrepResult {
  png: Buffer;
  width: number;
  height: number;
}

/** Draw red bbox outline(s) around the mask on the image (object remover). */
export async function applyRedBox(
  image: Uint8Array,
  mask: Uint8Array,
): Promise<MaskPrepResult & { boxes: PixelBox[] }> {
  const { sharp, rgb, maskRaw, width, height } = await decode(image, mask);
  const boxes = paintRedBoxes(rgb, maskRaw, width, height);
  const png = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  return { png, width, height, boxes };
}

/** Paint the mask magenta on the image (doodle-in marker). */
export async function applyScribble(
  image: Uint8Array,
  mask: Uint8Array,
): Promise<MaskPrepResult> {
  const { sharp, rgb, maskRaw, width, height } = await decode(image, mask);
  paintScribble(rgb, maskRaw, width, height);
  const png = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  return { png, width, height };
}

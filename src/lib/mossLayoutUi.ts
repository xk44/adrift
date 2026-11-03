/**
 * Pure helpers for the MOSS-Image layout box editor (geometry + request rule).
 * Coordinates are 0-1 fractions of the canvas, top-left origin.
 */
import type { MossLayoutBox } from "@/lib/oj/mossLayout";

export const MOSS_BOX_MIN = 0.02;
export const MOSS_T2I_WORKFLOW = "packs/moss-image/t2i.json";

export type Rect = Pick<MossLayoutBox, "x" | "y" | "w" | "h">;
export type Point = { x: number; y: number };

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);

/** Box spanning two pointer points (any drag direction), clamped, min size. */
export function drawRect(a: Point, b: Point, min = MOSS_BOX_MIN): Rect {
  const ax = clamp01(a.x);
  const ay = clamp01(a.y);
  const bx = clamp01(b.x);
  const by = clamp01(b.y);
  let x = Math.min(ax, bx);
  let y = Math.min(ay, by);
  let w = Math.max(Math.abs(bx - ax), min);
  let h = Math.max(Math.abs(by - ay), min);
  if (x + w > 1) x = 1 - w;
  if (y + h > 1) y = 1 - h;
  w = Math.min(w, 1);
  h = Math.min(h, 1);
  return { x: Math.max(0, x), y: Math.max(0, y), w, h };
}

/** Translate a box by (dx, dy), keeping it inside the canvas. */
export function moveRect(r: Rect, dx: number, dy: number): Rect {
  return {
    x: clamp(r.x + dx, 0, 1 - r.w),
    y: clamp(r.y + dy, 0, 1 - r.h),
    w: r.w,
    h: r.h,
  };
}

/** Drag the bottom-right corner to `p` (top-left stays fixed). */
export function resizeRect(r: Rect, p: Point, min = MOSS_BOX_MIN): Rect {
  const w = clamp(p.x - r.x, min, 1 - r.x);
  const h = clamp(p.y - r.y, min, 1 - r.y);
  return { x: r.x, y: r.y, w, h };
}

/** Parse "W:H" (or "W/H") into a positive ratio; null when invalid. */
export function parseAspectRatio(ar: string | undefined | null): number | null {
  if (!ar) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)\s*$/.exec(ar);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : null;
}

/** Effective aspect: `--ar` in the prompt wins over the settings aspect. */
export function effectiveAspect(prompt: string, settingsAspect: string): string {
  const m = /(?:^|\s)--(?:ar|aspect)\s+(\S+)/.exec(prompt);
  return m && parseAspectRatio(m[1]) ? m[1] : settingsAspect;
}

/** True when the path is the MOSS-Image t2i pack graph. */
export function isMossT2iWorkflowPath(path: string | null | undefined): boolean {
  if (!path) return false;
  return path.replace(/\\/g, "/").replace(/^\/+/, "").endsWith(MOSS_T2I_WORKFLOW);
}

/** A box the server will accept: non-text boxes need a caption, text boxes need text. */
export function isCompleteBox(b: MossLayoutBox): boolean {
  return b.kind === "text" ? !!b.text?.trim() : !!b.caption.trim();
}

/**
 * `layout_boxes` body fragment: only when boxes exist AND the effective
 * workflow is the MOSS t2i graph, and the request is not the krea2 route.
 */
export function layoutBoxesBody(
  boxes: MossLayoutBox[],
  effectiveWorkflowPath: string | null | undefined,
  isKrea2Route = false,
): { layout_boxes: MossLayoutBox[] } | Record<string, never> {
  if (isKrea2Route || !isMossT2iWorkflowPath(effectiveWorkflowPath)) return {};
  // Half-filled boxes (just drawn, caption not typed yet) are skipped, not 400'd.
  const complete = boxes.filter(isCompleteBox);
  return complete.length ? { layout_boxes: complete } : {};
}

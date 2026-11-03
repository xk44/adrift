/**
 * Video editor timeline geometry: ruler ticks, filmstrip slots per clip and
 * the drop index for a dragged clip. Pure.
 */

import {
  clipLength,
  clipSpeed,
  clipStarts,
  editPoints,
  type EditList,
  type VideoClip,
} from "./editList";

const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Seconds between labelled ruler ticks so labels are >= minPx apart. */
export function rulerStep(pxPerSecond: number, minPx = 72): number {
  for (const s of STEPS) if (s * pxPerSecond >= minPx) return s;
  return STEPS[STEPS.length - 1];
}

export function rulerTicks(total: number, step: number): number[] {
  if (!(total > 0) || !(step > 0)) return [0];
  const n = Math.min(2000, Math.floor(total / step + 1e-6));
  return Array.from(
    { length: n + 1 },
    (_, i) => Math.round(i * step * 1000) / 1000,
  );
}

export interface StripSlot {
  /** px from the clip's left edge. */
  left: number;
  width: number;
  /** Sprite tile index. */
  tile: number;
}

/**
 * Thumbnail slots across a clip block: each slot keeps the tile's aspect
 * (no stretching) and shows the sprite tile nearest its source time.
 */
export function stripSlots(
  clip: Pick<VideoClip, "in" | "out" | "src" | "speed">,
  pxPerSecond: number,
  rowHeight: number,
  strip: { count: number; tileWidth: number; tileHeight: number },
  maxSlots = 160,
): StripSlot[] {
  const blockW = clipLength(clip) * pxPerSecond;
  if (blockW <= 0 || strip.count <= 0 || strip.tileHeight <= 0) return [];
  const slotW = Math.max(8, (strip.tileWidth / strip.tileHeight) * rowHeight);
  const n = Math.min(maxSlots, Math.ceil(blockW / slotW));
  const dur = clip.src.duration > 0 ? clip.src.duration : clipLength(clip);
  const out: StripSlot[] = [];
  for (let i = 0; i < n; i += 1) {
    const left = i * slotW;
    // Middle of the visible part, so the last (cut-off) slot stays inside.
    const mid = left + Math.min(slotW, blockW - left) / 2;
    const t = clip.in + (mid / pxPerSecond) * clipSpeed(clip);
    const tile = Math.min(
      strip.count - 1,
      Math.max(0, Math.floor((t / dur) * strip.count)),
    );
    out.push({ left, width: Math.min(slotW, blockW - left), tile });
  }
  return out;
}

/**
 * Where a clip dragged from `from` lands when the pointer is at timeline
 * time `t`: the slot whose midpoint it passed.
 */
export function dropIndex(list: EditList, from: number, t: number): number {
  const starts = clipStarts(list);
  let idx = 0;
  list.clips.forEach((c, i) => {
    if (i === from) return;
    const mid = starts[i] + clipLength(c) / 2;
    if (t > mid) idx += 1;
  });
  return idx;
}

/** Ruler label: m:ss, with tenths when ticks are sub-second. */
export function rulerLabel(t: number, step: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss =
    step < 1
      ? s.toFixed(step < 0.5 ? 2 : 1).padStart(step < 0.5 ? 5 : 4, "0")
      : String(Math.floor(s + 1e-6)).padStart(2, "0");
  return `${m}:${ss}`;
}

/** Snapping distance on screen. */
export const SNAP_PX = 8;

/** Times a drag snaps to: cuts, the playhead and the in / out marks. */
export function snapTargets(
  list: EditList,
  playhead: number | null,
  inPoint: number | null,
  outPoint: number | null,
): number[] {
  const out = editPoints(list);
  if (playhead !== null) out.push(playhead);
  if (inPoint !== null) out.push(inPoint);
  if (outPoint !== null) out.push(outPoint);
  return out;
}

/** `t` moved to the nearest target within `tolerance` seconds, else `t`. */
export function snapTime(
  t: number,
  targets: readonly number[],
  tolerance: number,
): number {
  let best = t;
  let dist = tolerance;
  for (const x of targets) {
    const d = Math.abs(x - t);
    if (d <= dist) {
      best = x;
      dist = d;
    }
  }
  return best;
}

/**
 * Waveform slice for a clip block: background offset / size in px so the
 * whole-source image (width `imgW` for `duration` s) lines up with the
 * clip's in..out at this zoom and speed.
 */
export function waveSlice(
  clip: Pick<VideoClip, "in" | "speed">,
  duration: number,
  pxPerSecond: number,
): { offset: number; size: number } {
  if (!(duration > 0)) return { offset: 0, size: 0 };
  const sp = clipSpeed(clip);
  const size = (duration / sp) * pxPerSecond;
  return { offset: -(clip.in / sp) * pxPerSecond, size };
}

/**
 * Pure helpers for the "Fix a section" waveform picker
 * (components/tools/Sa3AudioControls.tsx): peaks for drawing, pointer x →
 * seconds, and region → CSS percentages.
 */
import type { AudioRegion } from "@/lib/oj/sa3Params";

/** Shortest section a drag creates; shorter drags are treated as clicks. */
export const MIN_REGION_SECONDS = 0.3;

/** `bars` peak heights in 0..1 (max |sample| per bucket, normalised). */
export function computePeaks(samples: ArrayLike<number>, bars: number): number[] {
  const n = Math.max(1, Math.floor(bars));
  const out = new Array<number>(n).fill(0);
  if (!samples.length) return out;
  const size = samples.length / n;
  let top = 0;
  for (let i = 0; i < n; i++) {
    const from = Math.floor(i * size);
    const to = Math.max(from + 1, Math.floor((i + 1) * size));
    let m = 0;
    for (let j = from; j < to && j < samples.length; j++) {
      const v = Math.abs(samples[j]);
      if (v > m) m = v;
    }
    out[i] = m;
    if (m > top) top = m;
  }
  return top > 0 ? out.map((v) => v / top) : out;
}

/** Pointer offset (px) in a `width`-px strip → seconds, clamped, 0.1 s steps. */
export function secondsAtX(x: number, width: number, duration: number): number {
  if (!(width > 0) || !(duration > 0)) return 0;
  const t = (Math.min(width, Math.max(0, x)) / width) * duration;
  return Math.round(t * 10) / 10;
}

/** Drag from `a` to `b` seconds → a region, or null when too short. */
export function regionFromDrag(a: number, b: number): AudioRegion | null {
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  return end - start >= MIN_REGION_SECONDS ? { start, end } : null;
}

/** Region → left / width percentages of a `duration`-long strip. */
export function regionPercent(
  r: AudioRegion,
  duration: number,
): { left: number; width: number } {
  if (!(duration > 0)) return { left: 0, width: 0 };
  const s = Math.min(duration, Math.max(0, r.start));
  const e = Math.min(duration, Math.max(s, r.end));
  return { left: (s / duration) * 100, width: ((e - s) / duration) * 100 };
}

/** "audio/lofi_keys.safetensors" → "lofi keys". */
export function audioLoraLabel(name: string): string {
  return name
    .replace(/\\/g, "/")
    .replace(/^audio\//, "")
    .replace(/\.safetensors$/i, "")
    .replace(/[_]+/g, " ");
}

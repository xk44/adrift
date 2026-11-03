/**
 * Timeline math for a MotionSpec: where every scene sits, which scene(s) are
 * on screen at time t, and each element's entrance / exit progress.
 *
 * Scenes play back to back. A scene's transition occupies its own first
 * `transitionDur` seconds: during that window the previous scene keeps
 * playing underneath (its local clock runs past its duration, elements hold
 * their final state) while the incoming scene is revealed on top.
 */

import { clamp, ease, progress } from "./easing";
import type { MotionElement, MotionScene, MotionSpec } from "./spec";

export interface SceneSpan {
  start: number;
  end: number;
}

export function sceneSpans(spec: Pick<MotionSpec, "scenes">): SceneSpan[] {
  let t = 0;
  return spec.scenes.map((s) => {
    const span = { start: t, end: t + s.duration };
    t += s.duration;
    return span;
  });
}

export function totalDuration(spec: Pick<MotionSpec, "scenes">): number {
  return spec.scenes.reduce((a, s) => a + s.duration, 0);
}

export interface FrameLocation {
  index: number;
  /** Seconds since the scene started. */
  local: number;
  /** Transition progress into `index` (eased later); 1 when settled. */
  transition: number;
  /** Previous scene still visible under the transition. */
  prev: { index: number; local: number } | null;
}

/** Effective transition length (never more than 60% of either scene). */
export function transitionLength(spec: MotionSpec, index: number): number {
  const s = spec.scenes[index];
  if (!s || index === 0 || s.transition === "cut") return 0;
  const prev = spec.scenes[index - 1];
  return Math.max(
    0,
    Math.min(s.transitionDur, s.duration * 0.6, prev.duration * 0.6),
  );
}

export function locate(spec: MotionSpec, t: number): FrameLocation {
  const spans = sceneSpans(spec);
  const total = spans.length ? spans[spans.length - 1].end : 0;
  const time = clamp(Number.isFinite(t) ? t : 0, 0, Math.max(0, total - 1e-6));
  let index = spans.findIndex((s) => time >= s.start && time < s.end);
  if (index < 0) index = Math.max(0, spans.length - 1);
  const local = time - (spans[index]?.start ?? 0);
  const len = transitionLength(spec, index);
  if (len > 0 && local < len) {
    const prevScene = spec.scenes[index - 1];
    return {
      index,
      local,
      transition: local / len,
      prev: { index: index - 1, local: prevScene.duration + local },
    };
  }
  return { index, local, transition: 1, prev: null };
}

export interface ElementState {
  visible: boolean;
  /** Eased entrance progress 0..1. */
  enter: number;
  /** Raw (linear) entrance progress, for staggered sub-animations. */
  enterRaw: number;
  /** Exit progress 0..1 (0 = fully shown). */
  exit: number;
  /** Seconds since the element started. */
  age: number;
}

export const OUT_SECONDS = 0.45;

/** Where an element ends: its own `end`, else the scene end. */
export function elementEnd(el: MotionElement, scene: MotionScene): number {
  return el.end > el.start ? Math.min(el.end, scene.duration) : scene.duration;
}

export function elementState(
  el: MotionElement,
  scene: MotionScene,
  local: number,
): ElementState {
  const age = local - el.start;
  if (age < 0) return { visible: false, enter: 0, enterRaw: 0, exit: 0, age };
  const end = elementEnd(el, scene);
  const hasOwnEnd = el.end > el.start && el.end < scene.duration;
  const exits = el.out !== "none";
  let exit = 0;
  if (exits) {
    const outStart = end - OUT_SECONDS;
    exit = ease("inCubic", progress(local, outStart, OUT_SECONDS));
  } else if (hasOwnEnd && local >= end) {
    // No exit animation but an explicit end: it simply disappears.
    return { visible: false, enter: 1, enterRaw: 1, exit: 1, age };
  }
  // The previous scene's clock runs past its end during a transition: hold.
  if (exits && local >= end) exit = 1;
  const enterRaw = progress(age, 0, el.inDur);
  return {
    visible: exit < 1,
    enter: ease(el.ease, enterRaw),
    enterRaw,
    exit,
    age,
  };
}

/** Ease applied to transition progress. */
export function transitionEase(p: number): number {
  return ease("inOutCubic", p);
}

/** Frame count and the exact frame times for an export at `fps`. */
export function frameTimes(spec: MotionSpec, fps = spec.fps): number[] {
  const n = Math.max(1, Math.round(totalDuration(spec) * fps));
  return Array.from({ length: n }, (_, i) => i / fps);
}

/** Scene start (s) for each narration line, for voiceover placement. */
export function narrationCues(
  spec: MotionSpec,
): { scene: number; at: number; text: string }[] {
  const spans = sceneSpans(spec);
  return spec.scenes
    .map((s, i) => ({
      scene: i,
      at: spans[i].start + Math.min(0.25, s.duration / 4),
      text: s.narration.trim(),
    }))
    .filter((c) => c.text.length > 0);
}

/** Visible characters of a typewriter reveal. */
export function typewriterCount(text: string, p: number): number {
  return Math.round(Array.from(text).length * clamp(p, 0, 1));
}

/** Counter value at progress p (already eased), rounded to `decimals`. */
export function counterValue(
  from: number,
  to: number,
  p: number,
  decimals: number,
): number {
  const v = from + (to - from) * clamp(p, 0, 1);
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

/** "12,345.6" style grouping without Intl locale surprises. */
export function formatNumber(v: number, decimals: number): string {
  const neg = v < 0;
  const fixed = Math.abs(v).toFixed(decimals);
  const [int, frac] = fixed.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

/**
 * Motion Designer easing library: pure functions of t in [0, 1].
 * Penner-style in/out/inOut families plus back, elastic, bounce, a CSS-style
 * cubic-bezier solver and a critically damped spring. Everything is
 * deterministic so a frame at time t always renders the same pixels.
 */

export type EaseFn = (t: number) => number;

export const clamp01 = (t: number): number =>
  t <= 0 ? 0 : t >= 1 ? 1 : Number.isFinite(t) ? t : 0;

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number =>
  a + (b - a) * t;

/** Progress of `t` through the window [start, start + duration], clamped. */
export function progress(t: number, start: number, duration: number): number {
  if (duration <= 0) return t >= start ? 1 : 0;
  return clamp01((t - start) / duration);
}

/** Staggered progress for item i of n inside one window (kinetic text). */
export function stagger(
  p: number,
  i: number,
  n: number,
  overlap = 0.6,
): number {
  if (n <= 1) return clamp01(p);
  // Each item takes `slot` of the window; consecutive items overlap.
  const slot = 1 / (1 + (n - 1) * (1 - overlap));
  const start = i * slot * (1 - overlap);
  return clamp01((p - start) / slot);
}

const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3;
const c5 = (2 * Math.PI) / 4.5;

function bounceOut(t: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
}

/** CSS cubic-bezier(x1, y1, x2, y2) solved with Newton + bisection. */
export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): EaseFn {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sy = (u: number) => ((ay * u + by) * u + cy) * u;
  const dx = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  return (t: number) => {
    const x = clamp01(t);
    if (x === 0 || x === 1) return x;
    let u = x;
    for (let i = 0; i < 8; i++) {
      const err = sx(u) - x;
      if (Math.abs(err) < 1e-6) return sy(u);
      const d = dx(u);
      if (Math.abs(d) < 1e-6) break;
      u -= err / d;
    }
    let lo = 0;
    let hi = 1;
    u = x;
    for (let i = 0; i < 30; i++) {
      const v = sx(u);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = u;
      else hi = u;
      u = (lo + hi) / 2;
    }
    return sy(u);
  };
}

/** Damped spring settling to 1 (overshoots when damping < 1). */
export function spring(damping = 0.55, frequency = 3.2): EaseFn {
  const w = frequency * 2 * Math.PI;
  const z = clamp(damping, 0.05, 1);
  return (t: number) => {
    const x = clamp01(t);
    if (x === 0 || x === 1) return x;
    if (z >= 1) return 1 - (1 + w * x) * Math.exp(-w * x);
    const wd = w * Math.sqrt(1 - z * z);
    return (
      1 -
      Math.exp(-z * w * x) *
        (Math.cos(wd * x) + ((z * w) / wd) * Math.sin(wd * x))
    );
  };
}

export const EASINGS = {
  linear: (t: number) => t,
  inQuad: (t: number) => t * t,
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t: number) =>
    t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
  inCubic: (t: number) => t * t * t,
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  inQuart: (t: number) => t * t * t * t,
  outQuart: (t: number) => 1 - Math.pow(1 - t, 4),
  inOutQuart: (t: number) =>
    t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2,
  inExpo: (t: number) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  outExpo: (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOutExpo: (t: number) =>
    t === 0
      ? 0
      : t === 1
        ? 1
        : t < 0.5
          ? Math.pow(2, 20 * t - 10) / 2
          : (2 - Math.pow(2, -20 * t + 10)) / 2,
  inSine: (t: number) => 1 - Math.cos((t * Math.PI) / 2),
  outSine: (t: number) => Math.sin((t * Math.PI) / 2),
  inOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  inBack: (t: number) => c3 * t * t * t - c1 * t * t,
  outBack: (t: number) => 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2),
  inOutBack: (t: number) =>
    t < 0.5
      ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
      : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2,
  outElastic: (t: number) =>
    t === 0
      ? 0
      : t === 1
        ? 1
        : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1,
  inOutElastic: (t: number) =>
    t === 0
      ? 0
      : t === 1
        ? 1
        : t < 0.5
          ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * c5)) / 2
          : (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * c5)) / 2 +
            1,
  outBounce: bounceOut,
  inBounce: (t: number) => 1 - bounceOut(1 - t),
  /** Material "emphasized" curve: fast start, long soft landing. */
  smooth: cubicBezier(0.2, 0, 0, 1),
  /** Snappy UI curve. */
  snap: cubicBezier(0.5, 0, 0.1, 1),
  spring: spring(0.5, 2.6),
} satisfies Record<string, EaseFn>;

export type EaseName = keyof typeof EASINGS;
export const EASE_NAMES = Object.keys(EASINGS) as EaseName[];

export function ease(name: string | undefined, t: number): number {
  const fn = (EASINGS as Record<string, EaseFn>)[name ?? ""] ?? EASINGS.smooth;
  const x = clamp01(t);
  // Endpoints are exact for every curve.
  if (x === 0) return 0;
  if (x === 1) return 1;
  return fn(x);
}

/** Smooth 0..1..0 bump (pulse / breathe), period in seconds. */
export function wave(t: number, period: number, phase = 0): number {
  return 0.5 - 0.5 * Math.cos(((t + phase) / period) * 2 * Math.PI);
}

/** Deterministic pseudo-random in [0, 1) from an integer seed (mulberry32). */
export function rand(seed: number): number {
  let a = (seed | 0) + 0x6d2b79f5;
  a = Math.imul(a ^ (a >>> 15), a | 1);
  a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
  return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
}

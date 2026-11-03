/**
 * Grid Video: one short source clip (or a still) cut to a music track as a
 * beat-synced grid music video. Three styles:
 *
 *   poster     grid of tiles (1x1 -> 2x2 -> ... -> NxN, stepping on beats),
 *              every tile a different moment / crop / zoom of the source,
 *              tiles reshuffle and flash on each cut
 *   infection  a fixed grid where a "style" (duotone, posterize, invert,
 *              halftone, ...) spreads tile to tile on the beat until the
 *              whole frame is infected, then resets with the next style
 *   mosaic     temporal mosaic: each tile plays the clip at a time offset
 *              that ripples out from a moving centre (and a slightly
 *              different speed), the grid pulses between two sizes on beats
 *
 * The output is as long as the music (capped), the source loops back and
 * forth (ping-pong) to fill it. Pure, client- and server-safe planning: beat
 * times -> frame-quantized segments -> per-segment grid + per-tile
 * parameters (GridPlan). The builder (src/lib/oj/gridVideo.ts) runs
 * planGridVideo on the server and hands the plan JSON to the CJGridVideo
 * node (comfy_nodes/cj_h3_tools/cj_grid_video.py), which renders it with
 * numpy + ffmpeg. The executor is gridVideoRunner.ts.
 */
import type { HubCard } from "./hub";
import { AUDIO_EXT, VIDEO_EXT, isSafeFileRef } from "./pipelines";

export const GRID_VIDEO_ACTION = "grid_video";
export const GRID_VIDEO_KEY = "special:grid_video";
export const GRID_VIDEO_FPS = 24;
/** Same cap as the pipeline assembler: every output frame is rendered on CPU. */
export const GRID_VIDEO_MAX_SECONDS = 90;
export const GRID_VIDEO_MIN_SECONDS = 2;
/** Source frames held in RAM by the node (decoded at the output size). */
export const GRID_SOURCE_MAX_SECONDS = 20;
/** Cuts closer than this are merged (one-frame flicker reads as a glitch). */
export const GRID_MIN_SEGMENT_SECONDS = 0.25;
export const GRID_MAX_MIN = 2;
export const GRID_MAX_MAX = 6;
export const GRID_MAX_DEFAULT = 4;
/** Hard cap on segments so the plan JSON stays small (~3 min at 160 bpm). */
export const GRID_MAX_SEGMENTS = 480;
export const GRID_MAX_BEATS = 2000;
export const GRID_DEFAULT_BPM = 120;
export const GRID_IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

export const GRID_STYLES = ["poster", "infection", "mosaic"] as const;
export type GridStyle = (typeof GRID_STYLES)[number];
export const GRID_ASPECTS = ["1:1", "9:16", "16:9"] as const;
export type GridAspect = (typeof GRID_ASPECTS)[number];
export const GRID_INTENSITIES = ["low", "medium", "high"] as const;
export type GridIntensity = (typeof GRID_INTENSITIES)[number];
export const GRID_RESOLUTIONS = [720, 1080] as const;
export type GridResolution = (typeof GRID_RESOLUTIONS)[number];

export const GRID_STYLE_INFO: Record<
  GridStyle,
  { label: string; blurb: string }
> = {
  poster: {
    label: "Poster grid",
    blurb:
      "The grid steps 1x1 to NxN on the beat; every tile a different moment, crop and zoom, flashing on each cut.",
  },
  infection: {
    label: "Style infection",
    blurb:
      "A look (duotone, halftone, posterize, invert...) spreads tile to tile on the beat until the frame is taken, then resets.",
  },
  mosaic: {
    label: "Temporal mosaic",
    blurb:
      "Each tile plays the clip a little later than its neighbour, rippling out from a moving centre; the grid pulses on beats.",
  },
};

/** Output size per aspect at the short side (720 or 1080). */
export function gridVideoSize(
  aspect: GridAspect,
  resolution: GridResolution = 720,
): { width: number; height: number } {
  if (resolution !== 720 && resolution !== 1080) {
    throw new Error(`grid video: resolution must be 720 or 1080 (got ${String(resolution)})`);
  }
  const s = resolution;
  const l = Math.round((s * 16) / 9 / 2) * 2;
  if (aspect === "9:16") return { width: s, height: l };
  if (aspect === "16:9") return { width: l, height: s };
  return { width: s, height: s };
}

interface IntensityTuning {
  /** Beats per cut. */
  beatsPerSegment: number;
  /** Peak white flash on a cut (0..1), decays over ~0.15 s. */
  flash: number;
  /** Tile speeds vary by +- this around 1x. */
  speedSpread: number;
  /** Max tile zoom (1 = the tile shows the whole frame, cover fit). */
  zoomMax: number;
  /** Poster: chance a tile gets a one-segment effect. */
  fxChance: number;
  /** Infection: segments from the first infected tile to a full frame. */
  infectSteps: number;
  /** Mosaic: frames of delay per ring of distance from the ripple centre. */
  lag: number;
  /** Zoom punch on a cut (fraction), decays over ~0.25 s. */
  pulse: number;
}

export const GRID_INTENSITY: Record<GridIntensity, IntensityTuning> = {
  low: {
    beatsPerSegment: 4,
    flash: 0.3,
    speedSpread: 0,
    zoomMax: 1.25,
    fxChance: 0,
    infectSteps: 8,
    lag: 3,
    pulse: 0.03,
  },
  medium: {
    beatsPerSegment: 2,
    flash: 0.55,
    speedSpread: 0.25,
    zoomMax: 1.45,
    fxChance: 0.08,
    infectSteps: 6,
    lag: 4,
    pulse: 0.06,
  },
  high: {
    beatsPerSegment: 1,
    flash: 0.85,
    speedSpread: 0.5,
    zoomMax: 1.7,
    fxChance: 0.16,
    infectSteps: 4,
    lag: 6,
    pulse: 0.1,
  },
};

/**
 * Effect catalog (the node implements each `k`). Infection cycles through
 * them in this order; poster uses the cheap single-tile ones as accents.
 */
export type GridEffect =
  | { k: "duotone"; a: string; b: string }
  | { k: "posterize"; n: number }
  | { k: "invert" }
  | { k: "halftone"; ink: string; paper: string }
  | { k: "mono"; contrast: number }
  | { k: "solarize" }
  | { k: "rgbsplit"; px: number }
  | { k: "swap" };

export const GRID_EFFECTS: GridEffect[] = [
  { k: "duotone", a: "#1b0a3c", b: "#ff3d8b" },
  { k: "halftone", ink: "#111111", paper: "#f2ead8" },
  { k: "posterize", n: 3 },
  { k: "invert" },
  { k: "duotone", a: "#06202b", b: "#3df5c8" },
  { k: "mono", contrast: 1.7 },
  { k: "solarize" },
  { k: "rgbsplit", px: 8 },
  { k: "duotone", a: "#2a0800", b: "#ffb000" },
  { k: "swap" },
];
/** Poster accents: indexes into GRID_EFFECTS. */
const POSTER_ACCENTS = [3, 5, 7, 9];

/** One tile: [offset, speed, zoom0, zoom1, cx, cy, mirror, fx, flash]. */
export type GridTile = [
  number,
  number,
  number,
  number,
  number,
  number,
  0 | 1,
  number,
  number,
];

export interface GridSegment {
  /** First output frame (inclusive) and end frame (exclusive). */
  f0: number;
  f1: number;
  rows: number;
  cols: number;
  /** Gap between tiles in output pixels. */
  gap: number;
  /** Zoom punch at the cut (fraction), decays inside the segment. */
  pulse: number;
  /** Row-major, rows * cols. */
  tiles: GridTile[];
}

export interface GridPlan {
  v: 1;
  style: GridStyle;
  width: number;
  height: number;
  fps: number;
  /** Output frames (= music length, capped). */
  frames: number;
  /** Source frames the plan assumes (the node wraps on what it decodes). */
  srcFrames: number;
  still: boolean;
  bg: string;
  fx: GridEffect[];
  segments: GridSegment[];
}

export interface GridVideoSpec {
  source: string;
  sourceKind: "video" | "image";
  /** Source clip length (browser metadata); null = unknown. */
  sourceSeconds: number | null;
  audio: string;
  audioSeconds: number;
  /** Beat times in seconds (beats.ts); may be empty. */
  beats: number[];
  bpm: number | null;
  style: GridStyle;
  aspect: GridAspect;
  gridMax: number;
  intensity: GridIntensity;
  resolution: GridResolution;
  seed: number;
}

// Random

/** Small deterministic PRNG (mulberry32), returns [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));

// Params

function num(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function oneOf<T extends string>(
  value: unknown,
  list: readonly T[],
  fallback: T,
  what: string,
): T {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && (list as readonly string[]).includes(value))
    return value as T;
  throw new Error(`${GRID_VIDEO_ACTION}: unknown ${what} "${String(value)}"`);
}

/** Validate action params (server side; throws a readable Error). */
export function normalizeGridParams(
  params: Record<string, unknown>,
): GridVideoSpec {
  const A = GRID_VIDEO_ACTION;
  const sourceKind = params.sourceKind === "image" ? "image" : "video";
  const ext = sourceKind === "image" ? GRID_IMAGE_EXT : VIDEO_EXT;
  if (!isSafeFileRef(params.source, ext))
    throw new Error(`${A}: params.source must be a ComfyUI ${sourceKind} ref`);
  if (!isSafeFileRef(params.audio, AUDIO_EXT))
    throw new Error(`${A}: params.audio must be a ComfyUI audio ref`);
  const audioSeconds = num(params.audioSeconds);
  if (audioSeconds === undefined || audioSeconds <= 0)
    throw new Error(`${A}: params.audioSeconds must be the music length`);
  if (audioSeconds < GRID_VIDEO_MIN_SECONDS)
    throw new Error(
      `${A}: the music is under ${GRID_VIDEO_MIN_SECONDS} s; use a longer track`,
    );
  const srcSec = num(params.sourceSeconds);
  const beatsRaw = Array.isArray(params.beats) ? params.beats : [];
  if (beatsRaw.length > GRID_MAX_BEATS)
    throw new Error(`${A}: too many beats (max ${GRID_MAX_BEATS})`);
  const beats = beatsRaw
    .map((b) => num(b))
    .filter((b): b is number => b !== undefined && b >= 0);
  const bpm = num(params.bpm);
  const gridMax = Math.round(num(params.gridMax) ?? GRID_MAX_DEFAULT);
  const res = num(params.resolution) ?? 720;
  if (!(GRID_RESOLUTIONS as readonly number[]).includes(res))
    throw new Error(`${A}: resolution must be 720 or 1080`);
  return {
    source: params.source,
    sourceKind,
    sourceSeconds: srcSec !== undefined && srcSec > 0 ? srcSec : null,
    audio: params.audio,
    audioSeconds,
    beats,
    bpm: bpm !== undefined && bpm >= 40 && bpm <= 260 ? bpm : null,
    style: oneOf(params.style, GRID_STYLES, "poster", "style"),
    aspect: oneOf(params.aspect, GRID_ASPECTS, "1:1", "aspect"),
    gridMax: clamp(gridMax, GRID_MAX_MIN, GRID_MAX_MAX),
    intensity: oneOf(params.intensity, GRID_INTENSITIES, "medium", "intensity"),
    resolution: res as GridResolution,
    seed: Math.abs(Math.round(num(params.seed) ?? 1)) % 2147483647,
  };
}

// Timing

/**
 * Beat times to use: the detected beats inside (0, duration), sorted, with
 * near-duplicates dropped; fewer than 2 detected beats -> a regular grid at
 * bpm (default 120).
 */
export function beatTimes(
  beats: number[],
  duration: number,
  bpm: number | null,
): number[] {
  const sorted = beats
    .filter((b) => Number.isFinite(b) && b > 0.05 && b < duration - 0.05)
    .sort((a, b) => a - b);
  const out: number[] = [];
  for (const b of sorted)
    if (!out.length || b - out[out.length - 1] >= 0.1) out.push(b);
  if (out.length >= 2) return out;
  const period = 60 / (bpm ?? GRID_DEFAULT_BPM);
  const grid: number[] = [];
  for (let t = period; t < duration - 0.05; t += period) grid.push(r3(t));
  return grid;
}

/**
 * Cut frames: every `beatsPerSegment`-th beat, never closer than
 * GRID_MIN_SEGMENT_SECONDS (beats-per-cut doubles until the median beat
 * spacing clears it, then stragglers are skipped), frame-quantized, from 0
 * to `frames`.
 */
export function segmentBounds(
  beats: number[],
  frames: number,
  fps: number,
  beatsPerSegment: number,
): number[] {
  const minFrames = Math.max(1, Math.round(GRID_MIN_SEGMENT_SECONDS * fps));
  let per = Math.max(1, Math.round(beatsPerSegment));
  if (beats.length >= 2) {
    const gaps = beats
      .slice(1)
      .map((b, i) => b - beats[i])
      .sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    while (median * per < GRID_MIN_SEGMENT_SECONDS && per < 64) per *= 2;
  }
  const bounds = [0];
  for (let i = per - 1; i < beats.length; i += per) {
    const f = Math.round(beats[i] * fps);
    if (f - bounds[bounds.length - 1] >= minFrames && frames - f >= minFrames)
      bounds.push(f);
  }
  bounds.push(frames);
  // keep the plan small: merge the shortest neighbours past the cap
  while (bounds.length - 1 > GRID_MAX_SEGMENTS) {
    let best = 1;
    for (let i = 2; i < bounds.length - 1; i++)
      if (bounds[i + 1] - bounds[i - 1] < bounds[best + 1] - bounds[best - 1])
        best = i;
    bounds.splice(best, 1);
  }
  return bounds;
}

/** Rows for `cols` columns so tiles stay near square on a W x H frame. */
export function gridRows(cols: number, width: number, height: number): number {
  return clamp(Math.round((cols * height) / width), 1, cols * 2);
}

/**
 * Infection spread order over a rows x cols grid (row-major indexes): starts
 * at `start`, each next tile is a random 4-neighbour of the infected area
 * (Eden growth), so the style creeps outward as one organic blob.
 */
export function infectionOrder(
  rows: number,
  cols: number,
  start: number,
  rng: () => number,
): number[] {
  const n = rows * cols;
  const seen = new Uint8Array(n);
  const order = [start];
  seen[start] = 1;
  const frontier: number[] = [];
  const push = (i: number) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const nb = [
      r > 0 ? i - cols : -1,
      r < rows - 1 ? i + cols : -1,
      c > 0 ? i - 1 : -1,
      c < cols - 1 ? i + 1 : -1,
    ];
    for (const j of nb)
      if (j >= 0 && !seen[j]) {
        seen[j] = 2;
        frontier.push(j);
      }
  };
  push(start);
  while (frontier.length) {
    const k = Math.floor(rng() * frontier.length);
    const i = frontier[k];
    frontier[k] = frontier[frontier.length - 1];
    frontier.pop();
    seen[i] = 1;
    order.push(i);
    push(i);
  }
  return order;
}

/** Tiles infected after step s (1..steps): accelerating, 1 -> all. */
export function infectedCount(
  step: number,
  steps: number,
  total: number,
): number {
  if (step >= steps) return total;
  const s = Math.max(1, step);
  return clamp(Math.round(total * (s / steps) ** 2), 1, total);
}

// Plan

function tile(
  o: number,
  s: number,
  z0: number,
  z1: number,
  cx: number,
  cy: number,
  m: boolean,
  fx: number,
  fl: number,
): GridTile {
  return [
    Math.max(0, Math.round(o)),
    r3(s),
    r3(z0),
    r3(z1),
    r3(clamp(cx, 0, 1)),
    r3(clamp(cy, 0, 1)),
    m ? 1 : 0,
    fx,
    r3(fl),
  ];
}

/** Build the render plan for validated params (pure, deterministic per seed). */
export function planGridVideo(spec: GridVideoSpec): GridPlan {
  const fps = GRID_VIDEO_FPS;
  const { width, height } = gridVideoSize(spec.aspect, spec.resolution);
  const seconds = Math.min(spec.audioSeconds, GRID_VIDEO_MAX_SECONDS);
  const frames = Math.max(1, Math.round(seconds * fps));
  const still = spec.sourceKind === "image";
  const srcFrames = still
    ? 1
    : Math.max(
        1,
        Math.floor(
          Math.min(spec.sourceSeconds ?? 10, GRID_SOURCE_MAX_SECONDS) * fps,
        ),
      );
  const tune = GRID_INTENSITY[spec.intensity];
  const rng = mulberry32(spec.seed || 1);
  const rand = (lo: number, hi: number) => lo + (hi - lo) * rng();
  const beats = beatTimes(spec.beats, frames / fps, spec.bpm);
  const bounds = segmentBounds(beats, frames, fps, tune.beatsPerSegment);
  const minDim = Math.min(width, height);
  const speed = () => (still ? 0 : 1 + (rng() * 2 - 1) * tune.speedSpread);
  const zoomPair = (lo: number) => {
    const z = rand(lo, tune.zoomMax);
    const drift = still ? rand(0.08, 0.2) : rand(-0.06, 0.06);
    return [z, Math.max(1, z + drift)] as const;
  };
  const segments: GridSegment[] = [];

  if (spec.style === "poster") {
    const ramp: number[] = [];
    for (let n = 1; n <= spec.gridMax; n++) ramp.push(n);
    for (let i = 0; i < bounds.length - 1; i++) {
      const f0 = bounds[i];
      const f1 = bounds[i + 1];
      const cols = ramp[i % ramp.length];
      const rows = cols === 1 ? 1 : gridRows(cols, width, height);
      const tiles: GridTile[] = [];
      for (let t = 0; t < rows * cols; t++) {
        const s = speed();
        const [z0, z1] = cols === 1 ? [1, still ? 1.12 : 1.04] : zoomPair(1);
        const fx =
          cols > 1 && rng() < tune.fxChance
            ? POSTER_ACCENTS[Math.floor(rng() * POSTER_ACCENTS.length)]
            : -1;
        tiles.push(
          tile(
            still ? 0 : rng() * srcFrames,
            s,
            z0,
            z1,
            rand(0.2, 0.8),
            rand(0.2, 0.8),
            cols > 1 && rng() < 0.3,
            fx,
            tune.flash * rand(0.6, 1),
          ),
        );
      }
      segments.push({
        f0,
        f1,
        rows,
        cols,
        gap: cols === 1 ? 0 : Math.round(minDim * 0.012),
        pulse: tune.pulse,
        tiles,
      });
    }
  } else if (spec.style === "infection") {
    const cols = Math.max(3, spec.gridMax);
    const rows = gridRows(cols, width, height);
    const total = rows * cols;
    const steps = tune.infectSteps;
    const cycleLen = steps + 1; // + one fully infected hold
    let order: number[] = [];
    let base: {
      o: number;
      s: number;
      z0: number;
      z1: number;
      cx: number;
      cy: number;
      m: boolean;
    }[] = [];
    let fxIdx = Math.floor(rng() * GRID_EFFECTS.length);
    let prevInfected = 0;
    for (let i = 0; i < bounds.length - 1; i++) {
      const f0 = bounds[i];
      const f1 = bounds[i + 1];
      const step = i % cycleLen;
      if (step === 0) {
        // new cycle: fresh seed tile, next effect, tiles re-framed
        order = infectionOrder(rows, cols, Math.floor(rng() * total), rng);
        if (i > 0) fxIdx = (fxIdx + 1) % GRID_EFFECTS.length;
        const s = speed();
        const startO = rng() * srcFrames;
        base = Array.from({ length: total }, (_, t) => {
          const [z0, z1] = zoomPair(1);
          return {
            o: startO + t * 2,
            s,
            z0,
            z1,
            cx: rand(0.3, 0.7),
            cy: rand(0.3, 0.7),
            m: rng() < 0.25,
          };
        });
        prevInfected = 0;
      }
      const count = infectedCount(step + 1, steps, total);
      const infected = new Set(order.slice(0, count));
      const fresh = new Set(order.slice(prevInfected, count));
      prevInfected = count;
      const tiles = base.map((b, t) =>
        tile(
          still ? 0 : b.o + (f0 - bounds[i - step]) * b.s,
          b.s,
          b.z0,
          b.z1,
          b.cx,
          b.cy,
          b.m,
          infected.has(t) ? fxIdx : -1,
          fresh.has(t) ? tune.flash : 0,
        ),
      );
      segments.push({
        f0,
        f1,
        rows,
        cols,
        gap: Math.round(minDim * 0.008),
        pulse: step === steps - 1 ? tune.pulse * 1.5 : tune.pulse * 0.5,
        tiles,
      });
    }
  } else {
    // mosaic: grid alternates gridMax / gridMax - 1 on the beat
    const big = spec.gridMax;
    const small = Math.max(2, big - 1);
    const sp = still ? 0 : 1;
    for (let i = 0; i < bounds.length - 1; i++) {
      const f0 = bounds[i];
      const f1 = bounds[i + 1];
      const cols = i % 2 === 0 ? big : small;
      const rows = gridRows(cols, width, height);
      const cr = Math.floor(rng() * rows);
      const cc = Math.floor(rng() * cols);
      const dMax = Math.max(
        1,
        Math.hypot(Math.max(cr, rows - 1 - cr), Math.max(cc, cols - 1 - cc)),
      );
      const tiles: GridTile[] = [];
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const d = Math.hypot(r - cr, c - cc);
          const s = still ? 0 : 1 + tune.speedSpread * 0.6 * (d / dMax - 0.5);
          tiles.push(
            tile(
              still ? 0 : f0 * sp + d * tune.lag,
              s,
              still ? 1 + 0.06 * d : 1.05,
              still ? 1.12 + 0.06 * d : 1.1,
              0.5,
              0.5,
              false,
              -1,
              d === 0 ? tune.flash : tune.flash * 0.25 * (1 - d / dMax),
            ),
          );
        }
      segments.push({
        f0,
        f1,
        rows,
        cols,
        gap: Math.round(minDim * 0.006),
        pulse: tune.pulse,
        tiles,
      });
    }
  }

  return {
    v: 1,
    style: spec.style,
    width,
    height,
    fps,
    frames,
    srcFrames,
    still,
    bg: spec.style === "infection" ? "#0b0b0b" : "#000000",
    fx: GRID_EFFECTS,
    segments,
  };
}

// Client helpers

export interface GridVideoInputs {
  /** ComfyUI refs of the uploaded source + music. */
  source: string;
  sourceKind: "video" | "image";
  sourceSeconds: number | null;
  audio: string;
  audioSeconds: number;
  beats: number[];
  bpm: number | null;
}

export interface GridVideoOptions {
  style: GridStyle;
  aspect: GridAspect;
  gridMax: number;
  intensity: GridIntensity;
  resolution?: GridResolution;
  seed?: number;
}

/** Action params for grid_video (validated the same way the server does). */
export function gridVideoParams(
  inputs: GridVideoInputs,
  opts: GridVideoOptions,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    source: inputs.source,
    sourceKind: inputs.sourceKind,
    sourceSeconds:
      inputs.sourceSeconds !== null ? r3(inputs.sourceSeconds) : null,
    audio: inputs.audio,
    audioSeconds: r3(inputs.audioSeconds),
    beats: inputs.beats
      .filter((b) => b < GRID_VIDEO_MAX_SECONDS)
      .slice(0, GRID_MAX_BEATS)
      .map(r3),
    bpm: inputs.bpm !== null ? Math.round(inputs.bpm * 10) / 10 : null,
    style: opts.style,
    aspect: opts.aspect,
    gridMax: opts.gridMax,
    intensity: opts.intensity,
    resolution: opts.resolution ?? 720,
    seed: opts.seed ?? Math.floor(Math.random() * 1e9),
  };
  normalizeGridParams(params); // throw early, same message as the server
  return params;
}

export function gridVideoCard(): HubCard {
  return {
    key: GRID_VIDEO_KEY,
    kind: "special",
    id: GRID_VIDEO_ACTION,
    title: "Grid Video",
    subtitle:
      "Turn a short clip and a song into a beat-synced grid music video",
    icon: "LayoutGrid",
    hubCategory: "Video",
    available: true,
    unavailableReason: null,
    licenseNote: null,
    checking: false,
    model: "No model (ffmpeg + numpy node)",
    nc: false,
    aliases: [
      "grid",
      "grid effect",
      "music video",
      "beat sync",
      "beat cut",
      "mosaic",
      "temporal mosaic",
      "poster wall",
      "split screen",
      "multi screen",
      "style infection",
      "glitch",
      "duotone",
      "halftone",
    ],
  };
}

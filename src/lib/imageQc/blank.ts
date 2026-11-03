/**
 * Blank-canvas detection for Ideogram 4 outputs. When Ideogram's built-in
 * safety filter trips, the graph still "succeeds" but saves a flat,
 * single-colour image. Pure (no node imports): the decoder + job wiring is
 * ./server.ts.
 */

export interface BlankStats {
  pixels: number;
  /** Per-channel mean, 0-255. */
  mean: number[];
  /** Largest per-channel standard deviation, 0-255. */
  std: number;
  /** Fraction of pixels within `tolerance` of the mean colour on every channel. */
  flatShare: number;
}

export interface BlankThresholds {
  maxStd: number;
  minFlatShare: number;
  tolerance: number;
}

// Conservative: a filtered canvas is one colour; a real photo of a plain
// wall or sky still carries grain/gradient well above these.
export const BLANK_THRESHOLDS: BlankThresholds = {
  maxStd: 2.5,
  minFlatShare: 0.995,
  tolerance: 6,
};

export const SAFETY_FILTER_MESSAGE = "Blocked by Ideogram's safety filter";

/** Stats over interleaved 8-bit pixels (`channels` = 1-4; alpha ignored). */
export function blankCanvasStats(
  data: Uint8Array,
  channels: number,
  tolerance = BLANK_THRESHOLDS.tolerance,
): BlankStats {
  const colour = Math.min(channels, 3);
  const pixels = channels > 0 ? Math.floor(data.length / channels) : 0;
  const mean = new Array<number>(colour).fill(0);
  if (pixels === 0) return { pixels: 0, mean, std: 0, flatShare: 0 };
  const sq = new Array<number>(colour).fill(0);
  for (let p = 0; p < pixels; p++) {
    for (let c = 0; c < colour; c++) {
      const v = data[p * channels + c];
      mean[c] += v;
      sq[c] += v * v;
    }
  }
  let std = 0;
  for (let c = 0; c < colour; c++) {
    mean[c] /= pixels;
    std = Math.max(std, Math.sqrt(Math.max(0, sq[c] / pixels - mean[c] ** 2)));
  }
  let flat = 0;
  for (let p = 0; p < pixels; p++) {
    let ok = true;
    for (let c = 0; c < colour && ok; c++)
      ok = Math.abs(data[p * channels + c] - mean[c]) <= tolerance;
    if (ok) flat++;
  }
  return { pixels, mean, std, flatShare: flat / pixels };
}

export function isBlankCanvas(
  s: BlankStats,
  t: BlankThresholds = BLANK_THRESHOLDS,
): boolean {
  return s.pixels > 0 && s.std <= t.maxStd && s.flatShare >= t.minFlatShare;
}

/**
 * The graph is an Ideogram 4 render (scheduler or text encoder). Masks,
 * solid fills and other tools never match, so flat outputs there are left
 * alone.
 */
export function isIdeogramGraph(
  graph: Record<string, unknown> | null | undefined,
): boolean {
  if (!graph) return false;
  return Object.values(graph).some((n) => {
    if (!n || typeof n !== "object") return false;
    const node = n as {
      class_type?: unknown;
      inputs?: Record<string, unknown>;
    };
    if (typeof node.class_type !== "string") return false;
    if (/^Ideogram4/i.test(node.class_type)) return true;
    return (
      node.class_type === "CLIPLoader" &&
      typeof node.inputs?.type === "string" &&
      /^ideogram/i.test(node.inputs.type)
    );
  });
}

/**
 * One automatic re-roll per original render, never a chain: only the first
 * attempt re-rolls, and only if it hasn't already.
 */
export function shouldAutoRerollBlank(
  blank: boolean,
  attempt: number,
  alreadyAutoRerolled: boolean,
): boolean {
  return blank && attempt <= 1 && !alreadyAutoRerolled;
}

/**
 * Client polling: the verdict for `key` is in and nothing more happens
 * without the user (passed, errored, a re-roll itself, or already re-rolled).
 */
export function blankCheckSettled(
  qc: {
    attempt: number;
    error?: string;
    rerolls?: unknown[];
    outputs?: Record<string, { status: string }>;
  } | null,
  key: string,
): boolean {
  const out = qc?.outputs?.[key];
  if (!qc || !out) return false;
  if (out.status === "pass" || qc.error || qc.attempt > 1) return true;
  return (qc.rerolls ?? []).length > 0;
}

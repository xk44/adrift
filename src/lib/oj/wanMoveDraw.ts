/**
 * Free-draw input for "Trajectory motion" (wan_move): the user draws one or
 * more paths over the photo, optionally marks what each path moves (brush or
 * Smart select region, a motion brush), and drops pins that hold points
 * still. Everything arrives normalized (0-1 of width / height); this module
 * turns it into the pixel track list WanMoveTracksFromCoords parses:
 * [[{x, y}, ...one per frame], ...one per track].
 *
 * Semantics (Wan-Move drags the image content under each track's first point
 * along the track):
 *   - path with region seeds: every seed point follows the path's
 *     displacement (path(u) - path(0)), so the whole region moves rigidly
 *     along the stroke (motion brush);
 *   - path without seeds: a small cross of points around the stroke start
 *     follows it (draw from the object to where it should go);
 *   - pin: a static track, the content there stays put.
 * Paths are walked by arc length with ease-in-out timing, matching the
 * named presets in ./wanMove.ts.
 *
 * Pure and client-safe: the Tools page sanitizes with the same parser it
 * sends, and the action builder re-parses server-side.
 */

export interface DrawPoint {
  x: number;
  y: number;
}

export interface WanMoveDrawPath {
  /** Stroke, normalized, in drawing order (>= 2 points). */
  points: DrawPoint[];
  /** Region points that follow this path (motion brush); empty = start cluster. */
  seeds?: DrawPoint[];
}

export interface WanMoveDraw {
  paths: WanMoveDrawPath[];
  /** Points held still for the whole clip. */
  pins?: DrawPoint[];
}

export const WAN_MOVE_DRAW_LIMITS = {
  paths: 6,
  pathPoints: 64,
  seedsPerPath: 24,
  pins: 12,
  /** Strokes shorter than this (normalized length) are taps, not paths. */
  minPathLength: 0.02,
} as const;

/** Start-cluster radius (normalized of the shorter side) when a path has no region. */
export const WAN_MOVE_DRAW_CLUSTER_RADIUS = 0.03;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round4 = (v: number) => Math.round(v * 10000) / 10000;

function cleanPoint(raw: unknown): DrawPoint | null {
  if (!raw || typeof raw !== "object") return null;
  const x = Number((raw as DrawPoint).x);
  const y = Number((raw as DrawPoint).y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: round4(clamp01(x)), y: round4(clamp01(y)) };
}

function cleanPoints(raw: unknown, max: number): DrawPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: DrawPoint[] = [];
  for (const p of raw) {
    const c = cleanPoint(p);
    if (c) out.push(c);
  }
  return out.length > max ? evenlyPick(out, max) : out;
}

/** Keep `max` items spread evenly, always including the first and last. */
function evenlyPick<T>(list: T[], max: number): T[] {
  if (list.length <= max) return list;
  if (max <= 1) return [list[0]];
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    out.push(list[Math.round((i * (list.length - 1)) / (max - 1))]);
  }
  return out;
}

export function pathLength(points: DrawPoint[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y,
    );
  }
  return len;
}

/**
 * Resample a raw pointer stroke to at most `max` points spaced evenly by arc
 * length (drops jitter, keeps the shape). Used by the draw UI before sending.
 */
export function simplifyStroke(
  points: DrawPoint[],
  max: number = WAN_MOVE_DRAW_LIMITS.pathPoints,
): DrawPoint[] {
  const pts = points.filter(
    (p, i) =>
      i === 0 ||
      Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 1e-4,
  );
  if (pts.length < 2) return pts.map((p) => ({ ...p }));
  const total = pathLength(pts);
  // ~1 point per 1.5% of the frame, bounded by max.
  const n = Math.max(2, Math.min(max, Math.ceil(total / 0.015) + 1));
  return Array.from({ length: n }, (_, i) => {
    const p = pointAlong(pts, i / (n - 1));
    return { x: round4(p.x), y: round4(p.y) };
  });
}

/** Point at fraction `u` (0..1) of the path's arc length. */
export function pointAlong(points: DrawPoint[], u: number): DrawPoint {
  if (points.length === 0) return { x: 0.5, y: 0.5 };
  if (points.length === 1 || u <= 0) return points[0];
  const total = pathLength(points);
  if (total <= 0) return points[0];
  let target = Math.min(1, u) * total;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (target <= seg || i === points.length - 1) {
      const t = seg > 0 ? Math.min(1, target / seg) : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    target -= seg;
  }
  return points[points.length - 1];
}

/**
 * Sanitize a client-sent drawing: normalized, finite, capped counts, taps
 * dropped. Returns null when nothing usable is left (no path and no pin
 * cannot animate anything; pins alone hold the scene and are rejected too).
 */
export function parseWanMoveDraw(raw: unknown): WanMoveDraw | null {
  if (!raw || typeof raw !== "object") return null;
  const L = WAN_MOVE_DRAW_LIMITS;
  const rawPaths = (raw as { paths?: unknown }).paths;
  const paths: WanMoveDrawPath[] = [];
  if (Array.isArray(rawPaths)) {
    for (const rp of rawPaths) {
      if (!rp || typeof rp !== "object") continue;
      const points = cleanPoints((rp as WanMoveDrawPath).points, L.pathPoints);
      if (points.length < 2 || pathLength(points) < L.minPathLength) continue;
      const seeds = cleanPoints((rp as WanMoveDrawPath).seeds, L.seedsPerPath);
      paths.push(seeds.length ? { points, seeds } : { points });
      if (paths.length >= L.paths) break;
    }
  }
  if (paths.length === 0) return null;
  const pins = cleanPoints((raw as WanMoveDraw).pins, L.pins);
  return pins.length ? { paths, pins } : { paths };
}

export function hasWanMoveDraw(raw: unknown): boolean {
  return parseWanMoveDraw(raw) !== null;
}

/** Cross of 5 points around `p` (round in pixels: x radius scaled by aspect). */
export function startCluster(p: DrawPoint, aspect: number): DrawPoint[] {
  const r = WAN_MOVE_DRAW_CLUSTER_RADIUS;
  // r is a fraction of the shorter side.
  const rx = aspect >= 1 ? r / aspect : r;
  const ry = aspect >= 1 ? r : r * aspect;
  return [
    p,
    { x: p.x - rx, y: p.y },
    { x: p.x + rx, y: p.y },
    { x: p.x, y: p.y - ry },
    { x: p.x, y: p.y + ry },
  ].map((q) => ({ x: clamp01(q.x), y: clamp01(q.y) }));
}

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * Pixel tracks for `frames` frames at width x height. Order: each path's
 * seed (or start-cluster) tracks in path order, then pins.
 */
export function wanMoveDrawTracks(
  draw: WanMoveDraw,
  width: number,
  height: number,
  frames: number,
): Array<Array<{ x: number; y: number }>> {
  const aspect = width / height;
  const px = (q: DrawPoint) => ({
    x: Math.round(Math.min(width - 1, Math.max(0, q.x * width))),
    y: Math.round(Math.min(height - 1, Math.max(0, q.y * height))),
  });
  const n = Math.max(1, frames);
  const us = Array.from({ length: n }, (_, f) => ease(n > 1 ? f / (n - 1) : 0));
  const tracks: Array<Array<{ x: number; y: number }>> = [];
  for (const path of draw.paths) {
    const start = path.points[0];
    const offsets = us.map((u) => {
      const p = pointAlong(path.points, u);
      return { dx: p.x - start.x, dy: p.y - start.y };
    });
    const seeds = path.seeds?.length ? path.seeds : startCluster(start, aspect);
    for (const s of seeds) {
      tracks.push(offsets.map((o) => px({ x: s.x + o.dx, y: s.y + o.dy })));
    }
  }
  for (const pin of draw.pins ?? []) {
    const p = px(pin);
    tracks.push(Array.from({ length: n }, () => ({ ...p })));
  }
  return tracks;
}

/**
 * Region seeds from a mask bitmap (any channel value > threshold = inside):
 * an even grid over the mask's bounding box, keeping cells whose center is
 * inside, refined until at most `max` points remain. Returns normalized
 * points; [] for an empty mask. `values` is one byte per pixel (w*h) or RGBA
 * (w*h*4: inside = opaque and bright, so a white-on-black PNG or a tinted
 * brush overlay both work).
 */
export function sampleMaskSeeds(
  values: ArrayLike<number>,
  width: number,
  height: number,
  max: number = WAN_MOVE_DRAW_LIMITS.seedsPerPath,
  threshold = 127,
): DrawPoint[] {
  if (!(width > 0 && height > 0)) return [];
  const stride = values.length >= width * height * 4 ? 4 : 1;
  const on = (x: number, y: number) => {
    const i = (y * width + x) * stride;
    if (stride === 1) return values[i] > threshold;
    // RGBA: opaque and bright (white-on-black mask PNG or a tinted overlay).
    return (
      values[i + 3] > threshold &&
      Math.max(values[i], values[i + 1], values[i + 2]) > threshold
    );
  };
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!on(x, y)) continue;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (count === 0) return [];
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  // Grid sized so roughly `max` cells land inside the mask.
  const fill = count / (bw * bh);
  let cells = Math.max(1, Math.ceil(Math.sqrt(max / Math.max(fill, 1e-3))));
  for (; cells >= 1; cells--) {
    const out: DrawPoint[] = [];
    const seen = new Set<number>();
    const gx = Math.min(bw, Math.max(1, Math.round(cells * Math.sqrt(bw / bh))));
    const gy = Math.min(bh, Math.max(1, Math.round(cells * Math.sqrt(bh / bw))));
    for (let j = 0; j < gy; j++) {
      for (let i = 0; i < gx; i++) {
        const x = Math.min(width - 1, Math.floor(x0 + ((i + 0.5) / gx) * bw));
        const y = Math.min(height - 1, Math.floor(y0 + ((j + 0.5) / gy) * bh));
        if (!on(x, y) || seen.has(y * width + x)) continue;
        seen.add(y * width + x);
        out.push({
            x: round4((x + 0.5) / width),
            y: round4((y + 0.5) / height),
          });
      }
    }
    if (out.length <= max) {
      if (out.length > 0) return out;
      break;
    }
  }
  // Thin sliver the grid missed: fall back to the first inside pixel.
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (on(x, y))
        return [
          { x: round4((x + 0.5) / width), y: round4((y + 0.5) / height) },
        ];
    }
  }
  return [];
}

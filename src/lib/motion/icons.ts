/**
 * Original line icons for the Motion Designer, drawn on a 24x24 grid.
 *
 * Each icon is a tiny path string (M/L/C/Q/A/Z, absolute coords; A is
 * "A cx cy r startDeg endDeg") flattened to polylines, so the renderer can
 * "draw them on" stroke by stroke (whiteboard style) with exact lengths.
 */

import type { IconName } from "./spec";

export type Pt = [number, number];
export type Polyline = Pt[];

const ICON_PATHS: Record<IconName, string> = {
  check: "M5 12.5 L10 17.5 L19 7",
  star: "M12 3 L14.6 9 L21 9.4 L16 13.6 L17.6 20 L12 16.6 L6.4 20 L8 13.6 L3 9.4 L9.4 9 Z",
  heart:
    "M12 20 C 5 15 3 11.5 3 8.6 C 3 6 5 4 7.5 4 C 9.4 4 11 5.2 12 7 C 13 5.2 14.6 4 16.5 4 C 19 4 21 6 21 8.6 C 21 11.5 19 15 12 20 Z",
  bolt: "M13.5 2.5 L5 13.5 L11.5 13.5 L10.5 21.5 L19 10.5 L12.5 10.5 Z",
  arrow: "M4 12 L19 12 M13 6 L19 12 L13 18",
  bulb: "M9 17 L15 17 M9.5 20 L14.5 20 M9 17 C 9 14.5 6 13 6 9.5 A 12 9.5 6 180 360 M18 9.5 C 18 13 15 14.5 15 17",
  gear: "A 12 12 3.2 0 360 M12 2.5 L12 5.5 M12 18.5 L12 21.5 M2.5 12 L5.5 12 M18.5 12 L21.5 12 M5.3 5.3 L7.4 7.4 M16.6 16.6 L18.7 18.7 M18.7 5.3 L16.6 7.4 M7.4 16.6 L5.3 18.7 A 12 12 6.5 0 360",
  chart: "M4 20 L20 20 M7 20 L7 13 M11 20 L11 9 M15 20 L15 15 M19 20 L19 5",
  user: "A 12 8 4 0 360 M4.5 21 C 5 16.5 8 14.5 12 14.5 C 16 14.5 19 16.5 19.5 21",
  clock: "A 12 12 9 0 360 M12 7 L12 12 L15.5 14",
  globe:
    "A 12 12 9 0 360 M3 12 L21 12 M12 3 C 8 7 8 17 12 21 M12 3 C 16 7 16 17 12 21",
  rocket:
    "M12 3 C 16 6 17 11 15.5 16 L8.5 16 C 7 11 8 6 12 3 Z M8.5 13 L5.5 16.5 L8.5 17 M15.5 13 L18.5 16.5 L15.5 17 M10.5 19 L12 21.5 L13.5 19 A 12 9.5 1.6 0 360",
  play: "A 12 12 9 0 360 M10 8.5 L16 12 L10 15.5 Z",
  lock: "M5.5 11 L18.5 11 L18.5 20.5 L5.5 20.5 Z M8.5 11 L8.5 8 A 12 8 3.5 180 360 M15.5 8 L15.5 11 M12 14.5 L12 17",
  chat: "M4 5 L20 5 L20 15.5 L11 15.5 L6.5 19.5 L6.5 15.5 L4 15.5 Z M8 9 L16 9 M8 12 L13.5 12",
  leaf: "M5 19 C 5 10 10 5 20 4 C 20 13 15 19 5 19 Z M5 19 L13 11",
  cloud:
    "M7 18.5 L17.5 18.5 C 20 18.5 21.5 16.8 21.5 14.8 C 21.5 12.8 20 11.2 17.8 11.2 C 17.3 8 14.8 5.8 11.8 5.8 C 9 5.8 6.7 7.7 6.1 10.4 C 4 10.8 2.5 12.5 2.5 14.6 C 2.5 16.8 4.5 18.5 7 18.5 Z",
  target: "A 12 12 9 0 360 A 12 12 5.5 0 360 A 12 12 2 0 360",
  spark:
    "M12 2.5 L13.6 10.4 L21.5 12 L13.6 13.6 L12 21.5 L10.4 13.6 L2.5 12 L10.4 10.4 Z",
  cube: "M12 3 L20 7.5 L20 16.5 L12 21 L4 16.5 L4 7.5 Z M4 7.5 L12 12 L20 7.5 M12 12 L12 21",
};

const STEPS_PER_CURVE = 14;

/** Parse a path string into polylines (one per subpath). */
export function parsePath(d: string): Polyline[] {
  const tokens = d.match(/[MLCQAZ]|-?\d*\.?\d+/gi) ?? [];
  const lines: Polyline[] = [];
  let cur: Polyline = [];
  let start: Pt = [0, 0];
  let i = 0;
  const num = () => Number(tokens[i++]);
  const last = (): Pt => cur[cur.length - 1] ?? start;
  const flush = () => {
    if (cur.length > 1) lines.push(cur);
    cur = [];
  };
  while (i < tokens.length) {
    const cmd = tokens[i++].toUpperCase();
    if (cmd === "M") {
      flush();
      start = [num(), num()];
      cur = [start];
    } else if (cmd === "L") {
      cur.push([num(), num()]);
    } else if (cmd === "C") {
      const p0 = last();
      const p1: Pt = [num(), num()];
      const p2: Pt = [num(), num()];
      const p3: Pt = [num(), num()];
      for (let k = 1; k <= STEPS_PER_CURVE; k++) {
        const t = k / STEPS_PER_CURVE;
        const a = (1 - t) ** 3;
        const b = 3 * (1 - t) ** 2 * t;
        const c = 3 * (1 - t) * t * t;
        const e = t ** 3;
        cur.push([
          a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0],
          a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1],
        ]);
      }
    } else if (cmd === "Q") {
      const p0 = last();
      const p1: Pt = [num(), num()];
      const p2: Pt = [num(), num()];
      for (let k = 1; k <= STEPS_PER_CURVE; k++) {
        const t = k / STEPS_PER_CURVE;
        cur.push([
          (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
          (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1],
        ]);
      }
    } else if (cmd === "A") {
      // Own subpath: A cx cy r startDeg endDeg (0deg = +x, clockwise on screen).
      const cx = num();
      const cy = num();
      const r = num();
      const a0 = (num() * Math.PI) / 180;
      const a1 = (num() * Math.PI) / 180;
      const steps = Math.max(
        8,
        Math.round((Math.abs(a1 - a0) / (Math.PI * 2)) * 40),
      );
      const arc: Polyline = [];
      for (let k = 0; k <= steps; k++) {
        const a = a0 + ((a1 - a0) * k) / steps;
        arc.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      // An arc continuing an open subpath joins it; otherwise it stands alone.
      if (cur.length > 0 && dist(last(), arc[0]) < 0.6) {
        cur.push(...arc.slice(1));
      } else {
        flush();
        lines.push(arc);
        start = arc[arc.length - 1];
      }
    } else if (cmd === "Z") {
      if (cur.length) cur.push([cur[0][0], cur[0][1]]);
      flush();
    }
  }
  flush();
  return lines;
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function polylineLength(line: Polyline): number {
  let len = 0;
  for (let i = 1; i < line.length; i++) len += dist(line[i - 1], line[i]);
  return len;
}

const cache = new Map<string, Polyline[]>();

export function iconStrokes(name: IconName): Polyline[] {
  let v = cache.get(name);
  if (!v) {
    v = parsePath(ICON_PATHS[name] ?? ICON_PATHS.spark);
    cache.set(name, v);
  }
  return v;
}

/**
 * The visible part of a set of strokes at draw-on progress p (0..1): strokes
 * are drawn one after another, proportional to their length.
 */
export function partialStrokes(lines: Polyline[], p: number): Polyline[] {
  if (p >= 1) return lines;
  if (p <= 0) return [];
  const total = lines.reduce((a, l) => a + polylineLength(l), 0);
  let budget = total * p;
  const out: Polyline[] = [];
  for (const line of lines) {
    if (budget <= 0) break;
    const part: Polyline = [line[0]];
    for (let i = 1; i < line.length; i++) {
      const seg = dist(line[i - 1], line[i]);
      if (seg <= budget) {
        part.push(line[i]);
        budget -= seg;
      } else {
        const t = budget / seg;
        part.push([
          line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t,
          line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t,
        ]);
        budget = 0;
        break;
      }
    }
    if (part.length > 1) out.push(part);
  }
  return out;
}

/** Where the pen is at progress p (whiteboard hand marker). */
export function penPosition(lines: Polyline[], p: number): Pt | null {
  const parts = partialStrokes(lines, p);
  const last = parts[parts.length - 1];
  return last ? last[last.length - 1] : null;
}

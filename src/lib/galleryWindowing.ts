/**
 * Pure windowing math for the Create feed. Finished runs are split into
 * chunks; chunks far outside the viewport collapse to spacers (a measured
 * fixed-height box in List view, size-identical empty tile boxes in the wall
 * views) and remount when they scroll back near. Kept free of React/DOM so
 * it's unit-testable.
 */

/** Average runs per chunk (content-defined, see {@link chunkRuns}). */
export const WINDOW_CHUNK_TARGET = 12;
/** Hard cap so an unlucky hash streak can't build a giant chunk. */
export const WINDOW_CHUNK_MAX = WINDOW_CHUNK_TARGET * 3;

export interface WindowRect {
  top: number;
  bottom: number;
}

export interface WindowUnit {
  key: string;
  /** Current client rect (null = not measurable, e.g. hidden: keep state). */
  rect: WindowRect | null;
  collapsed: boolean;
  /** Never collapse (e.g. holds keyboard focus). */
  pinned?: boolean;
}

/** FNV-1a 32-bit — stable, cheap string hash for chunk boundaries. */
export function hashString(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Content-defined chunking: a new chunk starts at a run whose id hashes to a
 * boundary (≈ 1 in `target`), or once a chunk reaches `max`. Boundaries
 * depend on the runs themselves, not their position, so new runs landing at
 * the top or more history loading at the bottom only reshuffle the chunk
 * they touch; every other chunk keeps its key (and its collapsed state).
 */
export function chunkRuns<T>(
  rows: readonly T[],
  idOf: (row: T) => string,
  target = WINDOW_CHUNK_TARGET,
  max = WINDOW_CHUNK_MAX,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  for (const row of rows) {
    const boundary =
      current.length > 0 &&
      (current.length >= max || hashString(idOf(row)) % target === 0);
    if (boundary) {
      chunks.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Distance in px from a rect to the viewport (0 when overlapping). */
export function distanceToViewport(
  rect: WindowRect,
  viewport: WindowRect,
): number {
  if (rect.bottom < viewport.top) return viewport.top - rect.bottom;
  if (rect.top > viewport.bottom) return rect.top - viewport.bottom;
  return 0;
}

/** Keep ~1.5 screens mounted on each side (at least 1200px). */
export function windowOverscan(viewportHeight: number): number {
  return Math.max(1200, Math.round(viewportHeight * 1.5));
}

/**
 * Next set of collapsed unit keys. Hysteresis avoids flapping at the edge:
 * a mounted unit collapses only beyond 2× overscan; a collapsed one remounts
 * as soon as it comes within 1× overscan.
 */
export function nextCollapsedKeys(
  units: readonly WindowUnit[],
  viewport: WindowRect,
  overscan: number,
): Set<string> {
  const next = new Set<string>();
  for (const unit of units) {
    if (unit.pinned) continue;
    if (!unit.rect) {
      if (unit.collapsed) next.add(unit.key);
      continue;
    }
    const distance = distanceToViewport(unit.rect, viewport);
    if (unit.collapsed ? distance > overscan : distance > overscan * 2) {
      next.add(unit.key);
    }
  }
  return next;
}

/** Same keys and heights? (skip a no-op state update) */
export function sameCollapsed(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, height] of a) {
    if (!b.has(key) || b.get(key) !== height) return false;
  }
  return true;
}

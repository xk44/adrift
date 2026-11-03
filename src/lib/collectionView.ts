/**
 * Shared list logic for the collection pages (Moodboards, Characters /
 * Styles dataset boards, Personalize style codes): the All/Selected scope,
 * the Latest/Oldest/Name sort, and the cover-collage layout.
 *
 * Pure functions only; the pages own their state.
 */

export type CollectionScope = "all" | "selected";
export type CollectionSort = "latest" | "oldest" | "name";

export const COLLECTION_SORT_OPTIONS: ReadonlyArray<{
  value: CollectionSort;
  label: string;
}> = [
  { value: "latest", label: "Latest" },
  { value: "oldest", label: "Oldest" },
  { value: "name", label: "Name" },
];

export function isCollectionSort(value: unknown): value is CollectionSort {
  return value === "latest" || value === "oldest" || value === "name";
}

/** Parse a createdAt-ish value (epoch ms/s number, numeric string or ISO). */
export function toTimestamp(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // Treat 10-digit values as epoch seconds.
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) return toTimestamp(Number(trimmed));
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

interface SortableItem {
  name?: string | null;
  createdAt?: string | number | null;
  updatedAt?: string | number | null;
}

/**
 * Sort a collection. "latest" puts the newest timestamps first and keeps
 * items without a timestamp in their incoming order after them; "oldest" is
 * exactly the reverse of "latest"; "name" is a natural, case-insensitive sort
 * with a stable tie-break. Never mutates the input.
 */
export function sortCollection<T extends SortableItem>(
  items: readonly T[],
  sort: CollectionSort,
): T[] {
  const decorated = items.map((item, index) => ({
    item,
    index,
    ts: toTimestamp(item.createdAt ?? item.updatedAt ?? null),
    name: (item.name ?? "").trim(),
  }));

  if (sort === "name") {
    decorated.sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: "base",
        }) || a.index - b.index,
    );
    return decorated.map((d) => d.item);
  }

  decorated.sort((a, b) => {
    if (a.ts !== null && b.ts !== null) return b.ts - a.ts || a.index - b.index;
    if (a.ts !== null) return -1;
    if (b.ts !== null) return 1;
    return a.index - b.index;
  });
  const latest = decorated.map((d) => d.item);
  return sort === "oldest" ? latest.reverse() : latest;
}

/** Apply the All/Selected scope. "selected" with nothing selected is empty. */
export function scopeCollection<T extends { id: string }>(
  items: readonly T[],
  scope: CollectionScope,
  selectedIds: ReadonlySet<string>,
): T[] {
  if (scope === "all") return [...items];
  return items.filter((item) => selectedIds.has(item.id));
}

export interface CollageLayout {
  /** CSS grid columns / rows for the cover. */
  cols: number;
  rows: number;
  /** One entry per rendered cell: the image URL and its grid span. */
  cells: Array<{ url: string; colSpan: number; rowSpan: number }>;
}

/**
 * Cover collage for a board card. Up to `max` (4 → 2x2, 6 → 3x2) images;
 * with fewer images the first one grows so the tile never has holes:
 * 1 → full bleed, 2 → halves, 3 → big left + two stacked, 4/5 → 2x2,
 * 6+ (max 6) → 3x2. Empty/blank URLs are skipped.
 */
export function collageLayout(
  urls: readonly (string | null | undefined)[],
  max: 4 | 6 = 4,
): CollageLayout {
  const clean = urls.filter(
    (url): url is string => typeof url === "string" && url.trim().length > 0,
  );
  const n = Math.min(clean.length, max);
  const cell = (url: string, colSpan = 1, rowSpan = 1) => ({
    url,
    colSpan,
    rowSpan,
  });

  if (n === 0) return { cols: 1, rows: 1, cells: [] };
  if (n === 1) return { cols: 1, rows: 1, cells: [cell(clean[0])] };
  if (n === 2)
    return { cols: 2, rows: 1, cells: clean.slice(0, 2).map((u) => cell(u)) };
  if (n === 3) {
    return {
      cols: 2,
      rows: 2,
      cells: [cell(clean[0], 1, 2), cell(clean[1]), cell(clean[2])],
    };
  }
  if (n < 6) {
    return { cols: 2, rows: 2, cells: clean.slice(0, 4).map((u) => cell(u)) };
  }
  return { cols: 3, rows: 2, cells: clean.slice(0, 6).map((u) => cell(u)) };
}

/**
 * Validate a rename draft. Returns the trimmed name to save, or null when
 * there is nothing to save (blank, unchanged, or over the 100-char limit
 * the moodboard API enforces).
 */
export function normalizeRename(
  draft: string,
  current: string,
  maxLength = 100,
): string | null {
  const next = draft.replace(/\s+/g, " ").trim();
  if (!next || next === current.trim() || next.length > maxLength) return null;
  return next;
}

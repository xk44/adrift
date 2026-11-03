/**
 * Organize page filter model.
 *
 * Multi-select facets (status / media / aspect) combine with OR inside a
 * facet and AND across facets; an empty facet places no constraint. The
 * Created range stays a single choice.
 */

export type MediaKind = "images" | "videos" | "3d" | "audio";
export type StatusKey = "liked" | "unrated" | "hidden";
export type AspectBucket = "portrait" | "square" | "landscape";
export type DateFilter = "all" | "today" | "7days" | "30days";
export type SortOption = "newest" | "oldest" | "name-az" | "name-za";

export interface OrganizeFilters {
  status: StatusKey[];
  media: MediaKind[];
  aspect: AspectBucket[];
  date: DateFilter;
}

export interface OrganizeFilterableImage {
  liked?: boolean;
  hidden?: boolean;
  width?: number;
  height?: number;
  createdAt?: string;
  videoUrl?: string;
  audioUrl?: string;
  meshUrl?: string;
}

export const EMPTY_ORGANIZE_FILTERS: OrganizeFilters = {
  status: [],
  media: [],
  aspect: [],
  date: "all",
};

export const STATUS_OPTIONS: ReadonlyArray<{
  value: StatusKey;
  label: string;
}> = [
  { value: "liked", label: "Liked" },
  { value: "unrated", label: "Unrated" },
  { value: "hidden", label: "Hidden" },
];

export const MEDIA_OPTIONS: ReadonlyArray<{ value: MediaKind; label: string }> =
  [
    { value: "images", label: "Image" },
    { value: "videos", label: "Video" },
    { value: "3d", label: "3D" },
    { value: "audio", label: "Audio" },
  ];

export const ASPECT_OPTIONS: ReadonlyArray<{
  value: AspectBucket;
  label: string;
}> = [
  { value: "portrait", label: "Portrait" },
  { value: "square", label: "Square" },
  { value: "landscape", label: "Landscape" },
];

export const DATE_OPTIONS: ReadonlyArray<{ value: DateFilter; label: string }> =
  [
    { value: "all", label: "All Time" },
    { value: "today", label: "Today" },
    { value: "7days", label: "Last 7 Days" },
    { value: "30days", label: "Last 30 Days" },
  ];

export const SORT_OPTIONS: ReadonlyArray<{ value: SortOption; label: string }> =
  [
    { value: "newest", label: "Newest First" },
    { value: "oldest", label: "Oldest First" },
    { value: "name-az", label: "Name A–Z" },
    { value: "name-za", label: "Name Z–A" },
  ];

/** Long/short side within 10% of 1:1 counts as square (e.g. 1100x1000). */
const SQUARE_TOLERANCE = 0.1;

export function getMediaKind(img: OrganizeFilterableImage): MediaKind {
  if (img.videoUrl) return "videos";
  if (img.audioUrl) return "audio";
  if (img.meshUrl) return "3d";
  return "images";
}

/** Bucket by width/height; null when dimensions are missing or invalid. */
export function getAspectBucket(
  img: Pick<OrganizeFilterableImage, "width" | "height">,
): AspectBucket | null {
  const { width, height } = img;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  // Long side / short side keeps the band symmetric for portrait and landscape.
  const spread = Math.max(width, height) / Math.min(width, height);
  if (spread <= 1 + SQUARE_TOLERANCE + 1e-9) return "square";
  return width > height ? "landscape" : "portrait";
}

export function matchesStatus(
  img: Pick<OrganizeFilterableImage, "liked" | "hidden">,
  key: StatusKey,
): boolean {
  if (key === "liked") return img.liked === true;
  if (key === "unrated") return img.liked !== true;
  return img.hidden === true;
}

export function getDateThreshold(
  filter: DateFilter,
  now: Date = new Date(),
): Date | null {
  if (filter === "all") return null;
  const d = new Date(now);
  if (filter === "today") {
    d.setHours(0, 0, 0, 0);
    return d;
  }
  d.setDate(d.getDate() - (filter === "7days" ? 7 : 30));
  return d;
}

/** Predicate for the facet filters (folder/search are applied elsewhere). */
export function createOrganizeFilter<T extends OrganizeFilterableImage>(
  filters: OrganizeFilters,
  now: Date = new Date(),
): (img: T) => boolean {
  const threshold = getDateThreshold(filters.date, now);
  const media = new Set(filters.media);
  const aspect = new Set(filters.aspect);
  return (img) => {
    if (
      filters.status.length > 0 &&
      !filters.status.some((key) => matchesStatus(img, key))
    ) {
      return false;
    }
    if (media.size > 0 && !media.has(getMediaKind(img))) return false;
    if (aspect.size > 0) {
      const bucket = getAspectBucket(img);
      if (!bucket || !aspect.has(bucket)) return false;
    }
    if (threshold) {
      const created = img.createdAt ? new Date(img.createdAt) : null;
      if (!created || Number.isNaN(created.getTime()) || created < threshold)
        return false;
    }
    return true;
  };
}

/** Add or remove a value from a multi-select facet, preserving option order. */
export function toggleFacet<T extends string>(
  selected: readonly T[],
  value: T,
  order: ReadonlyArray<{ value: T }>,
): T[] {
  const next = new Set(selected);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return order.map((o) => o.value).filter((v) => next.has(v));
}

/** One per selected chip, plus non-default Created range and sort. */
export function countActiveFilters(
  filters: OrganizeFilters,
  sort: SortOption = "newest",
): number {
  return (
    filters.status.length +
    filters.media.length +
    filters.aspect.length +
    (filters.date !== "all" ? 1 : 0) +
    (sort !== "newest" ? 1 : 0)
  );
}

export interface ActiveFilterChip {
  key: string;
  label: string;
  /** Clears just this selection. */
  remove: () => void;
}

function labelOf<T extends string>(
  options: ReadonlyArray<{ value: T; label: string }>,
  value: T,
): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

/** Removable chip list for the active facet selections + date + sort. */
export function describeActiveFilters(
  filters: OrganizeFilters,
  sort: SortOption,
  setFilters: (next: OrganizeFilters) => void,
  setSort: (next: SortOption) => void,
): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];
  for (const v of filters.status) {
    chips.push({
      key: `status:${v}`,
      label: labelOf(STATUS_OPTIONS, v),
      remove: () =>
        setFilters({
          ...filters,
          status: filters.status.filter((s) => s !== v),
        }),
    });
  }
  for (const v of filters.media) {
    chips.push({
      key: `media:${v}`,
      label: labelOf(MEDIA_OPTIONS, v),
      remove: () =>
        setFilters({ ...filters, media: filters.media.filter((m) => m !== v) }),
    });
  }
  for (const v of filters.aspect) {
    chips.push({
      key: `aspect:${v}`,
      label: labelOf(ASPECT_OPTIONS, v),
      remove: () =>
        setFilters({
          ...filters,
          aspect: filters.aspect.filter((a) => a !== v),
        }),
    });
  }
  if (filters.date !== "all") {
    chips.push({
      key: "date",
      label: labelOf(DATE_OPTIONS, filters.date),
      remove: () => setFilters({ ...filters, date: "all" }),
    });
  }
  if (sort !== "newest") {
    chips.push({
      key: "sort",
      label: labelOf(SORT_OPTIONS, sort),
      remove: () => setSort("newest"),
    });
  }
  return chips;
}

/** Stable key for render-window resets when filters change. */
export function filtersKey(filters: OrganizeFilters): string {
  return [
    filters.status.join(","),
    filters.media.join(","),
    filters.aspect.join(","),
    filters.date,
  ].join("|");
}

/**
 * Unified model-browser filter state (Explore → Models/LoRAs and the
 * Workflows → Civitai tab). One state object covers all three sources;
 * the filter bar hides what the active source can't use.
 *
 *   filters ──► buildCivitaiModelQuery / buildHfModelQuery  (API params)
 *   filters ◄─► modelFiltersToUrl / modelFiltersFromUrl     (page URL)
 *   filters ──► activeFilterChips / removeFilterChip        (chip row)
 */

import type { CivitaiSource } from "@/lib/civitai";
import {
  CIVITAI_LORA_TYPES,
  CIVITAI_MODEL_TYPES,
  CIVITAI_PERIOD_LABELS,
  civitaiTypeLabel,
  isCivitaiBaseModel,
  isCivitaiCheckpointType,
  isCivitaiModelSort,
  isCivitaiModelType,
  isCivitaiPeriod,
  CIVITAI_USERNAME_RE,
  type CivitaiBaseModel,
  type CivitaiCheckpointType,
  type CivitaiModelSort,
  type CivitaiModelType,
  type CivitaiPeriod,
} from "@/lib/civitaiFilters";
import {
  HF_AUTHOR_RE,
  hfTaskLabel,
  isHfLibrary,
  isHfSort,
  isHfTask,
  type HfLibrary,
  type HfSort,
  type HfTask,
} from "@/lib/hfModels";

export type ModelSource = "civitai" | "civitai-red" | "hf";
export const MODEL_SOURCES: {
  id: ModelSource;
  label: string;
  /** Rendered as a red pill next to the label (adult-content source). */
  badge?: string;
}[] = [
  { id: "civitai", label: "Civitai" },
  { id: "civitai-red", label: "Civitai Red", badge: "18+" },
  { id: "hf", label: "Hugging Face" },
];

/** "models" = all types; "loras" scopes types to the LoRA family. */
export type ModelScope = "models" | "loras";

export interface ModelFilters {
  source: ModelSource;
  /** Civitai sort */
  sort: CivitaiModelSort;
  period: CivitaiPeriod;
  types: CivitaiModelType[];
  baseModels: CivitaiBaseModel[];
  /** Only sent when Checkpoint is in the effective types */
  checkpointType: CivitaiCheckpointType | null;
  /** Civitai username / HF author */
  creator: string;
  /**
   * Civitai Red only — .com is always SFW. Defaults to false: even on Red,
   * mature results are an explicit opt-in (a `?src=red` deep link alone
   * stays SFW).
   */
  nsfw: boolean;
  hfSort: HfSort;
  hfTask: HfTask | null;
  hfLibrary: HfLibrary | null;
}

export const DEFAULT_MODEL_FILTERS: ModelFilters = {
  source: "civitai",
  sort: "Highest Rated",
  period: "AllTime",
  types: [],
  baseModels: [],
  checkpointType: null,
  creator: "",
  nsfw: false,
  hfSort: "trendingScore",
  /** Image-gen app: HF opens on text-to-image, not trending LLMs. null = any task. */
  hfTask: "text-to-image",
  hfLibrary: null,
};

export const isCivitaiSourceKind = (s: ModelSource) =>
  s === "civitai" || s === "civitai-red";

export function civitaiApiSource(s: ModelSource): CivitaiSource {
  return s === "civitai-red" ? "red" : "com";
}

/** Which controls the bar shows for a source. */
export function filterControlsFor(source: ModelSource) {
  const civ = isCivitaiSourceKind(source);
  return {
    sort: true,
    period: civ,
    type: civ,
    baseModel: civ,
    checkpointType: civ,
    nsfw: source === "civitai-red",
    task: !civ,
    library: !civ,
    creator: true,
  };
}

/** Type options the picker offers in a scope. */
export function typeOptionsFor(scope: ModelScope): readonly CivitaiModelType[] {
  return scope === "loras" ? CIVITAI_LORA_TYPES : CIVITAI_MODEL_TYPES;
}

/** Types actually sent to Civitai for a scope (LoRAs never leak non-LoRA types). */
export function effectiveCivitaiTypes(
  filters: ModelFilters,
  scope: ModelScope,
): CivitaiModelType[] {
  if (scope === "loras") {
    const picked = filters.types.filter((t) => CIVITAI_LORA_TYPES.includes(t));
    return picked.length > 0 ? picked : [...CIVITAI_LORA_TYPES];
  }
  return filters.types;
}

export function showsCheckpointType(filters: ModelFilters, scope: ModelScope) {
  return (
    isCivitaiSourceKind(filters.source) &&
    effectiveCivitaiTypes(filters, scope).includes("Checkpoint")
  );
}

const cleanCreator = (c: string) => c.trim().replace(/^@/, "");

// API query builders

export interface FeedPage {
  query: string;
  scope: ModelScope;
  cursor?: string;
  limit?: number;
}

/** Filters → /api/civitai/models query (repeated keys for multi-values). */
export function buildCivitaiModelQuery(
  filters: ModelFilters,
  { query, scope, cursor, limit = 24 }: FeedPage,
): URLSearchParams {
  const p = new URLSearchParams();
  const q = query.trim();
  if (q) p.set("q", q);
  p.set("limit", String(limit));
  if (cursor) p.set("cursor", cursor);
  p.set("sort", filters.sort);
  p.set("period", filters.period);
  const types = effectiveCivitaiTypes(filters, scope);
  for (const t of types) p.append("types", t);
  for (const b of filters.baseModels) p.append("baseModels", b);
  if (filters.checkpointType && types.includes("Checkpoint")) {
    p.set("checkpointType", filters.checkpointType);
  }
  const creator = cleanCreator(filters.creator);
  if (creator && CIVITAI_USERNAME_RE.test(creator)) p.set("username", creator);
  p.set("source", civitaiApiSource(filters.source));
  p.set(
    "nsfw",
    filters.source === "civitai-red" && filters.nsfw ? "true" : "false",
  );
  return p;
}

/** Filters → /api/hf/models query. */
export function buildHfModelQuery(
  filters: ModelFilters,
  { query, scope, cursor, limit = 24 }: FeedPage,
): URLSearchParams {
  const p = new URLSearchParams();
  const q = query.trim();
  if (q) p.set("search", q.slice(0, 128));
  p.set("sort", filters.hfSort);
  if (filters.hfTask) p.set("pipeline_tag", filters.hfTask);
  if (scope === "loras") p.append("filter", "lora");
  if (filters.hfLibrary) p.append("filter", filters.hfLibrary);
  const creator = cleanCreator(filters.creator);
  if (creator && HF_AUTHOR_RE.test(creator)) p.set("author", creator);
  p.set("limit", String(limit));
  if (cursor) p.set("cursor", cursor);
  return p;
}

// Page-URL persistence
// Keys are prefixed/unique so they don't collide with Explore's own
// `tab` / `view` / `period` params. Only non-default values are written.

export const MODEL_FILTER_URL_KEYS = [
  "src",
  "msort",
  "mperiod",
  "mtype",
  "base",
  "ckpt",
  "creator",
  "nsfw",
  "hsort",
  "task",
  "lib",
] as const;

const SOURCE_TO_URL: Record<ModelSource, string> = {
  civitai: "civitai",
  "civitai-red": "red",
  hf: "hf",
};

/** Filters → URL param updates (null = delete the key). */
export function modelFiltersToUrl(
  f: ModelFilters,
  /** The surface's own defaults (omitted from the URL). */
  d: ModelFilters = DEFAULT_MODEL_FILTERS,
): Record<(typeof MODEL_FILTER_URL_KEYS)[number], string | null> {
  const creator = cleanCreator(f.creator);
  return {
    src: f.source === d.source ? null : SOURCE_TO_URL[f.source],
    msort: f.sort === d.sort ? null : f.sort,
    mperiod: f.period === d.period ? null : f.period,
    mtype: f.types.length ? f.types.join(",") : null,
    base: f.baseModels.length ? f.baseModels.join(",") : null,
    ckpt: f.checkpointType,
    creator: creator || null,
    nsfw: f.nsfw === d.nsfw ? null : f.nsfw ? "1" : "0",
    hsort: f.hfSort === d.hfSort ? null : f.hfSort,
    task: f.hfTask === d.hfTask ? null : (f.hfTask ?? "any"),
    lib: f.hfLibrary,
  };
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** URL → filters; unknown/invalid values fall back to defaults. */
export function modelFiltersFromUrl(
  sp: URLSearchParams,
  /** The surface's own defaults (what an absent key means). */
  d: ModelFilters = DEFAULT_MODEL_FILTERS,
): ModelFilters {
  const src = sp.get("src");
  const source: ModelSource =
    src === "red"
      ? "civitai-red"
      : src === "hf"
        ? "hf"
        : src === "civitai"
          ? "civitai"
          : d.source;
  const list = (k: string) =>
    (sp.get(k) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const sort = sp.get("msort");
  const period = sp.get("mperiod");
  const ckpt = sp.get("ckpt");
  const creator = cleanCreator(sp.get("creator") ?? "");
  const nsfw = sp.get("nsfw");
  const hsort = sp.get("hsort");
  const task = sp.get("task");
  const lib = sp.get("lib");
  return {
    source,
    sort: isCivitaiModelSort(sort) ? sort : d.sort,
    period: isCivitaiPeriod(period) ? period : d.period,
    types: uniq(list("mtype").filter(isCivitaiModelType)),
    baseModels: uniq(list("base").filter(isCivitaiBaseModel)),
    checkpointType: isCivitaiCheckpointType(ckpt) ? ckpt : null,
    creator:
      creator &&
      (CIVITAI_USERNAME_RE.test(creator) || HF_AUTHOR_RE.test(creator))
        ? creator
        : "",
    nsfw: nsfw === "0" ? false : nsfw === "1" ? true : d.nsfw,
    hfSort: isHfSort(hsort) ? hsort : d.hfSort,
    hfTask: task === "any" ? null : isHfTask(task) ? task : d.hfTask,
    hfLibrary: isHfLibrary(lib) ? lib : null,
  };
}

// Active-filter chips

export interface FilterChip {
  id: string;
  label: string;
}

/**
 * Removable chips for filters that narrow results (sort/source aren't
 * chips — they're always-set controls). Hidden-for-source filters are
 * left out so the row matches what's actually applied.
 */
export function activeFilterChips(
  f: ModelFilters,
  scope: ModelScope,
): FilterChip[] {
  const chips: FilterChip[] = [];
  const c = filterControlsFor(f.source);
  if (c.period && f.period !== DEFAULT_MODEL_FILTERS.period) {
    chips.push({ id: "period", label: CIVITAI_PERIOD_LABELS[f.period] });
  }
  if (c.type) {
    const allowed = scope === "loras" ? CIVITAI_LORA_TYPES : null;
    for (const t of f.types) {
      if (allowed && !allowed.includes(t)) continue;
      chips.push({ id: `type:${t}`, label: civitaiTypeLabel(t) });
    }
  }
  if (c.baseModel) {
    for (const b of f.baseModels) chips.push({ id: `base:${b}`, label: b });
  }
  if (c.checkpointType && f.checkpointType && showsCheckpointType(f, scope)) {
    chips.push({ id: "ckpt", label: f.checkpointType });
  }
  if (c.task && f.hfTask)
    chips.push({ id: "task", label: hfTaskLabel(f.hfTask) });
  if (c.library && f.hfLibrary) chips.push({ id: "lib", label: f.hfLibrary });
  const creator = cleanCreator(f.creator);
  if (c.creator && creator) chips.push({ id: "creator", label: `@${creator}` });
  // Mature results are the non-default state; removing the chip makes the
  // feed SFW again (removing a chip never opts *into* mature content).
  if (c.nsfw && f.nsfw) chips.push({ id: "mature", label: "Mature included" });
  return chips;
}

export function removeFilterChip(f: ModelFilters, id: string): ModelFilters {
  if (id.startsWith("type:")) {
    const t = id.slice(5);
    const types = f.types.filter((x) => x !== t);
    return {
      ...f,
      types,
      checkpointType: types.includes("Checkpoint") ? f.checkpointType : null,
    };
  }
  if (id.startsWith("base:")) {
    const b = id.slice(5);
    return { ...f, baseModels: f.baseModels.filter((x) => x !== b) };
  }
  switch (id) {
    case "period":
      return { ...f, period: DEFAULT_MODEL_FILTERS.period };
    case "ckpt":
      return { ...f, checkpointType: null };
    case "task":
      return { ...f, hfTask: null };
    case "lib":
      return { ...f, hfLibrary: null };
    case "creator":
      return { ...f, creator: "" };
    case "mature":
      return { ...f, nsfw: false };
    default:
      return f;
  }
}

/** "Clear all": reset every narrowing filter, keep source + sort choices. */
export function clearModelFilters(f: ModelFilters): ModelFilters {
  return {
    ...DEFAULT_MODEL_FILTERS,
    source: f.source,
    sort: f.sort,
    hfSort: f.hfSort,
  };
}

/**
 * Switch source. Mature results are opt-in per visit to Civitai Red:
 * leaving Red turns the NSFW toggle back off, so coming back later never
 * silently restores mature results.
 */
export function withModelSource(
  f: ModelFilters,
  source: ModelSource,
): ModelFilters {
  if (source === f.source) return f;
  return { ...f, source, nsfw: source === "civitai-red" ? f.nsfw : false };
}

/** Toggle helper for multi-selects. */
export function toggleIn<T>(list: readonly T[], value: T): T[] {
  return list.includes(value)
    ? list.filter((x) => x !== value)
    : [...list, value];
}

/**
 * Pure state + data helpers for the merged Styles page. No React here so it
 * can be tested.
 *
 * Legacy nav keys all land on the one page:
 *   library        → Browse
 *   style-creator  → Browse with the creator panel open (`/style-creator/:id`
 *                    opens that session; `new` opens the start screen)
 *   styles         → Datasets view (`/style-datasets/:id`)
 *   style-vault    → a library view: Map by default, `/styles/clusters`,
 *                    `/styles/images`, `/styles/train`. Any other id (old
 *                    `/styles/:id` links) opens Clusters.
 */

import type { NavKey, StylesHubTab } from "@/types";
import { promptSrefCodes } from "@/components/style/styleCreatorLogic";

export type LibraryView = "map" | "clusters" | "images" | "train";

export type StylesView = "browse" | "datasets" | LibraryView;

export const LIBRARY_VIEWS: readonly LibraryView[] = [
  "map",
  "clusters",
  "images",
  "train",
];

export function isLibraryView(value: unknown): value is LibraryView {
  return LIBRARY_VIEWS.includes(value as LibraryView);
}

/** The library view a `style-vault` route opens. */
export function libraryViewForId(id: string | undefined): LibraryView {
  if (!id) return "map";
  return isLibraryView(id) ? id : "clusters";
}

export const STYLE_NAV_KEYS: readonly NavKey[] = [
  "library",
  "styles",
  "style-creator",
  "style-vault",
];

export function isStylesNav(nav: NavKey): boolean {
  return STYLE_NAV_KEYS.includes(nav);
}

/** Hub tab for a nav key (kept: the store still persists it). */
export function stylesHubTabForNav(nav: NavKey): StylesHubTab {
  switch (nav) {
    case "styles":
      return "boards";
    case "style-creator":
      return "creator";
    case "style-vault":
      return "map";
    default:
      return "library";
  }
}

export function viewForTab(tab: StylesHubTab | "vault"): StylesView {
  if (tab === "boards") return "datasets";
  // A store persisted before the merge can still hold "vault".
  if (tab === "vault") return "map";
  if (isLibraryView(tab)) return tab;
  return "browse";
}

export function viewForNav(nav: NavKey): StylesView {
  return viewForTab(stylesHubTabForNav(nav));
}

/** Nav key that shows a view (used when the view switcher is clicked). */
export function navForView(view: StylesView): NavKey {
  if (view === "datasets") return "styles";
  if (isLibraryView(view)) return "style-vault";
  return "library";
}

/** Route params that select a view under its nav key. */
export function navParamsForView(view: StylesView): { id: string } | undefined {
  return isLibraryView(view) && view !== "map" ? { id: view } : undefined;
}

export type CreatorPanelState =
  { open: false } | { open: true; sessionId: string | null };

/** Whether the creator panel is open, and on which session. */
export function creatorStateForNav(
  nav: NavKey,
  id: string | undefined,
): CreatorPanelState {
  if (nav !== "style-creator") return { open: false };
  if (!id || id === "new") return { open: true, sessionId: null };
  return { open: true, sessionId: id };
}

// Browse filters

export type StylesFilter =
  "all" | "saved" | "catalog" | "loras" | "collections";

export const STYLES_FILTERS: { key: StylesFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "saved", label: "Yours" },
  { key: "catalog", label: "Catalog" },
  { key: "loras", label: "Style LoRAs" },
  { key: "collections", label: "Collections" },
];

export type StylesSection = Exclude<StylesFilter, "all">;

export function sectionVisible(
  filter: StylesFilter,
  section: StylesSection,
): boolean {
  return filter === "all" || filter === section;
}

// Catalog feeds

export type CatalogFeed =
  | "styles_top_week"
  | "styles_top"
  | "styles_top_month"
  | "styles_hot"
  | "liked";

export const CATALOG_FEEDS: { key: CatalogFeed; label: string }[] = [
  { key: "styles_top_week", label: "Top this week" },
  { key: "styles_top", label: "Top today" },
  { key: "styles_top_month", label: "Top this month" },
  { key: "styles_hot", label: "Hot" },
  { key: "liked", label: "Liked" },
];

/** Query string for /api/style-catalog/index. */
export function catalogQuery(
  feed: CatalogFeed,
  query: string,
  offset: number,
  limit: number,
): string {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (feed === "liked") params.set("liked", "true");
  else params.set("feed", feed);
  const q = query.trim();
  if (q) params.set("q", q);
  return params.toString();
}

// Saved codes

export interface SavedCodeLike {
  code: string;
  name?: string;
  tags?: string[];
  createdAt: number;
  isFavorite: boolean;
}

/** Favorites first, then newest; filtered by code, name or tag. */
export function filterSavedCodes<T extends SavedCodeLike>(
  entries: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  return [...entries]
    .sort(
      (a, b) =>
        Number(b.isFavorite) - Number(a.isFavorite) ||
        b.createdAt - a.createdAt,
    )
    .filter(
      (entry) =>
        !q ||
        entry.code.toLowerCase().includes(q) ||
        Boolean(entry.name?.toLowerCase().includes(q)) ||
        Boolean(entry.tags?.some((tag) => tag.toLowerCase().includes(q))),
    );
}

export function matchesName(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || name.toLowerCase().includes(q);
}

// Blend tray + creator seeds

export const MAX_BLEND = 4;

/** Add or remove a code from the blend tray (capped at MAX_BLEND, FIFO). */
export function toggleBlend(codes: readonly string[], code: string): string[] {
  if (codes.includes(code)) return codes.filter((c) => c !== code);
  const next = [...codes, code];
  return next.length > MAX_BLEND ? next.slice(next.length - MAX_BLEND) : next;
}

/**
 * Put every code into the prompt's single `--sref` flag, keeping codes the
 * prompt already had (first) and the rest of the prompt intact.
 */
export function withSrefCodes(
  prompt: string,
  codes: readonly string[],
): string {
  const merged = [...promptSrefCodes(prompt)];
  for (const code of codes)
    if (code && !merged.includes(code)) merged.push(code);
  const without = prompt
    .replace(/(^|\s)--sref(?:\s+(?!--)\S+)*/i, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (merged.length === 0) return without;
  const flag = `--sref ${merged.join(" ")}`;
  return without ? `${without} ${flag}` : flag;
}

/** What the creator panel starts from when opened from a card or the tray. */
export interface CreatorSeed {
  /** Prompt text placed in the start screen (srefs / loras). */
  prompt: string;
  /** Gallery image ids to pre-select in the new session. */
  imageIds: string[];
  /** Bumped on every seed so the start screen re-applies it. */
  nonce: number;
}

export function seedFromCodes(
  codes: readonly string[],
  nonce: number,
  base = "",
): CreatorSeed {
  return { prompt: withSrefCodes(base, codes), imageIds: [], nonce };
}

export function seedFromLora(loraId: string, nonce: number): CreatorSeed {
  return { prompt: `--lora ${loraId}.safetensors`, imageIds: [], nonce };
}

/** Card title: a saved name, else "Style <code>" instead of a bare number. */
export function styleCardTitle(code: string, name?: string | null): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : `Style ${code}`;
}

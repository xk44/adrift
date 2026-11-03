import { createWithEqualityFn } from "zustand/traditional";
import { updateUrlQuery } from "@/lib/urlQuery";
import {
  DEFAULT_MODEL_FILTERS,
  modelFiltersFromUrl,
  modelFiltersToUrl,
  type ModelFilters,
} from "@/lib/modelFilters";

// Explore tab definitions (shared by ExplorePage + ExploreControls)

export type PrimaryTab = "hot" | "top" | "new" | "likes";
export type SecondaryTab = "images" | "styles" | "videos" | "models" | "loras";
export type TopPeriod = "today" | "week" | "month" | "year" | "alltime";

/**
 * Likes is a local-favorites view: images show liked Civitai images and
 * Styles shows liked srefs. Videos and the model feeds have no likes list.
 */
export function supportsLikes(tab: SecondaryTab): boolean {
  return tab === "images" || tab === "styles";
}

export interface PrimaryTabDef {
  id: PrimaryTab;
  label: string;
  sort?: string;
}

export const PRIMARY_TABS: PrimaryTabDef[] = [
  { id: "hot", label: "Hot", sort: "Most Reactions" },
  { id: "top", label: "Top", sort: "Most Collected" },
  { id: "new", label: "New", sort: "Newest" },
  { id: "likes", label: "Likes", sort: "Most Reactions" },
];

export const TOP_PERIODS: { id: TopPeriod; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "This Week" },
  { id: "month", label: "This Month" },
  { id: "year", label: "This Year" },
  { id: "alltime", label: "All Time" },
];

export const CIVITAI_TOP_PERIOD: Record<TopPeriod, string> = {
  today: "Day",
  week: "Week",
  month: "Month",
  year: "Year",
  alltime: "AllTime",
};

// URL helpers

const parsePrimaryTab = (v: string | null): PrimaryTab =>
  v === "hot" || v === "top" || v === "new" || v === "likes" ? v : "hot";
const parseSecondaryTab = (v: string | null): SecondaryTab =>
  v === "images" ||
  v === "styles" ||
  v === "videos" ||
  v === "models" ||
  v === "loras"
    ? v
    : "images";
const parseTopPeriod = (v: string | null): TopPeriod =>
  v === "today" ||
  v === "week" ||
  v === "month" ||
  v === "year" ||
  v === "alltime"
    ? v
    : "week";

const syncUrl = updateUrlQuery;

// Store

interface ExploreState {
  primaryTab: PrimaryTab;
  secondaryTab: SecondaryTab;
  topPeriod: TopPeriod;
  searchQuery: string;
  viewMode: "grid" | "list";
  /** Models/LoRAs feed filters (source + Civitai/HF filters), URL-synced */
  modelFilters: ModelFilters;
  /** Bumped by the refresh button; ExplorePage refetches on change */
  refreshNonce: number;
  setPrimaryTab: (tab: PrimaryTab) => void;
  setSecondaryTab: (tab: SecondaryTab) => void;
  setTopPeriod: (p: TopPeriod) => void;
  setSearchQuery: (q: string) => void;
  setViewMode: (m: "grid" | "list") => void;
  setModelFilters: (next: ModelFilters) => void;
  requestRefresh: () => void;
  /** Re-hydrate tab state from the current URL (call on Explore mount) */
  initFromUrl: () => void;
}

export const useExploreStore = createWithEqualityFn<ExploreState>((set, get) => ({
  primaryTab: "hot",
  secondaryTab: "images",
  topPeriod: "week",
  searchQuery: "",
  viewMode: "grid",
  modelFilters: DEFAULT_MODEL_FILTERS,
  refreshNonce: 0,

  setPrimaryTab: (tab) => {
    syncUrl({ tab, ...(tab !== "top" ? { period: null } : {}) });
    set({ primaryTab: tab });
  },
  setSecondaryTab: (tab) => {
    // Leaving Likes selected on a tab without a likes list would render a
    // blank grid, so fall back to Hot.
    if (get().primaryTab === "likes" && !supportsLikes(tab)) {
      syncUrl({ view: tab, tab: "hot" });
      set({ secondaryTab: tab, primaryTab: "hot" });
      return;
    }
    syncUrl({ view: tab });
    set({ secondaryTab: tab });
  },
  setTopPeriod: (p) => {
    syncUrl({ period: p });
    set({ topPeriod: p });
  },
  setSearchQuery: (q) => {
    syncUrl({ q: q.trim() ? q : null });
    set({ searchQuery: q });
  },
  setViewMode: (m) => set({ viewMode: m }),
  setModelFilters: (modelFilters) => {
    syncUrl(modelFiltersToUrl(modelFilters), "push");
    set({ modelFilters });
  },
  requestRefresh: () => set((s) => ({ refreshNonce: s.refreshNonce + 1 })),

  initFromUrl: () => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    set({
      primaryTab: parsePrimaryTab(sp.get("tab")),
      secondaryTab: parseSecondaryTab(sp.get("view")),
      topPeriod: parseTopPeriod(sp.get("period")),
      searchQuery: sp.get("q") ?? "",
      modelFilters: modelFiltersFromUrl(sp),
    });
  },
}));

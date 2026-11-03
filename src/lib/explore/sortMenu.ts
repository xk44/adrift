import type { PrimaryTab, SecondaryTab, TopPeriod } from "@/store/exploreStore";

/**
 * Flattened Explore sort menu for the compact (phone) header: the primary
 * tabs plus every Top period become one list, so a single "Hot ⌄" trigger
 * replaces the tab row + period select.
 */
export interface SortMenuOption {
  key: string;
  label: string;
  tab: PrimaryTab;
  period?: TopPeriod;
}

const TOP_LABELS: Record<TopPeriod, string> = {
  today: "Top Day",
  week: "Top Week",
  month: "Top Month",
  year: "Top Year",
  alltime: "Top All Time",
};

export const SORT_MENU_OPTIONS: SortMenuOption[] = [
  { key: "hot", label: "Hot", tab: "hot" },
  { key: "new", label: "New", tab: "new" },
  ...(Object.keys(TOP_LABELS) as TopPeriod[]).map((period) => ({
    key: `top-${period}`,
    label: TOP_LABELS[period],
    tab: "top" as const,
    period,
  })),
  { key: "likes", label: "Likes", tab: "likes" },
];

/** The option matching the current store state (Top folds in its period). */
export function activeSortKey(tab: PrimaryTab, period: TopPeriod): string {
  return tab === "top" ? `top-${period}` : tab;
}

export function sortMenuLabel(tab: PrimaryTab, period: TopPeriod): string {
  const key = activeSortKey(tab, period);
  return SORT_MENU_OPTIONS.find((o) => o.key === key)?.label ?? "Hot";
}

/**
 * Likes is a local-favorites view that only exists for still images (the
 * Civitai model/video feeds have no likes list) — keep the option out of the
 * menu elsewhere instead of offering a choice that renders nothing.
 */
export function sortMenuOptionsFor(secondary: SecondaryTab): SortMenuOption[] {
  if (secondary === "images") return SORT_MENU_OPTIONS;
  return SORT_MENU_OPTIONS.filter((o) => o.tab !== "likes");
}

/**
 * Styles is a curated library with no feed ordering — no sort trigger.
 * Models/LoRAs sort through the shared ModelFilterBar (all 8 Civitai sorts,
 * or the Hugging Face sorts), not the Hot/New/Top image menu.
 */
export function hasSortMenu(secondary: SecondaryTab): boolean {
  return secondary === "images" || secondary === "videos";
}

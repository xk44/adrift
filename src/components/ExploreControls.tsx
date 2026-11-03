"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useUIStore } from "@/store";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import {
  activeSortKey,
  hasSortMenu,
  sortMenuLabel,
  sortMenuOptionsFor,
} from "@/lib/explore/sortMenu";
import {
  useExploreStore,
  PRIMARY_TABS,
  TOP_PERIODS,
  supportsLikes,
  type SecondaryTab,
} from "@/store/exploreStore";
import {
  Search,
  RefreshCw,
  Heart,
  Image as ImageIcon,
  Palette,
  Film,
  Boxes,
  Sparkles,
  ChevronDown,
  Check,
  X,
} from "lucide-react";

const SEARCH_PLACEHOLDER: Record<SecondaryTab, string> = {
  images: "Search Images",
  styles: "Search Styles",
  videos: "Search Videos",
  models: "Search Models",
  loras: "Search LoRAs",
};

function searchPlaceholder(tab: SecondaryTab): string {
  return SEARCH_PLACEHOLDER[tab] ?? "Search";
}

const SECONDARY_TABS: {
  id: SecondaryTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: "images", label: "Images", icon: ImageIcon },
  { id: "styles", label: "Styles", icon: Palette },
  { id: "videos", label: "Videos", icon: Film },
  { id: "models", label: "Models", icon: Boxes },
  { id: "loras", label: "LoRAs", icon: Sparkles },
];

/**
 * Explore sort/filter controls rendered inline with the prompt bar (reference-style
 * single header row) — primary sort tabs, secondary content tabs, search.
 * The "mobile" variant renders as a wrapping row above the grid (<lg only).
 */
export function ExploreControls({
  variant = "inline",
}: {
  variant?: "inline" | "mobile";
}) {
  const activeNav = useUIStore((s) => s.activeNav);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const primaryTab = useExploreStore((s) => s.primaryTab);
  const setPrimaryTab = useExploreStore((s) => s.setPrimaryTab);
  const secondaryTab = useExploreStore((s) => s.secondaryTab);
  const setSecondaryTab = useExploreStore((s) => s.setSecondaryTab);
  const topPeriod = useExploreStore((s) => s.topPeriod);
  const setTopPeriod = useExploreStore((s) => s.setTopPeriod);
  const searchQuery = useExploreStore((s) => s.searchQuery);
  const setSearchQuery = useExploreStore((s) => s.setSearchQuery);
  const requestRefresh = useExploreStore((s) => s.requestRefresh);
  const isModelTab = secondaryTab === "models" || secondaryTab === "loras";

  if (activeNav !== "explore") return null;

  // With the settings panel open the right gutter is too narrow for the
  // inline cluster — controls drop to the wrap row above the grid instead.
  if (variant === "inline" && settingsOpen) return null;

  const row = (
    <div
      className={
        variant === "mobile"
          ? `hidden md:flex ${settingsOpen ? "" : "min-[2500px]:hidden"} flex-wrap items-center gap-2 pb-3`
          : "hidden min-[2500px]:flex min-w-0 flex-wrap content-start items-center justify-end gap-x-3 gap-y-1.5 pt-[9px]"
      }
    >
      {/* Primary sort tabs — model feeds sort via the ModelFilterBar instead */}
      {!isModelTab && (
      <div className="flex items-center gap-0.5">
        {PRIMARY_TABS.filter(
          (tab) => tab.id !== "likes" || supportsLikes(secondaryTab),
        ).map((tab) => (
          <button
            type="button"
            aria-label={tab.label}
            aria-pressed={primaryTab === tab.id}
            key={tab.id}
            onClick={() => setPrimaryTab(tab.id)}
            className={[
              "flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-full transition-colors",
              primaryTab === tab.id
                ? "text-[var(--text-primary)] bg-[var(--bg-tertiary)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]",
            ].join(" ")}
          >
            {tab.id === "likes" ? <Heart className="w-3.5 h-3.5" /> : tab.label}
          </button>
        ))}
        {primaryTab === "top" && (
          <select
            value={topPeriod}
            onChange={(e) =>
              setTopPeriod(e.target.value as (typeof TOP_PERIODS)[number]["id"])
            }
            aria-label="Top period"
            className="ml-1 text-xs bg-[var(--bg-secondary)] border border-[var(--border-primary)] text-[var(--text-secondary)] rounded-full px-2 py-1 focus:outline-none focus:border-[var(--text-primary)] cursor-pointer"
          >
            {TOP_PERIODS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        )}
      </div>
      )}

      {!isModelTab && <div className="w-px h-5 bg-[var(--border-primary)]" />}

      {/* Secondary content tabs */}
      <div className="flex items-center gap-0.5">
        {SECONDARY_TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSecondaryTab(tab.id)}
              title={tab.label}
              aria-label={tab.label}
              aria-pressed={secondaryTab === tab.id}
              className={[
                "flex items-center gap-1.5 px-2.5 py-1.5 text-sm rounded-full transition-colors",
                secondaryTab === tab.id
                  ? "text-[var(--text-primary)] bg-[var(--bg-tertiary)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]",
              ].join(" ")}
            >
              <Icon className="w-3.5 h-3.5" />
              {secondaryTab === tab.id && tab.label}
            </button>
          );
        })}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)] pointer-events-none" />
        <input
          aria-label="Search"
          type="text"
          placeholder={searchPlaceholder(secondaryTab)}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-40 focus:w-56 transition-[width] pl-8 pr-2 py-1.5 text-sm rounded-full bg-[var(--bg-secondary)] border border-[var(--border-primary)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-secondary)]"
        />
      </div>


      {/* Refresh */}
      {(secondaryTab === "images" ||
        secondaryTab === "models" ||
        secondaryTab === "loras") &&
        (isModelTab || primaryTab !== "likes") && (
        <button
          onClick={requestRefresh}
          className="p-2 rounded-full text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          title="Refresh"
          aria-label="Refresh"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
        )}
    </div>
  );

  if (variant !== "mobile") return row;
  return (
    <>
      <ExploreCompactHeader />
      {row}
    </>
  );
}

// Phone header (reference-site pattern)
// One quiet row ("Images v  Hot v ....... refresh search") instead of three
// wrapping pill rows; each trigger opens a bottom sheet and the search icon
// swaps the row for a full-width field. Rendered below md only.

type Sheet = "type" | "sort" | null;

function ExploreCompactHeader() {
  const primaryTab = useExploreStore((s) => s.primaryTab);
  const setPrimaryTab = useExploreStore((s) => s.setPrimaryTab);
  const secondaryTab = useExploreStore((s) => s.secondaryTab);
  const setSecondaryTab = useExploreStore((s) => s.setSecondaryTab);
  const topPeriod = useExploreStore((s) => s.topPeriod);
  const setTopPeriod = useExploreStore((s) => s.setTopPeriod);
  const searchQuery = useExploreStore((s) => s.searchQuery);
  const setSearchQuery = useExploreStore((s) => s.setSearchQuery);
  const requestRefresh = useExploreStore((s) => s.requestRefresh);

  const [sheet, setSheet] = useState<Sheet>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const isModelTab = secondaryTab === "models" || secondaryTab === "loras";
  const showSearch = searchOpen || searchQuery.length > 0;
  const typeDef =
    SECONDARY_TABS.find((t) => t.id === secondaryTab) ?? SECONDARY_TABS[0];
  const sortLabel = sortMenuLabel(primaryTab, topPeriod);
  const canRefresh =
    isModelTab ||
    (secondaryTab !== "styles" &&
      secondaryTab !== "videos" &&
      primaryTab !== "likes");

  // Likes only exists for images — fall back to Hot when the type changes
  // under it so the grid never goes blank.
  const pickType = (id: SecondaryTab) => {
    setSecondaryTab(id);
    if (id !== "images" && primaryTab === "likes") setPrimaryTab("hot");
    setSheet(null);
  };

  const closeSearch = () => {
    setSearchQuery("");
    setSearchOpen(false);
  };

  const triggerClass =
    "flex h-11 min-w-0 items-center gap-1 rounded-lg pl-1 pr-1.5 text-[17px] font-medium text-[var(--text-primary)] transition-[transform,background-color] duration-150 active:scale-[0.96] active:bg-[var(--bg-hover)]";
  const iconBtnClass =
    "flex h-11 w-11 items-center justify-center rounded-full text-[var(--text-secondary)] transition-[transform,color,background-color] duration-150 hover:text-[var(--text-primary)] active:scale-[0.96] active:bg-[var(--bg-hover)]";

  return (
    <div className="md:hidden pb-2" data-testid="explore-compact-header">
      {showSearch ? (
        <div className="relative flex h-11 items-center">
          <Search className="pointer-events-none absolute left-3.5 h-4 w-4 text-[var(--text-muted)]" />
          <input
            type="search"
            autoFocus={searchOpen}
            enterKeyHint="search"
            placeholder={searchPlaceholder(secondaryTab)}
            aria-label={searchPlaceholder(secondaryTab)}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                closeSearch();
              }
            }}
            className="h-11 w-full rounded-xl bg-[var(--bg-secondary)] pl-10 pr-12 text-[16px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] shadow-[inset_0_0_0_1px_var(--border-primary)] focus:outline-none focus:shadow-[inset_0_0_0_1px_var(--border-secondary)] [&::-webkit-search-cancel-button]:hidden"
          />
          <button
            type="button"
            onClick={closeSearch}
            className="absolute right-0 flex h-11 w-11 items-center justify-center rounded-full text-[var(--text-secondary)] transition-transform active:scale-[0.96]"
            aria-label="Close search"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      ) : (
        <div className="flex h-11 items-center gap-3">
          <button
            type="button"
            onClick={() => setSheet("type")}
            className={triggerClass}
            aria-haspopup="dialog"
            aria-expanded={sheet === "type"}
            aria-label={`Content type: ${typeDef.label}`}
          >
            <span className="truncate">{typeDef.label}</span>
            <ChevronDown className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
          </button>
          {hasSortMenu(secondaryTab) && (
            <button
              type="button"
              onClick={() => setSheet("sort")}
              className={triggerClass}
              aria-haspopup="dialog"
              aria-expanded={sheet === "sort"}
              aria-label={`Sort: ${sortLabel}`}
            >
              <span className="truncate">{sortLabel}</span>
              <ChevronDown className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
            </button>
          )}
          <div className="flex-1" />
          <div className="-mr-2 flex items-center">
            {canRefresh && (
              <button
                type="button"
                onClick={requestRefresh}
                className={iconBtnClass}
                aria-label="Refresh"
              >
                <RefreshCw className="h-[18px] w-[18px]" />
              </button>
            )}
            {secondaryTab !== "styles" && (
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                className={iconBtnClass}
                aria-label="Search"
              >
                <Search className="h-[22px] w-[22px]" />
              </button>
            )}
          </div>
        </div>
      )}


      <BottomSheet
        open={sheet === "type"}
        onClose={() => setSheet(null)}
        label="Content type"
      >
        {SECONDARY_TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <SheetOption
              key={tab.id}
              selected={secondaryTab === tab.id}
              onSelect={() => pickType(tab.id)}
              icon={<Icon className="h-[18px] w-[18px]" />}
            >
              {tab.label}
            </SheetOption>
          );
        })}
      </BottomSheet>

      <BottomSheet
        open={sheet === "sort"}
        onClose={() => setSheet(null)}
        label="Sort"
      >
        {sortMenuOptionsFor(secondaryTab).map((opt) => (
          <SheetOption
            key={opt.key}
            selected={activeSortKey(primaryTab, topPeriod) === opt.key}
            onSelect={() => {
              setPrimaryTab(opt.tab);
              if (opt.period) setTopPeriod(opt.period);
              setSheet(null);
            }}
          >
            {opt.label}
          </SheetOption>
        ))}
      </BottomSheet>
    </div>
  );
}

const SHEET_EXIT_MS = 160;

/**
 * Floating bottom sheet over a dimmed page (reference: the type/sort
 * dropdowns on phones). Enter is a 12px rise + fade; the exit is softer.
 * Escape and backdrop tap close it; Escape is captured so the page-level
 * shortcut handler doesn't also act on it.
 */
function BottomSheet({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (open) {
      setMounted(true);
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), SHEET_EXIT_MS);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open || !mounted) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    // Start keyboard users on the selected row
    panelRef.current
      ?.querySelector<HTMLElement>('[aria-checked="true"]')
      ?.focus({ preventScroll: true });
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, mounted]);
  // Tab stays inside the sheet and focus returns to the trigger on close.
  // Escape and the initial focus (selected row) are handled above.
  useDialogFocus(panelRef, open && mounted, { initialFocus: "none" });

  if (!mounted || typeof document === "undefined") return null;
  // Portal to <body>: the explore scroller is its own stacking context, so a
  // sheet rendered in place would sit under the fixed bottom tab bar.
  return createPortal(
    <div className="fixed inset-0 z-[60] md:hidden" role="presentation">
      <div
        className={`absolute inset-0 bg-black/60 transition-opacity duration-200 ${
          shown ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`absolute inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] max-h-[60dvh] overflow-y-auto overscroll-contain rounded-2xl bg-[var(--bg-secondary)] p-2 shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_16px_48px_rgba(0,0,0,0.5)] transition-[transform,opacity] ease-[cubic-bezier(0.2,0,0,1)] ${
          shown
            ? "translate-y-0 opacity-100 duration-200"
            : "translate-y-3 opacity-0 duration-150"
        }`}
      >
        <div role="radiogroup" aria-label={label} className="flex flex-col">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SheetOption({
  selected,
  onSelect,
  icon,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex h-12 w-full shrink-0 items-center gap-3 rounded-xl px-4 text-left text-[16px] transition-colors focus:outline-none focus-visible:bg-[var(--bg-hover)] ${
        selected
          ? "bg-[color-mix(in_srgb,var(--accent-primary)_14%,transparent)] text-[var(--accent-primary)]"
          : "text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
      }`}
    >
      {icon && (
        <span
          className={
            selected ? "text-[var(--accent-primary)]" : "text-[var(--text-muted)]"
          }
        >
          {icon}
        </span>
      )}
      <span className="flex-1">{children}</span>
      {selected && <Check className="h-4 w-4" />}
    </button>
  );
}

export default ExploreControls;

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Folder, SlidersHorizontal, X } from "lucide-react";
import {
  ASPECT_OPTIONS,
  DATE_OPTIONS,
  MEDIA_OPTIONS,
  SORT_OPTIONS,
  STATUS_OPTIONS,
  describeActiveFilters,
  toggleFacet,
  type OrganizeFilters,
  type SortOption,
} from "@/lib/organize/organizeFilters";
import { useDialogFocus } from "@/hooks/useDialogFocus";

interface FolderChip {
  id: string;
  name: string;
  count: number;
}

export interface MobileOrganizeSheetProps {
  filters: OrganizeFilters;
  setFilters: (next: OrganizeFilters) => void;
  sortOption: SortOption;
  setSortOption: (v: SortOption) => void;
  activeFilterCount: number;
  clearFilters: () => void;
  resultCount: number;
  /** Smart-folder quick-access chips shown at bottom of the sheet */
  folders?: FolderChip[];
  selectedFolder?: string;
  onSelectFolder?: (id: string) => void;
}

// Half = 50vh, Full = 85vh (leaving room for status bar)
const SNAP_HALF = 0.5;
const SNAP_FULL = 0.85;
const DISMISS_THRESHOLD = 80; // px drag distance to dismiss
const SNAP_THRESHOLD = 100; // px drag distance to switch snap points

function PillGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup">
      {options.map((opt) => (
        <button
          key={opt.value}
          role="radio"
          aria-checked={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1.5 rounded-full text-sm font-medium transition-[color,background-color,transform] duration-150 active:scale-[0.96] ${
            value === opt.value
              ? "bg-[var(--accent-primary)]/15 text-[var(--accent-primary)] border border-[var(--accent-primary)]/25"
              : "bg-[var(--bg-secondary)] text-[var(--text-muted)] border border-[var(--border-primary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ChipToggleGroup<T extends string>({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  selected: readonly T[];
  onToggle: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
      {options.map((opt) => {
        const active = selected.includes(opt.value);
        return (
          <button
            key={opt.value}
            type="button"
            role="checkbox"
            aria-checked={active}
            onClick={() => onToggle(opt.value)}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-medium transition-[color,background-color,transform] duration-150 active:scale-[0.96] ${
              active
                ? "bg-[var(--accent-primary)]/15 text-[var(--accent-primary)] border border-[var(--accent-primary)]/25"
                : "bg-[var(--bg-secondary)] text-[var(--text-muted)] border border-[var(--border-primary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            }`}
          >
            {active && <Check className="h-3 w-3" strokeWidth={3} />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function SheetLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-medium text-[var(--text-muted)] mb-2">
      {children}
    </p>
  );
}

function ActiveFilterChips({
  filters,
  sortOption,
  setFilters,
  setSortOption,
}: {
  filters: OrganizeFilters;
  sortOption: SortOption;
  setFilters: (next: OrganizeFilters) => void;
  setSortOption: (v: SortOption) => void;
}) {
  const chips = describeActiveFilters(
    filters,
    sortOption,
    setFilters,
    setSortOption,
  );

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1" data-testid="active-filter-chips">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-primary)]/10 text-[var(--accent-primary)] border border-[var(--accent-primary)]/20 px-2 py-0.5 text-xs font-medium"
        >
          {chip.label}
          <button
            onClick={chip.remove}
            className="ml-0.5 rounded-full p-0.5 hover:bg-[var(--accent-primary)]/20 transition-colors"
            aria-label={`Remove ${chip.label} filter`}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}
    </div>
  );
}

export function MobileOrganizeSheetTrigger({
  activeFilterCount,
  onClick,
}: {
  activeFilterCount: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      data-testid="mobile-organize-trigger"
      className="relative flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-[var(--text-muted)] border border-[var(--border-primary)] bg-[var(--bg-secondary)] transition-[color,background-color,transform] duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] active:scale-[0.96]"
      aria-label={`Open filters${activeFilterCount > 0 ? ` (${activeFilterCount} active)` : ""}`}
    >
      <SlidersHorizontal className="h-4 w-4" />
      <span>Filters</span>
      {activeFilterCount > 0 && (
        <span
          className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent-primary)] px-1 text-[9px] font-bold text-white tabular-nums"
          data-testid="filter-count-badge"
        >
          {activeFilterCount}
        </span>
      )}
    </button>
  );
}

export function MobileOrganizeSheet({
  filters,
  setFilters,
  sortOption,
  setSortOption,
  activeFilterCount,
  clearFilters,
  resultCount,
  folders,
  selectedFolder,
  onSelectFolder,
}: MobileOrganizeSheetProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [snapPoint, setSnapPoint] = useState<"half" | "full">("half");
  const [isDragging, setIsDragging] = useState(false);
  const [dragY, setDragY] = useState(0);
  const dragStartY = useRef(0);
  const closeTimerRef = useRef<number | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Focus trap
  useDialogFocus(sheetRef, isOpen && !isClosing);

  // Animated close: slide down then unmount
  const closeSheet = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
    }
    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      setIsOpen(false);
      setIsClosing(false);
      setSnapPoint("half");
      closeTimerRef.current = null;
    }, 250);
  }, []);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  // Lock body scroll while open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSheet();
    };
    if (isOpen) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, closeSheet]);

  // Drag-to-dismiss / snap
  const handleDragStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      dragStartY.current = e.clientY;
      setIsDragging(true);
      setDragY(0);
    },
    [],
  );

  const handleDragMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging) return;
      const delta = e.clientY - dragStartY.current;
      // Allow small upward drag (negative) for snap-up, clamp at reasonable limit
      setDragY(Math.max(-100, delta));
    },
    [isDragging],
  );

  const handleDragEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (dragY > DISMISS_THRESHOLD) {
      // Dragged down far enough to dismiss
      closeSheet();
    } else if (dragY < -SNAP_THRESHOLD && snapPoint === "half") {
      // Dragged up from half — snap to full
      setSnapPoint("full");
    } else if (dragY > SNAP_THRESHOLD && snapPoint === "full") {
      // Dragged down from full — snap back to half
      setSnapPoint("half");
    }
    setIsDragging(false);
    setDragY(0);
  }, [dragY, snapPoint, closeSheet]);

  // Show folder chips: built-in + user folders (max ~8 to avoid overflow)
  const visibleFolders = folders?.slice(0, 8);

  const snapHeight = snapPoint === "full" ? SNAP_FULL : SNAP_HALF;

  return (
    <>
      {/* Trigger + active filter chips */}
      <div className="flex flex-col gap-1.5">
        <MobileOrganizeSheetTrigger
          activeFilterCount={activeFilterCount}
          onClick={() => {
            setIsOpen(true);
            setIsClosing(false);
            setSnapPoint("half");
          }}
        />
        <ActiveFilterChips
          filters={filters}
          sortOption={sortOption}
          setFilters={setFilters}
          setSortOption={setSortOption}
        />
      </div>

      {/* Portal overlay */}
      {isOpen && (
        <>
          <div
            data-testid="sheet-backdrop"
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
            style={{
              animation: isClosing
                ? "fadeOut 0.25s ease-in forwards"
                : "fadeIn 0.2s ease-out",
            }}
            onClick={closeSheet}
            aria-hidden="true"
          />

          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-label="Filter and sort options"
            data-testid="mobile-organize-sheet"
            className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-2xl bg-[var(--bg-primary)] shadow-[0_-1px_0_0_var(--border-primary),0_-8px_32px_rgba(0,0,0,0.35)]"
            style={{
              maxHeight: `${snapHeight * 100}vh`,
              transform: isClosing
                ? "translateY(100%)"
                : `translateY(${Math.max(0, dragY)}px)`,
              transition: isDragging
                ? "none"
                : "transform 0.35s cubic-bezier(0.32,0.72,0,1), max-height 0.35s cubic-bezier(0.32,0.72,0,1)",
              paddingBottom: "calc(env(safe-area-inset-bottom))",
              willChange: "transform, max-height",
              // Spring-like entry animation
              ...(!(isDragging || isClosing) && {
                animation: "slideUp 0.35s cubic-bezier(0.32,0.72,0,1)",
              }),
            }}
          >
            {/* Drag handle area */}
            <div
              className="flex flex-col items-center pt-3 pb-1 touch-none cursor-grab active:cursor-grabbing select-none"
              onPointerDown={handleDragStart}
              onPointerMove={handleDragMove}
              onPointerUp={handleDragEnd}
              onPointerCancel={handleDragEnd}
              data-testid="drag-handle"
            >
              <div className="h-1 w-10 rounded-full bg-[var(--border-primary)]" />
            </div>

            <div className="flex items-center justify-between border-b border-[var(--border-primary)] px-5 pb-3 pt-1">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  Filter & Sort
                </h2>
                <span className="tabular-nums text-xs text-[var(--text-muted)]">
                  {resultCount} item{resultCount !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {activeFilterCount > 0 && (
                  <button
                    onClick={clearFilters}
                    className="text-xs font-medium text-[var(--accent-primary)] transition-opacity duration-150 hover:opacity-80 active:scale-[0.96]"
                  >
                    Clear all
                  </button>
                )}
                <button
                  onClick={closeSheet}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-muted)] transition-[color,background-color,transform] duration-150 hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] active:scale-[0.96]"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4 space-y-5">
              {/* Status (multi-select) */}
              <div>
                <SheetLabel>Status</SheetLabel>
                <ChipToggleGroup
                  label="Status"
                  options={STATUS_OPTIONS}
                  selected={filters.status}
                  onToggle={(v) =>
                    setFilters({
                      ...filters,
                      status: toggleFacet(filters.status, v, STATUS_OPTIONS),
                    })
                  }
                />
              </div>

              {/* Type (multi-select) */}
              <div>
                <SheetLabel>Type</SheetLabel>
                <ChipToggleGroup
                  label="Media type"
                  options={MEDIA_OPTIONS}
                  selected={filters.media}
                  onToggle={(v) =>
                    setFilters({
                      ...filters,
                      media: toggleFacet(filters.media, v, MEDIA_OPTIONS),
                    })
                  }
                />
              </div>

              {/* Aspect ratio (multi-select) */}
              <div>
                <SheetLabel>Aspect Ratio</SheetLabel>
                <ChipToggleGroup
                  label="Aspect ratio"
                  options={ASPECT_OPTIONS}
                  selected={filters.aspect}
                  onToggle={(v) =>
                    setFilters({
                      ...filters,
                      aspect: toggleFacet(filters.aspect, v, ASPECT_OPTIONS),
                    })
                  }
                />
              </div>

              {/* Created */}
              <div>
                <SheetLabel>Created</SheetLabel>
                <PillGroup
                  options={DATE_OPTIONS}
                  value={filters.date}
                  onChange={(v) => setFilters({ ...filters, date: v })}
                />
              </div>

              {/* Sort */}
              <div>
                <SheetLabel>Sort</SheetLabel>
                <PillGroup
                  options={SORT_OPTIONS}
                  value={sortOption}
                  onChange={(v) => setSortOption(v)}
                />
              </div>

              {/* Smart-folder quick-access chips */}
              {visibleFolders &&
                visibleFolders.length > 0 &&
                onSelectFolder && (
                  <div>
                    <SheetLabel>Quick Folders</SheetLabel>
                    <div className="flex flex-wrap gap-1.5">
                      {visibleFolders.map((folder) => (
                        <button
                          key={folder.id}
                          onClick={() => {
                            onSelectFolder(folder.id);
                            closeSheet();
                          }}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-[color,background-color,transform] duration-150 active:scale-[0.96] ${
                            selectedFolder === folder.id
                              ? "bg-[var(--accent-primary)]/15 text-[var(--accent-primary)] border border-[var(--accent-primary)]/25"
                              : "bg-[var(--bg-secondary)] text-[var(--text-muted)] border border-[var(--border-primary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                          }`}
                        >
                          <Folder className="h-3 w-3" />
                          <span className="truncate max-w-[120px]">
                            {folder.name}
                          </span>
                          <span className="text-[10px] tabular-nums opacity-60">
                            {folder.count}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
            </div>

            <div className="px-5 pt-3 pb-2 border-t border-[var(--border-primary)]">
              <button
                onClick={closeSheet}
                className="w-full rounded-xl bg-[var(--accent-primary)] py-3 text-sm font-semibold text-white transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.98]"
              >
                Apply Filters
                {activeFilterCount > 0 && (
                  <span className="ml-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-white/20 px-1 text-[9px] font-bold tabular-nums">
                    {activeFilterCount}
                  </span>
                )}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

export default MobileOrganizeSheet;

"use client";

import { useCallback, useMemo, useRef } from "react";
import type React from "react";
import { Check, Minus, SquareCheck } from "lucide-react";
import { useGallerySelectionStore } from "@/store/gallerySelectionStore";
import { groupSelectionState } from "@/lib/gallerySelection";

const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP_PX = 10;

/**
 * Tile hook-in for Select mode. Spread the returned props on the tile root:
 * capture-phase handlers swallow clicks/keys while selecting (so neither the
 * tile's open-lightbox handler nor its hover buttons fire), and a touch
 * long-press enters Select mode with the tile picked.
 *
 * Reads the store imperatively, so tiles don't re-render on mode changes.
 */
export function useTileSelect(id: string) {
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);

  const cancelPress = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    startRef.current = null;
  }, []);

  const pick = useCallback(
    (shift: boolean) => {
      const store = useGallerySelectionStore.getState();
      if (shift) store.extendTo(id);
      else store.toggle(id);
    },
    [id],
  );

  return useMemo(
    () => ({
      onClickCapture: (e: React.MouseEvent) => {
        if (suppressClickRef.current) {
          // The click that ends a long-press must not toggle the tile back.
          suppressClickRef.current = false;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (!useGallerySelectionStore.getState().selectMode) return;
        e.preventDefault();
        e.stopPropagation();
        pick(e.shiftKey);
      },
      onKeyDownCapture: (e: React.KeyboardEvent) => {
        if (!useGallerySelectionStore.getState().selectMode) return;
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        pick(e.shiftKey);
      },
      onPointerDown: (e: React.PointerEvent) => {
        if (e.pointerType === "mouse") return;
        cancelPress();
        startRef.current = { x: e.clientX, y: e.clientY };
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          suppressClickRef.current = true;
          // Safety: if the platform never sends the trailing click, don't
          // eat the next deliberate tap.
          window.setTimeout(() => {
            suppressClickRef.current = false;
          }, 800);
          const store = useGallerySelectionStore.getState();
          if (store.selectMode) store.extendTo(id);
          else store.enterWith(id);
          try {
            navigator.vibrate?.(10);
          } catch {
            // Vibration unsupported or blocked.
          }
        }, LONG_PRESS_MS);
      },
      onPointerMove: (e: React.PointerEvent) => {
        const start = startRef.current;
        if (!start) return;
        if (
          Math.abs(e.clientX - start.x) > LONG_PRESS_SLOP_PX ||
          Math.abs(e.clientY - start.y) > LONG_PRESS_SLOP_PX
        ) {
          cancelPress();
        }
      },
      onPointerUp: cancelPress,
      onPointerCancel: cancelPress,
      onContextMenu: (e: React.MouseEvent) => {
        // Touch long-press would otherwise pop the image callout menu.
        if (suppressClickRef.current || timerRef.current !== null) {
          e.preventDefault();
        }
      },
    }),
    [id, pick, cancelPress],
  );
}

function CheckGlyph({ state }: { state: "none" | "some" | "all" }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-5 w-5 items-center justify-center rounded-[5px] border transition-colors ${
        state === "none"
          ? "border-white/80 bg-black/35"
          : "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white"
      }`}
    >
      {state === "all" && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
      {state === "some" && <Minus className="h-3.5 w-3.5" strokeWidth={3} />}
    </span>
  );
}

/**
 * Per-tile overlay: top-left checkbox plus a selected ring/tint. Renders
 * nothing outside Select mode. The tile root's capture handler does the
 * toggling, so this layer is purely visual.
 */
export function SelectCheckbox({ id }: { id: string }) {
  const selectMode = useGallerySelectionStore((s) => s.selectMode);
  const selected = useGallerySelectionStore((s) => s.selected.has(id));
  if (!selectMode) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-20"
      data-selected={selected || undefined}
    >
      <div
        className={`absolute inset-0 rounded-[4px] transition-colors ${
          selected
            ? "bg-[var(--accent-primary)]/15 ring-[3px] ring-inset ring-[var(--accent-primary)]"
            : "bg-black/10"
        }`}
      />
      <div className="absolute left-1.5 top-1.5" role="presentation">
        <CheckGlyph state={selected ? "all" : "none"} />
      </div>
      <span className="sr-only">{selected ? "Selected" : "Not selected"}</span>
    </div>
  );
}

/**
 * Checkbox for a whole run or day. Hidden outside Select mode; a full group
 * clears on click, a partial or empty one fills.
 */
export function GroupSelectCheckbox({
  ids,
  label,
  showLabel = false,
  className = "",
}: {
  ids: readonly string[];
  label: string;
  showLabel?: boolean;
  className?: string;
}) {
  const selectMode = useGallerySelectionStore((s) => s.selectMode);
  const state = useGallerySelectionStore((s) =>
    s.selectMode ? groupSelectionState(s.selected, ids) : "none",
  );
  const toggleGroup = useGallerySelectionStore((s) => s.toggleGroup);
  if (!selectMode || ids.length === 0) return null;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "all" ? true : state === "some" ? "mixed" : false}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        toggleGroup(ids);
      }}
      className={`inline-flex items-center gap-1.5 rounded-md text-xs font-normal text-[var(--text-secondary)] hover:text-[var(--text-primary)] ${className}`}
    >
      <span
        className={`flex h-4 w-4 items-center justify-center rounded-[4px] border transition-colors ${
          state === "none"
            ? "border-[var(--border-secondary,var(--border-primary))] bg-transparent"
            : "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white"
        }`}
        aria-hidden="true"
      >
        {state === "all" && <Check className="h-3 w-3" strokeWidth={3} />}
        {state === "some" && <Minus className="h-3 w-3" strokeWidth={3} />}
      </span>
      {showLabel && <span>{label}</span>}
    </button>
  );
}

/** Toolbar toggle for Select mode. */
export function SelectModeButton({ compact = false }: { compact?: boolean }) {
  const selectMode = useGallerySelectionStore((s) => s.selectMode);
  const toggleMode = useGallerySelectionStore((s) => s.toggleMode);
  return (
    <button
      type="button"
      onClick={toggleMode}
      aria-pressed={selectMode}
      title={selectMode ? "Exit select mode (Esc)" : "Select items"}
      className={`h-8 rounded-md px-2.5 text-[13px] flex items-center gap-1.5 transition-colors ${
        selectMode
          ? "bg-[var(--accent-primary)]/15 text-[var(--accent-primary)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      }`}
    >
      <SquareCheck className="w-3.5 h-3.5" />
      <span className={compact ? "hidden sm:inline" : ""}>
        {selectMode ? "Done" : "Select"}
      </span>
    </button>
  );
}

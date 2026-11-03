import { createWithEqualityFn } from "zustand/traditional";
import {
  pruneToIds,
  selectRange,
  toggleGroup,
  toggleId,
} from "@/lib/gallerySelection";

/**
 * Create feed Select mode. A tiny store (not React context) so each tile
 * subscribes to its own `selected.has(id)` and a click re-renders only the
 * tiles whose state flipped.
 */
interface GallerySelectionState {
  selectMode: boolean;
  selected: ReadonlySet<string>;
  /** Last plain-clicked tile; shift-click spans from here. */
  anchorId: string | null;
  /** Every loaded image id in feed order (synced by the Create feed). */
  orderedIds: readonly string[];

  enter: () => void;
  exit: () => void;
  toggleMode: () => void;
  setOrderedIds: (ids: readonly string[]) => void;
  /** Plain / ctrl / cmd click: toggle one tile and move the anchor. */
  toggle: (id: string) => void;
  /** Shift-click: add the anchor→id range. */
  extendTo: (id: string) => void;
  /** Long-press: enter Select mode with this tile picked. */
  enterWith: (id: string) => void;
  toggleGroup: (ids: readonly string[]) => void;
  selectAll: () => void;
  clear: () => void;
}

const EMPTY: ReadonlySet<string> = new Set();

export const useGallerySelectionStore = createWithEqualityFn<GallerySelectionState>()(
  (set, get) => ({
    selectMode: false,
    selected: EMPTY,
    anchorId: null,
    orderedIds: [],

    enter: () => set({ selectMode: true }),
    exit: () => set({ selectMode: false, selected: EMPTY, anchorId: null }),
    toggleMode: () =>
      get().selectMode ? get().exit() : set({ selectMode: true }),
    setOrderedIds: (ids) =>
      set((s) => {
        const selected = pruneToIds(s.selected, ids);
        const anchorId =
          s.anchorId && ids.includes(s.anchorId) ? s.anchorId : null;
        return { orderedIds: ids, selected, anchorId };
      }),
    toggle: (id) =>
      set((s) => ({ selected: toggleId(s.selected, id), anchorId: id })),
    extendTo: (id) =>
      set((s) => ({
        selected: selectRange(s.selected, s.orderedIds, s.anchorId, id),
        anchorId: s.anchorId ?? id,
      })),
    enterWith: (id) =>
      set((s) => ({
        selectMode: true,
        selected: s.selected.has(id) ? s.selected : toggleId(s.selected, id),
        anchorId: id,
      })),
    toggleGroup: (ids) =>
      set((s) => ({ selected: toggleGroup(s.selected, ids) })),
    selectAll: () => set((s) => ({ selected: new Set(s.orderedIds) })),
    clear: () => set({ selected: EMPTY, anchorId: null }),
  }),
);

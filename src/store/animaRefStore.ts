/**
 * The Character picker's "From a reference image (Anima)" mode: one
 * reference image, plus an optional second character (v2 adapter only; the
 * two are stitched left | right). While a reference is set, the prompt bar
 * submits to the `anima_ref` action instead of /imagine. Not persisted
 * (uploads are data URLs).
 */
import { createWithEqualityFn } from "zustand/traditional";
import type { ToolImage } from "@/lib/tools/runTool";

interface AnimaRefState {
  /** Left / only character. */
  reference: ToolImage | null;
  /** Right character (two-character mode). */
  second: ToolImage | null;
  setReference: (image: ToolImage | null) => void;
  setSecond: (image: ToolImage | null) => void;
  /** Remove the first reference; a second one moves up to take its place. */
  clearReference: () => void;
  clearSecond: () => void;
  /** Remove both. */
  clear: () => void;
}

export const useAnimaRefStore = createWithEqualityFn<AnimaRefState>()(
  (set) => ({
    reference: null,
    second: null,
    setReference: (image) =>
      set((s) =>
        image ? { reference: image } : { reference: s.second, second: null },
      ),
    setSecond: (image) =>
      set((s) => (s.reference ? { second: image } : { reference: image })),
    clearReference: () => set((s) => ({ reference: s.second, second: null })),
    clearSecond: () => set({ second: null }),
    clear: () => set({ reference: null, second: null }),
  }),
);

/**
 * Per-workflow control_after_generate modes (fixed / increment /
 * decrement / randomize), keyed by selection then control key.
 * Kept separate from workflowControlStore so mode changes never enter
 * the override undo history.
 */

import { STORAGE_KEYS, legacyAwareJSONStorage } from "@/lib/storageKeys";
import { createWithEqualityFn } from "zustand/traditional";
import { persist } from "zustand/middleware";
import type { ControlAfterGenerateMode } from "@/lib/oj/inputSpec";

interface ControlModeState {
  modes: Record<string, Record<string, ControlAfterGenerateMode>>;
  setMode: (
    selection: string,
    key: string,
    mode: ControlAfterGenerateMode,
  ) => void;
}

export const useControlModeStore = createWithEqualityFn<ControlModeState>()(
  persist(
    (set) => ({
      modes: {},
      setMode: (selection, key, mode) =>
        set((state) => ({
          modes: {
            ...state.modes,
            [selection]: { ...(state.modes[selection] ?? {}), [key]: mode },
          },
        })),
    }),
    { name: STORAGE_KEYS.controlModes, storage: legacyAwareJSONStorage() },
  ),
);

/** Default mode when the user hasn't picked one (ComfyUI's default is randomize,
 *  but Adrift persists seeds as overrides, so we keep them stable unless asked). */
export const DEFAULT_CONTROL_MODE: ControlAfterGenerateMode = "fixed";

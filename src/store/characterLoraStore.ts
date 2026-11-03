/**
 * Character LoRAs picked from the prompt bar's Character pill. Kept apart
 * from image inputs and from Styles. Persisted under
 * STORAGE_KEYS.characterLoras (selection only; the picker's open state is
 * per page view).
 */

import { createWithEqualityFn } from "zustand/traditional";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS, legacyAwareJSONStorage } from "@/lib/storageKeys";
import {
  clampStrength,
  sanitizeSelections,
  toggleSelection,
  type CharacterSelection,
} from "@/lib/characters/characterLoras";

interface CharacterLoraState {
  selected: CharacterSelection[];
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;
  /** Add (up to MAX_CHARACTERS) or remove by filename. */
  toggle: (item: CharacterSelection) => void;
  remove: (filename: string) => void;
  setStrength: (filename: string, strength: number) => void;
  removeTrigger: (filename: string, trigger: string) => void;
  /** Fill in details found after picking (trigger words, base family). */
  enrich: (
    filename: string,
    patch: Partial<Pick<CharacterSelection, "triggers" | "baseFamily">>,
  ) => void;
  setApplyAnyway: (filename: string, on: boolean) => void;
  clear: () => void;
}

const mapOne = (
  list: CharacterSelection[],
  filename: string,
  fn: (s: CharacterSelection) => CharacterSelection,
) => list.map((s) => (s.filename === filename ? fn(s) : s));

export const useCharacterLoraStore = createWithEqualityFn<CharacterLoraState>()(
  persist(
    (set) => ({
      selected: [],
      pickerOpen: false,
      setPickerOpen: (open) => set({ pickerOpen: open }),
      toggle: (item) =>
        set((s) => ({ selected: toggleSelection(s.selected, item) })),
      remove: (filename) =>
        set((s) => ({
          selected: s.selected.filter((x) => x.filename !== filename),
        })),
      setStrength: (filename, strength) =>
        set((s) => ({
          selected: mapOne(s.selected, filename, (x) => ({
            ...x,
            strength: clampStrength(strength),
          })),
        })),
      removeTrigger: (filename, trigger) =>
        set((s) => ({
          selected: mapOne(s.selected, filename, (x) => ({
            ...x,
            triggers: x.triggers.filter((t) => t !== trigger),
          })),
        })),
      enrich: (filename, patch) =>
        set((s) => ({
          selected: mapOne(s.selected, filename, (x) => ({
            ...x,
            ...(patch.triggers && x.triggers.length === 0
              ? { triggers: patch.triggers.slice(0, 6) }
              : {}),
            ...(patch.baseFamily && !x.baseFamily
              ? { baseFamily: patch.baseFamily }
              : {}),
          })),
        })),
      setApplyAnyway: (filename, on) =>
        set((s) => ({
          selected: mapOne(s.selected, filename, (x) => {
            const { applyAnyway: _drop, ...rest } = x;
            void _drop;
            return on ? { ...rest, applyAnyway: true } : rest;
          }),
        })),
      clear: () => set({ selected: [] }),
    }),
    {
      name: STORAGE_KEYS.characterLoras,
      version: 1,
      storage: legacyAwareJSONStorage(),
      partialize: (s) => ({ selected: s.selected }),
      merge: (persisted, current) => ({
        ...current,
        selected: sanitizeSelections(
          (persisted as { selected?: unknown } | undefined)?.selected,
        ),
      }),
    },
  ),
);

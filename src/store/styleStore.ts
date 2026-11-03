/**
 * Zustand store for managing style references (SREF) and LoRA shortcuts.
 *
 * Handles:
 * - Active style references (images and codes)
 * - Style weight (SW) global setting
 * - Style code history and favorites
 * - LoRA shortcode management
 * - Auto-trigger settings
 */

import { STORAGE_KEYS, legacyAwareJSONStorage } from "@/lib/storageKeys";
import { createWithEqualityFn } from "zustand/traditional";
import { persist } from "zustand/middleware";
import type {
  SREFParams,
  SREFItem,
  LoRAParams,
  LoRAItem,
} from "@/lib/sref/srefParser";
import { generateRandomStyleCode } from "@/lib/sref/srefParser";
import type { Moodboard } from "@/types";
import * as moodboardClient from "@/lib/sref/moodboardClient";
import { showToast } from "@/components/Toast";
import { friendlyLoadError } from "@/lib/ui/viewState";
import {
  createRequestSequence,
  isAbortError,
} from "@/lib/util/requestSequence";

// Types

const fetchMoodboardsSequence = createRequestSequence();

export interface StyleCodeEntry {
  code: string;
  name?: string;
  tags?: string[];
  thumbnailUrl?: string;
  createdAt: number;
  useCount: number;
  isFavorite: boolean;
}

export interface LoRAShortcodeEntry {
  shortcode: string;
  filename: string;
  displayName?: string;
  tags?: string[];
  triggers?: string[];
  defaultStrength: number;
  curatedSet?: string;
  useCount: number;
  isFavorite: boolean;
}

// State Interface

interface StyleState {
  // Active SREF configuration
  sref: SREFParams | null;

  // Active LoRA configuration
  lora: LoRAParams | null;

  // Style code library
  styleCodes: StyleCodeEntry[];

  // LoRA shortcode library
  loraShortcodes: LoRAShortcodeEntry[];

  // Recently used codes (for quick access)
  recentStyleCodes: string[];
  recentLoraShortcodes: string[];

  // UI state
  srefPanelOpen: boolean;

  // Moodboard state
  moodboards: Moodboard[];
  moodboardsLoading: boolean;
  /** Last fetchMoodboards failure (null = none); never shown as "empty". */
  moodboardsError: string | null;
  activeMoodboardId: string | null;
}

interface StyleActions {
  // SREF Management
  setSREF: (sref: SREFParams | null) => void;
  addSREFItem: (item: SREFItem) => void;
  removeSREFItem: (index: number) => void;
  updateSREFItem: (index: number, update: Partial<SREFItem>) => void;
  setStyleWeight: (sw: number) => void;
  setStyleVersion: (sv: number | undefined) => void;
  addRandomSREF: () => string;
  clearSREF: () => void;

  // LoRA Management
  setLoRA: (lora: LoRAParams | null) => void;
  addLoRAItem: (item: LoRAItem) => void;
  removeLoRAItem: (index: number) => void;
  updateLoRAItem: (index: number, update: Partial<LoRAItem>) => void;
  setAutoTrigger: (
    enabled: boolean,
    position?: "beginning" | "middle" | "end",
  ) => void;
  addRandomLoRA: (curatedSet?: string) => void;
  clearLoRA: () => void;

  // Style Code Library
  saveStyleCode: (
    code: string,
    name?: string,
    tags?: string[],
    thumbnailUrl?: string,
  ) => void;
  removeStyleCode: (code: string) => void;
  toggleStyleCodeFavorite: (code: string) => void;
  incrementStyleCodeUse: (code: string) => void;

  // LoRA Shortcode Library
  saveLoRAShortcode: (
    entry: Omit<LoRAShortcodeEntry, "useCount" | "isFavorite">,
  ) => void;
  removeLoRAShortcode: (shortcode: string) => void;
  toggleLoRAShortcodeFavorite: (shortcode: string) => void;
  incrementLoRAShortcodeUse: (shortcode: string) => void;

  // UI
  setSREFPanelOpen: (open: boolean) => void;
  toggleSREFPanel: () => void;

  // Moodboard actions
  fetchMoodboards: () => Promise<void>;
  createMoodboard: (data: {
    name: string;
    description?: string;
    images: Moodboard["images"];
    isDefault?: boolean;
  }) => Promise<Moodboard | null>;
  deleteMoodboard: (id: string) => Promise<void>;
  updateMoodboard: (data: {
    id: string;
    name?: string;
    description?: string | null;
    images?: Moodboard["images"];
    isDefault?: boolean;
  }) => Promise<void>;
  setDefaultMoodboard: (id: string) => void;
  setActiveMoodboard: (id: string | null) => void;
  applyMoodboardToSREF: (id: string) => void;
}

// Store Creation

const MAX_RECENT = 10;
const MAX_STYLE_CODES = 200;
const MAX_LORA_SHORTCODES = 200;

export const useStyleStore = createWithEqualityFn<StyleState & StyleActions>()(
  persist(
    (set, get) => ({
      sref: null,
      lora: null,
      styleCodes: [],
      loraShortcodes: [],
      recentStyleCodes: [],
      recentLoraShortcodes: [],
      srefPanelOpen: false,
      moodboards: [],
      moodboardsLoading: false,
      moodboardsError: null,
      activeMoodboardId: null,

      // SREF Management
      setSREF: (sref) => set({ sref }),

      addSREFItem: (item) =>
        set((state) => {
          const current = state.sref ?? { items: [], styleWeight: 100 };
          return {
            sref: {
              ...current,
              items: [...current.items, item],
            },
          };
        }),

      removeSREFItem: (index) =>
        set((state) => {
          if (!state.sref) return state;
          return {
            sref: {
              ...state.sref,
              items: state.sref.items.filter((_, i) => i !== index),
            },
          };
        }),

      updateSREFItem: (index, update) =>
        set((state) => {
          if (!state.sref) return state;
          return {
            sref: {
              ...state.sref,
              items: state.sref.items.map((item, i) =>
                i === index ? { ...item, ...update } : item,
              ),
            },
          };
        }),

      setStyleWeight: (sw) =>
        set((state) => ({
          sref: state.sref
            ? { ...state.sref, styleWeight: Math.max(0, Math.min(1000, sw)) }
            : { items: [], styleWeight: Math.max(0, Math.min(1000, sw)) },
        })),

      setStyleVersion: (sv) =>
        set((state) => ({
          sref: state.sref
            ? { ...state.sref, styleVersion: sv }
            : { items: [], styleWeight: 100, styleVersion: sv },
        })),

      addRandomSREF: () => {
        const code = generateRandomStyleCode();
        const item: SREFItem = {
          value: "random",
          type: "random",
          weight: 1.0,
          resolved: code,
        };

        set((state) => {
          const current = state.sref ?? { items: [], styleWeight: 100 };
          return {
            sref: {
              ...current,
              items: [...current.items, item],
            },
            recentStyleCodes: [
              code,
              ...state.recentStyleCodes.filter((c) => c !== code),
            ].slice(0, MAX_RECENT),
          };
        });

        return code;
      },

      clearSREF: () => set({ sref: null }),

      // LoRA Management
      setLoRA: (lora) => set({ lora }),

      addLoRAItem: (item) =>
        set((state) => {
          const current = state.lora ?? {
            items: [],
            autoTrigger: false,
            triggerPosition: "beginning" as const,
          };
          return {
            lora: {
              ...current,
              items: [...current.items, item],
            },
          };
        }),

      removeLoRAItem: (index) =>
        set((state) => {
          if (!state.lora) return state;
          return {
            lora: {
              ...state.lora,
              items: state.lora.items.filter((_, i) => i !== index),
            },
          };
        }),

      updateLoRAItem: (index, update) =>
        set((state) => {
          if (!state.lora) return state;
          return {
            lora: {
              ...state.lora,
              items: state.lora.items.map((item, i) =>
                i === index ? { ...item, ...update } : item,
              ),
            },
          };
        }),

      setAutoTrigger: (enabled, position = "beginning") =>
        set((state) => ({
          lora: state.lora
            ? { ...state.lora, autoTrigger: enabled, triggerPosition: position }
            : { items: [], autoTrigger: enabled, triggerPosition: position },
        })),

      addRandomLoRA: (curatedSet) => {
        // This would need backend support to pick from available LoRAs
        const item: LoRAItem = {
          name: "random",
          strength: 1.0,
          isRandom: true,
        };

        set((state) => {
          const current = state.lora ?? {
            items: [],
            autoTrigger: false,
            triggerPosition: "beginning" as const,
          };
          return {
            lora: {
              ...current,
              items: [...current.items, item],
            },
          };
        });
      },

      clearLoRA: () => set({ lora: null }),

      // Style Code Library
      saveStyleCode: (code, name, tags, thumbnailUrl) =>
        set((state) => {
          const existing = state.styleCodes.find((c) => c.code === code);
          if (existing) {
            return {
              styleCodes: state.styleCodes.map((c) =>
                c.code === code
                  ? {
                      ...c,
                      name: name ?? c.name,
                      tags: tags ?? c.tags,
                      thumbnailUrl: thumbnailUrl ?? c.thumbnailUrl,
                    }
                  : c,
              ),
            };
          }
          return {
            styleCodes: [
              {
                code,
                name,
                tags,
                thumbnailUrl,
                createdAt: Date.now(),
                useCount: 0,
                isFavorite: false,
              },
              ...state.styleCodes,
            ].slice(0, MAX_STYLE_CODES),
          };
        }),

      removeStyleCode: (code) =>
        set((state) => ({
          styleCodes: state.styleCodes.filter((c) => c.code !== code),
        })),

      toggleStyleCodeFavorite: (code) =>
        set((state) => ({
          styleCodes: state.styleCodes.map((c) =>
            c.code === code ? { ...c, isFavorite: !c.isFavorite } : c,
          ),
        })),

      incrementStyleCodeUse: (code) =>
        set((state) => ({
          styleCodes: state.styleCodes.map((c) =>
            c.code === code ? { ...c, useCount: c.useCount + 1 } : c,
          ),
          recentStyleCodes: [
            code,
            ...state.recentStyleCodes.filter((c) => c !== code),
          ].slice(0, MAX_RECENT),
        })),

      // LoRA Shortcode Library
      saveLoRAShortcode: (entry) =>
        set((state) => {
          const existing = state.loraShortcodes.find(
            (l) => l.shortcode === entry.shortcode,
          );
          if (existing) {
            return {
              loraShortcodes: state.loraShortcodes.map((l) =>
                l.shortcode === entry.shortcode ? { ...l, ...entry } : l,
              ),
            };
          }
          return {
            loraShortcodes: [
              {
                ...entry,
                useCount: 0,
                isFavorite: false,
              },
              ...state.loraShortcodes,
            ].slice(0, MAX_LORA_SHORTCODES),
          };
        }),

      removeLoRAShortcode: (shortcode) =>
        set((state) => ({
          loraShortcodes: state.loraShortcodes.filter(
            (l) => l.shortcode !== shortcode,
          ),
        })),

      toggleLoRAShortcodeFavorite: (shortcode) =>
        set((state) => ({
          loraShortcodes: state.loraShortcodes.map((l) =>
            l.shortcode === shortcode ? { ...l, isFavorite: !l.isFavorite } : l,
          ),
        })),

      incrementLoRAShortcodeUse: (shortcode) =>
        set((state) => ({
          loraShortcodes: state.loraShortcodes.map((l) =>
            l.shortcode === shortcode ? { ...l, useCount: l.useCount + 1 } : l,
          ),
          recentLoraShortcodes: [
            shortcode,
            ...state.recentLoraShortcodes.filter((s) => s !== shortcode),
          ].slice(0, MAX_RECENT),
        })),

      // UI
      setSREFPanelOpen: (open) => set({ srefPanelOpen: open }),
      toggleSREFPanel: () =>
        set((state) => ({ srefPanelOpen: !state.srefPanelOpen })),

      // Moodboard actions
      fetchMoodboards: async () => {
        const request = fetchMoodboardsSequence.begin();
        set({ moodboardsLoading: true });
        try {
          // Plain moodboards only — character/style datasets have their own tabs.
          const response = await fetch("/api/moodboards?kind=moodboard", {
            signal: request.signal,
          });
          const result = (await response.json()) as {
            ok: boolean;
            moodboards: Moodboard[];
          };
          if (!request.isCurrent()) return;
          if (result.ok)
            set({ moodboards: result.moodboards, moodboardsError: null });
          else
            set({
              moodboardsError: `The server answered ${response.status}.`,
            });
        } catch (error) {
          if (!request.isCurrent() || isAbortError(error)) return;
          set({ moodboardsError: friendlyLoadError(error) });
          showToast("Could not load moodboards. Try again.", "error");
        } finally {
          if (request.isCurrent()) {
            set({ moodboardsLoading: false });
          }
        }
      },

      createMoodboard: async (data) => {
        try {
          const result = await moodboardClient.createMoodboard(data);
          if (result.ok && result.moodboard) {
            set((state) => ({
              moodboards: [...state.moodboards, result.moodboard!],
            }));
            return result.moodboard;
          }
        } catch {
          // fall through
        }
        return null;
      },

      deleteMoodboard: async (id) => {
        try {
          const result = await moodboardClient.deleteMoodboard(id);
          if (!result.ok) {
            showToast(
              result.error ?? "Could not delete moodboard. Try again.",
              "error",
            );
            return;
          }
          set((state) => ({
            moodboards: state.moodboards.filter((m) => m.id !== id),
            activeMoodboardId:
              state.activeMoodboardId === id ? null : state.activeMoodboardId,
          }));
        } catch {
          showToast("Could not delete moodboard. Try again.", "error");
        }
      },

      updateMoodboard: async (data) => {
        try {
          const result = await moodboardClient.updateMoodboard(data);
          if (result.ok && result.moodboard) {
            const updated = result.moodboard;
            set((state) => ({
              moodboards: state.moodboards.map((m) =>
                m.id === updated.id ? updated : m,
              ),
            }));
          }
        } catch {
          showToast("Could not update moodboard. Try again.", "error");
        }
      },

      setDefaultMoodboard: (id) =>
        set((state) => ({
          moodboards: state.moodboards.map((m) => ({
            ...m,
            isDefault: m.id === id,
          })),
        })),

      setActiveMoodboard: (id) => set({ activeMoodboardId: id }),

      applyMoodboardToSREF: (id) => {
        const state = get();
        const mb = state.moodboards.find((m) => m.id === id);
        if (!mb || mb.images.length === 0) return;
        const items: import("@/lib/sref/srefParser").SREFItem[] = mb.images.map(
          (img) => ({
            value: img.url,
            type: "url" as const,
            weight: img.weight ?? 1.0,
          }),
        );
        set({ sref: { items, styleWeight: state.sref?.styleWeight ?? 100 } });
      },
    }),
    {
      name: STORAGE_KEYS.style,
      storage: legacyAwareJSONStorage(),
      partialize: (state) => ({
        sref: state.sref,
        lora: state.lora,
        styleCodes: state.styleCodes,
        loraShortcodes: state.loraShortcodes,
        recentStyleCodes: state.recentStyleCodes,
        recentLoraShortcodes: state.recentLoraShortcodes,
      }),
    },
  ),
);

// Selectors

export const selectFavoriteStyleCodes = (state: StyleState) =>
  state.styleCodes.filter((c) => c.isFavorite);

export const selectFavoriteLoRAShortcodes = (state: StyleState) =>
  state.loraShortcodes.filter((l) => l.isFavorite);

export const selectStyleCodesByTag = (state: StyleState, tag: string) =>
  state.styleCodes.filter((c) => c.tags?.includes(tag));

export const selectLoRAShortcodesBySet = (state: StyleState, set: string) =>
  state.loraShortcodes.filter((l) => l.curatedSet === set);

/**
 * Get effective SREF string for prompt
 */
export const selectSREFString = (state: StyleState): string => {
  if (!state.sref || state.sref.items.length === 0) return "";

  const items = state.sref.items.map((item) => {
    const value =
      item.type === "random" && item.resolved ? item.resolved : item.value;
    return item.weight !== 1.0 ? `${value}::${item.weight}` : value;
  });

  let str = `--sref ${items.join(" ")}`;

  if (state.sref.styleWeight !== 100) {
    str += ` --sw ${state.sref.styleWeight}`;
  }

  if (state.sref.styleVersion) {
    str += ` --sv ${state.sref.styleVersion}`;
  }

  return str;
};

/**
 * Get effective LoRA string for prompt
 */
export const selectLoRAString = (state: StyleState): string => {
  if (!state.lora || state.lora.items.length === 0) return "";

  const items = state.lora.items.map((item) => {
    if (
      item.clipStrength !== undefined &&
      item.clipStrength !== item.strength
    ) {
      return `${item.name}::${item.strength}::${item.clipStrength}`;
    } else if (item.strength !== 1.0) {
      return `${item.name}::${item.strength}`;
    }
    return item.name;
  });

  let str = `--lora ${items.join(" ")}`;

  if (state.lora.autoTrigger) {
    str += ` --autotrigger`;
    if (state.lora.triggerPosition !== "beginning") {
      str += ` ${state.lora.triggerPosition}`;
    }
  }

  return str;
};

export default useStyleStore;

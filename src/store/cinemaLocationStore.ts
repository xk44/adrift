/**
 * Saved locations for Cinema Studio multi-shot scenes (see
 * `src/lib/tools/cinemaLocations.ts`), persisted in browser storage the same
 * way as character profiles. Storage access never throws.
 */

import { STORAGE_KEYS, withLegacyFallback, type SyncStorage } from "@/lib/storageKeys";
import { createWithEqualityFn } from "zustand/traditional";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  LOCATION_NAME_MAX,
  LOCATION_STORAGE_BUDGET,
  buildLocation,
  locationsSize,
  sanitizeLocations,
  upsertLocation,
  validateLocationDraft,
  type LocationDraft,
  type SavedLocation,
} from "@/lib/tools/cinemaLocations";

export type SaveLocationResult =
  { ok: true; location: SavedLocation } | { ok: false; error: string };

interface CinemaLocationState {
  locations: SavedLocation[];
  saveLocation: (draft: LocationDraft) => SaveLocationResult;
  removeLocation: (id: string) => void;
}

/** localStorage that never throws (quota, private mode, SSR). */
export const safeLocationStorage: SyncStorage = {
  getItem: (k) => {
    try {
      return globalThis.localStorage?.getItem(k) ?? null;
    } catch {
      return null;
    }
  },
  setItem: (k, v) => {
    try {
      globalThis.localStorage?.setItem(k, v);
    } catch {
      /* quota exceeded: the save budget check normally prevents this */
    }
  },
  removeItem: (k) => {
    try {
      globalThis.localStorage?.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

export const CINEMA_LOCATIONS_KEY = STORAGE_KEYS.cinemaLocations;

export const useCinemaLocationStore = createWithEqualityFn<CinemaLocationState>()(
  persist(
    (set, get) => ({
      locations: [],

      saveLocation: (draft) => {
        const error = validateLocationDraft(draft);
        if (error) return { ok: false, error };
        const { locations } = get();
        // Same normalization as buildLocation, so a long name matches its saved copy.
        const key = draft.name
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, LOCATION_NAME_MAX)
          .toLowerCase();
        const prev = locations.find(
          (l) =>
            (draft.id && l.id === draft.id) || l.name.toLowerCase() === key,
        );
        const location = buildLocation(draft, prev);
        const next = upsertLocation(locations, location);
        if (locationsSize(next) > LOCATION_STORAGE_BUDGET)
          return {
            ok: false,
            error:
              "Browser storage for locations is full. Save without the image, or delete a location.",
          };
        set({ locations: next });
        return { ok: true, location };
      },

      removeLocation: (id) =>
        set((s) => ({ locations: s.locations.filter((l) => l.id !== id) })),
    }),
    {
      name: CINEMA_LOCATIONS_KEY,
      version: 1,
      storage: createJSONStorage(() => withLegacyFallback(safeLocationStorage)),
      partialize: (s) => ({ locations: s.locations }),
      merge: (persisted, current) => ({
        ...current,
        locations: sanitizeLocations(
          (persisted as { locations?: unknown } | undefined)?.locations,
        ),
      }),
    },
  ),
);

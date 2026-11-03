/**
 * Create feed view state that outlives the page: the "Made with" filter
 * (src/lib/runProvenance.ts). Persisted under STORAGE_KEYS.createFeed.
 */

import { createWithEqualityFn } from "zustand/traditional";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS, legacyAwareJSONStorage } from "@/lib/storageKeys";
import { parseMadeWithFilter, type MadeWithFilter } from "@/lib/runProvenance";

interface CreateFeedState {
  madeWith: MadeWithFilter;
  setMadeWith: (filter: MadeWithFilter) => void;
}

export const useCreateFeedStore = createWithEqualityFn<CreateFeedState>()(
  persist(
    (set) => ({
      madeWith: "all",
      setMadeWith: (filter) => set({ madeWith: parseMadeWithFilter(filter) }),
    }),
    {
      name: STORAGE_KEYS.createFeed,
      version: 1,
      storage: legacyAwareJSONStorage(),
      partialize: (s) => ({ madeWith: s.madeWith }),
      // Hand-edited / older stored values fall back to "all".
      merge: (persisted, current) => ({
        ...current,
        madeWith: parseMadeWithFilter(
          (persisted as { madeWith?: unknown } | undefined)?.madeWith,
        ),
      }),
    },
  ),
);

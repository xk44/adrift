import { createWithEqualityFn } from "zustand/traditional";

/**
 * Explore / Workflows model feeds: "Fits my GPU" toggle. Off by default and
 * deliberately not persisted, so nobody comes back to a mysteriously short
 * list. Shared by ModelFilterBar (the toggle) and ModelFeedResults (the filter).
 */
interface FitsFilterState {
  fitsOnly: boolean;
  setFitsOnly: (on: boolean) => void;
}

export const useFitsFilterStore = createWithEqualityFn<FitsFilterState>((set) => ({
  fitsOnly: false,
  setFitsOnly: (fitsOnly) => set({ fitsOnly }),
}));

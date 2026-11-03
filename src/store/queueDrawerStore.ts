import { createWithEqualityFn } from "zustand/traditional";

/** Open state of the global job queue drawer (not persisted). */
interface QueueDrawerState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useQueueDrawerStore = createWithEqualityFn<QueueDrawerState>()(
  (set) => ({
    open: false,
    setOpen: (open) => set({ open }),
    toggle: () => set((s) => ({ open: !s.open })),
  }),
);

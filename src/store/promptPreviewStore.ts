import { createWithEqualityFn } from "zustand/traditional";

/**
 * Transient prompt-bar preview: the Thumbnails view publishes the hovered
 * run's caption here and the empty prompt bar shows it as its placeholder.
 * Not persisted; cleared on mouse leave / unmount.
 */
interface PromptPreviewState {
  preview: string | null;
  /** Owner key so a stale mouseleave can't clear a newer hover's preview. */
  owner: string | null;
  setPreview: (owner: string, preview: string) => void;
  clearPreview: (owner: string) => void;
}

export const usePromptPreviewStore = createWithEqualityFn<PromptPreviewState>()((set) => ({
  preview: null,
  owner: null,
  setPreview: (owner, preview) => set({ owner, preview }),
  clearPreview: (owner) =>
    set((state) =>
      state.owner === owner ? { owner: null, preview: null } : state,
    ),
}));

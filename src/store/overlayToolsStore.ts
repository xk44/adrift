/**
 * Overlay Tools bridge state: the image currently picked in the ComfyUI
 * graph, a tool the launcher asked the Tools page to open, and the outcome
 * of "Send to graph" inserts. Session-only (no persistence): all of it
 * describes the live host graph.
 */

import { createWithEqualityFn } from "zustand/traditional";
import type {
  GraphImagePayload,
  GraphInsertedPayload,
} from "@/lib/overlay/protocol";

export type GraphInsertStatus =
  | { state: "pending"; title: string; at: number }
  | ({ state: "done"; title: string; at: number } & GraphInsertedPayload);

export interface OverlayToolsState {
  /** Latest graph-image report from the host (null = never received). */
  graphImage: GraphImagePayload | null;
  /** Tool key ("catalog:<id>", "action:<id>", ...) the Tools page should open. */
  pendingToolKey: string | null;
  /** Feed the graph image into the opened tool's first input. */
  pendingUseGraphImage: boolean;
  /** Last "Send to graph" request, keyed by requestId. */
  inserts: Record<string, GraphInsertStatus>;

  setGraphImage: (img: GraphImagePayload | null) => void;
  openToolFromLauncher: (key: string, useGraphImage: boolean) => void;
  consumePendingTool: () => void;
  consumeGraphImageRequest: () => boolean;
  markInsertPending: (requestId: string, title: string) => void;
  markInsertResult: (result: GraphInsertedPayload) => void;
}

const MAX_TRACKED_INSERTS = 20;

export const useOverlayToolsStore = createWithEqualityFn<OverlayToolsState>((set, get) => ({
  graphImage: null,
  pendingToolKey: null,
  pendingUseGraphImage: false,
  inserts: {},

  setGraphImage: (img) => set({ graphImage: img }),

  openToolFromLauncher: (key, useGraphImage) =>
    set({ pendingToolKey: key, pendingUseGraphImage: useGraphImage }),

  consumePendingTool: () => set({ pendingToolKey: null }),

  consumeGraphImageRequest: () => {
    const wanted = get().pendingUseGraphImage;
    if (wanted) set({ pendingUseGraphImage: false });
    return wanted;
  },

  markInsertPending: (requestId, title) =>
    set((s) => {
      const entries = Object.entries(s.inserts);
      const kept = entries.slice(
        Math.max(0, entries.length - (MAX_TRACKED_INSERTS - 1)),
      );
      return {
        inserts: {
          ...Object.fromEntries(kept),
          [requestId]: { state: "pending", title, at: Date.now() },
        },
      };
    }),

  markInsertResult: (result) =>
    set((s) => {
      const id = result.requestId;
      if (!id || !s.inserts[id]) return {};
      return {
        inserts: {
          ...s.inserts,
          [id]: {
            ...result,
            state: "done",
            title: s.inserts[id].title,
            at: Date.now(),
          },
        },
      };
    }),
}));

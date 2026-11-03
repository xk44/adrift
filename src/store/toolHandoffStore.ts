/**
 * Pending lightbox -> Tools page input hand-off (session only). See
 * lib/tools/toolHandoff.ts for the rules.
 */

import { createWithEqualityFn } from "zustand/traditional";
import {
  takeHandoff,
  type ToolHandoff,
  type ToolPrefill,
} from "@/lib/tools/toolHandoff";

export interface ToolHandoffState {
  pending: ToolHandoff | null;
  offer: (handoff: ToolHandoff) => void;
  /** Consume the hand-off meant for `toolKey` (null when none / stale). */
  take: (toolKey: string, now?: number) => ToolHandoff | null;
  /** Pending settings for the card a "Made with" chip opens. */
  prefill: ToolPrefill | null;
  offerPrefill: (prefill: ToolPrefill | null) => void;
  takePrefill: (toolKey: string, now?: number) => ToolPrefill | null;
}

export const useToolHandoffStore = createWithEqualityFn<ToolHandoffState>((set, get) => ({
  pending: null,
  offer: (handoff) => set({ pending: handoff }),
  take: (toolKey, now = Date.now()) => {
    const { handoff, remaining } = takeHandoff(get().pending, toolKey, now);
    if (remaining !== get().pending) set({ pending: remaining });
    return handoff;
  },
  prefill: null,
  offerPrefill: (prefill) => set({ prefill }),
  takePrefill: (toolKey, now = Date.now()) => {
    const { handoff, remaining } = takeHandoff(get().prefill, toolKey, now);
    if (remaining !== get().prefill) set({ prefill: remaining });
    return handoff;
  },
}));

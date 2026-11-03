/**
 * Imported user tools (summaries, no graphs), shared by the Tools page,
 * the lightbox / editor Tools panels and the Workflows assignments page.
 * Plus a one-shot "import this Civitai link" request from Explore.
 * Session-only: the source of truth is /api/user-tools.
 */

import { useEffect } from "react";
import { createWithEqualityFn } from "zustand/traditional";
import type { UserToolSummary } from "@/lib/userTools/types";
import { listUserToolsApi } from "@/lib/userTools/client";

export interface UserToolsState {
  /** null = not loaded yet. */
  tools: UserToolSummary[] | null;
  /** Civitai link Explore asked the Tools page to import. */
  pendingImportUrl: string | null;
  load: (force?: boolean) => Promise<void>;
  upsert: (tool: UserToolSummary) => void;
  remove: (id: string) => void;
  requestImport: (url: string) => void;
  consumeImport: () => string | null;
}

let inflight: Promise<void> | null = null;

export const useUserToolsStore = createWithEqualityFn<UserToolsState>((set, get) => ({
  tools: null,
  pendingImportUrl: null,
  load: async (force = false) => {
    if (!force && get().tools !== null) return;
    if (inflight && !force) return inflight;
    const p = Promise.resolve()
      .then(() => listUserToolsApi(fetch))
      .then((tools) => set({ tools }))
      .catch(() => {
        // Offline / not signed in: show no user tools rather than spinning.
        if (get().tools === null) set({ tools: [] });
      })
      .finally(() => {
        if (inflight === p) inflight = null;
      });
    inflight = p;
    return p;
  },
  upsert: (tool) =>
    set((s) => {
      const list = s.tools ?? [];
      const i = list.findIndex((t) => t.id === tool.id);
      return {
        tools:
          i < 0
            ? [...list, tool]
            : list.map((t) => (t.id === tool.id ? tool : t)),
      };
    }),
  remove: (id) =>
    set((s) => ({ tools: (s.tools ?? []).filter((t) => t.id !== id) })),
  requestImport: (url) => set({ pendingImportUrl: url }),
  consumeImport: () => {
    const url = get().pendingImportUrl;
    if (url) set({ pendingImportUrl: null });
    return url;
  },
}));

/** Loaded user tools (kicks off the first load). */
export function useUserTools(): UserToolSummary[] | null {
  const tools = useUserToolsStore((s) => s.tools);
  useEffect(() => {
    if (tools === null) void useUserToolsStore.getState().load();
  }, [tools]);
  return tools;
}

/** Display name for a "user:<id>" workflow selection, or null. */
export function userToolSelectionName(selection: string): string | null {
  if (!selection.startsWith("user:")) return null;
  const id = selection.slice("user:".length);
  return useUserToolsStore.getState().tools?.find((t) => t.id === id)?.name ?? null;
}

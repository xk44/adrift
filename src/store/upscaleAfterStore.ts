/**
 * "Upscale after" chains (lib/upscale/upscaleAfter.ts) keyed by parent run
 * id. Persisted so a chain whose tool run finishes after a reload still
 * fires; hooks/useUpscaleAfter.ts drives them.
 */

import { STORAGE_KEYS, legacyAwareJSONStorage } from "@/lib/storageKeys";
import { createWithEqualityFn } from "zustand/traditional";
import { persist } from "zustand/middleware";
import {
  pruneChains,
  type UpscaleChain,
} from "@/lib/upscale/upscaleAfter";

interface UpscaleAfterState {
  chains: Record<string, UpscaleChain>;
  add: (chain: UpscaleChain) => void;
  patch: (parentRunId: string, patch: Partial<UpscaleChain>) => void;
  remove: (parentRunId: string) => void;
}

function sanitize(raw: unknown): Record<string, UpscaleChain> {
  const src = (raw as { chains?: unknown } | null)?.chains;
  if (!src || typeof src !== "object") return {};
  const out: Record<string, UpscaleChain> = {};
  for (const c of Object.values(src as Record<string, unknown>)) {
    const v = c as Partial<UpscaleChain> | null;
    if (
      !v ||
      typeof v.parentRunId !== "string" ||
      typeof v.createdAt !== "number" ||
      (v.factor !== 2 && v.factor !== 4)
    )
      continue;
    out[v.parentRunId] = {
      parentRunId: v.parentRunId,
      parentLabel: typeof v.parentLabel === "string" ? v.parentLabel : "Tool",
      cardKey: typeof v.cardKey === "string" ? v.cardKey : "",
      factor: v.factor,
      createdAt: v.createdAt,
      status:
        v.status === "queued" || v.status === "skipped" || v.status === "failed"
          ? v.status
          : "waiting",
      children: Array.isArray(v.children)
        ? v.children.filter((x): x is string => typeof x === "string")
        : [],
      ...(typeof v.note === "string" ? { note: v.note } : {}),
    };
  }
  return pruneChains(out);
}

export const useUpscaleAfterStore = createWithEqualityFn<UpscaleAfterState>()(
  persist(
    (set) => ({
      chains: {},
      add: (chain) =>
        set((s) => ({
          chains: pruneChains({ ...s.chains, [chain.parentRunId]: chain }),
        })),
      patch: (id, patch) =>
        set((s) =>
          s.chains[id]
            ? { chains: { ...s.chains, [id]: { ...s.chains[id], ...patch } } }
            : s,
        ),
      remove: (id) =>
        set((s) => {
          if (!s.chains[id]) return s;
          const next = { ...s.chains };
          delete next[id];
          return { chains: next };
        }),
    }),
    {
      name: STORAGE_KEYS.upscaleAfter,
      storage: legacyAwareJSONStorage(),
      version: 1,
      partialize: (s) => ({ chains: s.chains }),
      merge: (persisted, current) => ({
        ...current,
        chains: sanitize(persisted),
      }),
    },
  ),
);

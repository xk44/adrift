/**
 * Saved character profiles (see `src/lib/tools/characterProfiles.ts`),
 * persisted in browser storage like the other client stores. `armedId` is a
 * transient hand-off: "Use" on a profile arms it, the next runner's picker
 * applies it once.
 */

import { STORAGE_KEYS, withLegacyFallback, type SyncStorage } from "@/lib/storageKeys";
import { createWithEqualityFn } from "zustand/traditional";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  PROFILE_STORAGE_BUDGET,
  buildProfile,
  profilesSize,
  sanitizeProfiles,
  validateProfileDraft,
  type CharacterProfile,
  type ProfileDraft,
} from "@/lib/tools/characterProfiles";

export type SaveProfileResult =
  { ok: true; profile: CharacterProfile } | { ok: false; error: string };

interface CharacterProfileState {
  profiles: CharacterProfile[];
  armedId: string | null;
  saveProfile: (draft: ProfileDraft) => SaveProfileResult;
  removeProfile: (id: string) => void;
  armProfile: (id: string | null) => void;
  /** Return and clear the armed profile id. */
  takeArmed: () => string | null;
}

/** localStorage that never throws (quota, private mode, SSR). */
const safeStorage: SyncStorage = {
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

export const useCharacterProfileStore = createWithEqualityFn<CharacterProfileState>()(
  persist(
    (set, get) => ({
      profiles: [],
      armedId: null,

      saveProfile: (draft) => {
        const error = validateProfileDraft(draft);
        if (error) return { ok: false, error };
        const { profiles } = get();
        const prev = draft.id
          ? profiles.find((p) => p.id === draft.id)
          : undefined;
        const profile = buildProfile(draft, prev);
        const next = prev
          ? profiles.map((p) => (p.id === prev.id ? profile : p))
          : [profile, ...profiles];
        if (profilesSize(next) > PROFILE_STORAGE_BUDGET)
          return {
            ok: false,
            error:
              "Browser storage for profiles is full. Use gallery images instead of uploads, or delete a profile.",
          };
        set({ profiles: next });
        return { ok: true, profile };
      },

      removeProfile: (id) =>
        set((s) => ({
          profiles: s.profiles.filter((p) => p.id !== id),
          armedId: s.armedId === id ? null : s.armedId,
        })),

      armProfile: (id) => set({ armedId: id }),

      takeArmed: () => {
        const id = get().armedId;
        if (id) set({ armedId: null });
        return id;
      },
    }),
    {
      name: STORAGE_KEYS.characterProfiles,
      version: 1,
      storage: createJSONStorage(() => withLegacyFallback(safeStorage)),
      partialize: (s) => ({ profiles: s.profiles }),
      merge: (persisted, current) => ({
        ...current,
        profiles: sanitizeProfiles(
          (persisted as { profiles?: unknown } | undefined)?.profiles,
        ),
      }),
    },
  ),
);

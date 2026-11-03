/**
 * Preference Store — tracks aesthetic preference votes from Teach mode
 * and community ranking comparisons from Tasks page.
 */

import { STORAGE_KEYS, legacyAwareJSONStorage } from "@/lib/storageKeys";
import { createWithEqualityFn } from "zustand/traditional";
import { persist } from "zustand/middleware";

export interface PreferenceVote {
  imageA: string; // image ID or URL
  imageB: string;
  preferred: "a" | "b";
  timestamp: number;
}

export interface RankingVote {
  imageA: string;
  imageB: string;
  preferred: "a" | "b";
  challengePrompt?: string;
  timestamp: number;
}

interface PreferenceState {
  // Teach mode votes
  votes: PreferenceVote[];
  sessionCount: number;
  currentSessionVotes: number;

  // Tasks ranking votes
  rankingVotes: RankingVote[];
  rankingStreak: number;
  lastRankingDate: string | null;

  // Actions
  addVote: (vote: Omit<PreferenceVote, "timestamp">) => void;
  addRankingVote: (vote: Omit<RankingVote, "timestamp">) => void;
  incrementSession: () => void;
  resetSessionVotes: () => void;
}

export const usePreferenceStore = createWithEqualityFn<PreferenceState>()(
  persist(
    (set, get) => ({
      votes: [],
      sessionCount: 0,
      currentSessionVotes: 0,
      rankingVotes: [],
      rankingStreak: 0,
      lastRankingDate: null,

      addVote: (vote) =>
        set((s) => ({
          votes: [...s.votes, { ...vote, timestamp: Date.now() }],
          currentSessionVotes: s.currentSessionVotes + 1,
        })),

      addRankingVote: (vote) => {
        const today = new Date().toISOString().slice(0, 10);
        const state = get();
        const isNewDay = state.lastRankingDate !== today;
        const isConsecutive =
          state.lastRankingDate &&
          new Date(today).getTime() -
            new Date(state.lastRankingDate).getTime() <=
            86400000;

        set({
          rankingVotes: [
            ...state.rankingVotes,
            { ...vote, timestamp: Date.now() },
          ],
          rankingStreak: isNewDay
            ? isConsecutive
              ? state.rankingStreak + 1
              : 1
            : state.rankingStreak,
          lastRankingDate: today,
        });
      },

      incrementSession: () =>
        set((s) => ({
          sessionCount: s.sessionCount + 1,
          currentSessionVotes: 0,
        })),

      resetSessionVotes: () => set({ currentSessionVotes: 0 }),
    }),
    {
      name: STORAGE_KEYS.preferences,
      storage: legacyAwareJSONStorage(),
      partialize: (state) => ({
        votes: state.votes,
        sessionCount: state.sessionCount,
        rankingVotes: state.rankingVotes,
        rankingStreak: state.rankingStreak,
        lastRankingDate: state.lastRankingDate,
      }),
    },
  ),
);

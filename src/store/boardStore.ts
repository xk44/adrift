/**
 * Tools > Board: saved boards (lanes of chained tool steps). Every edit goes
 * through the pure boardReducer (src/lib/tools/board.ts); this store only
 * persists the result in localStorage.
 */

import { STORAGE_KEYS, legacyAwareJSONStorage } from "@/lib/storageKeys";
import { createWithEqualityFn } from "zustand/traditional";
import { persist } from "zustand/middleware";
import {
  EMPTY_BOARDS,
  boardReducer,
  sanitizeBoards,
  settleBoards,
  type BoardAction,
  type BoardsState,
} from "@/lib/tools/board";

export const BOARD_STORAGE_KEY = STORAGE_KEYS.toolsBoards;

interface BoardStore extends BoardsState {
  dispatch: (action: BoardAction) => void;
}

export const useBoardStore = createWithEqualityFn<BoardStore>()(
  persist(
    (set) => ({
      ...EMPTY_BOARDS,
      dispatch: (action) =>
        set((s) =>
          boardReducer({ boards: s.boards, activeId: s.activeId }, action),
        ),
    }),
    {
      name: BOARD_STORAGE_KEY,
      storage: legacyAwareJSONStorage(),
      version: 1,
      partialize: (s) => ({ boards: s.boards, activeId: s.activeId }),
      // Unknown shapes are dropped and steps a closed tab left "running"
      // go back to idle.
      merge: (persisted, current) => ({
        ...current,
        ...settleBoards(sanitizeBoards(persisted)),
      }),
    },
  ),
);

/**
 * The live board run. Kept outside BoardRunner (and out of localStorage) so
 * leaving the Board view mid-run doesn't lose it: on return the view still
 * shows the running lane and Stop, and a second run can't start on top.
 */
interface BoardRunStore {
  /** Board being run, or null when idle. */
  boardId: string | null;
  /** Lane whose steps are executing right now. */
  laneId: string | null;
  cancelRequested: boolean;
  /** Claim the single run slot; false when a run is already active. */
  begin: (boardId: string) => boolean;
  setLane: (laneId: string | null) => void;
  requestCancel: () => void;
  finish: () => void;
}

export const useBoardRunStore = createWithEqualityFn<BoardRunStore>()((set, get) => ({
  boardId: null,
  laneId: null,
  cancelRequested: false,
  begin: (boardId) => {
    if (get().boardId !== null) return false;
    set({ boardId, laneId: null, cancelRequested: false });
    return true;
  },
  setLane: (laneId) => set({ laneId }),
  requestCancel: () => {
    if (get().boardId !== null) set({ cancelRequested: true });
  },
  finish: () => set({ boardId: null, laneId: null, cancelRequested: false }),
}));

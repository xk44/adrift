/**
 * Lightbox creator-action prefs (lib/ui/creatorActions.ts): hidden actions
 * and groups, quick-row pins, group order. Persisted under
 * STORAGE_KEYS.creatorActions; gallery hover actions read the same hidden
 * set.
 */

import { createWithEqualityFn } from "zustand/traditional";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS, legacyAwareJSONStorage } from "@/lib/storageKeys";
import {
  CREATOR_ACTION_IDS,
  defaultCreatorActionPrefs,
  isCreatorActionShown,
  moveGroup,
  movePinned,
  normalizeCreatorActionPrefs,
  resetGroupPrefs,
  withPinned,
  type CreatorActionContext,
  type CreatorActionId,
  type CreatorActionPrefs,
  type CreatorGroupId,
} from "@/lib/ui/creatorActions";

interface CreatorActionsState extends CreatorActionPrefs {
  setActionHidden: (id: CreatorActionId, hidden: boolean) => void;
  setGroupHidden: (group: CreatorGroupId, hidden: boolean) => void;
  setPinned: (id: CreatorActionId, pinned: boolean) => void;
  movePinned: (
    id: CreatorActionId,
    dir: -1 | 1,
    ctx?: CreatorActionContext,
  ) => void;
  moveGroup: (group: CreatorGroupId, dir: -1 | 1) => void;
  resetGroup: (group: CreatorGroupId) => void;
  reset: () => void;
}

const toggle = <T>(list: T[], item: T, on: boolean): T[] =>
  on
    ? list.includes(item)
      ? list
      : [...list, item]
    : list.filter((x) => x !== item);

const prefsOf = (s: CreatorActionsState): CreatorActionPrefs => ({
  pinned: s.pinned,
  hidden: s.hidden,
  groupOrder: s.groupOrder,
  hiddenGroups: s.hiddenGroups,
});

export const useCreatorActionsStore =
  createWithEqualityFn<CreatorActionsState>()(
    persist(
      (set) => ({
        ...defaultCreatorActionPrefs(),
        setActionHidden: (id, hidden) =>
          set((s) => ({ hidden: toggle(s.hidden, id, hidden) })),
        setGroupHidden: (group, hidden) =>
          set((s) => ({
            hiddenGroups: toggle(s.hiddenGroups, group, hidden),
          })),
        setPinned: (id, pinned) =>
          set((s) => ({ pinned: withPinned(prefsOf(s), id, pinned) })),
        movePinned: (id, dir, ctx) =>
          set((s) => ({ pinned: movePinned(prefsOf(s), id, dir, ctx) })),
        moveGroup: (group, dir) =>
          set((s) => ({ groupOrder: moveGroup(prefsOf(s), group, dir) })),
        resetGroup: (group) => set((s) => resetGroupPrefs(prefsOf(s), group)),
        reset: () => set(defaultCreatorActionPrefs()),
      }),
      {
        name: STORAGE_KEYS.creatorActions,
        // v1 hid whole rows; normalize maps them onto actions.
        version: 2,
        migrate: (persisted) => persisted as CreatorActionsState,
        storage: legacyAwareJSONStorage(),
        partialize: (s) => prefsOf(s),
        merge: (persisted, current) => ({
          ...current,
          ...normalizeCreatorActionPrefs(persisted),
        }),
      },
    ),
  );

export const selectCreatorActionPrefs = prefsOf;

/** id -> shown, for surfaces that only show/hide (gallery). */
export function selectCreatorActionShown(
  s: CreatorActionsState,
): Record<CreatorActionId, boolean> {
  const prefs = prefsOf(s);
  return Object.fromEntries(
    CREATOR_ACTION_IDS.map((id) => [id, isCreatorActionShown(prefs, id)]),
  ) as Record<CreatorActionId, boolean>;
}

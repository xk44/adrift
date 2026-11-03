/**
 * Tools "Scene" (lib/tools/scene.ts): settings shared by every Tools card,
 * persisted per browser.
 */

import { STORAGE_KEYS, legacyAwareJSONStorage } from "@/lib/storageKeys";
import { createWithEqualityFn } from "zustand/traditional";
import { persist } from "zustand/middleware";
import { DEFAULT_SCENE, sanitizeScene, type Scene } from "@/lib/tools/scene";

interface SceneState {
  scene: Scene;
  update: (patch: Partial<Scene>) => void;
  /** Clear every value; keeps the Apply toggle. */
  clear: () => void;
}

export const useSceneStore = createWithEqualityFn<SceneState>()(
  persist(
    (set) => ({
      scene: DEFAULT_SCENE,
      update: (patch) =>
        set((s) => ({ scene: sanitizeScene({ ...s.scene, ...patch }) })),
      clear: () =>
        set((s) => ({ scene: { ...DEFAULT_SCENE, apply: s.scene.apply } })),
    }),
    {
      name: STORAGE_KEYS.toolsScene,
      storage: legacyAwareJSONStorage(),
      version: 1,
      partialize: (s) => ({ scene: s.scene }),
      merge: (persisted, current) => ({
        ...current,
        scene: sanitizeScene((persisted as { scene?: unknown } | null)?.scene),
      }),
    },
  ),
);

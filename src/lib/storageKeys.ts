/**
 * Browser-storage keys (localStorage, including zustand `persist` names).
 *
 * Every key used to carry the product's pre-rename prefix. Builds before the
 * Adrift rename wrote those keys, so reads fall back to the legacy key when
 * the new one is missing and copy the value forward. The legacy copy is left
 * in place (a downgrade still finds its data); removing a key removes both,
 * so cleared data never comes back from the legacy copy.
 */

import { createJSONStorage } from "zustand/middleware";

export const STORAGE_KEYS = {
  profile: "adrift.profile",
  bannerImage: "adrift.banner-image",
  avatarImage: "adrift.avatar-image",
  pinnedImages: "adrift.pinned-images",
  following: "adrift.following",
  styleSessions: "adrift.style-sessions",
  feedback: "adrift.feedback",
  readVersions: "adrift.read-versions",
  completedChallenges: "adrift.completed-challenges",
  presets: "adrift.presets",
  characterProfiles: "adrift.character-profiles",
  toolsBoards: "adrift.tools-boards",
  cinemaLocations: "adrift.cinema-locations",
  generation: "adrift.generation",
  ui: "adrift.ui",
  overlay: "adrift.overlay",
  style: "adrift.style",
  models: "adrift.models",
  workflowControls: "adrift.workflow-controls",
  controlModes: "adrift.control-modes",
  downloads: "adrift.downloads",
  preferences: "adrift.preferences",
  likes: "adrift.likes",
  // Added after the rename: no legacy key.
  createFeed: "adrift.create-feed",
  characterLoras: "adrift.character-loras",
  videoEdit: "adrift.video-edit",
  creatorActions: "adrift.creator-actions",
  upscaleAfter: "adrift.upscale-after",
  toolsScene: "adrift.tools-scene",
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

/**
 * New key -> the key builds before the Adrift rename wrote. Keys added after
 * the rename have no entry (nothing to migrate).
 */
export const LEGACY_STORAGE_KEYS: Readonly<
  Partial<Record<StorageKey, string>>
> = {
  [STORAGE_KEYS.profile]: "comfyjourney-profile", // legacy-name
  [STORAGE_KEYS.bannerImage]: "comfyjourney-banner-image", // legacy-name
  [STORAGE_KEYS.avatarImage]: "comfyjourney-avatar-image", // legacy-name
  [STORAGE_KEYS.pinnedImages]: "comfyjourney-pinned-images", // legacy-name
  [STORAGE_KEYS.following]: "comfyjourney-following", // legacy-name
  [STORAGE_KEYS.styleSessions]: "comfyjourney-style-sessions", // legacy-name
  [STORAGE_KEYS.feedback]: "comfyjourney-feedback", // legacy-name
  [STORAGE_KEYS.readVersions]: "comfyjourney-read-versions", // legacy-name
  [STORAGE_KEYS.completedChallenges]: "comfyjourney-completed-challenges", // legacy-name
  [STORAGE_KEYS.presets]: "comfyjourney-presets", // legacy-name
  [STORAGE_KEYS.characterProfiles]: "comfyjourney-character-profiles", // legacy-name
  [STORAGE_KEYS.toolsBoards]: "comfy-journey-tools-boards", // legacy-name
  [STORAGE_KEYS.cinemaLocations]: "comfyjourney-cinema-locations", // legacy-name
  [STORAGE_KEYS.generation]: "comfy-journey-generation", // legacy-name
  [STORAGE_KEYS.ui]: "comfy-journey-ui", // legacy-name
  [STORAGE_KEYS.overlay]: "comfy-journey-overlay", // legacy-name
  [STORAGE_KEYS.style]: "comfy-journey-style", // legacy-name
  [STORAGE_KEYS.models]: "comfy-journey-models", // legacy-name
  [STORAGE_KEYS.workflowControls]: "comfy-journey-workflow-controls", // legacy-name
  [STORAGE_KEYS.controlModes]: "comfy-journey-control-modes", // legacy-name
  [STORAGE_KEYS.downloads]: "comfyjourney-downloads", // legacy-name
  [STORAGE_KEYS.preferences]: "comfyjourney-preferences", // legacy-name
  [STORAGE_KEYS.likes]: "comfyjourney-likes", // legacy-name
};

/** Synchronous Storage subset (window.localStorage or a test double). */
export interface SyncStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function legacyKeyFor(key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(LEGACY_STORAGE_KEYS, key)
    ? LEGACY_STORAGE_KEYS[key as StorageKey]
    : undefined;
}

/**
 * storage.getItem(key), falling back to the key's legacy name. A legacy
 * value is copied to the new key (best effort: a full or read-only storage
 * still returns the value).
 */
export function readStorageItem(
  storage: SyncStorage,
  key: string,
): string | null {
  const current = storage.getItem(key);
  if (current !== null && current !== undefined) return current;
  const legacy = legacyKeyFor(key);
  if (!legacy) return null;
  const old = storage.getItem(legacy);
  if (old === null || old === undefined) return null;
  try {
    storage.setItem(key, old);
  } catch {
    /* quota / private mode: the legacy value is still returned */
  }
  return old;
}

/** Remove a key and its legacy copy, so the fallback cannot resurrect it. */
export function removeStorageItem(storage: SyncStorage, key: string): void {
  storage.removeItem(key);
  const legacy = legacyKeyFor(key);
  if (legacy) storage.removeItem(legacy);
}

/** Wrap a storage so reads fall back to (and migrate) legacy keys. */
export function withLegacyFallback(storage: SyncStorage): SyncStorage {
  return {
    getItem: (key) => readStorageItem(storage, key),
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => removeStorageItem(storage, key),
  };
}

/** localStorage when the environment has one (not during SSR). */
function browserLocalStorage(): SyncStorage {
  const storage = globalThis.localStorage;
  if (!storage) throw new Error("localStorage unavailable");
  return storage;
}

/** localStorage.getItem(key) with legacy fallback; null when unavailable. */
export function readLocalStorage(key: StorageKey): string | null {
  try {
    return readStorageItem(browserLocalStorage(), key);
  } catch {
    return null;
  }
}

/**
 * zustand `persist` storage: JSON over localStorage (or `base`), reading
 * legacy keys as a fallback. Without `base` it behaves like zustand's
 * default storage, which is a no-op when localStorage is unavailable.
 */
export function legacyAwareJSONStorage<S>(base?: () => SyncStorage) {
  return createJSONStorage<S>(() =>
    withLegacyFallback((base ?? browserLocalStorage)()),
  );
}

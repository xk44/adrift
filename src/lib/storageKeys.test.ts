import { describe, expect, it } from "vitest";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  LEGACY_STORAGE_KEYS,
  STORAGE_KEYS,
  legacyAwareJSONStorage,
  readStorageItem,
  removeStorageItem,
  withLegacyFallback,
  type SyncStorage,
} from "./storageKeys";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage: SyncStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
  return { data, storage };
}

const LEGACY_LIKES = "comfyjourney-likes"; // legacy-name

describe("storage keys", () => {
  it("maps every pre-rename key to a distinct legacy key", () => {
    const keys = Object.values(STORAGE_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
    // Keys added after the rename have nothing to migrate.
    const postRename = new Set<string>([
      STORAGE_KEYS.createFeed,
      STORAGE_KEYS.characterLoras,
      STORAGE_KEYS.videoEdit,
      STORAGE_KEYS.creatorActions,
      STORAGE_KEYS.upscaleAfter,
      STORAGE_KEYS.toolsScene,
    ]);
    for (const key of keys) {
      expect(key.startsWith("adrift.")).toBe(true);
      if (postRename.has(key)) {
        expect(LEGACY_STORAGE_KEYS[key]).toBeUndefined();
      } else {
        expect(LEGACY_STORAGE_KEYS[key]).toBeTruthy();
      }
    }
    for (const key of Object.keys(LEGACY_STORAGE_KEYS)) {
      expect(keys).toContain(key);
    }
    const legacy = Object.values(LEGACY_STORAGE_KEYS);
    expect(new Set(legacy).size).toBe(legacy.length);
    expect(LEGACY_STORAGE_KEYS[STORAGE_KEYS.likes]).toBe(LEGACY_LIKES);
  });
});

describe("readStorageItem", () => {
  it("reads the legacy key when the new one is missing and copies it forward", () => {
    const { data, storage } = memoryStorage({ [LEGACY_LIKES]: "old" });
    expect(readStorageItem(storage, STORAGE_KEYS.likes)).toBe("old");
    expect(data.get(STORAGE_KEYS.likes)).toBe("old");
    // The legacy copy stays for a downgrade.
    expect(data.get(LEGACY_LIKES)).toBe("old");
  });

  it("prefers the new key over the legacy one", () => {
    const { storage } = memoryStorage({
      [STORAGE_KEYS.likes]: "new",
      [LEGACY_LIKES]: "old",
    });
    expect(readStorageItem(storage, STORAGE_KEYS.likes)).toBe("new");
  });

  it("returns an empty string stored under the new key without falling back", () => {
    const { storage } = memoryStorage({
      [STORAGE_KEYS.likes]: "",
      [LEGACY_LIKES]: "old",
    });
    expect(readStorageItem(storage, STORAGE_KEYS.likes)).toBe("");
  });

  it("returns null when neither key exists, and ignores unknown keys", () => {
    const { data, storage } = memoryStorage({ other: "x" });
    expect(readStorageItem(storage, STORAGE_KEYS.likes)).toBeNull();
    expect(readStorageItem(storage, "other")).toBe("x");
    expect(readStorageItem(storage, "missing")).toBeNull();
    expect(data.size).toBe(1);
  });

  it("still returns the legacy value when copying it forward throws", () => {
    const { storage } = memoryStorage({ [LEGACY_LIKES]: "old" });
    const full: SyncStorage = {
      ...storage,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readStorageItem(full, STORAGE_KEYS.likes)).toBe("old");
  });
});

describe("removeStorageItem", () => {
  it("removes both keys so cleared data cannot come back from the legacy copy", () => {
    const { data, storage } = memoryStorage({
      [STORAGE_KEYS.likes]: "new",
      [LEGACY_LIKES]: "old",
    });
    removeStorageItem(storage, STORAGE_KEYS.likes);
    expect(data.size).toBe(0);
    expect(readStorageItem(storage, STORAGE_KEYS.likes)).toBeNull();
  });
});

describe("withLegacyFallback", () => {
  it("writes only the new key", () => {
    const { data, storage } = memoryStorage();
    withLegacyFallback(storage).setItem(STORAGE_KEYS.likes, "v");
    expect([...data.keys()]).toEqual([STORAGE_KEYS.likes]);
  });
});

describe("legacyAwareJSONStorage", () => {
  it("hydrates a persisted zustand store from the legacy key and migrates it", async () => {
    const { data, storage } = memoryStorage({
      [LEGACY_LIKES]: JSON.stringify({ state: { liked: ["a", "b"] }, version: 0 }),
    });
    const useStore = create<{ liked: string[] }>()(
      persist(() => ({ liked: [] as string[] }), {
        name: STORAGE_KEYS.likes,
        storage: legacyAwareJSONStorage(() => storage),
      }),
    );
    await useStore.persist.rehydrate();
    expect(useStore.getState().liked).toEqual(["a", "b"]);

    useStore.setState({ liked: ["c"] });
    const saved = JSON.parse(data.get(STORAGE_KEYS.likes)!);
    expect(saved.state.liked).toEqual(["c"]);
    // Legacy value untouched (downgrade-safe); the new key now wins.
    expect(JSON.parse(data.get(LEGACY_LIKES)!).state.liked).toEqual(["a", "b"]);
  });
});

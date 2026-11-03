/**
 * Create feed "Made with" filter persistence (adrift.create-feed).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEYS } from "@/lib/storageKeys";
import { useCreateFeedStore } from "@/store/createFeedStore";

const KEY = STORAGE_KEYS.createFeed;

describe("createFeedStore", () => {
  beforeEach(() => {
    localStorage.removeItem(KEY);
    useCreateFeedStore.setState({ madeWith: "all" });
  });

  it("uses an adrift.* key", () => {
    expect(KEY).toBe("adrift.create-feed");
  });

  it("persists the Made with filter", () => {
    useCreateFeedStore.getState().setMadeWith("label:Upscale · Creative");
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    expect(stored.state).toEqual({ madeWith: "label:Upscale · Creative" });
  });

  it("restores the stored filter on rehydrate", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ state: { madeWith: "tools" }, version: 1 }),
    );
    await useCreateFeedStore.persist.rehydrate();
    expect(useCreateFeedStore.getState().madeWith).toBe("tools");
  });

  it("falls back to all for an invalid stored value", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ state: { madeWith: "nonsense" }, version: 1 }),
    );
    await useCreateFeedStore.persist.rehydrate();
    expect(useCreateFeedStore.getState().madeWith).toBe("all");
  });
});

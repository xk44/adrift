/**
 * Likes Store Tests
 * =================
 * Unit tests for useLikesStore (Zustand).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useLikesStore } from "@/store/likesStore";
import type { LikedImage } from "@/store/likesStore";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeImage(
  civitaiId: number,
  overrides?: Partial<LikedImage>,
): LikedImage {
  return {
    civitaiId,
    url: `https://example.com/img/${civitaiId}.jpg`,
    thumbnailUrl: `https://example.com/thumb/${civitaiId}.jpg`,
    prompt: `test prompt ${civitaiId}`,
    width: 512,
    height: 512,
    models: [{ name: "test-model", type: "Checkpoint" }],
    likedAt: new Date().toISOString(),
    ...overrides,
  };
}

// Reset store state before each test
beforeEach(() => {
  useLikesStore.setState({ likes: [] });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useLikesStore — toggleLike", () => {
  it("adds a new image to liked list", () => {
    const img = makeImage(1001);
    useLikesStore.getState().toggleLike(img);

    expect(useLikesStore.getState().likes).toHaveLength(1);
    expect(useLikesStore.getState().likes[0].civitaiId).toBe(1001);
  });

  it("removes an already-liked image on second toggle", () => {
    const img = makeImage(1002);
    useLikesStore.getState().toggleLike(img);
    useLikesStore.getState().toggleLike(img);

    expect(useLikesStore.getState().likes).toHaveLength(0);
  });

  it("sets likedAt timestamp when adding", () => {
    const before = Date.now();
    const img = makeImage(1003);
    useLikesStore.getState().toggleLike(img);
    const after = Date.now();

    const stored = useLikesStore.getState().likes[0];
    const ts = new Date(stored.likedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("leaves other images intact when removing one", () => {
    useLikesStore.getState().toggleLike(makeImage(1));
    useLikesStore.getState().toggleLike(makeImage(2));
    useLikesStore.getState().toggleLike(makeImage(3));
    // Remove middle
    useLikesStore.getState().toggleLike(makeImage(2));

    const ids = useLikesStore.getState().likes.map((l) => l.civitaiId);
    expect(ids).toContain(1);
    expect(ids).toContain(3);
    expect(ids).not.toContain(2);
  });
});

describe("useLikesStore — isLiked", () => {
  it("returns true for a liked image", () => {
    useLikesStore.getState().toggleLike(makeImage(5001));
    expect(useLikesStore.getState().isLiked(5001)).toBe(true);
  });

  it("returns false for an image that has not been liked", () => {
    expect(useLikesStore.getState().isLiked(9999)).toBe(false);
  });

  it("returns false after unliking", () => {
    const img = makeImage(5002);
    useLikesStore.getState().toggleLike(img);
    useLikesStore.getState().toggleLike(img);
    expect(useLikesStore.getState().isLiked(5002)).toBe(false);
  });
});

describe("useLikesStore — getLikedImages", () => {
  it("returns all liked images sorted newest first", () => {
    // Add images with explicit timestamps so ordering is deterministic
    useLikesStore.setState({
      likes: [
        { ...makeImage(1), likedAt: "2024-01-01T00:00:00.000Z" },
        { ...makeImage(2), likedAt: "2024-03-01T00:00:00.000Z" },
        { ...makeImage(3), likedAt: "2024-02-01T00:00:00.000Z" },
      ],
    });

    const images = useLikesStore.getState().getLikedImages();
    expect(images).toHaveLength(3);
    expect(images[0].civitaiId).toBe(2); // newest
    expect(images[1].civitaiId).toBe(3);
    expect(images[2].civitaiId).toBe(1); // oldest
  });

  it("returns empty array when nothing liked", () => {
    expect(useLikesStore.getState().getLikedImages()).toHaveLength(0);
  });
});

describe("useLikesStore — removeLike", () => {
  it("removes a specific image by civitaiId", () => {
    useLikesStore.getState().toggleLike(makeImage(7001));
    useLikesStore.getState().toggleLike(makeImage(7002));
    useLikesStore.getState().removeLike(7001);

    expect(useLikesStore.getState().isLiked(7001)).toBe(false);
    expect(useLikesStore.getState().isLiked(7002)).toBe(true);
  });

  it("is a no-op for an image that is not liked", () => {
    useLikesStore.getState().toggleLike(makeImage(8001));
    useLikesStore.getState().removeLike(9999);

    expect(useLikesStore.getState().likes).toHaveLength(1);
  });
});

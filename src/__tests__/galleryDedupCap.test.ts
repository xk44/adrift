/**
 * Gallery dedup + cap tests (Fix #1)
 * addToGallery must skip images whose runId+jobIndex already exist and cap at 1000.
 *
 * Run with: npx vitest run src/__tests__/galleryDedupCap.test.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useGenerationStore } from "@/store";
import type { GalleryImage } from "@/types";

function makeImg(
  id: string,
  runId: string,
  jobIndex: number,
  overrides?: Partial<GalleryImage>,
): GalleryImage {
  return {
    id,
    url: `https://example.com/${id}.jpg`,
    prompt: "test",
    fullPrompt: "test",
    params: [],
    paramsMap: {},
    seed: 1,
    createdAt: new Date().toISOString(),
    runId,
    jobIndex,
    width: 512,
    height: 512,
    ...overrides,
  };
}

beforeEach(() => {
  useGenerationStore.setState({ gallery: [] });
});

describe("addToGallery — dedup by runId+jobIndex", () => {
  it("adds a new image when gallery is empty", () => {
    useGenerationStore.getState().addToGallery([makeImg("a", "run1", 0)]);
    expect(useGenerationStore.getState().gallery).toHaveLength(1);
  });

  it("skips duplicate runId+jobIndex on second call", () => {
    useGenerationStore.getState().addToGallery([makeImg("a", "run1", 0)]);
    // Same runId+jobIndex, different id — should be deduped
    useGenerationStore.getState().addToGallery([makeImg("b", "run1", 0)]);
    expect(useGenerationStore.getState().gallery).toHaveLength(1);
    expect(useGenerationStore.getState().gallery[0].id).toBe("a");
  });

  it("allows different jobIndex on same runId", () => {
    useGenerationStore.getState().addToGallery([makeImg("a", "run1", 0)]);
    useGenerationStore.getState().addToGallery([makeImg("b", "run1", 1)]);
    expect(useGenerationStore.getState().gallery).toHaveLength(2);
  });

  it("allows same jobIndex on different runId", () => {
    useGenerationStore.getState().addToGallery([makeImg("a", "run1", 0)]);
    useGenerationStore.getState().addToGallery([makeImg("b", "run2", 0)]);
    expect(useGenerationStore.getState().gallery).toHaveLength(2);
  });

  it("keeps every output of a multi-image job within one batch call", () => {
    // A single job can emit several images — all must survive the first add
    const batch = [
      makeImg("a", "run1", 0),
      makeImg("a2", "run1", 0), // second output of the same job
      makeImg("b", "run1", 1),
    ];
    useGenerationStore.getState().addToGallery(batch);
    expect(useGenerationStore.getState().gallery).toHaveLength(3);
  });

  it("re-adding a multi-image job does not multiply entries", () => {
    const batch = () => [
      makeImg(`x-${Math.random()}`, "run1", 0),
      makeImg(`y-${Math.random()}`, "run1", 0),
    ];
    useGenerationStore.getState().addToGallery(batch());
    useGenerationStore.getState().addToGallery(batch());
    expect(useGenerationStore.getState().gallery).toHaveLength(2);
  });

  it("repeated WS ticks (same run, same jobs) do not multiply entries", () => {
    for (let tick = 0; tick < 5; tick++) {
      useGenerationStore
        .getState()
        .addToGallery([
          makeImg(`img-r1j0-tick${tick}`, "run1", 0),
          makeImg(`img-r1j1-tick${tick}`, "run1", 1),
        ]);
    }
    expect(useGenerationStore.getState().gallery).toHaveLength(2);
  });
});

describe("addToGallery — 1000-entry cap", () => {
  it("caps gallery at 1000 entries, dropping oldest", () => {
    // Pre-fill with 995 distinct entries
    const initial: GalleryImage[] = Array.from({ length: 995 }, (_, i) =>
      makeImg(`pre-${i}`, `run-pre-${i}`, 0),
    );
    useGenerationStore.setState({ gallery: initial });

    // Add 10 new entries
    const newImgs: GalleryImage[] = Array.from({ length: 10 }, (_, i) =>
      makeImg(`new-${i}`, `run-new-${i}`, 0),
    );
    useGenerationStore.getState().addToGallery(newImgs);

    const gallery = useGenerationStore.getState().gallery;
    expect(gallery.length).toBe(1000);
    // Newest entries are at the front
    expect(gallery[0].id).toBe("new-0");
    // Oldest entries (pre-995..999 range) are dropped
    const ids = gallery.map((g) => g.id);
    expect(ids).not.toContain("pre-990"); // was at tail, evicted
    expect(ids).not.toContain("pre-994");
  });

  it("exactly 1000 entries does not evict", () => {
    const initial: GalleryImage[] = Array.from({ length: 999 }, (_, i) =>
      makeImg(`e-${i}`, `run-e-${i}`, 0),
    );
    useGenerationStore.setState({ gallery: initial });
    useGenerationStore
      .getState()
      .addToGallery([makeImg("exact", "run-exact", 0)]);
    expect(useGenerationStore.getState().gallery).toHaveLength(1000);
    expect(useGenerationStore.getState().gallery[0].id).toBe("exact");
    expect(
      useGenerationStore.getState().gallery.find((g) => g.id === "e-0"),
    ).toBeDefined();
  });

  it("1001st entry evicts the oldest", () => {
    const initial: GalleryImage[] = Array.from({ length: 1000 }, (_, i) =>
      makeImg(`g-${i}`, `run-g-${i}`, 0),
    );
    useGenerationStore.setState({ gallery: initial });
    useGenerationStore
      .getState()
      .addToGallery([makeImg("new-one", "run-new-one", 0)]);
    const gallery = useGenerationStore.getState().gallery;
    expect(gallery).toHaveLength(1000);
    expect(gallery[0].id).toBe("new-one");
    expect(gallery.find((g) => g.id === "g-999")).toBeUndefined(); // oldest dropped
    expect(gallery.find((g) => g.id === "g-0")).toBeDefined(); // newest pre-fill kept
  });
});

import { describe, expect, it } from "vitest";

import {
  pickSourceImage,
  isComparableImage,
  pickDefaultCompareTarget,
  stepPercent,
  wipePercent,
} from "@/lib/compareSlider";
import type { GalleryImage } from "@/types";

function img(overrides: Partial<GalleryImage> = {}): GalleryImage {
  return {
    id: "id",
    url: "http://x/a.png",
    prompt: "p",
    fullPrompt: "p",
    params: [],
    paramsMap: {},
    seed: 0,
    createdAt: "2026-01-01T00:00:00Z",
    runId: "run1",
    jobIndex: 0,
    width: 512,
    height: 512,
    ...overrides,
  };
}

describe("wipePercent", () => {
  it("maps pointer x into 0..100 within the rect", () => {
    expect(wipePercent(50, 0, 100)).toBe(50);
    expect(wipePercent(0, 0, 100)).toBe(0);
    expect(wipePercent(100, 0, 100)).toBe(100);
  });
  it("clamps outside the rect", () => {
    expect(wipePercent(-20, 0, 100)).toBe(0);
    expect(wipePercent(200, 0, 100)).toBe(100);
  });
  it("accounts for rect offset", () => {
    expect(wipePercent(150, 100, 100)).toBe(50);
  });
  it("is safe on a zero-width rect", () => {
    expect(wipePercent(10, 0, 0)).toBe(50);
  });
});

describe("stepPercent", () => {
  it("nudges left/right and clamps", () => {
    expect(stepPercent(50, "ArrowRight")).toBe(55);
    expect(stepPercent(50, "ArrowLeft")).toBe(45);
    expect(stepPercent(2, "ArrowLeft")).toBe(0);
    expect(stepPercent(98, "ArrowRight")).toBe(100);
  });
  it("jumps to ends", () => {
    expect(stepPercent(50, "Home")).toBe(0);
    expect(stepPercent(50, "End")).toBe(100);
  });
  it("ignores unrelated keys", () => {
    expect(stepPercent(42, "a")).toBe(42);
  });
});

describe("isComparableImage", () => {
  it("accepts still images", () => {
    expect(isComparableImage(img())).toBe(true);
  });
  it("rejects video/audio/mesh and urlless", () => {
    expect(isComparableImage(img({ videoUrl: "v.mp4" }))).toBe(false);
    expect(isComparableImage(img({ audioUrl: "a.mp3" }))).toBe(false);
    expect(isComparableImage(img({ meshUrl: "m.glb" }))).toBe(false);
    expect(isComparableImage(img({ url: "" }))).toBe(false);
  });
});

describe("pickDefaultCompareTarget", () => {
  it("prefers a same-run sibling", () => {
    const images = [
      img({ id: "a", runId: "r1" }),
      img({ id: "b", runId: "r2" }),
      img({ id: "c", runId: "r1" }),
    ];
    // from a (index 0): b is next but different run; c is same run -> pick c
    expect(pickDefaultCompareTarget(images, 0)?.id).toBe("c");
  });
  it("falls back to the next comparable when no same-run sibling", () => {
    const images = [
      img({ id: "a", runId: "r1" }),
      img({ id: "b", runId: "r2" }),
    ];
    expect(pickDefaultCompareTarget(images, 0)?.id).toBe("b");
  });
  it("skips non-comparable candidates", () => {
    const images = [
      img({ id: "a", runId: "r1" }),
      img({ id: "b", runId: "r2", videoUrl: "v.mp4" }),
      img({ id: "c", runId: "r3" }),
    ];
    expect(pickDefaultCompareTarget(images, 0)?.id).toBe("c");
  });
  it("returns null when nothing else is comparable", () => {
    const images = [img({ id: "a" }), img({ id: "b", videoUrl: "v.mp4" })];
    expect(pickDefaultCompareTarget(images, 0)).toBeNull();
  });
});

describe("pickSourceImage", () => {
  const grid = [0, 1, 2, 3].map((j) =>
    img({ id: `src-${j}`, runId: "run-src", jobIndex: j, url: `/s${j}.png` }),
  );

  it("picks the recorded job index from a grid", () => {
    expect(pickSourceImage(grid, 2)?.id).toBe("src-2");
  });

  it("never guesses a grid tile without a job index", () => {
    expect(pickSourceImage(grid, undefined)).toBeNull();
  });

  it("uses an unambiguous single-image source without an index", () => {
    expect(pickSourceImage([grid[0]], undefined)?.id).toBe("src-0");
  });

  it("returns null when the index is missing from the run", () => {
    expect(pickSourceImage(grid, 7)).toBeNull();
  });

  it("skips videos and the current image itself", () => {
    const video = img({ id: "v", jobIndex: 0, videoUrl: "/v.mp4" });
    expect(pickSourceImage([video], 0)).toBeNull();
    expect(pickSourceImage([grid[1]], 1, "src-1")).toBeNull();
  });
});

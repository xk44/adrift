import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  formatPromptPreview,
  galleryMediaKind,
  isWallViewMode,
  localDayKey,
  matchesMediaFilter,
  moreImagesLabel,
  parseGalleryViewMode,
  relativeDateLabel,
  runTrashToggle,
  stripPromptFlags,
} from "@/lib/galleryView";

describe("galleryView", () => {
  it("parses view mode with grid fallback", () => {
    expect(parseGalleryViewMode("list")).toBe("list");
    expect(parseGalleryViewMode("thumbs")).toBe("thumbs");
    expect(parseGalleryViewMode("grid")).toBe("grid");
    expect(parseGalleryViewMode("bogus")).toBe("grid");
    expect(parseGalleryViewMode(null)).toBe("grid");
  });

  it("classifies media with tile precedence", () => {
    expect(galleryMediaKind({})).toBe("image");
    expect(galleryMediaKind({ meshUrl: "m.glb" })).toBe("3d");
    expect(galleryMediaKind({ audioUrl: "a.wav", meshUrl: "m" })).toBe("audio");
    expect(galleryMediaKind({ videoUrl: "v.mp4", audioUrl: "a" })).toBe(
      "video",
    );
    expect(matchesMediaFilter({ videoUrl: "v" }, "all")).toBe(true);
    expect(matchesMediaFilter({ videoUrl: "v" }, "video")).toBe(true);
    expect(matchesMediaFilter({ videoUrl: "v" }, "image")).toBe(false);
  });

  it("labels dates relative to now", () => {
    const now = new Date(2026, 9, 25, 9, 30);
    expect(relativeDateLabel(new Date(2026, 9, 25, 0, 1), now)).toBe("Today");
    expect(relativeDateLabel(new Date(2026, 9, 24, 23, 59), now)).toBe(
      "Yesterday",
    );
    expect(relativeDateLabel(new Date(2026, 9, 20), now)).toBe("October 20");
    expect(relativeDateLabel(new Date(2025, 11, 31), now)).toBe(
      "December 31, 2025",
    );
    expect(relativeDateLabel(new Date("nope"), now)).toBe("Earlier");
    // Month boundary.
    expect(
      relativeDateLabel(new Date(2026, 9, 31), new Date(2026, 10, 1, 8)),
    ).toBe("Yesterday");
  });

  it("builds local day keys", () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 0))).toBe("2026-01-05");
  });

  it("counts active filters", () => {
    expect(activeFilterCount({ likedOnly: false, media: "all" })).toBe(0);
    expect(activeFilterCount({ likedOnly: true, media: "video" })).toBe(2);
  });

  it("treats grid and thumbs as walls, list as rows", () => {
    expect(isWallViewMode("grid")).toBe(true);
    expect(isWallViewMode("thumbs")).toBe(true);
    expect(isWallViewMode("list")).toBe(false);
  });

  it("strips --flags from captions", () => {
    expect(stripPromptFlags("a red fox --ar 16:9 --seed 7")).toBe("a red fox");
    expect(stripPromptFlags("  a   red\nfox  ")).toBe("a red fox");
    expect(stripPromptFlags("well-lit--room")).toBe("well-lit--room");
    expect(stripPromptFlags("--ar 1:1")).toBe("--ar 1:1");
    expect(stripPromptFlags("")).toBe("");
  });

  it("labels extra run images", () => {
    expect(moreImagesLabel(1)).toBeNull();
    expect(moreImagesLabel(0)).toBeNull();
    expect(moreImagesLabel(4)).toBe("+3 more");
  });

  it("toggles run trash state", () => {
    expect(runTrashToggle([{ id: "a" }, { id: "b", hidden: true }])).toEqual({
      restoring: false,
      ids: ["a"],
    });
    expect(
      runTrashToggle([
        { id: "a", hidden: true },
        { id: "b", hidden: true },
      ]),
    ).toEqual({ restoring: true, ids: ["a", "b"] });
    expect(runTrashToggle([])).toEqual({ restoring: false, ids: [] });
  });

  it("formats prompt-bar preview", () => {
    expect(formatPromptPreview("a fox --ar 1:1", ["ar 1:1", "seed 7"])).toBe(
      "a fox · ar 1:1 · seed 7",
    );
    expect(formatPromptPreview("a fox", ["a", "b", "c"], 1)).toBe("a fox · a");
    expect(formatPromptPreview("", [])).toBe("");
  });
});

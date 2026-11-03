import { describe, expect, it } from "vitest";
import {
  addIds,
  buildSelectionIndex,
  downloadTarget,
  groupSelectionState,
  isMoodboardEligible,
  mergeIntoMoodboard,
  moveToFolderByIds,
  nextLikedValue,
  pruneToIds,
  rangeIds,
  removeIds,
  selectRange,
  selectedInOrder,
  setLikedByIds,
  toggleGroup,
  toggleId,
} from "./gallerySelection";

const ORDER = ["a", "b", "c", "d", "e"];

describe("set ops", () => {
  it("toggles without mutating the input", () => {
    const start = new Set(["a"]);
    const added = toggleId(start, "b");
    expect([...added]).toEqual(["a", "b"]);
    expect([...toggleId(added, "a")]).toEqual(["b"]);
    expect([...start]).toEqual(["a"]);
  });

  it("adds and removes many", () => {
    expect([...addIds(new Set(["a"]), ["b", "a"])]).toEqual(["a", "b"]);
    expect([...removeIds(new Set(["a", "b", "c"]), ["a", "c", "z"])]).toEqual([
      "b",
    ]);
  });
});

describe("range select", () => {
  it("spans anchor→target inclusive in either direction", () => {
    expect(rangeIds(ORDER, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeIds(ORDER, "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeIds(ORDER, "c", "c")).toEqual(["c"]);
  });

  it("falls back to the target alone without a usable anchor", () => {
    expect(rangeIds(ORDER, null, "c")).toEqual(["c"]);
    expect(rangeIds(ORDER, "gone", "c")).toEqual(["c"]);
    expect(rangeIds(ORDER, "a", "gone")).toEqual([]);
  });

  it("unions the range into the existing selection", () => {
    const next = selectRange(new Set(["e"]), ORDER, "a", "b");
    expect(selectedInOrder(next, ORDER)).toEqual(["a", "b", "e"]);
  });
});

describe("group (run/day) select", () => {
  it("reports none / some / all", () => {
    expect(groupSelectionState(new Set(), ["a", "b"])).toBe("none");
    expect(groupSelectionState(new Set(["a"]), ["a", "b"])).toBe("some");
    expect(groupSelectionState(new Set(["a", "b", "x"]), ["a", "b"])).toBe(
      "all",
    );
    expect(groupSelectionState(new Set(["a"]), [])).toBe("none");
  });

  it("fills a partial group and clears a full one, leaving others alone", () => {
    const partial = toggleGroup(new Set(["a", "x"]), ["a", "b"]);
    expect([...partial].sort()).toEqual(["a", "b", "x"]);
    const cleared = toggleGroup(partial, ["a", "b"]);
    expect([...cleared]).toEqual(["x"]);
  });
});

describe("pruneToIds", () => {
  it("returns the same set when nothing is stale", () => {
    const sel = new Set(["a", "b"]);
    expect(pruneToIds(sel, ORDER)).toBe(sel);
  });

  it("drops ids no longer in the feed", () => {
    expect([...pruneToIds(new Set(["a", "zz"]), ORDER)]).toEqual(["a"]);
  });
});

describe("buildSelectionIndex", () => {
  it("flattens day → run → tile order and indexes days", () => {
    const index = buildSelectionIndex([
      {
        date: "2026-10-25",
        rows: [
          { images: [{ id: "r1a" }, { id: "r1b" }] },
          { images: [{ id: "r2a" }] },
        ],
      },
      { date: "2026-10-24", rows: [{ images: [{ id: "r3a" }] }] },
    ]);
    expect(index.orderedIds).toEqual(["r1a", "r1b", "r2a", "r3a"]);
    expect(index.byDay.get("2026-10-25")).toEqual(["r1a", "r1b", "r2a"]);
    expect(index.byDay.get("2026-10-24")).toEqual(["r3a"]);
  });
});

describe("bulk actions", () => {
  it("unlikes only when every image is already liked", () => {
    expect(nextLikedValue([{ liked: true }, { liked: true }])).toBe(false);
    expect(nextLikedValue([{ liked: true }, { liked: false }])).toBe(true);
    expect(nextLikedValue([{}])).toBe(true);
    expect(nextLikedValue([])).toBe(true);
  });

  it("sets liked on targeted ids and keeps others by identity", () => {
    const gallery = [
      { id: "a", liked: false },
      { id: "b", liked: true },
      { id: "c" },
    ];
    const next = setLikedByIds(gallery, new Set(["a", "b"]), true);
    expect(next.map((g) => g.liked)).toEqual([true, true, undefined]);
    expect(next[1]).toBe(gallery[1]);
    expect(next[2]).toBe(gallery[2]);
  });

  it("moves into exactly one folder", () => {
    const gallery = [
      { id: "a", folderIds: ["f1", "f2"] },
      { id: "b" },
      { id: "c", folderIds: ["f3"] },
    ];
    const next = moveToFolderByIds(gallery, new Set(["a", "b"]), "f3");
    expect(next[0].folderIds).toEqual(["f3"]);
    expect(next[1].folderIds).toEqual(["f3"]);
    expect(next[2]).toBe(gallery[2]);
  });

  it("builds download names per media kind", () => {
    const base = { id: "x", url: "/img.png", seed: 42 };
    expect(downloadTarget(base)).toEqual({
      href: "/img.png",
      filename: "Adrift_create_42_v1.png",
    });
    expect(downloadTarget({ ...base, videoUrl: "/v" })?.filename).toBe(
      "Adrift_create_42_v1.mp4",
    );
    expect(
      downloadTarget({ ...base, audioUrl: "/view?filename=s.mp3" })?.filename,
    ).toBe("Adrift_create_42_v1.mp3");
    expect(downloadTarget({ ...base, meshUrl: "/m" })?.filename).toBe(
      "Adrift_create_42_v1.glb",
    );
    expect(downloadTarget({ ...base, url: "" })).toBeNull();
  });

  it("names downloads Adrift_<tool>_<seed>_v<N> from the run", () => {
    const img = {
      id: "x",
      url: "/api/comfy/image?filename=a_00001_.webp&subfolder=&type=output",
      seed: 7,
      jobIndex: 2,
      paramsMap: { tool_id: "upscale" },
    };
    expect(downloadTarget(img)?.filename).toBe("Adrift_upscale_7_v3.webp");
    expect(
      downloadTarget({
        ...img,
        videoUrl: "/api/comfy/image?filename=v.webm",
        paramsMap: { action_provenance: { kind: "action", id: "animate_auto" } },
      })?.filename,
    ).toBe("Adrift_animate-auto_7_v3.webm");
  });

  it("only treats still images as moodboard material", () => {
    expect(isMoodboardEligible({ url: "/a.png" })).toBe(true);
    expect(isMoodboardEligible({ url: "/a.png", videoUrl: "/v" })).toBe(false);
    expect(isMoodboardEligible({ url: "" })).toBe(false);
  });
});

describe("mergeIntoMoodboard", () => {
  it("appends new urls, skips duplicates, and respects the cap", () => {
    const current = [{ url: "/1", weight: 1 }];
    const result = mergeIntoMoodboard(
      current,
      [
        { url: "/1", prompt: "dup" },
        { url: "/2", prompt: "two" },
        { url: "/2", prompt: "two again" },
        { url: "/3", prompt: "" },
        { url: "/4", prompt: "overflow" },
      ],
      3,
    );
    expect(result.images).toEqual([
      { url: "/1", weight: 1 },
      { url: "/2", weight: 1, prompt: "two" },
      { url: "/3", weight: 1 },
    ]);
    expect(result).toMatchObject({ added: 2, duplicates: 2, overflow: 1 });
    expect(current).toHaveLength(1);
  });
});

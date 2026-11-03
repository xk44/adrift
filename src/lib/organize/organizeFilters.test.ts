import { describe, it, expect, vi } from "vitest";
import {
  ASPECT_OPTIONS,
  EMPTY_ORGANIZE_FILTERS,
  MEDIA_OPTIONS,
  STATUS_OPTIONS,
  countActiveFilters,
  createOrganizeFilter,
  describeActiveFilters,
  filtersKey,
  getAspectBucket,
  getDateThreshold,
  getMediaKind,
  matchesStatus,
  toggleFacet,
  type OrganizeFilterableImage,
  type OrganizeFilters,
} from "./organizeFilters";

const NOW = new Date("2026-10-25T12:00:00");

function img(o: Partial<OrganizeFilterableImage> & { id: string }) {
  return {
    width: 1024,
    height: 1024,
    createdAt: NOW.toISOString(),
    ...o,
  };
}

const GALLERY = [
  img({ id: "sq-liked", liked: true }),
  img({ id: "portrait", width: 832, height: 1216 }),
  img({ id: "landscape-vid", width: 1280, height: 720, videoUrl: "/v.mp4" }),
  img({ id: "hidden", hidden: true }),
  img({ id: "audio", audioUrl: "/a.wav", width: 0, height: 0 }),
  img({ id: "mesh", meshUrl: "/m.glb" }),
  img({ id: "old", createdAt: "2026-08-01T00:00:00Z", liked: true }),
];

function run(filters: Partial<OrganizeFilters>): string[] {
  const pred = createOrganizeFilter<(typeof GALLERY)[number]>(
    { ...EMPTY_ORGANIZE_FILTERS, ...filters },
    NOW,
  );
  return GALLERY.filter(pred).map((i) => i.id);
}

describe("getAspectBucket", () => {
  it("buckets by width/height ratio", () => {
    expect(getAspectBucket({ width: 1024, height: 1024 })).toBe("square");
    expect(getAspectBucket({ width: 832, height: 1216 })).toBe("portrait");
    expect(getAspectBucket({ width: 1280, height: 720 })).toBe("landscape");
  });

  it("treats near-square sizes (within 10%) as square", () => {
    expect(getAspectBucket({ width: 1100, height: 1000 })).toBe("square");
    expect(getAspectBucket({ width: 1000, height: 1100 })).toBe("square");
    expect(getAspectBucket({ width: 1200, height: 1000 })).toBe("landscape");
  });

  it("returns null for missing or invalid dimensions", () => {
    expect(getAspectBucket({})).toBeNull();
    expect(getAspectBucket({ width: 0, height: 0 })).toBeNull();
    expect(getAspectBucket({ width: 100, height: Number.NaN })).toBeNull();
    expect(getAspectBucket({ width: -5, height: 10 })).toBeNull();
  });
});

describe("getMediaKind / matchesStatus", () => {
  it("classifies media by attached urls", () => {
    expect(getMediaKind({})).toBe("images");
    expect(getMediaKind({ videoUrl: "x" })).toBe("videos");
    expect(getMediaKind({ audioUrl: "x" })).toBe("audio");
    expect(getMediaKind({ meshUrl: "x" })).toBe("3d");
  });

  it("liked / unrated / hidden", () => {
    expect(matchesStatus({ liked: true }, "liked")).toBe(true);
    expect(matchesStatus({ liked: true }, "unrated")).toBe(false);
    expect(matchesStatus({}, "unrated")).toBe(true);
    expect(matchesStatus({ hidden: true }, "hidden")).toBe(true);
    expect(matchesStatus({}, "hidden")).toBe(false);
  });
});

describe("createOrganizeFilter", () => {
  it("empty filters pass everything (hidden included, as before)", () => {
    expect(run({})).toEqual(GALLERY.map((i) => i.id));
  });

  it("ORs values within a facet", () => {
    expect(run({ media: ["videos", "audio"] })).toEqual([
      "landscape-vid",
      "audio",
    ]);
    expect(run({ status: ["liked", "hidden"] })).toEqual([
      "sq-liked",
      "hidden",
      "old",
    ]);
  });

  it("ANDs across facets", () => {
    expect(run({ status: ["liked"], aspect: ["square"] })).toEqual([
      "sq-liked",
      "old",
    ]);
    expect(run({ status: ["unrated"], media: ["images"] })).toEqual([
      "portrait",
      "hidden",
    ]);
  });

  it("aspect filter excludes items without usable dimensions", () => {
    expect(run({ aspect: ["square", "portrait", "landscape"] })).not.toContain(
      "audio",
    );
    expect(run({ aspect: ["portrait"] })).toEqual(["portrait"]);
  });

  it("applies the Created range", () => {
    expect(run({ date: "30days" })).not.toContain("old");
    expect(run({ date: "today" })).toHaveLength(GALLERY.length - 1);
  });

  it("drops undated or unparseable items when a range is active", () => {
    const pred = createOrganizeFilter<OrganizeFilterableImage>(
      { ...EMPTY_ORGANIZE_FILTERS, date: "7days" },
      NOW,
    );
    expect(pred({ createdAt: undefined })).toBe(false);
    expect(pred({ createdAt: "not a date" })).toBe(false);
  });
});

describe("getDateThreshold", () => {
  it("returns null for all time and start-of-day for today", () => {
    expect(getDateThreshold("all", NOW)).toBeNull();
    const today = getDateThreshold("today", NOW)!;
    expect(today.getHours()).toBe(0);
    expect(today.getDate()).toBe(NOW.getDate());
  });

  it("subtracts 7 / 30 days", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(
      Math.round(
        (NOW.getTime() - getDateThreshold("7days", NOW)!.getTime()) / day,
      ),
    ).toBe(7);
    expect(
      Math.round(
        (NOW.getTime() - getDateThreshold("30days", NOW)!.getTime()) / day,
      ),
    ).toBe(30);
  });
});

describe("toggleFacet", () => {
  it("adds and removes, keeping option order", () => {
    let sel = toggleFacet([], "audio", MEDIA_OPTIONS);
    sel = toggleFacet(sel, "images", MEDIA_OPTIONS);
    expect(sel).toEqual(["images", "audio"]);
    expect(toggleFacet(sel, "audio", MEDIA_OPTIONS)).toEqual(["images"]);
  });

  it("does not mutate its input", () => {
    const sel = ["liked"] as const;
    toggleFacet(sel, "hidden", STATUS_OPTIONS);
    expect(sel).toEqual(["liked"]);
  });
});

describe("countActiveFilters / filtersKey", () => {
  it("counts each chip plus non-default date and sort", () => {
    expect(countActiveFilters(EMPTY_ORGANIZE_FILTERS)).toBe(0);
    expect(
      countActiveFilters(
        {
          status: ["liked"],
          media: ["images", "videos"],
          aspect: ["square"],
          date: "7days",
        },
        "oldest",
      ),
    ).toBe(6);
  });

  it("filtersKey changes when any facet changes", () => {
    const a = filtersKey(EMPTY_ORGANIZE_FILTERS);
    const b = filtersKey({ ...EMPTY_ORGANIZE_FILTERS, aspect: ["portrait"] });
    const c = filtersKey({ ...EMPTY_ORGANIZE_FILTERS, date: "today" });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("describeActiveFilters", () => {
  it("lists removable chips in facet order and removes only the target", () => {
    const filters: OrganizeFilters = {
      status: ["unrated"],
      media: ["videos"],
      aspect: ASPECT_OPTIONS.map((o) => o.value).slice(0, 2),
      date: "today",
    };
    const setFilters = vi.fn();
    const setSort = vi.fn();
    const chips = describeActiveFilters(
      filters,
      "name-az",
      setFilters,
      setSort,
    );
    expect(chips.map((c) => c.label)).toEqual([
      "Unrated",
      "Video",
      "Portrait",
      "Square",
      "Today",
      "Name A–Z",
    ]);
    expect(new Set(chips.map((c) => c.key)).size).toBe(chips.length);

    chips[2].remove();
    expect(setFilters).toHaveBeenLastCalledWith({
      ...filters,
      aspect: ["square"],
    });
    chips[4].remove();
    expect(setFilters).toHaveBeenLastCalledWith({ ...filters, date: "all" });
    chips[5].remove();
    expect(setSort).toHaveBeenCalledWith("newest");
  });

  it("is empty for defaults", () => {
    expect(
      describeActiveFilters(EMPTY_ORGANIZE_FILTERS, "newest", vi.fn(), vi.fn()),
    ).toEqual([]);
  });
});

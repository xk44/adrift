import { describe, expect, it } from "vitest";
import {
  appendCapped,
  buildExploreImageQuery,
  civitaiThumbUrl,
  exploreOpenLabel,
  isMatureLevel,
  shouldBlurMedia,
} from "@/lib/explore/imageFeed";

describe("buildExploreImageQuery (F1 safe default)", () => {
  it("always sends nsfw=false&source=com", () => {
    const q = buildExploreImageQuery({});
    expect(q.get("nsfw")).toBe("false");
    expect(q.get("source")).toBe("com");
  });

  it("maps search/cursor/sort/period/video", () => {
    const q = buildExploreImageQuery({
      query: "  cat  ",
      cursor: "abc",
      sort: "Newest",
      period: "Week",
      video: true,
      limit: 12,
    });
    expect(q.get("q")).toBe("cat");
    expect(q.get("cursor")).toBe("abc");
    expect(q.get("sort")).toBe("Newest");
    expect(q.get("period")).toBe("Week");
    expect(q.get("type")).toBe("video");
    expect(q.get("limit")).toBe("12");
    expect(q.get("nsfw")).toBe("false");
  });

  it("omits empty optional params", () => {
    const q = buildExploreImageQuery({ query: " " });
    expect(q.has("q")).toBe(false);
    expect(q.has("cursor")).toBe(false);
    expect(q.has("period")).toBe(false);
    expect(q.has("type")).toBe(false);
  });
});

describe("mature detection", () => {
  it("reads numeric and string Civitai levels", () => {
    expect(isMatureLevel(1)).toBe(false);
    expect(isMatureLevel(2)).toBe(false);
    expect(isMatureLevel(4)).toBe(true);
    expect(isMatureLevel(16)).toBe(true);
    expect(isMatureLevel("None")).toBe(false);
    expect(isMatureLevel("Soft")).toBe(false);
    expect(isMatureLevel("Mature")).toBe(true);
    expect(isMatureLevel("X")).toBe(true);
    expect(isMatureLevel(undefined)).toBeNull();
    expect(isMatureLevel("weird")).toBeNull();
  });

  it("level wins; nsfw flag next; unrated follows the feed", () => {
    expect(shouldBlurMedia({ nsfwLevel: "None", nsfw: true })).toBe(false);
    expect(shouldBlurMedia({ nsfwLevel: 8 })).toBe(true);
    expect(shouldBlurMedia({ nsfw: true })).toBe(true);
    expect(shouldBlurMedia({})).toBe(false);
    expect(shouldBlurMedia({}, true)).toBe(true);
    expect(shouldBlurMedia(null, true)).toBe(false);
  });
});

describe("civitaiThumbUrl", () => {
  const base = "https://image.civitai.com/KEY/0000-uuid";
  it("replaces an existing options segment", () => {
    expect(civitaiThumbUrl(`${base}/original=true/1.jpeg`)).toBe(
      `${base}/width=450/1.jpeg`,
    );
    expect(civitaiThumbUrl(`${base}/width=1024,quality=90/1.jpeg`, 300)).toBe(
      `${base}/width=300/1.jpeg`,
    );
  });

  it("inserts the segment when absent", () => {
    expect(civitaiThumbUrl(`${base}/1.jpeg`)).toBe(`${base}/width=450/1.jpeg`);
  });

  it("leaves non-Civitai and malformed URLs alone", () => {
    expect(civitaiThumbUrl("https://example.com/a/b/c.jpg")).toBe(
      "https://example.com/a/b/c.jpg",
    );
    expect(civitaiThumbUrl("not a url")).toBe("not a url");
    expect(civitaiThumbUrl("")).toBe("");
    expect(civitaiThumbUrl("https://civitai.com/a/b/c")).toBe(
      "https://civitai.com/a/b/c",
    );
  });
});

describe("appendCapped", () => {
  it("dedupes by id and keeps the head at the cap", () => {
    const a = [{ id: 1 }, { id: 2 }];
    expect(appendCapped(a, [{ id: 2 }, { id: 3 }])).toEqual([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
    expect(appendCapped(a, [{ id: 3 }, { id: 4 }], 3).map((x) => x.id)).toEqual(
      [1, 2, 3],
    );
  });
});

describe("exploreOpenLabel", () => {
  it("names the card by author and prompt snippet", () => {
    expect(exploreOpenLabel("image", "alice", "a  red\nfox")).toBe(
      "Open image by alice: a red fox",
    );
    expect(exploreOpenLabel("video", null, "")).toBe("Open video");
    const long = exploreOpenLabel("image", "", "x".repeat(200));
    expect(long.length).toBeLessThan(100);
    expect(long.endsWith("…")).toBe(true);
  });
});

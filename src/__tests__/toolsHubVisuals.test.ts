import { describe, expect, it } from "vitest";
import type { HubCard } from "@/lib/tools/hub";
import { STORYBOARD_KEY } from "@/lib/tools/hub";
import { CLICK_TO_AD_KEY, SHORTS_STUDIO_KEY } from "@/lib/tools/pipelineCards";
import { PRODUCT_STUDIO_KEY } from "@/lib/tools/productStudio";
import { repeatedPreviews } from "@/lib/tools/toolPreviews";
import {
  COVER_HUES,
  COVER_PATTERNS,
  countByCategory,
  coverBackground,
  coverSpec,
  featuredCards,
  hashKey,
  isNewCard,
  patternStyle,
  readyCount,
  searchWithTool,
  spreadHueSlots,
  toolFromSearch,
} from "@/lib/tools/hubVisuals";

function card(over: Partial<HubCard> & { key: string }): HubCard {
  return {
    kind: "action",
    id: over.key,
    title: over.key,
    subtitle: "",
    icon: "Sparkles",
    hubCategory: "Image",
    available: true,
    unavailableReason: null,
    licenseNote: null,
    checking: false,
    model: null,
    nc: false,
    aliases: [],
    ...over,
  } as HubCard;
}

const hueDist = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

describe("coverSpec", () => {
  it("is deterministic per key", () => {
    const c = card({ key: "action:upscale", hubCategory: "Enhance" });
    expect(coverSpec(c)).toEqual(coverSpec({ ...c }));
    expect(hashKey("a")).toBe(hashKey("a"));
    expect(hashKey("a")).not.toBe(hashKey("b"));
  });

  it("keeps hues inside the palette and in range", () => {
    for (let i = 0; i < 200; i++) {
      const s = coverSpec(card({ key: `k${i}` }));
      const near = Math.min(...COVER_HUES.map((h) => hueDist(s.hue, h)));
      expect(near).toBeLessThanOrEqual(6);
      const swing = hueDist(s.hue, s.hue2);
      expect(swing).toBeGreaterThanOrEqual(14);
      expect(swing).toBeLessThanOrEqual(35);
      expect(s.hue).toBeGreaterThanOrEqual(0);
      expect(s.hue).toBeLessThan(360);
      expect(COVER_PATTERNS).toContain(s.pattern);
      expect(s.x).toBeGreaterThanOrEqual(18);
      expect(s.x).toBeLessThan(82);
    }
  });

  it("varies hue across sibling cards and honours an explicit slot", () => {
    const hues = new Set(
      Array.from({ length: 30 }, (_, i) =>
        Math.round(coverSpec(card({ key: `s${i}` })).hue / 30),
      ),
    );
    expect(hues.size).toBeGreaterThan(4);
    const c = card({ key: "slot-test" });
    expect(hueDist(coverSpec(c, 0).hue, COVER_HUES[0])).toBeLessThanOrEqual(6);
  });

  it("spreadHueSlots never repeats a slot within the window", () => {
    const keys = Array.from({ length: 40 }, (_, i) => `row:${i}`);
    const slots = spreadHueSlots(keys, 4);
    const seq = keys.map((k) => slots.get(k)!);
    for (let i = 0; i < seq.length; i++) {
      expect(seq.slice(Math.max(0, i - 4), i)).not.toContain(seq[i]);
    }
  });

  it("uses more than one pattern across cards", () => {
    const seen = new Set(
      Array.from(
        { length: 60 },
        (_, i) => coverSpec(card({ key: `t${i}` })).pattern,
      ),
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  it("renders CSS for background + every pattern", () => {
    const bg = coverBackground(coverSpec(card({ key: "x" })));
    expect(bg).toMatch(/^radial-gradient\(/);
    expect(bg).toContain("linear-gradient(");
    for (const p of COVER_PATTERNS) {
      const s = patternStyle(p);
      expect(s.backgroundImage).toContain("gradient(");
      expect(s.backgroundSize).toBeTruthy();
    }
  });
});

describe("hub lists", () => {
  const cards = [
    card({ key: "a", hubCategory: "Image" }),
    card({ key: STORYBOARD_KEY, hubCategory: "Ads" }),
    card({ key: "b", hubCategory: "Video", available: false }),
    card({ key: PRODUCT_STUDIO_KEY, hubCategory: "Ads" }),
    card({ key: "c", kind: "placeholder", hubCategory: "Audio" }),
  ];

  it("featuredCards follows FEATURED_KEYS order and skips missing", () => {
    expect(featuredCards(cards).map((c) => c.key)).toEqual([
      PRODUCT_STUDIO_KEY,
    ]);
    const more = [
      card({ key: "action:ltx_cinemagraph", hubCategory: "Video" }),
      card({ key: CLICK_TO_AD_KEY, hubCategory: "Ads" }),
      card({ key: SHORTS_STUDIO_KEY, hubCategory: "Video" }),
      ...cards,
    ];
    expect(featuredCards(more).map((c) => c.key)).toEqual([
      "action:ltx_cinemagraph",
      PRODUCT_STUDIO_KEY,
      CLICK_TO_AD_KEY,
    ]);
    // Shorts Studio left the row for the FLUX 3 Product Studio.
    expect(featuredCards(more).map((c) => c.key)).not.toContain(
      SHORTS_STUDIO_KEY,
    );
    // Storyboard has its own section; featuring it too would duplicate it.
    expect(featuredCards(cards).map((c) => c.key)).not.toContain(
      STORYBOARD_KEY,
    );
  });

  it("countByCategory zero-fills every section", () => {
    const n = countByCategory(cards);
    expect(n.all).toBe(5);
    expect(n.Ads).toBe(2);
    expect(n.Image).toBe(1);
    expect(n.Edit).toBe(0);
    expect(n.Identity).toBe(0);
  });

  it("readyCount excludes unavailable and placeholders", () => {
    expect(readyCount(cards)).toBe(3);
  });

  it("flags the multi-step flows as new", () => {
    expect(isNewCard({ key: CLICK_TO_AD_KEY })).toBe(true);
    expect(isNewCard({ key: "a" })).toBe(false);
  });
});

describe("repeatedPreviews", () => {
  const manifest = {
    previews: { "a--x": {}, "a--y": {}, "a--z": {}, "a--w": {} },
  } as never;
  const subjects = { "a--x": "fox", "a--y": "fox", "a--z": "market" };

  it("keeps the first image per subject and drops later repeats", () => {
    const out = repeatedPreviews(
      ["a:x", "a:y", "a:z", "a:w", "a:none"],
      manifest,
      subjects,
    );
    expect([...out]).toEqual(["a:y"]);
  });
});

describe("?tool= deep link", () => {
  const keys = ["action:camera_move", SHORTS_STUDIO_KEY];

  it("reads only known keys", () => {
    expect(toolFromSearch("?tool=action%3Acamera_move", keys)).toBe(
      "action:camera_move",
    );
    expect(toolFromSearch("?tool=special:shorts_studio&x=1", keys)).toBe(
      SHORTS_STUDIO_KEY,
    );
    expect(toolFromSearch("?tool=nope", keys)).toBeNull();
    expect(toolFromSearch("", keys)).toBeNull();
  });

  it("sets, replaces and clears the param, keeping others", () => {
    expect(searchWithTool("", "action:x")).toBe("?tool=action%3Ax");
    expect(searchWithTool("?a=1&tool=old", "new")).toBe("?a=1&tool=new");
    expect(searchWithTool("?a=1&tool=old", null)).toBe("?a=1");
    expect(searchWithTool("?tool=old", null)).toBe("");
  });

  it("round-trips", () => {
    expect(
      toolFromSearch(searchWithTool("?a=1", SHORTS_STUDIO_KEY), keys),
    ).toBe(SHORTS_STUDIO_KEY);
  });
});

import { describe, expect, it } from "vitest";
import {
  libraryViewForId,
  navParamsForView,
  MAX_BLEND,
  STYLE_NAV_KEYS,
  catalogQuery,
  creatorStateForNav,
  filterSavedCodes,
  isStylesNav,
  matchesName,
  navForView,
  sectionVisible,
  seedFromCodes,
  seedFromLora,
  styleCardTitle,
  stylesHubTabForNav,
  toggleBlend,
  viewForNav,
  viewForTab,
  withSrefCodes,
} from "@/lib/stylesHub";
import {
  generateStyleCodeFromImages,
  newStyleSession,
} from "@/components/style/useStyleSessions";
import { buildPathname, parsePathname } from "@/lib/routeMapper";

describe("Styles page nav mapping", () => {
  it.each([
    ["library", "browse"],
    ["style-creator", "browse"],
    ["styles", "datasets"],
    ["style-vault", "map"],
  ] as const)("%s lands on the %s view", (nav, view) => {
    expect(isStylesNav(nav)).toBe(true);
    expect(viewForNav(nav)).toBe(view);
  });

  it("style-vault ids pick a library view; old links open Clusters", () => {
    expect(libraryViewForId(undefined)).toBe("map");
    expect(libraryViewForId("train")).toBe("train");
    expect(libraryViewForId("images")).toBe("images");
    expect(libraryViewForId("123")).toBe("clusters");
  });

  it("a persisted vault tab opens Map", () => {
    expect(viewForTab("vault")).toBe("map");
  });

  it("round-trips every view through its nav key", () => {
    for (const view of ["browse", "datasets", "map", "clusters", "images", "train"] as const) {
      const nav = navForView(view);
      const expected =
        nav === "style-vault"
          ? libraryViewForId(navParamsForView(view)?.id)
          : viewForNav(nav);
      expect(expected).toBe(view);
    }
  });

  it("keeps the legacy tab mapping", () => {
    expect(stylesHubTabForNav("library")).toBe("library");
    expect(stylesHubTabForNav("styles")).toBe("boards");
    expect(stylesHubTabForNav("style-creator")).toBe("creator");
    expect(stylesHubTabForNav("style-vault")).toBe("map");
    expect(viewForTab("creator")).toBe("browse");
    expect(viewForTab("library")).toBe("browse");
  });

  it("does not claim non-style navs", () => {
    expect(isStylesNav("create")).toBe(false);
    expect(isStylesNav("moodboards")).toBe(false);
    expect(STYLE_NAV_KEYS).toHaveLength(4);
  });

  it("opens the creator panel only for style-creator", () => {
    expect(creatorStateForNav("library", undefined)).toEqual({ open: false });
    expect(creatorStateForNav("style-vault", "abc")).toEqual({ open: false });
    expect(creatorStateForNav("style-creator", undefined)).toEqual({
      open: true,
      sessionId: null,
    });
    expect(creatorStateForNav("style-creator", "new")).toEqual({
      open: true,
      sessionId: null,
    });
    expect(creatorStateForNav("style-creator", "session-1")).toEqual({
      open: true,
      sessionId: "session-1",
    });
  });

  it("keeps the legacy deep links resolvable", () => {
    expect(parsePathname("/styles/123")?.nav).toBe("style-vault");
    expect(parsePathname("/style-creator/session-1")?.nav).toBe("style-creator");
    expect(parsePathname("/style-creator")?.nav).toBe("style-creator");
    expect(parsePathname("/library")?.nav).toBe("library");
    expect(buildPathname("style-creator", { id: "session-1" })).toBe(
      "/style-creator/session-1",
    );
  });
});

describe("Styles browse helpers", () => {
  it("titles cards with a name, never a bare numeric code", () => {
    expect(styleCardTitle("1787377")).toBe("Style 1787377");
    expect(styleCardTitle("1787377", "  ")).toBe("Style 1787377");
    expect(styleCardTitle("1787377", null)).toBe("Style 1787377");
    expect(styleCardTitle("1787377", "Ink wash")).toBe("Ink wash");
  });

  it("shows every section under All and one under a filter", () => {
    expect(sectionVisible("all", "catalog")).toBe(true);
    expect(sectionVisible("saved", "saved")).toBe(true);
    expect(sectionVisible("saved", "catalog")).toBe(false);
  });

  it("builds catalog queries for feeds, likes and search", () => {
    const feed = new URLSearchParams(
      catalogQuery("styles_hot", " ink ", 24, 24),
    );
    expect(feed.get("feed")).toBe("styles_hot");
    expect(feed.get("q")).toBe("ink");
    expect(feed.get("offset")).toBe("24");
    const liked = new URLSearchParams(catalogQuery("liked", "", 0, 12));
    expect(liked.get("liked")).toBe("true");
    expect(liked.has("feed")).toBe(false);
    expect(liked.has("q")).toBe(false);
  });

  it("sorts saved codes favorites first, then newest, and filters", () => {
    const entries = [
      { code: "111", createdAt: 1, isFavorite: false, name: "Ink wash" },
      { code: "222", createdAt: 3, isFavorite: false, tags: ["neon"] },
      { code: "333", createdAt: 2, isFavorite: true },
    ];
    expect(filterSavedCodes(entries, "").map((e) => e.code)).toEqual([
      "333",
      "222",
      "111",
    ]);
    expect(filterSavedCodes(entries, "ink").map((e) => e.code)).toEqual([
      "111",
    ]);
    expect(filterSavedCodes(entries, "NEON").map((e) => e.code)).toEqual([
      "222",
    ]);
    expect(filterSavedCodes(entries, "33").map((e) => e.code)).toEqual(["333"]);
    expect(matchesName("Style 4", "style")).toBe(true);
    expect(matchesName("Style 4", "zzz")).toBe(false);
  });

  it("toggles blend codes with a FIFO cap", () => {
    expect(toggleBlend([], "a")).toEqual(["a"]);
    expect(toggleBlend(["a", "b"], "a")).toEqual(["b"]);
    const full = ["a", "b", "c", "d"].slice(0, MAX_BLEND);
    expect(toggleBlend(full, "e")).toEqual([...full.slice(1), "e"]);
  });

  it("merges codes into a single --sref flag", () => {
    expect(withSrefCodes("", ["1", "2"])).toBe("--sref 1 2");
    expect(withSrefCodes("a fox --sref 1 --ar 3:2", ["2", "1"])).toBe(
      "a fox --ar 3:2 --sref 1 2",
    );
    expect(withSrefCodes("a fox", [])).toBe("a fox");
  });

  it("seeds the creator from codes and LoRAs", () => {
    expect(seedFromCodes(["7", "8"], 3)).toEqual({
      prompt: "--sref 7 8",
      imageIds: [],
      nonce: 3,
    });
    expect(seedFromLora("ink-style", 4).prompt).toBe(
      "--lora ink-style.safetensors",
    );
  });
});

describe("style sessions", () => {
  it("creates a draft session named after the prompt", () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    const session = newStyleSession(2, now, "soft pastel city", [
      "x",
      "x",
      "y",
    ]);
    expect(session.id).toBe(`session-${now.getTime()}`);
    expect(session.status).toBe("draft");
    expect(session.selectedImageIds).toEqual(["x", "y"]);
    expect(session.prompt).toBe("soft pastel city");
    expect(session.createdAt).toBe(now.toISOString());

    const blank = newStyleSession(2, now);
    expect(blank.name).toBe("Style 3");
    expect("prompt" in blank).toBe(false);
  });

  it("generates the same code for the same images in any order", () => {
    const a = { url: "/a.png", seed: 1 };
    const b = { url: "/b.png", seed: 2 };
    const code = generateStyleCodeFromImages([a, b]);
    expect(code).toMatch(/^[0-9a-f]{12}$/);
    expect(generateStyleCodeFromImages([b, a])).toBe(code);
    expect(generateStyleCodeFromImages([a])).not.toBe(code);
  });
});

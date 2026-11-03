/**
 * LTX showcase on the Tools hub: the LTX VFX section lists every LTX-2.5
 * tool (home VFX tools + cross-listed Animate, Transitions, Video Expand,
 * Motion presets), every LTX card gets the LTX chip, and the featured row
 * leads with LTX cards.
 */
import { describe, expect, it } from "vitest";
import {
  HUB_CATEGORY_NOTES,
  buildHubCards,
  filterHubCards,
  groupHubCards,
} from "@/lib/tools/hub";
import { foldEngineGroups } from "@/lib/tools/engineGroups";
import { isGridCard } from "@/lib/tools/toolRegistry";
import {
  FEATURED_KEYS,
  countByCategory,
  featuredCards,
} from "@/lib/tools/hubVisuals";
import {
  LTX_CROSS_LISTINGS,
  LTX_LISTING_PREFIX,
  LTX_SECTION_KEYS,
  isLtxCard,
  previewKey,
  withLtxListings,
} from "@/lib/tools/ltxShowcase";
import { buildToolCards } from "@/lib/tools/toolsPage";
import type { EngineContext } from "@/lib/tools/templates";

const ctx: EngineContext = {
  catalog: [],
  packIds: new Set(["ltx25", "wan22"]),
  editLoras: { families: {}, loras: [] },
};

const toolCards = buildToolCards({
  catalog: [],
  packIds: ctx.packIds,
  editLoras: null,
  modelStatus: { tools: {} },
});
const cards = buildHubCards({ toolCards, ctx });
const grid = foldEngineGroups(cards).filter((c) => isGridCard(c.key));
const pool = withLtxListings(grid, cards);

describe("LTX VFX section membership", () => {
  it("lists every LTX tool, home and cross-listed", () => {
    const [group] = groupHubCards(pool, "VFX");
    expect(group.label).toBe("LTX VFX");
    const opens = group.cards.map((c) => c.openKey ?? c.key);
    expect([...opens].sort()).toEqual([...LTX_SECTION_KEYS].sort());
    for (const key of [
      "action:ltx25_animate",
      "action:ltx25_transition",
      "action:video_expand",
      "action:ltx_restore",
      "action:wan_motion",
    ]) {
      expect(opens).toContain(key);
    }
  });

  it("cross-listed copies open the real tool and keep its license", () => {
    for (const l of LTX_CROSS_LISTINGS) {
      const copy = pool.find((c) => c.key === `${LTX_LISTING_PREFIX}${l.key}`);
      const real = cards.find((c) => c.key === l.key)!;
      expect(copy, l.key).toBeDefined();
      expect(copy!.hubCategory).toBe("VFX");
      expect(copy!.openKey).toBe(l.key);
      expect(copy!.title).toMatch(/LTX-2\.5/);
      expect(copy!.nc).toBe(real.nc);
      expect(copy!.model).toBe(real.model);
      expect(copy!.engineGroup).toBeUndefined();
      expect(previewKey(copy!)).toBe(l.key);
    }
  });

  it("home sections and buildHubCards are unchanged", () => {
    // Copies live only on the grid; the real cards stay where they were.
    expect(cards.some((c) => c.key.startsWith(LTX_LISTING_PREFIX))).toBe(false);
    expect(
      cards.find((c) => c.key === "action:video_expand")!.hubCategory,
    ).toBe("Video");
    expect(pool.length).toBe(grid.length + LTX_CROSS_LISTINGS.length);
    // The All chip counts each tool once.
    expect(countByCategory(pool).all).toBe(grid.length);
  });

  it("skips a cross-listing whose tool is missing", () => {
    const without = cards.filter((c) => c.key !== "action:video_expand");
    const keys = withLtxListings([], without).map((c) => c.openKey);
    expect(keys).not.toContain("action:video_expand");
    expect(keys).toHaveLength(LTX_CROSS_LISTINGS.length - 1);
  });

  it("searching ltx finds every LTX tool", () => {
    const opens = new Set(
      filterHubCards(pool, "ltx").map((c) => c.openKey ?? c.key),
    );
    for (const key of LTX_SECTION_KEYS) expect(opens).toContain(key);
  });

  it("section note names the core model in one line", () => {
    const note = HUB_CATEGORY_NOTES.VFX!;
    expect(note).toMatch(/LTX-2\.5 22B/);
    expect(note).toMatch(/open weights/);
    expect(note).toMatch(/synced audio/);
    expect(note).not.toMatch(/\n/);
  });
});

describe("LTX chip and featured row", () => {
  it("every LTX VFX card and every LTX-2.5 card elsewhere gets the chip", () => {
    for (const c of groupHubCards(pool, "VFX")[0].cards) {
      expect(isLtxCard(c), c.key).toBe(true);
    }
    const expand = cards.find((c) => c.key === "action:video_expand")!;
    expect(isLtxCard(expand)).toBe(true);
    // Legacy LTX-Video and non-LTX tools do not.
    expect(isLtxCard({ hubCategory: "Video", model: "LTX-Video" })).toBe(false);
    expect(isLtxCard({ hubCategory: "Video", model: "MiniMax H3" })).toBe(
      false,
    );
  });

  it("leads with 2+ LTX cards so they fill the first row at 1512px", () => {
    const featured = featuredCards(pool);
    expect(featured.length).toBe(FEATURED_KEYS.length);
    // 5 cards fit one row at minmax(220px) on a 1512px window; the first
    // two (also the first on the phone strip) are LTX.
    expect(featured.length).toBeLessThanOrEqual(5);
    expect(featured.slice(0, 2).every(isLtxCard)).toBe(true);
    expect(featured.filter(isLtxCard).length).toBeGreaterThanOrEqual(2);
  });
});

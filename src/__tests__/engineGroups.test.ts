import { describe, it, expect } from "vitest";
import { getEditTools, toPublicTool } from "@/lib/tools/editTools";
import { buildToolCards } from "@/lib/tools/toolsPage";
import { HUB_CATEGORIES, buildHubCards, type HubCard } from "@/lib/tools/hub";
import { isGridCard } from "@/lib/tools/toolRegistry";
import { toolFromSearch } from "@/lib/tools/hubVisuals";
import {
  ENGINE_GROUPS,
  defaultEngineKey,
  engineGroupOf,
  engineOptions,
  foldEngineGroups,
  licenseRank,
} from "@/lib/tools/engineGroups";
import { BEST_ORDER, badgeRank } from "@/lib/tools/licenseBadges";
import { weightsClass, weightsTooltip } from "@/lib/tools/openWeights";

function hubCards(ready: (id: string) => boolean = () => true): HubCard[] {
  const catalog = getEditTools().map((t) =>
    toPublicTool(t, {
      installed: ready(t.id),
      packAvailable: ready(t.id),
      available: ready(t.id),
      missingNodes: [],
    } as never),
  ) as never;
  const ctx = { catalog, packIds: new Set(["flux3", "qwen-image-21", "fibo2", "krea2", "ltx25", "h3"]), editLoras: null } as never;
  return buildHubCards({
    toolCards: buildToolCards({ ...(ctx as object), modelStatus: null } as never),
    ctx,
    modelStatus: null,
  });
}

describe("engine groups", () => {
  const cards = hubCards();
  const keys = new Set(cards.map((c) => c.key));

  it("every member is a real hub card and belongs to one group", () => {
    const seen = new Set<string>();
    for (const g of ENGINE_GROUPS) {
      expect(g.variants.map((v) => v.key)).toContain(g.primary);
      for (const v of g.variants) {
        expect(keys.has(v.key), v.key).toBe(true);
        expect(seen.has(v.key), v.key).toBe(false);
        seen.add(v.key);
      }
    }
  });

  it("the grid shows one card per group, under the primary key", () => {
    const grid = foldEngineGroups(cards).filter((c) => isGridCard(c.key));
    for (const g of ENGINE_GROUPS) {
      const shown = grid.filter((c) => engineGroupOf(c.key) === g);
      expect(shown.map((c) => c.key)).toEqual([g.primary]);
      expect(shown[0].title).toBe(g.title);
      expect(shown[0].engineGroup).toBe(g.id);
    }
    const members = ENGINE_GROUPS.reduce((n, g) => n + g.variants.length - 1, 0);
    expect(grid.length).toBe(cards.filter((c) => isGridCard(c.key)).length);
    expect(members).toBeGreaterThan(0);
  });

  it("old member ids still deep-link to that engine's card", () => {
    for (const g of ENGINE_GROUPS)
      for (const v of g.variants)
        expect(toolFromSearch(`?tool=${encodeURIComponent(v.key)}`, keys)).toBe(
          v.key,
        );
  });

  it("the merged card opens the first ready engine in preference order", () => {
    const edit = ENGINE_GROUPS.find((g) => g.id === "edit")!;
    expect(defaultEngineKey(edit, cards)).toBe(edit.variants[0].key);
    const noKrea = hubCards((id) => !id.startsWith("krea2"));
    const folded = foldEngineGroups(noKrea).find((c) => c.key === edit.primary)!;
    expect(folded.openKey).toBe("action:edit_flux3");
    expect(folded.available).toBe(true);
  });

  it("an engine missing its pack shows a setup reason in the picker only", () => {
    const g = ENGINE_GROUPS.find((x) => x.id === "face_swap")!;
    const cs = hubCards((id) => id !== "krea2-head-swap");
    const opts = engineOptions(g, cs);
    const krea = opts.find((o) => o.key === "catalog:krea2-head-swap")!;
    expect(krea.available).toBe(false);
    expect(krea.reason).toBeTruthy();
    const card = foldEngineGroups(cs).find((c) => c.key === g.primary)!;
    expect(card.available).toBe(true);
    expect(card.unavailableReason).toBeNull();
    expect(card.openKey).toBe("catalog:qwen21-head-swap");
  });

  it("license badge is the most permissive engine's", () => {
    for (const card of foldEngineGroups(cards)) {
      const g = card.engineGroup && ENGINE_GROUPS.find((x) => x.id === card.engineGroup);
      if (!g) continue;
      const ranks = engineOptions(g, cards).map((o) => badgeRank(o.badge));
      expect(licenseRank(card), g.id).toBe(Math.min(...ranks));
      expect(weightsClass(card), g.id).toBe(
        engineOptions(g, cards).map((o) => o.badge).sort((a, b) => badgeRank(a) - badgeRank(b))[0],
      );
    }
    expect(BEST_ORDER).toEqual(["open", "cap", "nc", "region", "check"]);
  });

  it("merged cards: Restore shows Revenue cap (FLUX.3), Face swap Revenue cap (Krea 2 BFS)", () => {
    const folded = foldEngineGroups(cards);
    const restore = folded.find((c) => c.engineGroup === "restore")!;
    expect(weightsClass(restore)).toBe("cap");
    expect(weightsTooltip(restore)).toMatch(/US\$5M/);
    const face = folded.find((c) => c.engineGroup === "face_swap")!;
    expect(weightsClass(face)).toBe("cap");
    expect(weightsTooltip(face)).toMatch(/US\$1M/);
    const opts = engineOptions(ENGINE_GROUPS.find((g) => g.id === "face_swap")!, cards);
    expect(Object.fromEntries(opts.map((o) => [o.key, o.badge]))).toEqual({
      "catalog:krea2-head-swap": "cap",
      "catalog:qwen21-head-swap": "nc",
    });
    for (const c of folded) expect(weightsTooltip(c)).not.toMatch(/unverified/i);
  });
});

describe("Apps split into job categories", () => {
  it("no card lands in the retired Apps chip and buckets stay sized", () => {
    const grid = foldEngineGroups(hubCards()).filter((c) => isGridCard(c.key));
    expect(HUB_CATEGORIES as readonly string[]).not.toContain("Apps");
    for (const cat of ["Ads", "Portraits", "Characters", "Styles", "Scenes"] as const) {
      const n = grid.filter((c) => c.hubCategory === cat).length;
      expect(n, cat).toBeGreaterThanOrEqual(8);
      expect(n, cat).toBeLessThanOrEqual(40);
    }
    expect(grid.every((c) => HUB_CATEGORIES.includes(c.hubCategory))).toBe(true);
  });
});

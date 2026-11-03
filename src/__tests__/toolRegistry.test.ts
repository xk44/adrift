import { describe, it, expect } from "vitest";
import {
  ACTION_TOOLS,
  CATEGORY_ORDER,
  buildToolCards,
  getActionTool,
} from "@/lib/tools/toolsPage";
import {
  ACTION_HUB,
  CATALOG_HUB,
  HUB_CATEGORIES,
  buildHubCards,
} from "@/lib/tools/hub";
import {
  CARD_KEY_ALIASES,
  isGridCard,
  mediaVariants,
  resolveCardKey,
} from "@/lib/tools/toolRegistry";
import { toolFromSearch } from "@/lib/tools/hubVisuals";
import { buildLightboxTools } from "@/lib/ui/lightboxTools";
import { toolTitle } from "@/lib/tools/toolNames";

const cards = () =>
  buildHubCards({
    toolCards: buildToolCards({ catalog: [], packIds: null, editLoras: null }),
    ctx: { catalog: [], packIds: null, editLoras: null },
  });

describe("CATEGORY_ORDER follows the hub order", () => {
  it("maps every category to a hub section in HUB_CATEGORIES order", () => {
    const hubOf = (c: string) => ACTION_HUB[c] ?? CATALOG_HUB[c];
    const ranks = CATEGORY_ORDER.map((c) => {
      const hub = hubOf(c);
      expect(hub, c).toBeDefined();
      return HUB_CATEGORIES.indexOf(hub!);
    });
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("covers every mapped category", () => {
    for (const c of [...Object.keys(ACTION_HUB), ...Object.keys(CATALOG_HUB)])
      expect(CATEGORY_ORDER).toContain(c);
  });
});

describe("hidden tools", () => {
  it("legacy single-pass 3D and the CrossView stub are not offered", () => {
    const keys = cards().map((c) => c.key);
    expect(keys).not.toContain("action:make_3d");
    expect(keys).not.toContain("action:crossview");
    expect(keys).toContain("action:make_3d_trellis");
    const lb = buildLightboxTools().map((t) => t.key);
    expect(lb).not.toContain("action:make_3d");
    expect(lb).not.toContain("action:crossview");
    expect(lb).not.toContain("inline:3d");
    expect(lb).toContain("action:make_3d_trellis");
  });

  it("hidden specs still resolve for old runs", () => {
    expect(getActionTool("make_3d")?.hidden).toBe(true);
    expect(getActionTool("crossview")?.hidden).toBe(true);
  });

  it("no user-facing tool text names TripoSR", () => {
    const text = JSON.stringify([
      ACTION_TOOLS.map((t) => [t.title, t.subtitle]),
      cards().map((c) => [c.title, c.subtitle, c.model, c.aliases]),
      buildLightboxTools().map((t) => [t.title, t.subtitle, t.aliases]),
      toolTitle("action:make_3d"),
    ]);
    expect(text).not.toMatch(/triposr/i);
  });
});

describe("card-key aliases", () => {
  it("the legacy 3D card resolves to Trellis", () => {
    expect(resolveCardKey("action:make_3d")).toBe("action:make_3d_trellis");
    expect(resolveCardKey("action:upscale")).toBe("action:upscale");
    for (const target of Object.values(CARD_KEY_ALIASES))
      expect(cards().map((c) => c.key)).toContain(target);
  });

  it("old ?tool= links open the replacement", () => {
    const keys = cards().map((c) => c.key);
    expect(toolFromSearch("?tool=action:make_3d", keys)).toBe(
      "action:make_3d_trellis",
    );
    expect(toolFromSearch("?tool=nope", keys)).toBeNull();
  });
});

describe("SeedVR2 is one grid card", () => {
  it("photo and video upscale are variants of one capability", () => {
    const v = mediaVariants("upscale_video")!;
    expect(v.map((x) => x.id)).toEqual(["upscale_seedvr2", "upscale_video"]);
    expect(mediaVariants("upscale_seedvr2")).toBe(v);
    expect(mediaVariants("upscale")).toBeNull();
    expect(getActionTool("upscale_video")?.videoInput).toBeTruthy();
    expect(getActionTool("upscale_seedvr2")?.videoInput).toBeFalsy();
  });

  it("only the primary variant shows on the grid; both stay openable", () => {
    expect(isGridCard("action:upscale_seedvr2")).toBe(true);
    expect(isGridCard("action:upscale_video")).toBe(false);
    expect(isGridCard("action:upscale")).toBe(true);
    expect(isGridCard("app:x")).toBe(true);
    const all = cards();
    const grid = all.filter((c) => isGridCard(c.key));
    const seed = grid.filter((c) => /seedvr2/i.test(c.model ?? ""));
    expect(seed.map((c) => c.key)).toEqual(["action:upscale_seedvr2"]);
    expect(all.map((c) => c.key)).toContain("action:upscale_video");
  });
});

describe("license badges", () => {
  // FLUX.3 Klein is "restricted" (FLUX Kommunity License) in MODEL_FAMILIES,
  // the license source of truth; restricted carries no nc badge
  // (licenseConsistency.test). Flip both together if that changes.
  it("FLUX.3 edit follows the license source of truth", () => {
    expect(cards().find((c) => c.key === "action:edit_flux3")?.nc).toBe(false);
  });
});

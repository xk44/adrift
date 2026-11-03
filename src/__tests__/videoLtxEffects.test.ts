/** Video editor "Effects (LTX)": action mapping and LTX window limits. */
import { describe, expect, it } from "vitest";
import { ACTION_TOOLS } from "@/lib/tools/toolsPage";
import { LTX_VFX_SPECS } from "@/lib/oj/ltxVfx";
import { buildVideoEditorTools, toolRange } from "@/lib/videoEdit/videoTools";
import {
  LTX_EFFECTS,
  ltxEffectLimit,
  ltxEffectTitle,
  ltxEffectTools,
} from "@/lib/videoEdit/ltxEffects";

const tools = buildVideoEditorTools(null);
const effects = ltxEffectTools(tools);
const byId = (id: string) => {
  const e = effects.find((x) => x.id === id);
  if (!e) throw new Error(`missing effect ${id}`);
  return e;
};

describe("LTX effects mapping", () => {
  it("maps each effect to an action tool that exists", () => {
    for (const def of LTX_EFFECTS) {
      const specId = def.toolKey.replace(/^action:/, "");
      expect(ACTION_TOOLS.some((s) => s.id === specId)).toBe(true);
    }
  });

  it("lists all five video-in effects, in order, from the editor tools", () => {
    expect(effects.map((e) => e.id)).toEqual([
      "day_to_night",
      "add_water",
      "clean_plate",
      "alpha_matte",
      "expand",
    ]);
    for (const e of effects) {
      expect(e.tool.key).toBe(e.toolKey);
      expect(e.tool.media).toContain("video");
      // Same hand-off path as the Tools panel: opened in the Tools page.
      expect(e.tool.target).toEqual({ kind: "open", toolKey: e.toolKey });
    }
  });

  it("every effect runs on the LTX-2.5 pack", () => {
    for (const def of LTX_EFFECTS) {
      const spec = ACTION_TOOLS.find((s) => `action:${s.id}` === def.toolKey);
      expect(spec?.modelCheck?.pack).toBe("ltx25");
    }
  });

  it("skips effects missing from the tool list", () => {
    const partial = tools.filter((t) => t.key !== "action:ltx_add_water");
    expect(ltxEffectTools(partial).map((e) => e.id)).not.toContain("add_water");
    expect(ltxEffectTools([])).toEqual([]);
  });

  it("does not include the image-in LTX tools", () => {
    const keys = effects.map((e) => e.toolKey);
    expect(keys).not.toContain("action:ltx_cinemagraph");
    expect(keys).not.toContain("action:ltx_slow_motion");
  });
});

describe("LTX effect limits", () => {
  it("uses each tool's own LTX window", () => {
    const d2n = LTX_VFX_SPECS.ltx_day_to_night;
    expect(ltxEffectLimit(byId("day_to_night"), 2, 24).windowSeconds).toBe(
      Math.floor((d2n.maxFrames / d2n.fps) * 1000) / 1000,
    );
    const water = LTX_VFX_SPECS.ltx_add_water;
    expect(ltxEffectLimit(byId("add_water"), 2, 24).windowSeconds).toBe(
      Math.floor((water.maxFrames / water.fps) * 1000) / 1000,
    );
    // Clean plate renders at 25 fps: 97 frames is 3.88 s, not 4.04 s.
    expect(ltxEffectLimit(byId("clean_plate"), 2, 24).windowSeconds).toBe(3.88);
  });

  it("no warning when the clip fits the window", () => {
    const lim = ltxEffectLimit(byId("day_to_night"), 3.5, 24);
    expect(lim.over).toBe(false);
    expect(lim.warning).toBeNull();
  });

  it("warns when the clip exceeds the LTX window", () => {
    const lim = ltxEffectLimit(byId("day_to_night"), 9, 24);
    expect(lim.over).toBe(true);
    expect(lim.warning).toMatch(/Day to night/);
    expect(lim.warning).toMatch(/9 s/);
    expect(lim.warning).toMatch(/LTX window is 4 s/);
  });

  it("tolerates a frame of rounding at the window edge", () => {
    const w = ltxEffectLimit(byId("alpha_matte"), 1, 24).windowSeconds!;
    expect(ltxEffectLimit(byId("alpha_matte"), w + 0.04, 24).over).toBe(false);
  });

  it("expand's window follows the clip's own fps", () => {
    const at24 = ltxEffectLimit(byId("expand"), 1, 24).windowSeconds!;
    const at30 = ltxEffectLimit(byId("expand"), 1, 30).windowSeconds!;
    expect(at30).toBeLessThan(at24);
  });

  it("the cut sent matches the window the warning names", () => {
    const e = byId("add_water");
    const lim = ltxEffectLimit(e, 12, 24);
    const part = toolRange(e.tool, 10, 22, 24);
    expect(part.end - part.start).toBeCloseTo(lim.windowSeconds!, 5);
  });

  it("title names the effect, range and window", () => {
    const t = ltxEffectTitle(byId("add_water"), "Selected clip", 8, 24);
    expect(t).toMatch(/^Add water \(LTX\) on Selected clip/);
    expect(t).toMatch(/LTX window 5 s/);
    expect(t).toMatch(/clip is 8 s/);
  });
});

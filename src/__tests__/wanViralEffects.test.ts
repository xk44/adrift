/**
 * wan_motion effect catalog integrity: ids / labels / prompts unique and
 * well formed, and the signature viral effects are all reachable under the
 * Viral section. Pure data, no graphs.
 */
import { describe, expect, it } from "vitest";
import {
  WAN_MOTION_PRESETS,
  getWanMotionPreset,
  wanMotionPrompt,
} from "@/lib/oj/wanMotionPresets";

const effects = WAN_MOTION_PRESETS.filter((p) => p.category === "effect");
const viral = effects.filter((p) => p.section === "viral");

/** Signature short-form effects the Viral group must cover (one id each). */
const SIGNATURE_VIRAL = [
  "angel_wings", // wings sprouting
  "raven_wings",
  "levitate", // levitation
  "planet_zoom_out", // earth zoom-out
  "impact_punch",
  "cartoon_punch",
  "clone_split",
  "melt",
  "inflate",
  "squish",
  "disintegrate",
  "hair_surge",
  "blast_reveal", // explosion reveal
  "spiral_zoom", // rotating zoom
  "time_freeze",
  "plush_toy", // transform into an object
  "paper_fold",
  "shrink_down",
  "age_forward",
  "gravity_flip",
  "snow_globe",
  "jelly_wobble",
  "butterfly_burst",
  "voxel_break",
  "ice_shatter",
  "toon_shift",
  "eye_dive",
  "world_tilt",
];

describe("wan_motion effect catalog", () => {
  it("ids are unique, snake_case and resolve to themselves", () => {
    const ids = WAN_MOTION_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
      expect(getWanMotionPreset(id).id).toBe(id);
    }
  });

  it("labels are unique, non-empty and case-insensitively distinct", () => {
    const labels = WAN_MOTION_PRESETS.map((p) => p.label.trim().toLowerCase());
    for (const l of labels) expect(l.length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("every effect prompt is non-empty, slots the subject and is unique", () => {
    const prompts = effects.map((p) => p.prompt.trim());
    expect(new Set(prompts).size).toBe(prompts.length);
    for (const p of effects) {
      expect(p.prompt.trim().length, p.id).toBeGreaterThan(40);
      expect(p.prompt, p.id).toContain("{s}");
      expect(p.prompt, p.id).not.toMatch(/\{(?!s\})/);
      expect(p.prompt, p.id).toMatch(/[.!]$/);
      expect(p.prompt.toLowerCase(), p.id).not.toContain(["mid", "journey"].join(""));
      expect(p.label.toLowerCase(), p.id).not.toContain("higgsfield");
    }
  });

  it("signature viral effects are all in the Viral section", () => {
    const viralIds = new Set(viral.map((p) => p.id));
    for (const id of SIGNATURE_VIRAL) expect(viralIds, id).toContain(id);
    expect(viral.length).toBeGreaterThanOrEqual(90);
  });

  it("new prompt-only viral effects render with the subject filled in", () => {
    for (const id of SIGNATURE_VIRAL) {
      const preset = getWanMotionPreset(id);
      const text = wanMotionPrompt(preset, "a red fox.");
      expect(text, id).not.toContain("{s}");
      expect(text.toLowerCase(), id).toContain("a red fox");
      expect(text, id).not.toContain("a red fox..");
      expect(text[0], id).toBe(text[0].toUpperCase());
      expect(wanMotionPrompt(preset).toLowerCase(), id).toContain(
        "the main subject",
      );
    }
  });

  it("notes, when present, are short one-liners", () => {
    for (const p of WAN_MOTION_PRESETS.filter((x) => x.note)) {
      expect(p.note!.length, p.id).toBeLessThan(120);
      expect(p.note!, p.id).not.toContain("\n");
    }
  });
});

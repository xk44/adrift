/**
 * Motion presets "Engine: Wan 2.2 / LTX-2.5": the prompt-only effects listed
 * in src/lib/oj/wanMotionLtx.ts compile to an LTX-2.5 i2v (ltx25_animate)
 * request with the preset prompt, a sound line and the recommended length;
 * everything else (and the default engine) stays on wan_motion. The LTX
 * option blocks Run while the ltx25 pack or its models are missing.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import { actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  LTX_EFFECT_FITS,
  LTX_EFFECT_PRESET_IDS,
  ltxEffectPrompt,
  ltxEffectSeconds,
  resolveWanMotionEngine,
  wanMotionLtxRequest,
} from "@/lib/oj/wanMotionLtx";
import { getWanMotionPreset } from "@/lib/oj/wanMotionPresets";
import {
  buildActionRequest,
  buildToolCards,
  defaultSettings,
  getActionTool,
  optionBlocksFor,
  pickBlock,
  pickerVisible,
  type ActionToolSpec,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import { setupHint } from "@/lib/tools/setupHint";

const spec = getActionTool("wan_motion") as ActionToolSpec;
const engine = spec.pickers!.find((p) => p.key === "engine")!;

function settings(picks: Record<string, string>, text = ""): ToolSettings {
  return { ...defaultSettings(spec), text, picks };
}

const reg = registry as unknown as {
  actions: Record<string, { template: string }>;
  templates: Record<string, { file: string }>;
};

function baseGraph(action: string): Workflow {
  const file = reg.templates[reg.actions[action].template].file;
  return JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "public/workflows", file),
      "utf-8",
    ),
  ) as Workflow;
}

const run = {
  run_id: "ltx-fx",
  prompt: "a portrait",
  width: 1280,
  height: 720,
  jobs: [
    {
      index: 0,
      images: ["/api/comfy/view?filename=still.png&subfolder=&type=input"],
    },
  ],
} as unknown as ImagineRun;

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

describe("LTX effect fits", () => {
  it("cover camera moves and VFX, incl. the first-batch effects", () => {
    expect(LTX_EFFECT_PRESET_IDS.length).toBeGreaterThanOrEqual(40);
    for (const id of [
      "impact_punch",
      "blast_reveal",
      "eye_dive",
      // camera: orbit / crane / drone / crash zoom / dolly zoom
      "orbit_360",
      "crane_up",
      "cam_fpv_dive",
      "crash_zoom_in",
      "dolly_zoom",
      // VFX: fire / explosion / disintegration / levitation
      "on_fire",
      "explode",
      "disintegrate",
      "levitate",
    ])
      expect(LTX_EFFECT_PRESET_IDS).toContain(id);
    for (const id of LTX_EFFECT_PRESET_IDS) {
      const p = getWanMotionPreset(id);
      expect(p.id).toBe(id);
      expect(["camera", "effect"]).toContain(p.category);
      const fit = LTX_EFFECT_FITS[id];
      expect(fit.sound).toMatch(/^Sound: /);
      expect(fit.seconds).toBeGreaterThanOrEqual(3);
      expect(fit.seconds).toBeLessThanOrEqual(10);
      expect(fit.why.length).toBeGreaterThan(10);
    }
  });

  it("every preset has a one-paragraph template: subject, camera, light, sound", () => {
    for (const id of LTX_EFFECT_PRESET_IDS) {
      const { template, sound } = LTX_EFFECT_FITS[id];
      expect(template, id).toContain("{s}");
      expect(template, id).not.toMatch(/\n/);
      expect(template, id).toMatch(/\bcamera\b/i);
      expect(template, id).toMatch(/light|glow|sun|flash/i);
      expect(sound, id).not.toContain("{s}");
      // LTX prompt guide: one flowing paragraph, well under 200 words.
      expect(words(`${template} ${sound}`), id).toBeLessThanOrEqual(120);
      const prompt = ltxEffectPrompt(getWanMotionPreset(id), "a red fox");
      expect(prompt.toLowerCase(), id).toContain("a red fox");
      expect(prompt, id).not.toContain("{s}");
      expect(prompt.endsWith(sound), id).toBe(true);
    }
  });

  it("templates name no real people, brands or LoRA trigger words", () => {
    for (const id of LTX_EFFECT_PRESET_IDS) {
      const { template, sound } = LTX_EFFECT_FITS[id];
      for (const text of [template, sound]) {
        // Capitals only at sentence starts (no proper nouns).
        const mid = text.match(/[^.!?:]\s+[A-Z][a-z]+/g) ?? [];
        expect(mid, id).toEqual([]);
        // No leetspeak trigger tokens (e.g. "cr34sh") from the Wan LoRAs.
        expect(text, id).not.toMatch(/[a-z]\d|\d[a-z]/i);
        expect(text, id).not.toMatch(
          /\b(higgsfield|marvel|disney|pixar|nike|apple|tesla|dji)\b/i,
        );
      }
    }
  });

  it("only resolves to LTX-2.5 when asked and the preset fits", () => {
    expect(resolveWanMotionEngine("impact_punch", "ltx25")).toBe("ltx25");
    expect(resolveWanMotionEngine("impact_punch", "wan22")).toBe("wan22");
    expect(resolveWanMotionEngine("impact_punch", undefined)).toBe("wan22");
    expect(resolveWanMotionEngine("squish", "ltx25")).toBe("wan22");
    expect(resolveWanMotionEngine("melt", "ltx25")).toBe("wan22");
    expect(wanMotionLtxRequest({ preset: "melt" })).toBeNull();
  });

  it("length: auto = recommendation, Wan length picks map to seconds", () => {
    const fit = LTX_EFFECT_FITS.eye_dive;
    expect(ltxEffectSeconds(fit, "auto")).toBe(8);
    expect(ltxEffectSeconds(fit, "")).toBe(8);
    expect(ltxEffectSeconds(fit, undefined)).toBe(8);
    expect(ltxEffectSeconds(fit, "5s")).toBe(5);
    expect(ltxEffectSeconds(fit, "3s")).toBe(3);
  });
});

describe("Motion presets engine picker", () => {
  it("defaults to Wan 2.2 and shows only for LTX-fit presets", () => {
    expect(engine.options[0].id).toBe("wan22");
    expect(engine.options.map((o) => o.id)).toEqual(["wan22", "ltx25"]);
    expect(engine.options[1].requiresTool).toBe("ltx25_animate");
    // Default preset (orbit_360) offers LTX-2.5; non-fit presets hide it.
    expect(pickerVisible(engine, spec, settings({}))).toBe(true);
    expect(pickerVisible(engine, spec, settings({ preset: "squish" }))).toBe(
      false,
    );
    for (const id of LTX_EFFECT_PRESET_IDS)
      expect(pickerVisible(engine, spec, settings({ preset: id }))).toBe(true);
  });

  it("default engine keeps the wan_motion request", () => {
    const req = buildActionRequest(
      spec,
      settings({ preset: "impact_punch" }, "Mara"),
      null,
    );
    expect(req.action).toBe("wan_motion");
    expect(req.params).toMatchObject({
      pack_id: "wan22",
      preset: "impact_punch",
      prompt: "Mara",
    });
  });

  it("a stale LTX pick on a non-fit preset stays on Wan", () => {
    const req = buildActionRequest(
      spec,
      settings({ preset: "melt", engine: "ltx25" }),
      null,
    );
    expect(req.action).toBe("wan_motion");
    expect(req.params.preset).toBe("melt");
  });

  it("LTX-2.5 compiles the preset to an ltx25_animate request", () => {
    const req = buildActionRequest(
      spec,
      settings({ preset: "impact_punch", engine: "ltx25" }, "Mara"),
      null,
    );
    expect(req.action).toBe("ltx25_animate");
    expect(req.overrides).toEqual({});
    expect(req.params).toMatchObject({
      pack_id: "ltx25",
      duration: "5",
      effect: "impact_punch",
      engine: "ltx25",
    });
    const prompt = String(req.params.prompt);
    expect(prompt.startsWith("Mara winds up and throws a powerful punch")).toBe(
      true,
    );
    expect(prompt).toContain("The camera holds a low medium shot");
    expect(prompt).toContain(LTX_EFFECT_FITS.impact_punch.sound);
    // Wan-only knobs are not sent to LTX.
    expect(req.params).not.toHaveProperty("mode");
    expect(req.params).not.toHaveProperty("resolution");
    expect(req.params).not.toHaveProperty("preset");
  });

  it("uses the recommended length on auto and the subject default", () => {
    const req = buildActionRequest(
      spec,
      settings({ preset: "eye_dive", engine: "ltx25", duration: "auto" }),
      null,
    );
    expect(req.params.duration).toBe("8");
    expect(String(req.params.prompt)).toContain("the eye of the main subject");
    const short = buildActionRequest(
      spec,
      settings({ preset: "planet_zoom_out", engine: "ltx25", duration: "3s" }),
      null,
    );
    expect(short.params.duration).toBe("3");
  });

  it("the compiled request builds an LTX-2.5 i2v graph with prompt + length", () => {
    const req = buildActionRequest(
      spec,
      settings({ preset: "eye_dive", engine: "ltx25" }, "Pip"),
      null,
    );
    const builder = actionBuilderFor(req.action)!;
    const { workflow } = builder(baseGraph(req.action), run, 0, {
      ...req.params,
      seed: 5,
    });
    const nodes = Object.values(workflow);
    const latent = nodes.find((n) => n.class_type === "EmptyLTXVLatentVideo")!;
    expect(latent.inputs.length).toBe(8 * 24 + 1);
    const audio = nodes.find((n) => n.class_type === "LTXVEmptyLatentAudio")!;
    expect(audio.inputs.frames_number).toBe(8 * 24 + 1);
    const texts = nodes
      .filter((n) => n.class_type === "CLIPTextEncode")
      .map((n) => String(n.inputs.text));
    expect(texts).toContain(String(req.params.prompt));
    const load = nodes.find((n) => n.class_type === "LoadImage")!;
    expect(load.inputs.image).toBe("still.png [input]");
  });
});

describe("LTX-2.5 engine availability", () => {
  const packs = (...ids: string[]) => new Set(ids);
  const ready = {
    tools: { wan_motion: { missing: [] }, ltx25_animate: { missing: [] } },
  };

  it("no blocks when the LTX tool is available", () => {
    expect(
      optionBlocksFor(spec, packs("wan22", "ltx25"), null, ready),
    ).toBeUndefined();
  });

  it("blocks the LTX option (not the card) when the ltx25 pack is missing", () => {
    const cards = buildToolCards({
      catalog: [],
      packIds: packs("wan22"),
      editLoras: null,
      modelStatus: ready,
    });
    const card = cards.find((c) => c.key === "action:wan_motion")!;
    expect(card.available).toBe(true);
    const block = card.optionBlocks?.engine?.ltx25;
    expect(block).toMatchObject({
      checking: false,
      model: "LTX-2.5",
      reason: "The ltx25 pack isn't installed on this server.",
    });
    expect(setupHint(block!.reason, block!.model)).toBe("Needs the ltx25 pack");

    expect(
      pickBlock(card, spec, settings({ preset: "eye_dive", engine: "ltx25" })),
    ).toBe(block);
    // Wan engine, or a preset without the engine picker: nothing blocked.
    expect(pickBlock(card, spec, settings({ preset: "eye_dive" }))).toBeNull();
    expect(
      pickBlock(card, spec, settings({ preset: "melt", engine: "ltx25" })),
    ).toBeNull();
    // Cards without requiresTool options carry no blocks.
    expect(cards.find((c) => c.key === "action:wan_camera")?.optionBlocks).toBe(
      undefined,
    );
  });

  it("missing LTX weights and pending checks block too", () => {
    const missing = optionBlocksFor(spec, packs("wan22", "ltx25"), null, {
      tools: {
        ltx25_animate: {
          missing: ["diffusion_models/ltx-2.5-22b-distilled.safetensors"],
        },
      },
    });
    expect(missing?.engine?.ltx25.reason).toMatch(/^Model not installed: /);
    expect(
      setupHint(missing!.engine.ltx25.reason, missing!.engine.ltx25.model),
    ).toBe("Needs LTX-2.5 model");
    const pending = optionBlocksFor(spec, packs("wan22", "ltx25"), null, null);
    expect(pending?.engine?.ltx25).toMatchObject({
      checking: true,
      reason: null,
    });
  });
});

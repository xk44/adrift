/**
 * object_info input options in the auto control panel, against a trimmed
 * snapshot of a real ComfyUI /object_info (fixtures/objectInfo.inputOptions.json;
 * FutureNode is a synthetic class standing in for an unknown future type).
 */
import { describe, it, expect } from "vitest";
import oi from "./fixtures/objectInfo.inputOptions.json";
import {
  parseInputSpec,
  resolveInputSpec,
  roundNumeric,
  nextControlValue,
  expandDynamicPrompt,
  hasDynamicPromptSyntax,
  stripPromptComments,
  trimObjectInfo,
  MAX_RANDOM_SEED,
  type ObjectInfoIndex,
} from "@/lib/oj/inputSpec";
import {
  applyInputSpecs,
  applyControlOverrides,
  buildControlSchema,
  collectDynamicSubmitValues,
  syncDynamicComboControls,
  type ControlSchema,
} from "@/lib/oj/workflowControlSchema";
import {
  buildSubmitOverrides,
  computeAfterGeneratePatch,
} from "@/components/workflowControls/specControls";

const INDEX = oi as unknown as ObjectInfoIndex;
const spec = (cls: string, key: string, values: Record<string, unknown> = {}) =>
  resolveInputSpec(INDEX, cls, key, values)!;

/** Deterministic rng cycling through the given values. */
const seq = (...vals: number[]) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

describe("parseInputSpec / resolveInputSpec option types", () => {
  it("tooltip", () => {
    expect(spec("KSampler", "steps").meta.tooltip).toMatch(/steps/i);
    expect(spec("CLIPTextEncode", "text").meta.tooltip).toBeTruthy();
  });

  it("advanced", () => {
    expect(spec("CLIPSetLastLayer", "stop_at_clip_layer").meta.advanced).toBe(
      true,
    );
    expect(spec("TextGenerate", "use_default_template").meta.advanced).toBe(
      true,
    );
    expect(spec("KSampler", "steps").meta.advanced).toBe(false);
  });

  it("round / step (INT and FLOAT)", () => {
    const cfg = spec("KSampler", "cfg").meta;
    expect(cfg).toMatchObject({
      type: "FLOAT",
      step: 0.1,
      round: 0.01,
      min: 0,
      max: 100,
    });
    const w = spec("EmptyLatentImage", "width").meta;
    expect(w).toMatchObject({ type: "INT", step: 8, min: 16 });
  });

  it("roundNumeric honors INT step from min and FLOAT round/step", () => {
    // width: INT step 8 from min 16
    expect(
      roundNumeric(1021, { type: "INT", min: 16, max: 16384, step: 8 }),
    ).toBe(1024);
    expect(
      roundNumeric(19, { type: "INT", min: 16, max: 16384, step: 8 }),
    ).toBe(16);
    expect(
      roundNumeric(99999, { type: "INT", min: 16, max: 16384, step: 8 }),
    ).toBe(16384);
    // cfg: FLOAT round 0.01 wins over step 0.1
    expect(
      roundNumeric(7.456, {
        type: "FLOAT",
        min: 0,
        max: 100,
        step: 0.1,
        round: 0.01,
      }),
    ).toBe(7.46);
    // FutureNode.strength: round 0.001
    expect(
      roundNumeric(0.12345, {
        type: "FLOAT",
        min: 0,
        max: 2,
        step: 0.05,
        round: 0.001,
      }),
    ).toBe(0.123);
    // denoise: no round → step 0.01
    expect(
      roundNumeric(0.123, { type: "FLOAT", min: 0, max: 1, step: 0.01 }),
    ).toBe(0.12);
    // round:false disables rounding (still clamps)
    expect(
      roundNumeric(0.123456, { type: "FLOAT", min: 0, max: 1, round: false }),
    ).toBe(0.123456);
    expect(
      roundNumeric(-1, { type: "FLOAT", min: 0, max: 1, round: false }),
    ).toBe(0);
  });

  it("control_after_generate", () => {
    const seed = spec("KSampler", "seed").meta;
    expect(seed.controlAfterGenerate).toBe(true);
    // 2^64-1 exceeds JS precision; clamp to a safe integer
    expect(seed.max).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(spec("KSampler", "steps").meta.controlAfterGenerate).toBe(false);
  });

  it("nextControlValue: fixed / increment / decrement / randomize", () => {
    const r = { min: 0, max: 10 };
    expect(nextControlValue(5, "fixed", r)).toBe(5);
    expect(nextControlValue(5, "increment", r)).toBe(6);
    expect(nextControlValue(10, "increment", r)).toBe(10);
    expect(nextControlValue(5, "decrement", r)).toBe(4);
    expect(nextControlValue(0, "decrement", r)).toBe(0);
    expect(
      nextControlValue(24, "increment", { min: 16, max: 64, step: 8 }),
    ).toBe(32);
    const rand = nextControlValue(
      5,
      "randomize",
      { min: 0, max: Number.MAX_SAFE_INTEGER },
      () => 0.999999,
    );
    expect(rand).toBeLessThanOrEqual(MAX_RANDOM_SEED);
    expect(rand).toBeGreaterThan(MAX_RANDOM_SEED * 0.99);
    expect(nextControlValue(5, "randomize", { min: 3, max: 4 }, () => 0)).toBe(
      3,
    );
  });

  it("image_upload / audio_upload / video_upload", () => {
    expect(spec("LoadImage", "image").meta.upload).toBe("image");
    expect(spec("LoadAudio", "audio").meta.upload).toBe("audio");
    expect(spec("LoadVideo", "file").meta.upload).toBe("video");
    expect(spec("LoadImageOutput", "image").meta.imageFolder).toBe("output");
  });

  it("multiline / dynamicPrompts / forceInput", () => {
    const text = spec("CLIPTextEncode", "text").meta;
    expect(text.multiline).toBe(true);
    expect(text.dynamicPrompts).toBe(true);
    expect(spec("SaveImage", "filename_prefix").meta.multiline).toBe(false);
    const sys = spec("TextGenerate", "system_prompt").meta;
    expect(sys.forceInput).toBe(true);
    expect(sys.isLink).toBe(true);
  });

  it("remote combo", () => {
    expect(spec("LoadImageOutput", "image").meta.remote).toEqual({
      route: "/internal/files/output",
      refreshButton: true,
      controlAfterRefresh: "first",
    });
  });

  it("COMBO with options and legacy list combos", () => {
    expect(spec("TextGenerate", "mtp").meta.options).toContain("auto");
    const ckpt = spec("CheckpointLoaderSimple", "ckpt_name").meta;
    expect(ckpt.type).toBe("COMBO");
    expect(ckpt.options!.length).toBeGreaterThan(0);
  });

  it("COMFY_DYNAMICCOMBO_V3: children resolve against the selected option", () => {
    const parent = spec("TextGenerate", "sampling_mode").meta;
    expect(parent.type).toBe("COMFY_DYNAMICCOMBO_V3");
    expect(parent.options).toEqual(["on", "off"]);
    expect(parent.displayName).toBe("Sampling Mode");
    const t = spec("TextGenerate", "sampling_mode.temperature", {
      sampling_mode: "on",
    });
    expect(t.dynamicParent).toBe("sampling_mode");
    expect(t.dynamicOption).toBe("on");
    expect(t.meta).toMatchObject({ type: "FLOAT", min: 0.01, max: 2 });
    // unknown child → null (degrade, not crash)
    expect(
      resolveInputSpec(INDEX, "TextGenerate", "sampling_mode.nope"),
    ).toBeNull();
  });

  it("nested dynamic combos (SaveVideo format → codec)", () => {
    const codec = spec("SaveVideo", "format.codec", { format: "mp4" });
    expect(codec.meta.type).toBe("COMFY_DYNAMICCOMBO_V3");
    expect(codec.meta.options).toContain("h264");
    expect(spec("SaveVideo", "codec").meta.hidden).toBe(true);
  });

  it("COMFY_AUTOGROW_V3: prefix and names forms", () => {
    const img = spec("BatchImagesNode", "images.image3");
    expect(img.container).toEqual({
      key: "images",
      kind: "autogrow",
      slot: "image3",
    });
    expect(img.meta.isLink).toBe(true);
    expect(
      resolveInputSpec(INDEX, "BatchImagesNode", "images.imageX"),
    ).toBeNull();
    expect(spec("StringFormat", "values.c").container?.slot).toBe("c");
    expect(resolveInputSpec(INDEX, "StringFormat", "values.z")).toBeNull();
  });

  it("COMFY_DYNAMICGROUP_V3 rows (LoadLoraModel.loras)", () => {
    const s = spec("LoadLoraModel", "loras.0.strength");
    expect(s.container).toEqual({
      key: "loras",
      kind: "dynamic_group",
      slot: "0",
    });
    expect(s.pathLabel).toBe("LoRA 1 · Strength");
    expect(spec("LoadLoraModel", "loras.1.lora_name").meta.type).toBe("COMBO");
    expect(spec("LoadLoraModel", "loras.0.enabled").meta.type).toBe("BOOLEAN");
    expect(
      resolveInputSpec(INDEX, "LoadLoraModel", "loras.0.bogus"),
    ).toBeNull();
  });

  it("unknown types degrade gracefully", () => {
    const m = spec("FutureNode", "mystery").meta;
    expect(m.unknownType).toBe(true);
    expect(m.tooltip).toBeTruthy();
    expect(() => parseInputSpec(undefined)).not.toThrow();
    expect(() => parseInputSpec([{ weird: true }])).not.toThrow();
    expect(() => parseInputSpec(["INT", "not-an-object"])).not.toThrow();
    expect(resolveInputSpec(INDEX, "NoSuchNode", "x")).toBeNull();
    expect(resolveInputSpec(null, "KSampler", "seed")).toBeNull();
  });

  it("trimObjectInfo keeps requested classes and caps lists", () => {
    const t = trimObjectInfo(INDEX, ["KSampler", "Missing"], 2);
    expect(Object.keys(t)).toEqual(["KSampler"]);
    const sampler = t.KSampler.input!.required!.sampler_name as unknown[];
    expect((sampler[0] as unknown[]).length).toBeLessThanOrEqual(2);
  });
});

describe("dynamicPrompts expansion", () => {
  it("expands choices, nested groups, and keeps escapes", () => {
    expect(expandDynamicPrompt("a {red|blue} car", seq(0))).toBe("a red car");
    expect(expandDynamicPrompt("a {red|blue} car", seq(0.99))).toBe(
      "a blue car",
    );
    expect(expandDynamicPrompt("{a|{b|c}}", seq(0.99, 0.99))).toBe("c");
    expect(expandDynamicPrompt("literal \\{x|y\\}", seq(0))).toBe(
      "literal \\{x|y\\}",
    );
    expect(expandDynamicPrompt("open { brace", seq(0))).toBe("open { brace");
  });

  it("strips comments like ComfyUI", () => {
    expect(stripPromptComments("a // note\nb /* x */ c")).toBe("a \nb  c");
  });

  it("detects syntax", () => {
    expect(hasDynamicPromptSyntax("{a|b}")).toBe(true);
    expect(hasDynamicPromptSyntax("plain")).toBe(false);
    expect(hasDynamicPromptSyntax(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Controls integration
// ---------------------------------------------------------------------------

const WORKFLOW = {
  "3": {
    class_type: "KSampler",
    inputs: {
      seed: 42,
      steps: 20,
      cfg: 7,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1,
      model: ["4", 0],
      positive: ["6", 0],
      negative: ["7", 0],
      latent_image: ["5", 0],
    },
  },
  "6": {
    class_type: "CLIPTextEncode",
    inputs: { text: "a {red|blue} fox", clip: ["4", 1] },
  },
  "8": {
    class_type: "CLIPSetLastLayer",
    inputs: { stop_at_clip_layer: -2, clip: ["4", 1] },
  },
  "9": { class_type: "LoadImage", inputs: { image: "in.png" } },
  "10": {
    class_type: "LoadImageOutput",
    inputs: { image: "out.png [output]" },
  },
  "11": {
    class_type: "TextGenerate",
    inputs: {
      prompt: "hi",
      max_length: 512,
      sampling_mode: "off",
      clip: ["4", 1],
    },
  },
  "12": { class_type: "FutureNode", inputs: { mystery: "x", strength: 1 } },
};

function controlsFor(overrides: Record<string, unknown> = {}): ControlSchema[] {
  const base = buildControlSchema(WORKFLOW as never).controls;
  return syncDynamicComboControls(
    applyInputSpecs(base, INDEX, overrides),
    INDEX,
    overrides,
  );
}
const byKey = (cs: ControlSchema[], k: string) => cs.find((c) => c.key === k);

describe("applyInputSpecs / dynamic combos", () => {
  it("maps spec metadata onto controls", () => {
    const cs = controlsFor();
    expect(byKey(cs, "3.seed")).toMatchObject({
      kind: "seed",
      controlAfterGenerate: true,
    });
    expect(byKey(cs, "3.cfg")).toMatchObject({
      round: 0.01,
      step: 0.1,
      specType: "FLOAT",
    });
    expect(byKey(cs, "3.steps")?.tooltip).toBeTruthy();
    expect(byKey(cs, "8.stop_at_clip_layer")?.advanced).toBe(true);
    expect(byKey(cs, "6.text")).toMatchObject({
      multiline: true,
      dynamicPrompts: true,
    });
    expect(byKey(cs, "9.image")).toMatchObject({
      kind: "image",
      upload: "image",
    });
    expect(byKey(cs, "10.image")?.remote?.route).toBe("/internal/files/output");
    expect(byKey(cs, "12.mystery")?.unknownType).toBe(true);
  });

  it("leaves controls untouched without an index (offline)", () => {
    const base = buildControlSchema(WORKFLOW as never).controls;
    expect(applyInputSpecs(base, null)).toBe(base);
  });

  it("synthesizes the selected option's children and drops stale ones", () => {
    const off = controlsFor();
    expect(off.some((c) => c.key.startsWith("11.sampling_mode."))).toBe(false);
    const on = controlsFor({ "11.sampling_mode": "on" });
    const temp = byKey(on, "11.sampling_mode.temperature")!;
    expect(temp).toMatchObject({
      synthesized: true,
      dynamicParent: "sampling_mode",
      dynamicOption: "on",
    });
    expect(temp.defaultValue).toBe(0.7);
    // Submit path receives synthesized children's values
    const submit = collectDynamicSubmitValues(on, { "11.sampling_mode": "on" });
    expect(submit["11.sampling_mode.temperature"]).toBe(0.7);
    expect(submit["11.sampling_mode.seed"]).toBe(0);
  });

  it("applyControlOverrides writes dotted children and prunes the old option's", () => {
    const wf = {
      "11": {
        class_type: "TextGenerate",
        inputs: {
          sampling_mode: "on",
          "sampling_mode.temperature": 0.5,
          prompt: "x",
        },
      },
    };
    const out = applyControlOverrides(wf as never, {
      "11.sampling_mode": "off",
    });
    expect(out["11"].inputs.sampling_mode).toBe("off");
    expect(out["11"].inputs["sampling_mode.temperature"]).toBeUndefined();
    const out2 = applyControlOverrides(wf as never, {
      "11.sampling_mode": "on",
      "11.sampling_mode.temperature": 0.9,
    });
    expect(out2["11"].inputs["sampling_mode.temperature"]).toBe(0.9);
  });
});

describe("per-run behavior", () => {
  it("computeAfterGeneratePatch advances only non-fixed seed controls", () => {
    const cs = controlsFor();
    expect(computeAfterGeneratePatch(cs, {}, undefined)).toEqual({});
    expect(
      computeAfterGeneratePatch(cs, {}, { "3.seed": "increment" }),
    ).toEqual({ "3.seed": 43 });
    expect(
      computeAfterGeneratePatch(cs, { "3.seed": 7 }, { "3.seed": "decrement" }),
    ).toEqual({
      "3.seed": 6,
    });
    const r = computeAfterGeneratePatch(
      cs,
      {},
      { "3.seed": "randomize" },
      () => 0.5,
    );
    expect(r["3.seed"]).toBe(Math.floor(0.5 * (MAX_RANDOM_SEED + 1)));
  });

  it("buildSubmitOverrides expands dynamic prompts without touching stored overrides", () => {
    const cs = controlsFor();
    const overrides = {};
    const out = buildSubmitOverrides(cs, overrides, () => 0);
    expect(out["6.text"]).toBe("a red fox");
    expect(overrides).toEqual({});
    const out2 = buildSubmitOverrides(cs, { "6.text": "{x|y}" }, () => 0.99);
    expect(out2["6.text"]).toBe("y");
  });
});

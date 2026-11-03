/**
 * prompt-parameter semantics for NATIVE Krea2 workflows (plain UNETLoader graphs,
 * no custom enhancer nodes): variant swaps, turbo cfg protection, hd, iw.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  injectParams,
  detectKrea2Native,
  buildImagineRuns,
} from "@/lib/oj/engine";
import type { ParseResult, Workflow, WorkflowSlots } from "@/types";

const makeKrea2Workflow = (
  unet = "krea2_turbo_bf16.safetensors",
  extra: Workflow = {},
): Workflow => ({
  "1": {
    class_type: "UNETLoader",
    inputs: { unet_name: unet, weight_dtype: "default" },
  },
  "2": {
    class_type: "CLIPLoader",
    inputs: {
      clip_name: "qwen3vl_4b_bf16.safetensors",
      type: "krea2",
      device: "default",
    },
  },
  "3": {
    class_type: "VAELoader",
    inputs: { vae_name: "qwen_image_vae.safetensors" },
  },
  "4": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["2", 0] } },
  "5": {
    class_type: "ConditioningZeroOut",
    inputs: { conditioning: ["4", 0] },
  },
  "6": {
    class_type: "EmptyLatentImage",
    inputs: { width: 1024, height: 1024, batch_size: 1 },
  },
  "7": {
    class_type: "KSampler",
    inputs: {
      model: ["1", 0],
      positive: ["4", 0],
      negative: ["5", 0],
      latent_image: ["6", 0],
      seed: 1,
      steps: 8,
      cfg: 1,
      sampler_name: "euler",
      scheduler: "simple",
      denoise: 1,
    },
  },
  "8": {
    class_type: "VAEDecode",
    inputs: { samples: ["7", 0], vae: ["3", 0] },
  },
  "9": {
    class_type: "SaveImage",
    inputs: { images: ["8", 0], filename_prefix: "t" },
  },
  ...extra,
});

const slots: WorkflowSlots = {
  ksamplerId: "7",
  posTextId: "4",
  negTextId: "4",
  latentDimsId: "6",
};

const inject = (workflow: Workflow, params: Record<string, unknown>) =>
  injectParams(workflow, slots, params, "a fox", "", 42);

const input = (wf: Workflow, id: string, name: string) =>
  (wf[id].inputs as Record<string, unknown>)[name];

afterEach(() => {
  delete process.env.COMFY_KREA2_DRAFT_UNET;
});

describe("detectKrea2Native", () => {
  it("detects turbo variant", () => {
    expect(detectKrea2Native(makeKrea2Workflow())).toEqual({
      unetNodeId: "1",
      variant: "turbo",
    });
  });

  it("detects raw variant", () => {
    expect(
      detectKrea2Native(makeKrea2Workflow("krea2_raw_bf16.safetensors"))
        ?.variant,
    ).toBe("raw");
  });

  it("returns null for non-krea2 UNETLoader and checkpoint workflows", () => {
    expect(
      detectKrea2Native(makeKrea2Workflow("flux1-dev.safetensors")),
    ).toBeNull();
    expect(
      detectKrea2Native({
        "1": {
          class_type: "CheckpointLoaderSimple",
          inputs: { ckpt_name: "sdxl.safetensors" },
        },
      }),
    ).toBeNull();
  });
});

describe("--raw / --turbo variant swaps", () => {
  it("--raw swaps turbo->raw with raw sampling defaults", () => {
    const wf = makeKrea2Workflow();
    inject(wf, { raw: true });
    expect(input(wf, "1", "unet_name")).toBe("krea2_raw_bf16.safetensors");
    expect(input(wf, "7", "steps")).toBe(28);
    expect(input(wf, "7", "cfg")).toBe(3.5);
  });

  it("--raw respects explicit --steps/--cfg", () => {
    const wf = makeKrea2Workflow();
    inject(wf, { raw: true, steps: 40, cfg: 5 });
    expect(input(wf, "1", "unet_name")).toBe("krea2_raw_bf16.safetensors");
    expect(input(wf, "7", "steps")).toBe(40);
    expect(input(wf, "7", "cfg")).toBe(5);
  });

  it("--turbo swaps raw->turbo with 8 steps and cfg 1", () => {
    const wf = makeKrea2Workflow("krea2_raw_bf16.safetensors");
    inject(wf, { turbo: true });
    expect(input(wf, "1", "unet_name")).toBe("krea2_turbo_bf16.safetensors");
    expect(input(wf, "7", "steps")).toBe(8);
    expect(input(wf, "7", "cfg")).toBe(1);
  });
});

describe("turbo guidance protection", () => {
  it("--stylize does not disturb cfg on native turbo", () => {
    const wf = makeKrea2Workflow();
    inject(wf, { stylize: 800 });
    expect(input(wf, "7", "cfg")).toBe(1);
  });

  it("--stylize still scales cfg on native raw", () => {
    const wf = makeKrea2Workflow("krea2_raw_bf16.safetensors");
    (wf["7"].inputs as Record<string, unknown>).cfg = 3.5;
    inject(wf, { stylize: 1000 });
    expect(input(wf, "7", "cfg")).not.toBe(3.5);
  });

  it("generic --turbo scheduler override is restored to simple for krea2", () => {
    const wf = makeKrea2Workflow();
    inject(wf, { turbo: true });
    expect(input(wf, "7", "scheduler")).toBe("simple");
  });

  it("explicit --cfg wins on turbo", () => {
    const wf = makeKrea2Workflow();
    inject(wf, { cfg: 2 });
    expect(input(wf, "7", "cfg")).toBe(2);
  });
});

describe("--draft checkpoint routing", () => {
  it("swaps to COMFY_KREA2_DRAFT_UNET when set", () => {
    process.env.COMFY_KREA2_DRAFT_UNET =
      "krea2_turbo_keep22_healed.safetensors";
    const wf = makeKrea2Workflow();
    inject(wf, { draft: true });
    expect(input(wf, "1", "unet_name")).toBe(
      "krea2_turbo_keep22_healed.safetensors",
    );
    expect(input(wf, "7", "steps")).toBe(8);
  });

  it("without env, --draft keeps the checkpoint (generic step reduction only)", () => {
    const wf = makeKrea2Workflow();
    inject(wf, { draft: true });
    expect(input(wf, "1", "unet_name")).toBe("krea2_turbo_bf16.safetensors");
  });
});

describe("--hd sizing", () => {
  it("scales 1024-class dims to 1280-class, multiples of 16", () => {
    const wf = makeKrea2Workflow();
    inject(wf, { hd: true });
    expect(input(wf, "6", "width")).toBe(1280);
    expect(input(wf, "6", "height")).toBe(1280);
  });

  it("keeps aspect when combined with --ar", () => {
    const wf = makeKrea2Workflow();
    inject(wf, { ar: "16:9", hd: true });
    const w = input(wf, "6", "width") as number;
    const h = input(wf, "6", "height") as number;
    expect(w).toBeGreaterThan(h);
    expect(w % 16).toBe(0);
    expect(h % 16).toBe(0);
  });
});

describe("--iw image weight", () => {
  it("maps iw to denoise when a LoadImage is present", () => {
    const wf = makeKrea2Workflow(undefined, {
      "20": { class_type: "LoadImage", inputs: { image: "in.png" } },
    });
    inject(wf, { iw: 2 });
    expect(input(wf, "7", "denoise")).toBe(0.5);
  });

  it("ignores iw for pure t2i workflows", () => {
    const wf = makeKrea2Workflow();
    inject(wf, { iw: 2 });
    expect(input(wf, "7", "denoise")).toBe(1);
  });

  it("explicit --denoise wins over --iw", () => {
    const wf = makeKrea2Workflow(undefined, {
      "20": { class_type: "LoadImage", inputs: { image: "in.png" } },
    });
    inject(wf, { iw: 2, denoise: 0.9 });
    expect(input(wf, "7", "denoise")).toBe(0.9);
  });
});

describe("--version aliases", () => {
  it("--version raw swaps like --raw", () => {
    const wf = makeKrea2Workflow();
    inject(wf, { version: "raw" });
    expect(input(wf, "1", "unet_name")).toBe("krea2_raw_bf16.safetensors");
    expect(input(wf, "7", "cfg")).toBe(3.5);
  });

  it("--version k2t swaps raw to turbo", () => {
    const wf = makeKrea2Workflow("krea2_raw_bf16.safetensors");
    inject(wf, { version: "k2t" });
    expect(input(wf, "1", "unet_name")).toBe("krea2_turbo_bf16.safetensors");
  });
});

describe("--no fallback on turbo (zeroed negative)", () => {
  const parse = (params: Record<string, unknown>): ParseResult => ({
    prompt: "a fox",
    params,
    raw: "a fox",
    warnings: [],
  }) as unknown as ParseResult;

  it("folds --no terms into the prompt on native turbo", () => {
    const runs = buildImagineRuns(parse({ no: ["snow", "trees"] }), makeKrea2Workflow());
    expect(runs[0].parsedPrompt).toBe("a fox. Without snow, trees.");
  });

  it("keeps the prompt clean on raw (real negative works there)", () => {
    const runs = buildImagineRuns(
      parse({ no: ["snow"] }),
      makeKrea2Workflow("krea2_raw_bf16.safetensors"),
    );
    expect(runs[0].parsedPrompt).toBe("a fox");
  });
});

describe("--pa prompt adherence (projector gain)", () => {
  it("injects Krea2ProjectorTuner with scaled knobs at pa 200", () => {
    const wf = makeKrea2Workflow();
    inject(wf, { pa: 200 });
    const tuner = wf["krea2_projector_pa"];
    expect(tuner?.class_type).toBe("Krea2ProjectorTuner");
    const inputs = tuner.inputs as Record<string, unknown>;
    expect(inputs.preset).toBe("custom");
    // gain = 1.0 -> knob_0 equals the base projector value
    expect(inputs.knob_0).toBeCloseTo(-0.05444, 4);
    expect(inputs.knob_7).toBeCloseTo(-1.4375, 4);
    expect(input(wf, "7", "model")).toEqual(["krea2_projector_pa", 0]);
  });

  it("pa 100 is neutral (no node injected)", () => {
    const wf = makeKrea2Workflow();
    inject(wf, { pa: 100 });
    expect(wf["krea2_projector_pa"]).toBeUndefined();
  });

});

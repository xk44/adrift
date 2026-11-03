/**
 * Ideogram 4 + Krea 2 workflow contracts.
 *
 * Ideogram 4 uses a custom-sampling graph (SamplerCustomAdvanced + DualModelGuider
 * + Ideogram4Scheduler) where seed/steps/cfg/sampler live on dedicated nodes.
 * Krea 2 uses a local ComfyUI graph with Krea-specific stylization/filter nodes.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { discoverT2ISlots } from "@/lib/oj/discovery";
import {
  cloneWorkflow,
  injectParams,
  closestApiAspect,
  resolveKrea2Variant,
  krea2PerLayerWeights,
} from "@/lib/oj/engine";
import type { Workflow } from "@/types";

const WORKFLOWS_DIR = path.join(process.cwd(), "public", "workflows");

function loadWorkflow(filename: string): Workflow {
  return JSON.parse(
    fs.readFileSync(path.join(WORKFLOWS_DIR, filename), "utf-8"),
  ) as Workflow;
}

describe("ideogram4_t2i.json — custom-sampling slot discovery", () => {
  const workflow = loadWorkflow("ideogram4_t2i.json");
  const slots = discoverT2ISlots(workflow);

  it("finds SamplerCustomAdvanced as the main sampler (not KSamplerSelect)", () => {
    expect(workflow[slots.ksamplerId].class_type).toBe("SamplerCustomAdvanced");
  });

  it("discovers custom-sampling sub-slots", () => {
    expect(slots.customSampling).toBeDefined();
    const cs = slots.customSampling!;
    expect(workflow[cs.noiseId!].class_type).toBe("RandomNoise");
    expect(workflow[cs.samplerSelectId!].class_type).toBe("KSamplerSelect");
    expect(workflow[cs.sigmasId!].class_type).toBe("Ideogram4Scheduler");
    expect(workflow[cs.guiderId!].class_type).toBe("DualModelGuider");
  });

  it("resolves prompt text through the guider to CLIPTextEncode", () => {
    expect(workflow[slots.posTextId].class_type).toBe("CLIPTextEncode");
  });

  it("shares one encoder between positive and negative (ConditioningZeroOut)", () => {
    expect(slots.negTextId).toBe(slots.posTextId);
  });

  it("finds the Flux2 latent node", () => {
    expect(workflow[slots.latentDimsId].class_type).toBe(
      "EmptyFlux2LatentImage",
    );
  });
});

describe("ideogram4_t2i.json — param injection", () => {
  const base = loadWorkflow("ideogram4_t2i.json");
  const slots = discoverT2ISlots(base);

  function inject(params: Record<string, unknown>): Workflow {
    const wf = cloneWorkflow(base);
    injectParams(wf, slots, params, "a red fox", "blurry", 1234);
    return wf;
  }

  it("routes seed to RandomNoise.noise_seed", () => {
    const wf = inject({});
    expect(wf[slots.customSampling!.noiseId!].inputs.noise_seed).toBe(1234);
    // No stray `seed` input on SamplerCustomAdvanced
    expect(wf[slots.ksamplerId].inputs.seed).toBeUndefined();
  });

  it("routes steps to the Ideogram4Scheduler", () => {
    const wf = inject({ steps: 48 });
    expect(wf[slots.customSampling!.sigmasId!].inputs.steps).toBe(48);
    expect(wf[slots.ksamplerId].inputs.steps).toBeUndefined();
  });

  it("routes cfg to the DualModelGuider", () => {
    const wf = inject({ cfg: 5 });
    expect(wf[slots.customSampling!.guiderId!].inputs.cfg).toBe(5);
    expect(wf[slots.ksamplerId].inputs.cfg).toBeUndefined();
  });

  it("routes sampler to KSamplerSelect.sampler_name", () => {
    const wf = inject({ sampler: "res_multistep" });
    expect(wf[slots.customSampling!.samplerSelectId!].inputs.sampler_name).toBe(
      "res_multistep",
    );
  });

  it("keeps the dedicated sigma scheduler when --scheduler is passed", () => {
    const wf = inject({ scheduler: "karras" });
    expect(wf[slots.ksamplerId].inputs.scheduler).toBeUndefined();
  });

  it("applies aspect ratio to both latent and resolution-aware scheduler", () => {
    const wf = inject({ ar: "16:9" });
    const latent = wf[slots.latentDimsId].inputs;
    const sched = wf[slots.customSampling!.sigmasId!].inputs;
    expect(latent.width).toBeGreaterThan(latent.height as number);
    expect(sched.width).toBe(latent.width);
    expect(sched.height).toBe(latent.height);
  });

  it("does not overwrite the shared encoder with the negative prompt", () => {
    const wf = inject({});
    expect(wf[slots.posTextId].inputs.text).toBe("a red fox");
  });

  it("turbo lowers steps without swapping the sigma scheduler", () => {
    const wf = inject({ turbo: true });
    expect(wf[slots.customSampling!.sigmasId!].inputs.steps).toBe(12);
    expect(wf[slots.ksamplerId].inputs.scheduler).toBeUndefined();
  });
});

describe("krea2_t2i.json — local ComfyUI graph contracts", () => {
  const base = loadWorkflow("krea2_t2i.json");
  const slots = discoverT2ISlots(base);

  function inject(params: Record<string, unknown>): Workflow {
    const wf = cloneWorkflow(base);
    injectParams(wf, slots, params, "a neon city", "", 42);
    return wf;
  }

  it("discovers the standard sampler/text/latent slots", () => {
    expect(slots.apiPromptNodeId).toBeUndefined();
    expect(base[slots.ksamplerId].class_type).toBe("KSampler");
    expect(base[slots.posTextId].class_type).toBe("CLIPTextEncode");
    expect(base[slots.negTextId].class_type).toBe("CLIPTextEncode");
    expect(base[slots.latentDimsId].class_type).toBe("EmptySD3LatentImage");
  });

  it("implements the validated Krea 2 node chain", () => {
    expect(base["1"].class_type).toBe("UNETLoader");
    expect(base["1"].inputs.unet_name).toBe("krea2_turbo_fp8_scaled.safetensors");
    expect(base["2"]).toBeUndefined();
    expect(base["3"].inputs.model).toEqual(["1", 0]);
    expect(base["3"].class_type).toBe("ComfyUI-Krea2T-Enhancer");
    expect(base["4"].class_type).toBe("CLIPLoader");
    expect(base["4"].inputs.type).toBe("krea2");
    // ApplyKrea2NegPiP (node 5) removed 2026-07-06: the node pack was never
    // sourceable; consumers rewired to the raw loaders. --no folds into the
    // prompt on turbo instead.
    expect(base["5"]).toBeUndefined();
    expect(base["7"].class_type).toBe("ConditioningKrea2Rebalance");
    expect(base["10"].inputs.scheduler).toBe("simple");
    expect(base["11"].inputs.vae_name).toBe("qwen_image_vae.safetensors");
  });

  it("injects the prompt into the positive encoder", () => {
    const wf = inject({});
    expect(wf[slots.posTextId].inputs.text).toBe("a neon city");
  });

  it("injects seed, steps, cfg, and dimensions into local nodes", () => {
    const wf = inject({ steps: 12, cfg: 0.5, ar: "4:3" });
    expect(wf[slots.ksamplerId].inputs.seed).toBe(42);
    expect(wf[slots.ksamplerId].inputs.steps).toBe(12);
    expect(wf[slots.ksamplerId].inputs.cfg).toBe(0.5);
    expect(wf[slots.latentDimsId].inputs.width).toBeGreaterThan(
      wf[slots.latentDimsId].inputs.height as number,
    );
  });

  it("keeps Krea stylize off CFG and maps it to enhancer/rebalance", () => {
    const wf = inject({ stylize: 500, minimalism_maximalism: 1 });
    expect(wf[slots.ksamplerId].inputs.cfg).toBe(1);
    expect(wf["3"].inputs.strength).toBe(0.5);
    expect(wf["7"].inputs.per_layer_weights).toBe(
      krea2PerLayerWeights(0.5, 1),
    );
  });

  it("injects the seed", () => {
    const wf = inject({});
    expect(wf[slots.ksamplerId].inputs.seed).toBe(42);
  });
});

describe("closestApiAspect", () => {
  it.each([
    ["1:1", "1:1"],
    ["16:9", "16:9"],
    ["9:16", "9:16"],
    ["21:9", "2.35:1"],
    ["3:4", "4:5"],
    ["5:4", "4:3"],
    ["nonsense", "1:1"],
  ])("%s → %s", (input, expected) => {
    expect(closestApiAspect(input)).toBe(expected);
  });
});

describe("resolveKrea2Variant", () => {
  it("resolves known aliases case-insensitively", () => {
    expect(resolveKrea2Variant("Krea-2-Medium-Turbo")).toBe(
      "Krea 2 Medium Turbo",
    );
    expect(resolveKrea2Variant("krea 2 large")).toBe("Krea 2 Large");
  });
  it("returns undefined for non-Krea models", () => {
    expect(resolveKrea2Variant("sdxl_base")).toBeUndefined();
  });
});

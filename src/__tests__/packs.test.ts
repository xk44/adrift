/**
 * Tests for workflow packs and model-aware workflow resolution.
 *
 * Covers:
 *   - Pack registration and retrieval
 *   - Model family detection from checkpoint names
 *   - Workflow resolution chain: user override → pack workflow → registry default → fallback
 *   - Default overrides merging
 *   - Adapter config selection per model family
 */

import { describe, expect, it } from "vitest";
import {
  getPack,
  getDefaultPack,
  getAllPacks,
  detectModelFamily,
  getPackForModelFamily,
  getPackForCheckpoint,
  resolveWorkflow,
  getEffectiveDefaults,
  getAdapterConfig,
  getLoraLoaderClass,
  type ResolveWorkflowOptions,
} from "@/lib/oj/packs";

// ---------------------------------------------------------------------------
// Pack registry basics
// ---------------------------------------------------------------------------

describe("pack registry", () => {
  it("has a default Krea 2 pack", () => {
    const pack = getDefaultPack();
    expect(pack.id).toBe("krea2");
    expect(pack.isDefault).toBe(true);
    expect(pack.modelFamily).toBe("krea2");
    expect(getPack("sdxl")!.isDefault).toBe(false);
  });

  it("gets a pack by id", () => {
    const sdxl = getPack("sdxl");
    expect(sdxl).toBeDefined();
    expect(sdxl!.name).toBe("Stable Diffusion XL");

    const flux = getPack("flux");
    expect(flux).toBeDefined();
    expect(flux!.name).toBe("Flux");
  });

  it("returns undefined for unknown pack id", () => {
    expect(getPack("nonexistent")).toBeUndefined();
  });

  it("lists all registered packs", () => {
    const packs = getAllPacks();
    expect(packs.length).toBeGreaterThanOrEqual(2);
    const ids = packs.map((p) => p.id);
    expect(ids).toContain("sdxl");
    expect(ids).toContain("flux");
  });
});

// ---------------------------------------------------------------------------
// Model family detection
// ---------------------------------------------------------------------------

describe("model family detection", () => {
  it("detects SDXL from checkpoint names", () => {
    expect(detectModelFamily("sd_xl_base_1.0.safetensors")).toBe("sdxl");
    expect(detectModelFamily("SDXL-Refiner.safetensors")).toBe("sdxl");
    expect(detectModelFamily("juggernautXL_v8.safetensors")).toBe("sdxl");
  });

  it("detects Flux from checkpoint names", () => {
    expect(detectModelFamily("flux1-dev-fp16.safetensors")).toBe("flux");
    expect(detectModelFamily("FLUX.1-schnell.safetensors")).toBe("flux");
  });

  it("detects LTXV and Wan video models from filenames", () => {
    expect(detectModelFamily("ltx-video-2b-v0.9.5.safetensors")).toBe("ltxv");
    expect(detectModelFamily("wan2.2_ti2v_5B_fp16.safetensors")).toBe("wan");
    expect(detectModelFamily("wan2.1_t2v_1.3B_fp16.safetensors")).toBe("wan");
  });

  it("treats unknown named checkpoints as sdxl, no model as the default pack", () => {
    expect(detectModelFamily("some_random_model.safetensors")).toBe("sdxl");
    expect(detectModelFamily("")).toBe("krea2");
  });

  it("detects from registry model type as fallback", () => {
    // "pony" is in registry.models but has no pack — still returns "pony"
    expect(detectModelFamily("pony_diffusion_v6.safetensors")).toBe("pony");
  });
});

// ---------------------------------------------------------------------------
// Pack-for-model-family
// ---------------------------------------------------------------------------

describe("getPackForModelFamily", () => {
  it("returns the correct pack for known families", () => {
    expect(getPackForModelFamily("sdxl").id).toBe("sdxl");
    expect(getPackForModelFamily("flux").id).toBe("flux");
  });

  it("returns default pack for unknown families", () => {
    expect(getPackForModelFamily("unknown_model")).toBe(getDefaultPack());
  });
});

describe("getPackForCheckpoint", () => {
  it("returns SDXL pack for SDXL checkpoints", () => {
    expect(getPackForCheckpoint("sd_xl_base_1.0.safetensors").id).toBe("sdxl");
  });

  it("returns Flux pack for Flux checkpoints", () => {
    expect(getPackForCheckpoint("flux1-dev.safetensors").id).toBe("flux");
  });

  it("returns video packs for LTXV and Wan checkpoints", () => {
    expect(getPackForCheckpoint("ltx-video-2b-v0.9.5.safetensors").id).toBe(
      "ltxv",
    );
    expect(getPackForCheckpoint("wan2.2_ti2v_5B_fp16.safetensors").id).toBe(
      "wan",
    );
  });

  it("returns default pack for unknown checkpoints", () => {
    expect(getPackForCheckpoint("unknown_model.safetensors").id).toBe("sdxl");
  });
});

// ---------------------------------------------------------------------------
// Workflow resolution chain
// ---------------------------------------------------------------------------

describe("resolveWorkflow", () => {
  it("returns user override path with highest priority", () => {
    const result = resolveWorkflow({
      templateOrAction: "t2i",
      userWorkflowPath: "saved:my-custom-workflow.json",
    });
    expect(result.workflowPath).toBe("saved:my-custom-workflow.json");
    expect(result.source).toBe("user_override");
  });

  it("returns selected workflow path as second priority", () => {
    const result = resolveWorkflow({
      templateOrAction: "t2i",
      selectedWorkflowPath: "saved:selected-workflow.json",
    });
    expect(result.workflowPath).toBe("saved:selected-workflow.json");
    expect(result.source).toBe("selected_workflow");
  });

  it("prefers user override over selected workflow", () => {
    const result = resolveWorkflow({
      templateOrAction: "t2i",
      userWorkflowPath: "saved:override.json",
      selectedWorkflowPath: "saved:selected.json",
    });
    expect(result.workflowPath).toBe("saved:override.json");
    expect(result.source).toBe("user_override");
  });

  it("resolves pack-specific workflow for SDXL vary_subtle", () => {
    const result = resolveWorkflow({
      templateOrAction: "vary_subtle",
      modelFamily: "sdxl",
    });
    expect(result.workflowPath).toBe("vary_subtle.json");
    expect(result.source).toBe("pack_workflow");
    expect(result.pack!.id).toBe("sdxl");
  });

  it("resolves pack-specific workflow for SDXL inpaint", () => {
    const result = resolveWorkflow({
      templateOrAction: "inpaint",
      modelFamily: "sdxl",
    });
    expect(result.workflowPath).toBe("inpaint.json");
    expect(result.source).toBe("pack_workflow");
  });

  it("falls back to registry default when pack has no workflow for an action", () => {
    // Flux pack only has t2i; asking for "inpaint" should fall to registry
    const result = resolveWorkflow({
      templateOrAction: "inpaint",
      modelFamily: "flux",
    });
    // Flux pack doesn't define inpaint, so registry default (inpaint.json)
    expect(result.source).toBe("registry_default");
    expect(result.workflowPath).toBe("inpaint.json");
    expect(result.pack!.id).toBe("flux");
  });

  it("resolves Flux t2i from the Flux pack", () => {
    const result = resolveWorkflow({
      templateOrAction: "t2i",
      modelFamily: "flux",
    });
    expect(result.workflowPath).toBe("t2i.json");
    expect(result.source).toBe("pack_workflow");
    expect(result.pack!.id).toBe("flux");
  });

  it("falls to generic fallback for unknown template", () => {
    const result = resolveWorkflow({
      templateOrAction: "nonexistent_action",
    });
    expect(result.source).toBe("generic_fallback");
    expect(result.workflowPath).toBe("t2i.json");
  });

  it("resolves through the default pack for known template without pack match", () => {
    const result = resolveWorkflow({
      templateOrAction: "upscale_subtle",
    });
    expect(result.source).toBe("pack_workflow");
    expect(result.pack!.id).toBe("krea2");
    expect(result.workflowPath).toBe("upscale_subtle.json");
  });

  it("uses explicit packId to select pack", () => {
    const result = resolveWorkflow({
      templateOrAction: "t2i",
      packId: "flux",
    });
    expect(result.workflowPath).toBe("t2i.json");
    expect(result.pack!.id).toBe("flux");
  });

  it("uses checkpoint name to detect model family", () => {
    const result = resolveWorkflow({
      templateOrAction: "t2i",
      checkpointName: "flux1-dev.safetensors",
    });
    expect(result.workflowPath).toBe("t2i.json");
    expect(result.pack!.id).toBe("flux");
  });

  it("resolves pack-specific video workflows for LTXV and Wan", () => {
    const ltxv = resolveWorkflow({
      templateOrAction: "t2v",
      checkpointName: "ltx-video-2b-v0.9.5.safetensors",
    });
    expect(ltxv.workflowPath).toBe("packs/ltxv/t2v.json");
    expect(ltxv.source).toBe("pack_workflow");

    const wan = resolveWorkflow({
      templateOrAction: "i2v",
      checkpointName: "wan2.2_ti2v_5B_fp16.safetensors",
    });
    expect(wan.workflowPath).toBe("packs/wan/i2v.json");
    expect(wan.source).toBe("pack_workflow");
  });

  it("uses LTXV's distilled graph only for --turbo and preserves Wan's normal graph", () => {
    const ltxvTurbo = resolveWorkflow({
      templateOrAction: "i2v",
      checkpointName: "ltx-video-2b-v0.9.5.safetensors",
      turbo: true,
    });
    expect(ltxvTurbo.workflowPath).toBe("packs/ltxv/i2v_fast.json");

    const ltxvNormal = resolveWorkflow({
      templateOrAction: "t2v",
      checkpointName: "ltx-video-2b-v0.9.5.safetensors",
      turbo: false,
    });
    expect(ltxvNormal.workflowPath).toBe("packs/ltxv/t2v.json");

    const wanTurbo = resolveWorkflow({
      templateOrAction: "i2v",
      checkpointName: "wan2.2_ti2v_5B_fp16.safetensors",
      turbo: true,
    });
    expect(wanTurbo.workflowPath).toBe("packs/wan/i2v.json");
  });

  it("resolves SDXL t2i from pack when SDXL model family", () => {
    const result = resolveWorkflow({
      templateOrAction: "t2i",
      checkpointName: "juggernautXL_v8.safetensors",
    });
    expect(result.workflowPath).toBe("t2i.json");
    expect(result.pack!.id).toBe("sdxl");
  });

  it("packId takes precedence over checkpointName and modelFamily", () => {
    const result = resolveWorkflow({
      templateOrAction: "t2i",
      packId: "flux",
      checkpointName: "juggernautXL_v8.safetensors",
      modelFamily: "sdxl",
    });
    expect(result.pack!.id).toBe("flux");
    expect(result.workflowPath).toBe("t2i.json");
  });

  it("modelFamily takes precedence over checkpointName when packId is absent", () => {
    const result = resolveWorkflow({
      templateOrAction: "t2i",
      modelFamily: "flux",
      checkpointName: "juggernautXL_v8.safetensors",
    });
    expect(result.pack!.id).toBe("flux");
  });

  it("resolves full priority chain: user > selected > pack > registry > fallback", () => {
    // All 5 levels should work correctly
    const user = resolveWorkflow({
      templateOrAction: "t2i",
      userWorkflowPath: "saved:mine.json",
      selectedWorkflowPath: "saved:theirs.json",
      modelFamily: "sdxl",
    });
    expect(user.source).toBe("user_override");

    const selected = resolveWorkflow({
      templateOrAction: "t2i",
      selectedWorkflowPath: "saved:theirs.json",
      modelFamily: "sdxl",
    });
    expect(selected.source).toBe("selected_workflow");

    const pack = resolveWorkflow({
      templateOrAction: "t2i",
      modelFamily: "sdxl",
    });
    expect(pack.source).toBe("pack_workflow");

    const registry = resolveWorkflow({
      templateOrAction: "t2i",
      modelFamily: "flux",
      // flux pack has t2i so this will be pack_workflow;
      // to test registry fallback, use an action flux doesn't cover
    });
    const registryFallback = resolveWorkflow({
      templateOrAction: "upscale_subtle",
      modelFamily: "flux",
    });
    expect(registryFallback.source).toBe("registry_default");

    const generic = resolveWorkflow({
      templateOrAction: "nonexistent",
    });
    expect(generic.source).toBe("generic_fallback");
  });
});

// ---------------------------------------------------------------------------
// Default overrides merging
// ---------------------------------------------------------------------------

describe("getEffectiveDefaults", () => {
  it("merges registry defaults with SDXL pack defaults", () => {
    const defaults = getEffectiveDefaults("sdxl");
    // SDXL pack overrides cfg to 7.0 and steps to 25
    expect(defaults.cfg).toBe(7.0);
    expect(defaults.steps).toBe(25);
    // Width/height come from registry
    expect(defaults.width).toBe(1024);
    expect(defaults.height).toBe(1024);
  });

  it("merges registry defaults with Flux pack defaults", () => {
    const defaults = getEffectiveDefaults("flux");
    // Flux pack overrides cfg to 3.5 and steps to 20
    expect(defaults.cfg).toBe(3.5);
    expect(defaults.steps).toBe(20);
  });

  it("allows explicit overrides on top of merged defaults", () => {
    const defaults = getEffectiveDefaults("sdxl", { steps: 30, cfg: 9 });
    expect(defaults.steps).toBe(30);
    expect(defaults.cfg).toBe(9);
    // Other values should still come from pack/registry
    expect(defaults.sampler).toBe("euler");
  });

  it("uses default pack when modelFamily is not provided", () => {
    const defaults = getEffectiveDefaults();
    expect(defaults.cfg).toBe(1.0); // Krea 2 default
  });

  it("falls back to default pack for unknown model family", () => {
    const defaults = getEffectiveDefaults("unknown");
    // Falls back to the Krea 2 pack
    expect(defaults.cfg).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Adapter config
// ---------------------------------------------------------------------------

describe("getAdapterConfig", () => {
  it("returns the Krea 2 adapter config by default", () => {
    const config = getAdapterConfig();
    expect(config.loraLoaderClass).toBe("LoraLoaderModelOnly");
    expect(config.samplerClass).toBe("KSampler");
    expect(config.latentClass).toBe("EmptySD3LatentImage");
    expect(config.supportsNegativePrompt).toBe(true);
  });

  it("returns the SDXL adapter config for sdxl", () => {
    const config = getAdapterConfig("sdxl");
    expect(config.loraLoaderClass).toBe("LoraLoader");
    expect(config.latentClass).toBe("EmptySDXLLatentImage");
  });

  it("returns Flux adapter config for Flux family", () => {
    const config = getAdapterConfig("flux");
    expect(config.loraLoaderClass).toBe("LoraLoaderModelOnly");
    expect(config.samplerClass).toBe("FluxSampler");
    expect(config.latentClass).toBe("EmptyLatentImageFlux");
    expect(config.supportsNegativePrompt).toBe(false);
  });
});

describe("getLoraLoaderClass", () => {
  it("returns LoraLoader for SDXL", () => {
    expect(getLoraLoaderClass("sdxl")).toBe("LoraLoader");
  });

  it("returns LoraLoaderModelOnly for Flux", () => {
    expect(getLoraLoaderClass("flux")).toBe("LoraLoaderModelOnly");
  });

  it("defaults to the Krea 2 loader", () => {
    expect(getLoraLoaderClass()).toBe("LoraLoaderModelOnly");
  });
});

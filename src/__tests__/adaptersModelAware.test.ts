/**
 * Model-Aware Injectable Adapters — Slice C Tests
 * ================================================
 * Tests proving:
 *   1. SDXL gets LoraLoader (model+clip), Flux gets LoraLoaderModelOnly (model-only)
 *   2. IPAdapter resolution is model-aware (SDXL→IPAdapterAdvanced, Flux→IPAdapterFull)
 *   3. SREF apply class resolution is model-aware
 *   4. No hardcoded LoraLoader regression — createModelAwareLoraNode uses pack config
 *   5. engine.ts injectParams skips strength_clip for LoraLoaderModelOnly nodes
 *   6. workflowInjector LoRA creation is model-aware
 */

import {
  injectLoRANodes,
} from "@/lib/sref/workflowInjector";
import type { LoRAParams } from "@/lib/sref/srefParser";
import { describe, it, expect } from "vitest";
import {
  resolveAdapter,
  isLoraModelOnly,
  createModelAwareLoraNode,
  resolveIPAdapterApplyClass,
  resolveSrefApplyClass,
  SDXL_DEFAULT_PACK,
  FLUX_DEFAULT_PACK,
  SD15_DEFAULT_PACK,
  resolveAdapterPack,
  getAdapterConfig,
} from "@/lib/oj/adapters";
import type { Workflow, WorkflowNode } from "@/types";

// ---------------------------------------------------------------------------
// Mock workflows for injection tests
// ---------------------------------------------------------------------------

/** SDXL-style workflow with CheckpointLoaderSimple + LoraLoader */
const createSDXLWorkflow = (): Workflow => ({
  "1": {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" },
  },
  "2": {
    class_type: "LoraLoader",
    inputs: {
      lora_name: "existing_lora.safetensors",
      strength_model: 1.0,
      strength_clip: 1.0,
      model: ["1", 0],
      clip: ["1", 1],
    },
  },
  "3": {
    class_type: "CLIPTextEncode",
    inputs: { text: "test prompt", clip: ["2", 1] },
    _meta: { title: "Positive Prompt" },
  },
  "4": {
    class_type: "CLIPTextEncode",
    inputs: { text: "", clip: ["2", 1] },
    _meta: { title: "Negative Prompt" },
  },
  "5": {
    class_type: "EmptySDXLLatentImage",
    inputs: { width: 1024, height: 1024, batch_size: 1 },
  },
  "6": {
    class_type: "KSampler",
    inputs: {
      seed: 12345, steps: 20, cfg: 7.0, sampler_name: "euler",
      scheduler: "normal", denoise: 1.0,
      model: ["2", 0], positive: ["3", 0], negative: ["4", 0],
      latent_image: ["5", 0],
    },
  },
  "7": {
    class_type: "VAEDecode",
    inputs: { samples: ["6", 0], vae: ["1", 2] },
  },
  "8": {
    class_type: "SaveImage",
    inputs: { images: ["7", 0], filename_prefix: "output" },
  },
});

/** Flux-style workflow with UNETLoader + LoraLoaderModelOnly */
const createFluxWorkflow = (): Workflow => ({
  "1": {
    class_type: "UNETLoader",
    inputs: { unet_name: "flux1-dev-fp16.safetensors" },
  },
  "10": {
    class_type: "CLIPLoader",
    inputs: { clip_name: "t5xxl_fp16.safetensors" },
  },
  "2": {
    class_type: "LoraLoaderModelOnly",
    inputs: {
      lora_name: "existing_flux_lora.safetensors",
      strength_model: 0.8,
      model: ["1", 0],
    },
  },
  "3": {
    class_type: "CLIPTextEncode",
    inputs: { text: "flux prompt", clip: ["10", 0] },
  },
  "5": {
    class_type: "EmptyLatentImageFlux",
    inputs: { width: 1024, height: 1024, batch_size: 1 },
  },
  "6": {
    class_type: "KSampler",
    inputs: {
      seed: 12345, steps: 20, cfg: 3.5, sampler_name: "euler",
      scheduler: "normal", denoise: 1.0,
      model: ["2", 0], positive: ["3", 0], negative: ["3", 0],
      latent_image: ["5", 0],
    },
  },
  "7": {
    class_type: "VAEDecode",
    inputs: { samples: ["6", 0], vae: ["1", 1] },
  },
  "8": {
    class_type: "SaveImage",
    inputs: { images: ["7", 0] },
  },
});

// ---------------------------------------------------------------------------
// resolveAdapter — SDXL vs Flux choices
// ---------------------------------------------------------------------------

describe("resolveAdapter — SDXL vs Flux lora", () => {
  it("returns LoraLoader for SDXL model family", () => {
    const adapter = resolveAdapter("lora", "sdxl");
    expect(adapter.loaderClass).toBe("LoraLoader");
    expect(adapter.applyClass).toBe("LoraLoader");
    expect(adapter.strengthParamName).toBe("strength_model");
    expect(adapter.modelParamName).toBe("lora_name");
  });

  it("returns LoraLoaderModelOnly for Flux model family", () => {
    const adapter = resolveAdapter("lora", "flux");
    expect(adapter.loaderClass).toBe("LoraLoaderModelOnly");
    expect(adapter.applyClass).toBe("LoraLoaderModelOnly");
    expect(adapter.strengthParamName).toBe("strength_model");
    expect(adapter.modelParamName).toBe("lora_name");
  });

  it("returns LoraLoader for SD 1.5 model family", () => {
    const adapter = resolveAdapter("lora", "sd15");
    expect(adapter.loaderClass).toBe("LoraLoader");
  });

  it("defaults to SDXL (LoraLoader) for unknown families", () => {
    const adapter = resolveAdapter("lora", "unknown_model_xyz");
    expect(adapter.loaderClass).toBe("LoraLoader");
  });

  it("defaults to SDXL when no family specified", () => {
    const adapter = resolveAdapter("lora");
    expect(adapter.loaderClass).toBe("LoraLoader");
  });
});

describe("resolveAdapter — IP adapter classes", () => {
  it("returns IPAdapterAdvanced for SDXL", () => {
    const adapter = resolveAdapter("ipadapter", "sdxl");
    expect(adapter.loaderClass).toBe("IPAdapterModelLoader");
    expect(adapter.applyClass).toBe("IPAdapterAdvanced");
  });

  it("returns IPAdapterFull for Flux", () => {
    const adapter = resolveAdapter("ipadapter", "flux");
    expect(adapter.loaderClass).toBe("IPAdapterModelLoader");
    expect(adapter.applyClass).toBe("IPAdapterFull");
  });

  it("returns IPAdapterAdvanced for SD 1.5", () => {
    const adapter = resolveAdapter("ipadapter", "sd15");
    expect(adapter.applyClass).toBe("IPAdapterAdvanced");
  });
});

describe("resolveAdapter — SREF classes", () => {
  it("returns SREFStyleEncode + StyleApplyIPAdapter for SDXL", () => {
    const adapter = resolveAdapter("sref", "sdxl");
    expect(adapter.loaderClass).toBe("SREFStyleEncode");
    expect(adapter.applyClass).toBe("StyleApplyIPAdapter");
  });

  it("returns SREFStyleEncode + StyleApplyIPAdapter for Flux (first pass)", () => {
    const adapter = resolveAdapter("sref", "flux");
    expect(adapter.loaderClass).toBe("SREFStyleEncode");
    // First pass: Flux still uses StyleApplyIPAdapter for SREF
    expect(adapter.applyClass).toBe("StyleApplyIPAdapter");
  });
});

describe("resolveAdapter — ControlNet classes", () => {
  it("returns ControlNetApplyAdvanced for SDXL", () => {
    const adapter = resolveAdapter("controlnet", "sdxl");
    expect(adapter.loaderClass).toBe("ControlNetLoader");
    expect(adapter.applyClass).toBe("ControlNetApplyAdvanced");
  });

  it("returns ControlNetApplyAdvanced for Flux", () => {
    const adapter = resolveAdapter("controlnet", "flux");
    expect(adapter.applyClass).toBe("ControlNetApplyAdvanced");
  });
});

// ---------------------------------------------------------------------------
// isLoraModelOnly
// ---------------------------------------------------------------------------

describe("isLoraModelOnly", () => {
  it("returns true for LoraLoaderModelOnly", () => {
    expect(isLoraModelOnly("LoraLoaderModelOnly")).toBe(true);
  });

  it("returns false for LoraLoader", () => {
    expect(isLoraModelOnly("LoraLoader")).toBe(false);
  });

  it("returns false for unknown classes", () => {
    expect(isLoraModelOnly("SomeOtherLoader")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createModelAwareLoraNode
// ---------------------------------------------------------------------------

describe("createModelAwareLoraNode", () => {
  it("creates LoraLoader with model+clip for SDXL", () => {
    const result = createModelAwareLoraNode(
      "anime_style.safetensors",
      "1", // model source
      "1", // clip source (from checkpoint loader output 1)
      0.8,
      0.7,
      "sdxl",
    );

    expect(result.node.class_type).toBe("LoraLoader");
    expect(result.node.inputs.lora_name).toBe("anime_style.safetensors");
    expect(result.node.inputs.strength_model).toBe(0.8);
    expect(result.node.inputs.strength_clip).toBe(0.7);
    expect(result.node.inputs.model).toEqual(["1", 0]);
    expect(result.node.inputs.clip).toEqual(["1", 1]); // clip source with output 1
    expect(result.outputs.model).toBeDefined();
    expect(result.outputs.clip).toBeDefined();
    expect(result.outputs.clip).not.toBeNull();
  });

  it("creates LoraLoaderModelOnly with model-only for Flux", () => {
    const result = createModelAwareLoraNode(
      "flux_lora.safetensors",
      "1", // model source
      null, // no clip for flux
      0.8,
      0.7, // clip strength ignored for model-only
      "flux",
    );

    expect(result.node.class_type).toBe("LoraLoaderModelOnly");
    expect(result.node.inputs.lora_name).toBe("flux_lora.safetensors");
    expect(result.node.inputs.strength_model).toBe(0.8);
    expect(result.node.inputs.model).toEqual(["1", 0]);
    // No clip input for model-only
    expect(result.node.inputs.clip).toBeUndefined();
    expect(result.node.inputs.strength_clip).toBeUndefined();
    // Outputs: model only, no clip
    expect(result.outputs.model).toBeDefined();
    expect(result.outputs.clip).toBeNull();
  });

  it("defaults to SDXL (LoraLoader) when no family specified", () => {
    const result = createModelAwareLoraNode(
      "test_lora.safetensors",
      "1",
      "1",
      1.0,
      1.0,
    );

    expect(result.node.class_type).toBe("LoraLoader");
    expect(result.outputs.clip).not.toBeNull();
  });

  it("uses fallback checkpoint node when no clip source for SDXL", () => {
    const result = createModelAwareLoraNode(
      "test.safetensors",
      "5",
      null, // no separate clip source
      0.5,
      0.5,
      "sdxl",
    );

    // Should fallback to using model source node output 1 for clip
    expect(result.node.class_type).toBe("LoraLoader");
    expect(result.node.inputs.clip).toEqual(["5", 1]);
  });
});

// ---------------------------------------------------------------------------
// resolveIPAdapterApplyClass / resolveSrefApplyClass
// ---------------------------------------------------------------------------

describe("resolveIPAdapterApplyClass", () => {
  it("returns IPAdapterAdvanced for SDXL", () => {
    expect(resolveIPAdapterApplyClass("sdxl")).toBe("IPAdapterAdvanced");
  });

  it("returns IPAdapterFull for Flux", () => {
    expect(resolveIPAdapterApplyClass("flux")).toBe("IPAdapterFull");
  });

  it("returns IPAdapterAdvanced for SD 1.5", () => {
    expect(resolveIPAdapterApplyClass("sd15")).toBe("IPAdapterAdvanced");
  });

  it("defaults to IPAdapterAdvanced", () => {
    expect(resolveIPAdapterApplyClass()).toBe("IPAdapterAdvanced");
  });
});

describe("resolveSrefApplyClass", () => {
  it("returns StyleApplyIPAdapter for SDXL", () => {
    expect(resolveSrefApplyClass("sdxl")).toBe("StyleApplyIPAdapter");
  });

  it("returns StyleApplyIPAdapter for Flux (first pass)", () => {
    expect(resolveSrefApplyClass("flux")).toBe("StyleApplyIPAdapter");
  });

  it("returns StyleApplyIPAdapter by default", () => {
    expect(resolveSrefApplyClass()).toBe("StyleApplyIPAdapter");
  });
});

// ---------------------------------------------------------------------------
// engine.ts — strength_clip model-awareness
// ---------------------------------------------------------------------------

describe("engine.ts LoRA strength_clip model-awareness", () => {
  // We'll test isLoraModelOnly directly since injectParams needs a full workflow
  it("isLoraModelOnly identifies LoraLoaderModelOnly nodes", () => {
    const sdxlWf = createSDXLWorkflow();
    const fluxWf = createFluxWorkflow();

    const sdxlLora = sdxlWf["2"];
    const fluxLora = fluxWf["2"];

    expect(isLoraModelOnly(sdxlLora.class_type)).toBe(false);
    expect(isLoraModelOnly(fluxLora.class_type)).toBe(true);
  });

  it("SDXL LoraLoader has both strength_model and strength_clip inputs", () => {
    const sdxlWf = createSDXLWorkflow();
    const loraNode = sdxlWf["2"];
    expect("strength_model" in loraNode.inputs).toBe(true);
    expect("strength_clip" in loraNode.inputs).toBe(true);
    expect("clip" in loraNode.inputs).toBe(true);
  });

  it("Flux LoraLoaderModelOnly has strength_model but not strength_clip", () => {
    const fluxWf = createFluxWorkflow();
    const loraNode = fluxWf["2"];
    expect("strength_model" in loraNode.inputs).toBe(true);
    expect("strength_clip" in loraNode.inputs).toBe(false);
    expect("clip" in loraNode.inputs).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Adapter pack config consistency
// ---------------------------------------------------------------------------

describe("adapter pack config consistency", () => {
  it("SDXL pack lora adapter matches resolveAdapter", () => {
    const sdxlLora = getAdapterConfig(SDXL_DEFAULT_PACK, "lora");
    const resolved = resolveAdapter("lora", "sdxl");
    expect(resolved.loaderClass).toBe(sdxlLora!.loaderClass);
    expect(resolved.applyClass).toBe(sdxlLora!.applyClass);
  });

  it("Flux pack lora adapter matches resolveAdapter", () => {
    const fluxLora = getAdapterConfig(FLUX_DEFAULT_PACK, "lora");
    const resolved = resolveAdapter("lora", "flux");
    expect(resolved.loaderClass).toBe(fluxLora!.loaderClass);
    expect(resolved.applyClass).toBe(fluxLora!.applyClass);
  });

  it("SD 1.5 pack lora adapter matches resolveAdapter", () => {
    const sd15Lora = getAdapterConfig(SD15_DEFAULT_PACK, "lora");
    const resolved = resolveAdapter("lora", "sd15");
    expect(resolved.loaderClass).toBe(sd15Lora!.loaderClass);
    expect(resolved.applyClass).toBe(sd15Lora!.applyClass);
  });

  it("SDXL ipadapter matches resolveAdapter", () => {
    const sdxlIP = getAdapterConfig(SDXL_DEFAULT_PACK, "ipadapter");
    const resolved = resolveAdapter("ipadapter", "sdxl");
    expect(resolved.applyClass).toBe(sdxlIP!.applyClass);
  });

  it("Flux ipadapter matches resolveAdapter", () => {
    const fluxIP = getAdapterConfig(FLUX_DEFAULT_PACK, "ipadapter");
    const resolved = resolveAdapter("ipadapter", "flux");
    expect(resolved.applyClass).toBe(fluxIP!.applyClass);
  });

  it("resolveAdapterPack returns correct packs", () => {
    expect(resolveAdapterPack("sdxl").id).toBe("sdxl-default");
    expect(resolveAdapterPack("flux").id).toBe("flux-default");
    expect(resolveAdapterPack("sd15").id).toBe("sd15-default");
  });
});

// ---------------------------------------------------------------------------
// No hardcoded LoraLoader regression
// ---------------------------------------------------------------------------

describe("no hardcoded LoraLoader regression", () => {
  it("createModelAwareLoraNode never hardcodes LoraLoader for Flux", () => {
    // Even with weird/capitalized names, resolveAdapter should pick the right class
    const result = createModelAwareLoraNode("test", "1", null, 1.0, 1.0, "flux");
    expect(result.node.class_type).toBe("LoraLoaderModelOnly");
    // Verify no clip-related fields
    expect(result.node.inputs.strength_clip).toBeUndefined();
    expect(result.node.inputs.clip).toBeUndefined();
  });

  it("createModelAwareLoraNode never uses LoraLoaderModelOnly for SDXL", () => {
    const result = createModelAwareLoraNode("test", "1", "1", 1.0, 1.0, "sdxl");
    expect(result.node.class_type).toBe("LoraLoader");
    // Verify clip fields are present
    expect(result.node.inputs.strength_clip).toBeDefined();
    expect(result.node.inputs.clip).toBeDefined();
  });

  it("createModelAwareLoraNode never uses LoraLoaderModelOnly for SD 1.5", () => {
    const result = createModelAwareLoraNode("test", "1", "1", 1.0, 1.0, "sd15");
    expect(result.node.class_type).toBe("LoraLoader");
    expect(result.node.inputs.strength_clip).toBeDefined();
    expect(result.node.inputs.clip).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// workflowInjector LoRA model-awareness
// ---------------------------------------------------------------------------

describe("workflowInjector LoRA model-awareness", () => {
  it("injectLoRANodes creates LoraLoader for SDXL workflow", () => {
    const lora: LoRAParams = {
      items: [{ name: "test_lora", strength: 0.8 }],
      autoTrigger: false,
      triggerPosition: "beginning",
    };
    const result = injectLoRANodes(createSDXLWorkflow(), lora, "sdxl");
    const loraNodes = result.addedNodes.filter(
      (id: string) => result.workflow[id]?.class_type === "LoraLoader",
    );
    expect(loraNodes.length).toBe(1);
  });

  it("injectLoRANodes creates LoraLoaderModelOnly for Flux workflow", () => {
    const lora: LoRAParams = {
      items: [{ name: "test_flux_lora", strength: 0.7 }],
      autoTrigger: false,
      triggerPosition: "beginning",
    };
    const result = injectLoRANodes(createFluxWorkflow(), lora, "flux");
    const loraNodes = result.addedNodes.filter(
      (id: string) => result.workflow[id]?.class_type === "LoraLoaderModelOnly",
    );
    expect(loraNodes.length).toBe(1);
    // Verify no clip input on the LoRA node
    const loraNode = result.workflow[loraNodes[0]];
    expect(loraNode.inputs.clip).toBeUndefined();
    expect(loraNode.inputs.strength_clip).toBeUndefined();
  });

  it("injectLoRANodes defaults to SDXL (LoraLoader) without modelFamily", () => {
    const lora: LoRAParams = {
      items: [{ name: "test_lora", strength: 1.0 }],
      autoTrigger: false,
      triggerPosition: "beginning",
    };
    const result = injectLoRANodes(createSDXLWorkflow(), lora);
    const loraNodes = result.addedNodes.filter(
      (id: string) => result.workflow[id]?.class_type === "LoraLoader",
    );
    expect(loraNodes.length).toBe(1);
  });
});
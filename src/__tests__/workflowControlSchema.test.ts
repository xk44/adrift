/**
 * Tests for workflowControlSchema — dynamic control schema builder
 * that turns discovered workflow node inputs into UI-ready control schemas.
 */

import { describe, expect, it } from "vitest";
import {
  buildControlSchema,
  getVisibleControls,
  groupControls,
  buildDefaultsMap,
  applyControlOverrides,
  detectControlKind,
  deriveLabel,
  determineVisibility,
  isNodeLinkRef,
  computeOrder,
  type ControlSchema,
  type ControlKind,
  type BuildControlSchemaOptions,
} from "@/lib/oj/workflowControlSchema";
import type { Workflow, WorkflowNode } from "@/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(class_type: string, inputs: Record<string, unknown> = {}): WorkflowNode {
  return { class_type, inputs };
}

function makeWorkflow(nodes: Record<string, WorkflowNode>): Workflow {
  return nodes;
}

// Minimal SDXL-like t2i workflow
const sdxlWorkflow: Workflow = {
  "1": makeNode("CheckpointLoaderSimple", { ckpt_name: "sdxl_base.safetensors" }),
  "2": makeNode("CLIPTextEncode", { text: "a beautiful landscape", clip: ["1", 1] }),
  "3": makeNode("EmptySDXLLatentImage", { width: 1024, height: 1024, batch_size: 1 }),
  "4": makeNode("KSampler", {
    seed: 42,
    steps: 20,
    cfg: 7.0,
    sampler_name: "euler",
    scheduler: "normal",
    denoise: 1.0,
    model: ["1", 0],
    positive: ["2", 0],
    negative: ["5", 0],
    latent_image: ["3", 0],
  }),
  "5": makeNode("CLIPTextEncode", { text: "ugly, blurry", clip: ["1", 1] }),
  "6": makeNode("VAEDecode", { samples: ["4", 0], vae: ["1", 2] }),
  "7": makeNode("SaveImage", { filename_prefix: "ComfyUI", images: ["6", 0] }),
};

// Flux-like workflow
const fluxWorkflow: Workflow = {
  "1": makeNode("UNETLoader", { unet_name: "flux1-dev.safetensors", weight_dtype: "fp8_e4m3fn" }),
  "2": makeNode("CLIPLoader", { clip_name: "t5xxl_fp16.safetensors", type: "flux" }),
  "3": makeNode("DualCLIPLoader", { clip_name1: "t5xxl_fp16.safetensors", clip_name2: "clip_l.safetensors", type: "flux" }),
  "4": makeNode("CLIPTextEncodeFlux", { text: "a stunning photo", t5xxl: ["3", 0], clip_l: ["3", 1] }),
  "5": makeNode("EmptyLatentImageFlux", { width: 1024, height: 1024 }),
  "6": makeNode("FluxSampler", {
    seed: 12345,
    steps: 30,
    cfg: 3.5,
    sampler_name: "euler",
    scheduler: "normal",
    denoise: 1.0,
    model: ["1", 0],
    positive: ["4", 0],
    negative: ["4", 0],
    latent_image: ["5", 0],
  }),
  "7": makeNode("VAEDecode", { samples: ["6", 0], vae: ["1", 2] }),
  "8": makeNode("SaveImage", { filename_prefix: "Flux", images: ["7", 0] }),
};

// Workflow with LoRA and ControlNet
const complexWorkflow: Workflow = {
  "1": makeNode("CheckpointLoaderSimple", { ckpt_name: "sdxl_base.safetensors" }),
  "2": makeNode("LoraLoader", { lora_name: "style_lora.safetensors", strength_model: 0.8, strength_clip: 0.8, model: ["1", 0], clip: ["1", 1] }),
  "3": makeNode("ControlNetLoader", { control_net_name: "control_v11p_sd15_canny.pth" }),
  "4": makeNode("ControlNetApplyAdvanced", {
    strength: 0.7,
    start_percent: 0.0,
    end_percent: 1.0,
  }),
  "5": makeNode("KSampler", { steps: 25, cfg: 7.5, sampler_name: "dpm_2", scheduler: "karras", denoise: 0.75 }),
  "6": makeNode("LoadImage", { image: "input_image.png" }),
  "7": makeNode("SaveImage", { filename_prefix: "output" }),
};

// ---------------------------------------------------------------------------
// detectControlKind
// ---------------------------------------------------------------------------

describe("detectControlKind", () => {
  it("detects seed inputs", () => {
    expect(detectControlKind("seed", 42, "KSampler")).toBe("seed");
    expect(detectControlKind("noise_seed", 12345, "KSampler")).toBe("seed");
  });

  it("detects number inputs", () => {
    expect(detectControlKind("steps", 20, "KSampler")).toBe("number");
    expect(detectControlKind("cfg", 7.0, "KSampler")).toBe("number");
    expect(detectControlKind("width", 1024, "EmptySDXLLatentImage")).toBe("number");
    expect(detectControlKind("height", 1024, "EmptySDXLLatentImage")).toBe("number");
    expect(detectControlKind("denoise", 1.0, "KSampler")).toBe("number");
  });

  it("detects enum inputs", () => {
    expect(detectControlKind("sampler_name", "euler", "KSampler")).toBe("enum");
    expect(detectControlKind("scheduler", "normal", "KSampler")).toBe("enum");
  });

  it("detects string inputs", () => {
    expect(detectControlKind("text", "prompt text", "CLIPTextEncode")).toBe("string");
    expect(detectControlKind("filename_prefix", "ComfyUI", "SaveImage")).toBe("string");
  });

  it("detects boolean inputs", () => {
    expect(detectControlKind("add_noise", true, "KSamplerAdvanced")).toBe("boolean");
    expect(detectControlKind("return_with_leftover", false, "KSamplerAdvanced")).toBe("boolean");
  });

  it("detects model inputs", () => {
    expect(detectControlKind("ckpt_name", "model.safetensors", "CheckpointLoaderSimple")).toBe("model");
    expect(detectControlKind("lora_name", "style.safetensors", "LoraLoader")).toBe("model");
    expect(detectControlKind("vae_name", "vae.safetensors", "VAELoader")).toBe("model");
    expect(detectControlKind("control_net_name", "control.pth", "ControlNetLoader")).toBe("model");
    expect(detectControlKind("unet_name", "flux.safetensors", "UNETLoader")).toBe("model");
  });

  it("detects image inputs", () => {
    expect(detectControlKind("image", "photo.png", "LoadImage")).toBe("image");
    expect(detectControlKind("mask", "mask.png", "LoadImage")).toBe("image");
  });

  it("detects link inputs", () => {
    expect(detectControlKind("model", ["1", 0], "KSampler")).toBe("link");
    expect(detectControlKind("positive", ["2", 0], "KSampler")).toBe("link");
    expect(detectControlKind("latent_image", ["3", 0], "KSampler")).toBe("link");
  });

  it("detects hidden for null/undefined", () => {
    expect(detectControlKind("something", null, "SomeNode")).toBe("hidden");
    expect(detectControlKind("something", undefined, "SomeNode")).toBe("hidden");
  });

  it("falls back to string for unknown string inputs", () => {
    expect(detectControlKind("custom_param", "hello", "CustomNode")).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// deriveLabel
// ---------------------------------------------------------------------------

describe("deriveLabel", () => {
  it("returns known labels for common inputs", () => {
    expect(deriveLabel("seed")).toBe("Seed");
    expect(deriveLabel("steps")).toBe("Steps");
    expect(deriveLabel("cfg")).toBe("CFG Scale");
    expect(deriveLabel("sampler_name")).toBe("Sampler");
    expect(deriveLabel("scheduler")).toBe("Scheduler");
    expect(deriveLabel("ckpt_name")).toBe("Checkpoint");
    expect(deriveLabel("lora_name")).toBe("LoRA");
    expect(deriveLabel("width")).toBe("Width");
    expect(deriveLabel("height")).toBe("Height");
    expect(deriveLabel("text")).toBe("Prompt");
  });

  it("falls back to title case for unknown keys", () => {
    expect(deriveLabel("custom_param")).toBe("Custom param");
    expect(deriveLabel("myValue")).toBe("My Value");
  });
});

// ---------------------------------------------------------------------------
// isNodeLinkRef
// ---------------------------------------------------------------------------

describe("isNodeLinkRef", () => {
  it("detects valid link references", () => {
    expect(isNodeLinkRef(["1", 0])).toBe(true);
    expect(isNodeLinkRef(["42", 1])).toBe(true);
    expect(isNodeLinkRef([5, 0])).toBe(true);
  });

  it("rejects non-link values", () => {
    expect(isNodeLinkRef(42)).toBe(false);
    expect(isNodeLinkRef("text")).toBe(false);
    expect(isNodeLinkRef(null)).toBe(false);
    expect(isNodeLinkRef({})).toBe(false);
    expect(isNodeLinkRef([1])).toBe(false); // too short
    expect(isNodeLinkRef(["1", "0"])).toBe(false); // second element is string
  });
});

// ---------------------------------------------------------------------------
// determineVisibility
// ---------------------------------------------------------------------------

describe("determineVisibility", () => {
  it("hides link-type controls", () => {
    expect(determineVisibility("model", "link", ["1", 0], "KSampler")).toBe(false);
  });

  it("hides known wiring inputs", () => {
    expect(determineVisibility("positive", "string", "text", "KSampler")).toBe(false);
    expect(determineVisibility("negative", "string", "text", "KSampler")).toBe(false);
    expect(determineVisibility("model", "link", ["1", 0], "KSampler")).toBe(false);
    expect(determineVisibility("clip", "link", ["1", 1], "KSampler")).toBe(false);
  });

  it("shows user-facing parameters", () => {
    expect(determineVisibility("steps", "number", 20, "KSampler")).toBe(true);
    expect(determineVisibility("cfg", "number", 7.0, "KSampler")).toBe(true);
    expect(determineVisibility("seed", "seed", 42, "KSampler")).toBe(true);
    expect(determineVisibility("sampler_name", "enum", "euler", "KSampler")).toBe(true);
  });

  it("hides hidden kind", () => {
    expect(determineVisibility("something", "hidden", null, "SomeNode")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildControlSchema — full workflow
// ---------------------------------------------------------------------------

describe("buildControlSchema", () => {
  it("extracts controls from a minimal SDXL workflow", () => {
    const result = buildControlSchema(sdxlWorkflow);
    expect(result.nodeCount).toBe(7);
    expect(result.classTypes).toContain("KSampler");
    expect(result.classTypes).toContain("CheckpointLoaderSimple");
    expect(result.classTypes).toContain("CLIPTextEncode");
    expect(result.classTypes).toContain("EmptySDXLLatentImage");
  });

  it("produces deterministic output with stable keys", () => {
    const result = buildControlSchema(sdxlWorkflow);
    const keys = result.controls.map((c) => c.key);
    // Keys should be nodeId.inputKey format
    for (const key of keys) {
      expect(key).toMatch(/^\d+\./);
    }
    // No duplicate keys
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("finds seed control from KSampler", () => {
    const result = buildControlSchema(sdxlWorkflow);
    const seedControl = result.controls.find((c) => c.inputKey === "seed");
    expect(seedControl).toBeDefined();
    expect(seedControl!.kind).toBe("seed");
    expect(seedControl!.defaultValue).toBe(42);
  });

  it("finds steps control with bounds", () => {
    const result = buildControlSchema(sdxlWorkflow);
    const stepsControl = result.controls.find((c) => c.inputKey === "steps" && c.classType === "KSampler");
    expect(stepsControl).toBeDefined();
    expect(stepsControl!.kind).toBe("number");
    expect(stepsControl!.defaultValue).toBe(20);
    expect(stepsControl!.min).toBe(1);
    expect(stepsControl!.max).toBe(150);
  });

  it("finds cfg control with bounds", () => {
    const result = buildControlSchema(sdxlWorkflow);
    const cfgControl = result.controls.find((c) => c.inputKey === "cfg");
    expect(cfgControl).toBeDefined();
    expect(cfgControl!.kind).toBe("number");
    expect(cfgControl!.defaultValue).toBe(7.0);
  });

  it("finds sampler enum with options", () => {
    const result = buildControlSchema(sdxlWorkflow);
    const samplerControl = result.controls.find((c) => c.inputKey === "sampler_name" && c.classType === "KSampler");
    expect(samplerControl).toBeDefined();
    expect(samplerControl!.kind).toBe("enum");
    expect(samplerControl!.options).toBeDefined();
    expect(samplerControl!.options!.length).toBeGreaterThan(0);
    expect(samplerControl!.options).toContain("euler");
  });

  it("finds scheduler enum with options", () => {
    const result = buildControlSchema(sdxlWorkflow);
    const schedControl = result.controls.find((c) => c.inputKey === "scheduler" && c.classType === "KSampler");
    expect(schedControl).toBeDefined();
    expect(schedControl!.kind).toBe("enum");
    expect(schedControl!.options).toContain("normal");
    expect(schedControl!.options).toContain("karras");
  });

  it("finds checkpoint model selector", () => {
    const result = buildControlSchema(sdxlWorkflow);
    const ckptControl = result.controls.find((c) => c.inputKey === "ckpt_name");
    expect(ckptControl).toBeDefined();
    expect(ckptControl!.kind).toBe("model");
    expect(ckptControl!.modelCategory).toBe("checkpoint");
    expect(ckptControl!.defaultValue).toBe("sdxl_base.safetensors");
  });

  it("handles Flux workflow correctly", () => {
    const result = buildControlSchema(fluxWorkflow);
    expect(result.classTypes).toContain("UNETLoader");
    expect(result.classTypes).toContain("FluxSampler");

    // UNET model
    const unetControl = result.controls.find((c) => c.inputKey === "unet_name");
    expect(unetControl).toBeDefined();
    expect(unetControl!.kind).toBe("model");
    expect(unetControl!.modelCategory).toBe("unet");
  });

  it("handles complex workflow with LoRA and ControlNet", () => {
    const result = buildControlSchema(complexWorkflow);

    // LoRA model selector
    const loraControl = result.controls.find((c) => c.inputKey === "lora_name");
    expect(loraControl).toBeDefined();
    expect(loraControl!.modelCategory).toBe("lora");

    // ControlNet model
    const cnControl = result.controls.find((c) => c.inputKey === "control_net_name");
    expect(cnControl).toBeDefined();
    expect(cnControl!.modelCategory).toBe("controlnet");

    // LoRA strength
    const strengthControl = result.controls.find((c) => c.inputKey === "strength_model");
    expect(strengthControl).toBeDefined();
    expect(strengthControl!.kind).toBe("number");
  });

  it("excludes link-type inputs by default", () => {
    const result = buildControlSchema(sdxlWorkflow);
    const linkControls = result.controls.filter((c) => c.kind === "link");
    expect(linkControls).toHaveLength(0);
  });

  it("excludes hidden inputs by default", () => {
    const result = buildControlSchema(sdxlWorkflow);
    const hiddenControls = result.controls.filter((c) => c.kind === "hidden");
    expect(hiddenControls).toHaveLength(0);
  });

  it("includes link controls when requested", () => {
    const result = buildControlSchema(sdxlWorkflow, { includeLinks: true });
    const linkControls = result.controls.filter((c) => c.kind === "link");
    expect(linkControls.length).toBeGreaterThan(0);
    // Verify wiring inputs like model, positive, negative
    const linkKeys = linkControls.map((c) => c.inputKey);
    expect(linkKeys).toContain("model");
    expect(linkKeys).toContain("positive");
  });

  it("includes hidden controls when requested", () => {
    const workflow: Workflow = {
      "1": makeNode("SomeNode", { empty_val: null, normal_val: 42 }),
    };
    const result = buildControlSchema(workflow, { includeHidden: true });
    const hiddenControl = result.controls.find((c) => c.inputKey === "empty_val");
    expect(hiddenControl).toBeDefined();
    expect(hiddenControl!.kind).toBe("hidden");
  });

  it("filters by node IDs", () => {
    const result = buildControlSchema(sdxlWorkflow, { filterNodeIds: ["4"] });
    expect(result.controls.every((c) => c.nodeId === "4")).toBe(true);
    expect(result.controls.length).toBeGreaterThan(0);
    // Should have KSampler controls
    const stepsControl = result.controls.find((c) => c.inputKey === "steps");
    expect(stepsControl).toBeDefined();
  });

  it("filters by class types", () => {
    const result = buildControlSchema(sdxlWorkflow, { filterClassTypes: ["KSampler"] });
    expect(result.controls.every((c) => c.classType === "KSampler")).toBe(true);
  });

  it("skips PrimitiveNode inputs by default", () => {
    const workflow: Workflow = {
      "1": makeNode("PrimitiveNode", { value: 42, type: "INT" }),
    };
    const result = buildControlSchema(workflow);
    expect(result.controls).toHaveLength(0);
  });

  it("includes PrimitiveNode when requested", () => {
    const workflow: Workflow = {
      "1": makeNode("PrimitiveNode", { value: 42, type: "INT" }),
    };
    const result = buildControlSchema(workflow, { includePrimitives: true });
    expect(result.controls.length).toBeGreaterThan(0);
  });

  it("produces correct countsByKind", () => {
    const result = buildControlSchema(sdxlWorkflow);
    // Verify countsByKind values sum to total controls
    let total = 0;
    for (const v of Object.values(result.countsByKind)) {
      total += (v as number) ?? 0;
    }
    expect(total).toBe(result.controls.length);
  });

  it("sorts controls with Sampling before Model Loading before Output", () => {
    const result = buildControlSchema(sdxlWorkflow);
    const groupOrder = result.controls.map((c) => c.group);
    const samplingIdx = groupOrder.indexOf("Sampling");
    const modelIdx = groupOrder.indexOf("Model Loading");
    const promptIdx = groupOrder.indexOf("Prompt");
    if (samplingIdx >= 0 && modelIdx >= 0) {
      expect(samplingIdx).toBeLessThan(modelIdx);
    }
    if (promptIdx >= 0 && modelIdx >= 0) {
      expect(promptIdx).toBeLessThan(modelIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// getVisibleControls
// ---------------------------------------------------------------------------

describe("getVisibleControls", () => {
  it("returns only visible controls", () => {
    const controls = getVisibleControls(sdxlWorkflow);
    expect(controls.every((c) => c.visible)).toBe(true);
    expect(controls.every((c) => c.kind !== "link")).toBe(true);
    expect(controls.every((c) => c.kind !== "hidden")).toBe(true);
  });

  it("does not include wiring inputs like positive/negative/model/vae/clip", () => {
    const controls = getVisibleControls(sdxlWorkflow);
    const inputKeys = controls.map((c) => c.inputKey);
    expect(inputKeys).not.toContain("positive");
    expect(inputKeys).not.toContain("negative");
    expect(inputKeys).not.toContain("model");
    expect(inputKeys).not.toContain("clip");
    expect(inputKeys).not.toContain("vae");
  });

  it("does include user parameters like steps, cfg, seed", () => {
    const controls = getVisibleControls(sdxlWorkflow);
    const inputKeys = controls.map((c) => c.inputKey);
    expect(inputKeys).toContain("steps");
    expect(inputKeys).toContain("cfg");
    expect(inputKeys).toContain("seed");
    expect(inputKeys).toContain("sampler_name");
    expect(inputKeys).toContain("scheduler");
  });
});

// ---------------------------------------------------------------------------
// groupControls
// ---------------------------------------------------------------------------

describe("groupControls", () => {
  it("groups controls by their group field", () => {
    const controls = getVisibleControls(sdxlWorkflow);
    const groups = groupControls(controls);
    expect(Object.keys(groups).length).toBeGreaterThan(0);
    // Should have a Sampling group
    expect(Object.keys(groups)).toContain("Sampling");
    // Each group should have at least one control
    for (const group of Object.keys(groups)) {
      expect(groups[group].length).toBeGreaterThan(0);
    }
  });

  it("groups sampler controls together", () => {
    const controls = getVisibleControls(sdxlWorkflow);
    const groups = groupControls(controls);
    const samplingGroup = groups["Sampling"];
    if (samplingGroup) {
      const keys = samplingGroup.map((c) => c.inputKey);
      expect(keys).toContain("steps");
      expect(keys).toContain("cfg");
      expect(keys).toContain("sampler_name");
    }
  });
});

// ---------------------------------------------------------------------------
// buildDefaultsMap
// ---------------------------------------------------------------------------

describe("buildDefaultsMap", () => {
  it("builds a key-value map of visible control defaults", () => {
    const map = buildDefaultsMap(sdxlWorkflow);
    // Should have some entries
    expect(Object.keys(map).length).toBeGreaterThan(0);
  });

  it("uses nodeId.inputKey format for keys", () => {
    const map = buildDefaultsMap(sdxlWorkflow);
    const keys = Object.keys(map);
    for (const key of keys) {
      expect(key).toMatch(/^\d+\.\w+/);
    }
  });

  it("contains expected defaults", () => {
    const map = buildDefaultsMap(sdxlWorkflow);
    // KSampler defaults (node "4")
    expect(map["4.seed"]).toBe(42);
    expect(map["4.steps"]).toBe(20);
    expect(map["4.cfg"]).toBe(7.0);
    expect(map["4.sampler_name"]).toBe("euler");
  });

  it("does not include link-type values", () => {
    const map = buildDefaultsMap(sdxlWorkflow);
    const values = Object.values(map);
    for (const v of values) {
      expect(Array.isArray(v)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// applyControlOverrides
// ---------------------------------------------------------------------------

describe("applyControlOverrides", () => {
  it("applies overrides to a workflow", () => {
    const overrides = {
      "4.seed": 999,
      "4.steps": 30,
      "4.cfg": 5.0,
    };
    const result = applyControlOverrides(sdxlWorkflow, overrides);

    // KSampler (node "4") should have updated values
    expect(result["4"].inputs.seed).toBe(999);
    expect(result["4"].inputs.steps).toBe(30);
    expect(result["4"].inputs.cfg).toBe(5.0);

    // Other nodes should be unchanged
    expect(result["1"].inputs.ckpt_name).toBe("sdxl_base.safetensors");
  });

  it("does not add new keys that don't exist in inputs", () => {
    const overrides = { "4.nonexistent_key": "value" };
    const result = applyControlOverrides(sdxlWorkflow, overrides);
    expect(result["4"].inputs).not.toHaveProperty("nonexistent_key");
  });

  it("preserves nodes not in overrides", () => {
    const overrides = { "4.seed": 123 };
    const result = applyControlOverrides(sdxlWorkflow, overrides);
    // Node 7 (SaveImage) should be identical
    expect(result["7"].inputs.filename_prefix).toBe("ComfyUI");
  });

  it("handles empty overrides", () => {
    const result = applyControlOverrides(sdxlWorkflow, {});
    expect(Object.keys(result).length).toBe(Object.keys(sdxlWorkflow).length);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles empty workflow", () => {
    const result = buildControlSchema({});
    expect(result.controls).toHaveLength(0);
    expect(result.nodeCount).toBe(0);
    expect(result.classTypes).toHaveLength(0);
  });

  it("handles workflow with null inputs", () => {
    const workflow: Workflow = {
      "1": { class_type: "TestNode", inputs: {} as Record<string, unknown> },
    };
    const result = buildControlSchema(workflow);
    expect(result.controls).toHaveLength(0);
  });

  it("handles workflow with mixed numeric types", () => {
    const workflow: Workflow = {
      "1": makeNode("KSampler", {
        steps: 20,         // integer
        cfg: 7.5,          // float
        seed: 42,           // seed (integer)
      }),
    };
    const result = buildControlSchema(workflow);
    const stepsControl = result.controls.find((c) => c.inputKey === "steps");
    const cfgControl = result.controls.find((c) => c.inputKey === "cfg");
    const seedControl = result.controls.find((c) => c.inputKey === "seed");
    expect(stepsControl!.kind).toBe("number");
    expect(cfgControl!.kind).toBe("number");
    expect(seedControl!.kind).toBe("seed");
  });

  it("handles custom class_types gracefully", () => {
    const workflow: Workflow = {
      "1": makeNode("MyCustomSuperNode", {
        custom_param: "hello",
        custom_strength: 0.75,
      }),
    };
    const result = buildControlSchema(workflow);
    expect(result.controls.length).toBeGreaterThanOrEqual(2);
    const paramControl = result.controls.find((c) => c.inputKey === "custom_param");
    expect(paramControl).toBeDefined();
    expect(paramControl!.kind).toBe("string");
  });

  it("deterministic ordering across runs", () => {
    const result1 = buildControlSchema(sdxlWorkflow);
    const result2 = buildControlSchema(sdxlWorkflow);
    const keys1 = result1.controls.map((c) => c.key);
    const keys2 = result2.controls.map((c) => c.key);
    expect(keys1).toEqual(keys2);
  });

  it("boolean values from KSamplerAdvanced", () => {
    const workflow: Workflow = {
      "1": makeNode("KSamplerAdvanced", {
        add_noise: true,
        start_with_step: 0,
        end_with_step: -1,
        return_with_leftover: false,
        steps: 20,
        cfg: 7.0,
        sampler_name: "euler_ancestral",
        scheduler: "karras",
        denoise: 1.0,
      }),
    };
    const result = buildControlSchema(workflow);
    const addNoise = result.controls.find((c) => c.inputKey === "add_noise");
    expect(addNoise).toBeDefined();
    expect(addNoise!.kind).toBe("boolean");
    expect(addNoise!.defaultValue).toBe(true);

    const returnLeftover = result.controls.find((c) => c.inputKey === "return_with_leftover");
    expect(returnLeftover).toBeDefined();
    expect(returnLeftover!.kind).toBe("boolean");
    expect(returnLeftover!.defaultValue).toBe(false);
  });

  it("provides model category for model-type controls", () => {
    const result = buildControlSchema(complexWorkflow);
    const ckptControl = result.controls.find((c) => c.inputKey === "ckpt_name");
    expect(ckptControl!.modelCategory).toBe("checkpoint");

    const loraControl = result.controls.find((c) => c.inputKey === "lora_name");
    expect(loraControl!.modelCategory).toBe("lora");

    const cnControl = result.controls.find((c) => c.inputKey === "control_net_name");
    expect(cnControl!.modelCategory).toBe("controlnet");
  });

  it("assigns correct groups", () => {
    const result = buildControlSchema(sdxlWorkflow);
    const stepsControl = result.controls.find((c) => c.inputKey === "steps");
    expect(stepsControl!.group).toBe("Sampling");

    const widthControl = result.controls.find((c) => c.inputKey === "width");
    expect(widthControl!.group).toBe("Dimensions");

    const ckptControl = result.controls.find((c) => c.inputKey === "ckpt_name");
    expect(ckptControl!.group).toBe("Model Loading");
  });
});
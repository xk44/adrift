/**
 * Tests for workflow control non-scalar UI support — model validation,
 * image controls, and model inventory integration.
 */

import { describe, expect, it } from "vitest";
import {
  buildControlSchema,
  detectControlKind,
  getVisibleControls,
  MODEL_CATEGORY_TO_INVENTORY_KEY,
  validateModelChoice,
  getModelOptionsForControl,
  type ControlSchema,
  type ModelInventory,
  type ModelValidationResult,
} from "@/lib/oj/workflowControlSchema";
import { getEditableControls } from "@/store/workflowControlStore";
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

// Sample model inventories for testing
const emptyInventory: ModelInventory = {};

const richInventory: ModelInventory = {
  checkpoints: [
    "sdxl_base.safetensors",
    "dreamshaper_v8.safetensors",
    "realisticVision_v5.safetensors",
  ],
  loras: [
    "style_lora.safetensors",
    "detail_enhancer.safetensors",
  ],
  vaes: ["vae-ft-mse.safetensors", "sdxl_vae.safetensors"],
  controlnet: ["control_v11p_sd15_canny.pth"],
  upscale_models: ["4x-UltraSharp.pth"],
  clip: [],
  unet: ["flux1-dev.safetensors"],
  ipadapter: [],
};

const partialInventory: ModelInventory = {
  checkpoints: ["sdxl_base.safetensors"],
  // No loras, vaes, etc.
};

// ---------------------------------------------------------------------------
// MODEL_CATEGORY_TO_INVENTORY_KEY
// ---------------------------------------------------------------------------

describe("MODEL_CATEGORY_TO_INVENTORY_KEY", () => {
  it("maps all model categories to inventory keys", () => {
    const categories: Array<keyof typeof MODEL_CATEGORY_TO_INVENTORY_KEY> = [
      "checkpoint", "lora", "vae", "controlnet", "upscale", "clip", "unet", "ipadapter",
    ];
    for (const cat of categories) {
      expect(MODEL_CATEGORY_TO_INVENTORY_KEY[cat]).toBeDefined();
      expect(typeof MODEL_CATEGORY_TO_INVENTORY_KEY[cat]).toBe("string");
    }
  });

  it("maps checkpoint to checkpoints", () => {
    expect(MODEL_CATEGORY_TO_INVENTORY_KEY.checkpoint).toBe("checkpoints");
  });

  it("maps lora to loras", () => {
    expect(MODEL_CATEGORY_TO_INVENTORY_KEY.lora).toBe("loras");
  });

  it("maps vae to vaes", () => {
    expect(MODEL_CATEGORY_TO_INVENTORY_KEY.vae).toBe("vaes");
  });
});

// ---------------------------------------------------------------------------
// validateModelChoice
// ---------------------------------------------------------------------------

describe("validateModelChoice", () => {
  const checkpointControl: ControlSchema = {
    key: "1.ckpt_name",
    nodeId: "1",
    inputKey: "ckpt_name",
    classType: "CheckpointLoaderSimple",
    kind: "model",
    label: "Checkpoint",
    group: "Model Loading",
    defaultValue: "sdxl_base.safetensors",
    modelCategory: "checkpoint",
    visible: true,
    order: 400,
  };

  const loraControl: ControlSchema = {
    key: "2.lora_name",
    nodeId: "2",
    inputKey: "lora_name",
    classType: "LoraLoader",
    kind: "model",
    label: "LoRA",
    group: "LoRA",
    defaultValue: "style_lora.safetensors",
    modelCategory: "lora",
    visible: true,
    order: 410,
  };

  const numberControl: ControlSchema = {
    key: "4.steps",
    nodeId: "4",
    inputKey: "steps",
    classType: "KSampler",
    kind: "number",
    label: "Steps",
    group: "Sampling",
    defaultValue: 20,
    visible: true,
    order: 120,
  };

  it("validates a checkpoint that exists in inventory", () => {
    const result = validateModelChoice(checkpointControl, richInventory);
    expect(result.isValid).toBe(true);
    expect(result.hasInventory).toBe(true);
    expect(result.options).toEqual(richInventory.checkpoints);
    expect(result.currentValue).toBe("sdxl_base.safetensors");
  });

  it("invalidates a checkpoint not in inventory", () => {
    const customControl = { ...checkpointControl, defaultValue: "nonexistent_model.safetensors" };
    const result = validateModelChoice(customControl, richInventory);
    expect(result.isValid).toBe(false);
    expect(result.hasInventory).toBe(true);
    expect(result.currentValue).toBe("nonexistent_model.safetensors");
  });

  it("assumes valid when no inventory data is available", () => {
    const result = validateModelChoice(checkpointControl, emptyInventory);
    expect(result.isValid).toBe(true);
    expect(result.hasInventory).toBe(false);
    expect(result.options).toEqual([]);
  });

  it("assumes valid when inventory category is missing", () => {
    // partialInventory has checkpoints but no loras
    const result = validateModelChoice(loraControl, partialInventory);
    expect(result.isValid).toBe(true); // no data → assume valid
    expect(result.hasInventory).toBe(false);
  });

  it("returns valid for non-model controls", () => {
    const result = validateModelChoice(numberControl, richInventory);
    expect(result.isValid).toBe(true);
    expect(result.hasInventory).toBe(false);
    expect(result.options).toEqual([]);
  });

  it("returns valid for model controls without a modelCategory", () => {
    const noCategoryControl: ControlSchema = {
      ...checkpointControl,
      modelCategory: undefined,
    };
    const result = validateModelChoice(noCategoryControl, richInventory);
    expect(result.isValid).toBe(true);
    expect(result.hasInventory).toBe(false);
  });

  it("validates LoRA models against lora inventory", () => {
    const result = validateModelChoice(loraControl, richInventory);
    expect(result.isValid).toBe(true);
    expect(result.hasInventory).toBe(true);
    expect(result.options).toEqual(richInventory.loras);
  });

  it("handles model control with null default value", () => {
    const nullDefaultControl = { ...checkpointControl, defaultValue: null };
    const result = validateModelChoice(nullDefaultControl, richInventory);
    expect(result.currentValue).toBe("");
    expect(result.isValid).toBe(false); // empty string not in inventory
  });
});

// ---------------------------------------------------------------------------
// getModelOptionsForControl
// ---------------------------------------------------------------------------

describe("getModelOptionsForControl", () => {
  const checkpointControl: ControlSchema = {
    key: "1.ckpt_name",
    nodeId: "1",
    inputKey: "ckpt_name",
    classType: "CheckpointLoaderSimple",
    kind: "model",
    label: "Checkpoint",
    group: "Model Loading",
    defaultValue: "sdxl_base.safetensors",
    modelCategory: "checkpoint",
    visible: true,
    order: 400,
  };

  it("returns checkpoint options for checkpoint control", () => {
    const options = getModelOptionsForControl(checkpointControl, richInventory);
    expect(options).toEqual(richInventory.checkpoints);
  });

  it("returns empty array for non-model control", () => {
    const numberControl: ControlSchema = {
      key: "4.steps",
      nodeId: "4",
      inputKey: "steps",
      classType: "KSampler",
      kind: "number",
      label: "Steps",
      group: "Sampling",
      defaultValue: 20,
      visible: true,
      order: 120,
    };
    const options = getModelOptionsForControl(numberControl, richInventory);
    expect(options).toEqual([]);
  });

  it("returns empty array when inventory is empty", () => {
    const options = getModelOptionsForControl(checkpointControl, emptyInventory);
    expect(options).toEqual([]);
  });

  it("returns empty array for model control without category", () => {
    const noCategoryControl: ControlSchema = {
      ...checkpointControl,
      modelCategory: undefined,
    };
    const options = getModelOptionsForControl(noCategoryControl, richInventory);
    expect(options).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getEditableControls includes model and image kinds
// ---------------------------------------------------------------------------

describe("getEditableControls includes model and image", () => {
  it("includes model controls as editable", () => {
    const controls: ControlSchema[] = [
      {
        key: "1.ckpt_name",
        nodeId: "1",
        inputKey: "ckpt_name",
        classType: "CheckpointLoaderSimple",
        kind: "model",
        label: "Checkpoint",
        group: "Model Loading",
        defaultValue: "model.safetensors",
        modelCategory: "checkpoint",
        visible: true,
        order: 400,
      },
      {
        key: "4.steps",
        nodeId: "4",
        inputKey: "steps",
        classType: "KSampler",
        kind: "number",
        label: "Steps",
        group: "Sampling",
        defaultValue: 20,
        visible: true,
        order: 120,
      },
    ];

    const editable = getEditableControls(controls);
    expect(editable.length).toBe(2);
    expect(editable.some((c) => c.kind === "model")).toBe(true);
    expect(editable.some((c) => c.kind === "number")).toBe(true);
  });

  it("includes image controls as editable", () => {
    const controls: ControlSchema[] = [
      {
        key: "6.image",
        nodeId: "6",
        inputKey: "image",
        classType: "LoadImage",
        kind: "image",
        label: "Image",
        group: "Image Input",
        defaultValue: "input.png",
        visible: true,
        order: 600,
      },
    ];

    const editable = getEditableControls(controls);
    expect(editable.length).toBe(1);
    expect(editable[0].kind).toBe("image");
  });

  it("still excludes hidden and link controls", () => {
    const controls: ControlSchema[] = [
      {
        key: "4.model",
        nodeId: "4",
        inputKey: "model",
        classType: "KSampler",
        kind: "link",
        label: "Model",
        group: "Sampling",
        defaultValue: null,
        visible: false,
        order: 100,
      },
      {
        key: "5.hidden_val",
        nodeId: "5",
        inputKey: "hidden_val",
        classType: "SomeNode",
        kind: "hidden",
        label: "Hidden Val",
        group: "Other",
        defaultValue: null,
        visible: false,
        order: 200,
      },
    ];

    const editable = getEditableControls(controls);
    expect(editable.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: buildControlSchema produces model controls with proper categories
// ---------------------------------------------------------------------------

describe("buildControlSchema model controls with inventory validation", () => {
  it("validates checkpoint from inventory", () => {
    const workflow = makeWorkflow({
      "1": makeNode("CheckpointLoaderSimple", { ckpt_name: "sdxl_base.safetensors" }),
      "4": makeNode("KSampler", {
        seed: 42, steps: 20, cfg: 7.0,
        sampler_name: "euler", scheduler: "normal", denoise: 1.0,
        model: ["1", 0], positive: ["2", 0], negative: ["5", 0], latent_image: ["3", 0],
      }),
    });

    const result = buildControlSchema(workflow);
    const ckptControl = result.controls.find((c) => c.inputKey === "ckpt_name");
    expect(ckptControl).toBeDefined();
    expect(ckptControl!.kind).toBe("model");
    expect(ckptControl!.modelCategory).toBe("checkpoint");

    // Validate against rich inventory
    const validation = validateModelChoice(ckptControl!, richInventory);
    expect(validation.isValid).toBe(true);
    expect(validation.hasInventory).toBe(true);
    expect(validation.options.length).toBe(3);
  });

  it("detects missing model in inventory", () => {
    const workflow = makeWorkflow({
      "1": makeNode("CheckpointLoaderSimple", { ckpt_name: "missing_model.safetensors" }),
    });

    const result = buildControlSchema(workflow);
    const ckptControl = result.controls.find((c) => c.inputKey === "ckpt_name");
    expect(ckptControl).toBeDefined();

    const validation = validateModelChoice(ckptControl!, richInventory);
    expect(validation.isValid).toBe(false);
    expect(validation.hasInventory).toBe(true);
  });

  it("LoRA model controls validate against lora inventory", () => {
    const workflow = makeWorkflow({
      "2": makeNode("LoraLoader", {
        lora_name: "style_lora.safetensors",
        strength_model: 0.8,
        strength_clip: 0.8,
        model: ["1", 0],
        clip: ["1", 1],
      }),
    });

    const result = buildControlSchema(workflow);
    const loraControl = result.controls.find((c) => c.inputKey === "lora_name");
    expect(loraControl).toBeDefined();
    expect(loraControl!.modelCategory).toBe("lora");

    const validation = validateModelChoice(loraControl!, richInventory);
    expect(validation.isValid).toBe(true);
    expect(validation.options).toContain("style_lora.safetensors");
  });

  it("image control detected from LoadImage", () => {
    const workflow = makeWorkflow({
      "6": makeNode("LoadImage", { image: "input_photo.png" }),
    });

    const result = buildControlSchema(workflow, { includeLinks: false });
    const imageControl = result.controls.find((c) => c.inputKey === "image");
    expect(imageControl).toBeDefined();
    expect(imageControl!.kind).toBe("image");
    expect(imageControl!.visible).toBe(true);
    expect(imageControl!.defaultValue).toBe("input_photo.png");
  });
});

// ---------------------------------------------------------------------------
// Extended: custom-node category validation with new inventory categories
// ---------------------------------------------------------------------------

describe("new model category inventory validation", () => {
  const extendedInventory: ModelInventory = {
    checkpoints: ["sdxl_base.safetensors"],
    loras: ["style_lora.safetensors"],
    vaes: ["vae-ft-mse.safetensors"],
    controlnet: ["control_v11p_sd15_canny.pth"],
    upscale_models: ["4x-UltraSharp.pth"],
    clip: [],
    unet: [],
    ipadapter: [],
    embeddings: ["easy-negative.safetensors"],
    gligen: ["gligen_sd14.safetensors"],
    hypernetworks: ["hyper.safetensors"],
    diffusers: [],
    animatediff_models: ["v3_sd15_mm.ckpt"],
    video_models: [],
    style_models: ["style.safetensors"],
  };

  it("validates animatediff model category", () => {
    const animControl: ControlSchema = {
      key: "2.model_path",
      nodeId: "2",
      inputKey: "model_path",
      classType: "AnimateDiffLoaderWithContext",
      kind: "model",
      label: "Motion Model",
      group: "AnimateDiff",
      defaultValue: "v3_sd15_mm.ckpt",
      modelCategory: "animatediff",
      visible: true,
      order: 520,
    };
    const validation = validateModelChoice(animControl, extendedInventory);
    expect(validation.isValid).toBe(true);
    expect(validation.hasInventory).toBe(true);
    expect(validation.options).toContain("v3_sd15_mm.ckpt");
  });

  it("validates embedding category", () => {
    const embedControl: ControlSchema = {
      key: "1.embed_name",
      nodeId: "1",
      inputKey: "embed_name",
      classType: "SomeNode",
      kind: "model",
      label: "Embedding",
      group: "Embeddings",
      defaultValue: "easy-negative.safetensors",
      modelCategory: "embedding",
      visible: true,
      order: 540,
    };
    const validation = validateModelChoice(embedControl, extendedInventory);
    expect(validation.isValid).toBe(true);
    expect(validation.options).toContain("easy-negative.safetensors");
  });

  it("validates gligen category", () => {
    const gligenControl: ControlSchema = {
      key: "1.gligen_name",
      nodeId: "1",
      inputKey: "gligen_name",
      classType: "GLIGENLoader",
      kind: "model",
      label: "GLIGEN Model",
      group: "Gligen",
      defaultValue: "gligen_sd14.safetensors",
      modelCategory: "gligen",
      visible: true,
      order: 550,
    };
    const validation = validateModelChoice(gligenControl, extendedInventory);
    expect(validation.isValid).toBe(true);
    expect(validation.options).toContain("gligen_sd14.safetensors");
  });

  it("handles missing inventory for new categories gracefully", () => {
    const animControl: ControlSchema = {
      key: "2.model_path",
      nodeId: "2",
      inputKey: "model_path",
      classType: "AnimateDiffLoaderWithContext",
      kind: "model",
      label: "Motion Model",
      group: "AnimateDiff",
      defaultValue: "v3_sd15_mm.ckpt",
      modelCategory: "animatediff",
      visible: true,
      order: 520,
    };
    const emptyInv: ModelInventory = {};
    const validation = validateModelChoice(animControl, emptyInv);
    expect(validation.isValid).toBe(true); // assume valid with no inventory
    expect(validation.hasInventory).toBe(false);
  });
});
/**
 * Tests for workflow control picker/validation deepening —
 * Validation summary, enum enrichment, model category labels,
 * default-value helpers, control subtype detection, and
 * override diff computation.
 */

import { describe, expect, it } from "vitest";
import {
  buildControlSchema,
  enrichEnumOptions,
  getModelCategoryLabel,
  MODEL_CATEGORY_LABELS,
  validateAllControls,
  buildDefaultsMapFromControls,
  computeOverrideDiff,
  deriveControlSubtype,
  getSubtypeHint,
  SUBTYPE_EXTENSIONS,
  validateModelChoice,
  type ControlSchema,
  type ModelCategory,
  type ModelInventory,
  type ValidationSummary,
} from "@/lib/oj/workflowControlSchema";
import { findControlByKey } from "@/store/workflowControlStore";
import type { Workflow, WorkflowNode } from "@/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(
  class_type: string,
  inputs: Record<string, unknown> = {},
): WorkflowNode {
  return { class_type, inputs };
}

function makeWorkflow(nodes: Record<string, WorkflowNode>): Workflow {
  return nodes;
}

// ---------------------------------------------------------------------------
// enrichEnumOptions
// ---------------------------------------------------------------------------

describe("enrichEnumOptions", () => {
  const samplerControl: ControlSchema = {
    key: "4.sampler_name",
    nodeId: "4",
    inputKey: "sampler_name",
    classType: "KSampler",
    kind: "enum",
    label: "Sampler",
    group: "Sampling",
    defaultValue: "euler",
    options: ["euler", "euler_ancestral", "dpm_2"],
    visible: true,
    order: 140,
  };

  const schedulerControl: ControlSchema = {
    key: "4.scheduler",
    nodeId: "4",
    inputKey: "scheduler",
    classType: "KSampler",
    kind: "enum",
    label: "Scheduler",
    group: "Sampling",
    defaultValue: "normal",
    options: ["normal", "karras", "exponential"],
    visible: true,
    order: 150,
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

  const inventory: ModelInventory = {
    samplers: ["euler", "euler_ancestral", "dpm_2", "dpmpp_2m", "dpmpp_sde"],
    schedulers: ["normal", "karras", "exponential", "simple", "ddim_uniform"],
  };

  it("merges inventory samplers into sampler_name enum control", () => {
    const result = enrichEnumOptions(samplerControl, inventory);
    // Should contain all static + inventory samplers
    expect(result).toContain("euler");
    expect(result).toContain("euler_ancestral");
    expect(result).toContain("dpm_2");
    expect(result).toContain("dpmpp_2m");
    expect(result).toContain("dpmpp_sde");
    // No duplicates
    expect(result.filter((o) => o === "euler").length).toBe(1);
  });

  it("merges inventory schedulers into scheduler enum control", () => {
    const result = enrichEnumOptions(schedulerControl, inventory);
    expect(result).toContain("normal");
    expect(result).toContain("karras");
    expect(result).toContain("simple");
    expect(result).toContain("ddim_uniform");
    // No duplicates
    expect(result.filter((o) => o === "normal").length).toBe(1);
  });

  it("returns empty array for non-enum controls", () => {
    expect(enrichEnumOptions(numberControl, inventory)).toEqual([]);
  });

  it("returns empty array for enum controls without options", () => {
    const noOptsControl = { ...samplerControl, options: undefined };
    expect(enrichEnumOptions(noOptsControl, inventory)).toEqual([]);
  });

  it("returns base options when inventory has no samplers", () => {
    const emptyInv: ModelInventory = {};
    const result = enrichEnumOptions(samplerControl, emptyInv);
    expect(result).toEqual(["euler", "euler_ancestral", "dpm_2"]);
  });

  it("returns base options when inventory has no schedulers", () => {
    const emptyInv: ModelInventory = {};
    const result = enrichEnumOptions(schedulerControl, emptyInv);
    expect(result).toEqual(["normal", "karras", "exponential"]);
  });
});

// ---------------------------------------------------------------------------
// MODEL_CATEGORY_LABELS
// ---------------------------------------------------------------------------

describe("MODEL_CATEGORY_LABELS", () => {
  it("has a label for every model category", () => {
    const categories: ModelCategory[] = [
      "checkpoint",
      "lora",
      "vae",
      "controlnet",
      "upscale",
      "clip",
      "unet",
      "ipadapter",
      "embedding",
      "gligen",
      "hypernetwork",
      "diffusers",
      "animatediff",
      "video",
      "style",
    ];
    for (const cat of categories) {
      expect(MODEL_CATEGORY_LABELS[cat]).toBeDefined();
      expect(MODEL_CATEGORY_LABELS[cat].length).toBeGreaterThan(0);
    }
  });

  it("produces readable labels", () => {
    expect(MODEL_CATEGORY_LABELS.checkpoint).toBe("Checkpoints");
    expect(MODEL_CATEGORY_LABELS.lora).toBe("LoRAs");
    expect(
      (MODEL_CATEGORY_LABELS as Record<string, string>).embedded,
    ).toBeUndefined(); // embedding, not embedded
    expect(MODEL_CATEGORY_LABELS.embedding).toBe("Embeddings");
    expect(MODEL_CATEGORY_LABELS.animatediff).toBe("AnimateDiff Models");
    expect(MODEL_CATEGORY_LABELS.hypernetwork).toBe("Hypernetworks");
    expect(MODEL_CATEGORY_LABELS.gligen).toBe("GLIGEN Models");
  });
});

// ---------------------------------------------------------------------------
// getModelCategoryLabel
// ---------------------------------------------------------------------------

describe("getModelCategoryLabel", () => {
  it("returns correct label for known categories", () => {
    expect(getModelCategoryLabel("checkpoint")).toBe("Checkpoints");
    expect(getModelCategoryLabel("lora")).toBe("LoRAs");
    expect(getModelCategoryLabel("ipadapter")).toBe("IP-Adapters");
  });

  it("falls back to title-casing for unknown categories", () => {
    // The fallback uses deriveLabel which converts snake_case to Title Case
    expect(getModelCategoryLabel("video")).toBe("Video Models");
    expect(getModelCategoryLabel("style")).toBe("Style Models");
  });
});

// ---------------------------------------------------------------------------
// validateAllControls
// ---------------------------------------------------------------------------

describe("validateAllControls", () => {
  const richInventory: ModelInventory = {
    checkpoints: ["sdxl_base.safetensors", "dreamshaper_v8.safetensors"],
    loras: ["style_lora.safetensors"],
    vaes: ["vae-ft-mse.safetensors"],
    embeddings: ["easy-negative.safetensors"],
    animatediff_models: ["v3_sd15_mm.ckpt"],
    gligen: ["gligen_sd14.safetensors"],
    hypernetworks: ["hyper.safetensors"],
    style_models: ["style.safetensors"],
  };

  it("returns zero counts for controls with no model kind", () => {
    const controls: ControlSchema[] = [
      {
        key: "4.seed",
        nodeId: "4",
        inputKey: "seed",
        classType: "KSampler",
        kind: "seed",
        label: "Seed",
        group: "Sampling",
        defaultValue: 42,
        visible: true,
        order: 110,
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
    const summary = validateAllControls(controls, richInventory);
    expect(summary.total).toBe(0);
    expect(summary.valid).toBe(0);
    expect(summary.invalid).toBe(0);
    expect(summary.unknown).toBe(0);
    expect(summary.details).toEqual([]);
  });

  it("validates valid model controls", () => {
    const controls: ControlSchema[] = [
      {
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
      },
    ];
    const summary = validateAllControls(controls, richInventory);
    expect(summary.total).toBe(1);
    expect(summary.valid).toBe(1);
    expect(summary.invalid).toBe(0);
    expect(summary.unknown).toBe(0);
  });

  it("detects invalid model controls", () => {
    const controls: ControlSchema[] = [
      {
        key: "1.ckpt_name",
        nodeId: "1",
        inputKey: "ckpt_name",
        classType: "CheckpointLoaderSimple",
        kind: "model",
        label: "Checkpoint",
        group: "Model Loading",
        defaultValue: "missing_model.safetensors",
        modelCategory: "checkpoint",
        visible: true,
        order: 400,
      },
    ];
    const summary = validateAllControls(controls, richInventory);
    expect(summary.total).toBe(1);
    expect(summary.valid).toBe(0);
    expect(summary.invalid).toBe(1);
    expect(summary.details).toHaveLength(1);
    expect(summary.details[0].key).toBe("1.ckpt_name");
    expect(summary.details[0].isValid).toBe(false);
    expect(summary.details[0].currentValue).toBe("missing_model.safetensors");
  });

  it("tracks unknown categories (no inventory data)", () => {
    const controls: ControlSchema[] = [
      {
        key: "2.lora_name",
        nodeId: "2",
        inputKey: "lora_name",
        classType: "LoraLoader",
        kind: "model",
        label: "LoRA",
        group: "LoRA",
        defaultValue: "some_lora.safetensors",
        modelCategory: "lora",
        visible: true,
        order: 410,
      },
    ];
    const emptyInv: ModelInventory = {};
    const summary = validateAllControls(controls, emptyInv);
    expect(summary.total).toBe(1);
    expect(summary.unknown).toBe(1);
    expect(summary.valid).toBe(0);
    expect(summary.invalid).toBe(0);
  });

  it("handles mixed valid/invalid/unknown controls", () => {
    const controls: ControlSchema[] = [
      {
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
      },
      {
        key: "1b.ckpt_name",
        nodeId: "1b",
        inputKey: "ckpt_name",
        classType: "CheckpointLoaderSimple",
        kind: "model",
        label: "Checkpoint",
        group: "Model Loading",
        defaultValue: "missing.safetensors",
        modelCategory: "checkpoint",
        visible: true,
        order: 401,
      },
      {
        key: "3.embed_name",
        nodeId: "3",
        inputKey: "embed_name",
        classType: "SomeNode",
        kind: "model",
        label: "Embedding",
        group: "Embeddings",
        defaultValue: "embed.safetensors",
        modelCategory: "embedding",
        visible: true,
        order: 540,
      },
    ];
    // Available inventory has checkpoints but embedding inventory is listed
    const inv: ModelInventory = {
      checkpoints: ["sdxl_base.safetensors"],
      embeddings: ["easy-negative.safetensors"],
    };
    const summary = validateAllControls(controls, inv);
    expect(summary.total).toBe(3);
    expect(summary.valid).toBe(1); // valid checkpoint
    expect(summary.invalid).toBe(2); // invalid checkpoint + invalid embedding
    // Only invalid entries appear in details
    expect(summary.details).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// buildDefaultsMapFromControls
// ---------------------------------------------------------------------------

describe("buildDefaultsMapFromControls", () => {
  it("builds a defaults map from controls", () => {
    const controls: ControlSchema[] = [
      {
        key: "4.seed",
        nodeId: "4",
        inputKey: "seed",
        classType: "KSampler",
        kind: "seed",
        label: "Seed",
        group: "Sampling",
        defaultValue: 42,
        visible: true,
        order: 110,
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
      {
        key: "4.model",
        nodeId: "4",
        inputKey: "model",
        classType: "KSampler",
        kind: "link",
        label: "Model",
        group: "Sampling",
        defaultValue: ["1", 0],
        visible: false,
        order: 150,
      },
    ];

    const map = buildDefaultsMapFromControls(controls);
    expect(map["4.seed"]).toBe(42);
    expect(map["4.steps"]).toBe(20);
    // Link controls are excluded
    expect(map["4.model"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeOverrideDiff
// ---------------------------------------------------------------------------

describe("computeOverrideDiff", () => {
  it("returns entries where override differs from default", () => {
    const controls: ControlSchema[] = [
      {
        key: "4.seed",
        nodeId: "4",
        inputKey: "seed",
        classType: "KSampler",
        kind: "seed",
        label: "Seed",
        group: "Sampling",
        defaultValue: 42,
        visible: true,
        order: 110,
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

    const overrides = { "4.seed": 999, "4.steps": 20 };
    const diff = computeOverrideDiff(controls, overrides);

    // Only seed differs from default
    expect(diff["4.seed"]).toBeDefined();
    expect(diff["4.seed"].defaultValue).toBe(42);
    expect(diff["4.seed"].overrideValue).toBe(999);
    // steps override equals default, so not in diff
    expect(diff["4.steps"]).toBeUndefined();
  });

  it("returns empty for no overrides", () => {
    const controls: ControlSchema[] = [
      {
        key: "4.seed",
        nodeId: "4",
        inputKey: "seed",
        classType: "KSampler",
        kind: "seed",
        label: "Seed",
        group: "Sampling",
        defaultValue: 42,
        visible: true,
        order: 110,
      },
    ];
    const diff = computeOverrideDiff(controls, {});
    expect(Object.keys(diff)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deriveControlSubtype
// ---------------------------------------------------------------------------

describe("deriveControlSubtype", () => {
  it("detects mask subtype for mask inputs", () => {
    const ctrl: ControlSchema = {
      key: "6.mask",
      nodeId: "6",
      inputKey: "mask",
      classType: "LoadImageMask",
      kind: "image",
      label: "Mask",
      group: "Image Input",
      defaultValue: "mask.png",
      visible: true,
      order: 600,
    };
    expect(deriveControlSubtype(ctrl)).toBe("mask");
  });

  it("detects mask subtype for _mask suffix keys", () => {
    const ctrl: ControlSchema = {
      key: "6.input_mask",
      nodeId: "6",
      inputKey: "input_mask",
      classType: "SomeNode",
      kind: "image",
      label: "Input Mask",
      group: "Image Input",
      defaultValue: "",
      visible: true,
      order: 600,
    };
    expect(deriveControlSubtype(ctrl)).toBe("mask");
  });

  it("detects reference subtype for IPAdapter image_emb", () => {
    const ctrl: ControlSchema = {
      key: "2.image_emb",
      nodeId: "2",
      inputKey: "image_emb",
      classType: "IPAdapterAdvanced",
      kind: "image",
      label: "Image Emb",
      group: "IP-Adapter",
      defaultValue: "ref.png",
      visible: true,
      order: 510,
    };
    expect(deriveControlSubtype(ctrl)).toBe("reference");
  });

  it("detects reference subtype for reference_image key", () => {
    const ctrl: ControlSchema = {
      key: "7.reference_image",
      nodeId: "7",
      inputKey: "reference_image",
      classType: "SomeNode",
      kind: "image",
      label: "Reference Image",
      group: "Image Input",
      defaultValue: "",
      visible: true,
      order: 600,
    };
    expect(deriveControlSubtype(ctrl)).toBe("reference");
  });

  it("detects generic image subtype for plain image keys", () => {
    const ctrl: ControlSchema = {
      key: "6.image",
      nodeId: "6",
      inputKey: "image",
      classType: "LoadImage",
      kind: "image",
      label: "Image",
      group: "Image Input",
      defaultValue: "photo.png",
      visible: true,
      order: 600,
    };
    expect(deriveControlSubtype(ctrl)).toBe("image");
  });

  it("detects video subtype for video_path", () => {
    const ctrl: ControlSchema = {
      key: "1.video_path",
      nodeId: "1",
      inputKey: "video_path",
      classType: "VHS_LoadVideo",
      kind: "file",
      label: "Video File",
      group: "Video",
      defaultValue: "input/vid.mp4",
      visible: true,
      order: 530,
    };
    expect(deriveControlSubtype(ctrl)).toBe("video");
  });

  it("detects audio subtype for audio_path", () => {
    const ctrl: ControlSchema = {
      key: "1.audio_path",
      nodeId: "1",
      inputKey: "audio_path",
      classType: "VHS_LoadAudio",
      kind: "file",
      label: "Audio File",
      group: "Video",
      defaultValue: "input/audio.mp3",
      visible: true,
      order: 530,
    };
    expect(deriveControlSubtype(ctrl)).toBe("audio");
  });

  it("detects animation subtype for AnimateDiff model_path", () => {
    const ctrl: ControlSchema = {
      key: "2.model_path",
      nodeId: "2",
      inputKey: "model_path",
      classType: "AnimateDiffLoaderWithContext",
      kind: "file",
      label: "Motion Model",
      group: "AnimateDiff",
      defaultValue: "v3_sd15_mm.ckpt",
      visible: true,
      order: 520,
    };
    expect(deriveControlSubtype(ctrl)).toBe("animation");
  });

  it("detects model-file subtype for generic _path file keys", () => {
    const ctrl: ControlSchema = {
      key: "5.clip_path",
      nodeId: "5",
      inputKey: "clip_path",
      classType: "SomeNode",
      kind: "file",
      label: "Clip Path",
      group: "Model Loading",
      defaultValue: "",
      visible: true,
      order: 400,
    };
    expect(deriveControlSubtype(ctrl)).toBe("model-file");
  });

  it("returns generic for non-image/non-file controls", () => {
    const ctrl: ControlSchema = {
      key: "4.seed",
      nodeId: "4",
      inputKey: "seed",
      classType: "KSampler",
      kind: "seed",
      label: "Seed",
      group: "Sampling",
      defaultValue: 42,
      visible: true,
      order: 110,
    };
    expect(deriveControlSubtype(ctrl)).toBe("generic");
  });
});

// ---------------------------------------------------------------------------
// getSubtypeHint
// ---------------------------------------------------------------------------

describe("getSubtypeHint", () => {
  it("returns correct hints for each subtype", () => {
    expect(getSubtypeHint("image")).toBe(
      "Image filename from ComfyUI input folder",
    );
    expect(getSubtypeHint("mask")).toBe(
      "Mask filename from ComfyUI input folder",
    );
    expect(getSubtypeHint("reference")).toBe(
      "Reference image filename from ComfyUI input folder",
    );
    expect(getSubtypeHint("video")).toBe(
      "Video file from ComfyUI input folder",
    );
    expect(getSubtypeHint("audio")).toBe(
      "Audio file from ComfyUI input folder",
    );
    expect(getSubtypeHint("animation")).toBe("AnimateDiff motion model file");
    expect(getSubtypeHint("model-file")).toBe("Model file path");
    expect(getSubtypeHint("generic")).toBe("File from ComfyUI input folder");
  });
});

// ---------------------------------------------------------------------------
// SUBTYPE_EXTENSIONS
// ---------------------------------------------------------------------------

describe("SUBTYPE_EXTENSIONS", () => {
  it("has extensions for all subtypes", () => {
    const subtypes = [
      "image",
      "mask",
      "reference",
      "video",
      "audio",
      "animation",
      "model-file",
      "generic",
    ] as const;
    for (const st of subtypes) {
      expect(SUBTYPE_EXTENSIONS[st]).toBeDefined();
      expect(Array.isArray(SUBTYPE_EXTENSIONS[st])).toBe(true);
    }
  });

  it("video includes common video formats", () => {
    expect(SUBTYPE_EXTENSIONS.video).toContain(".mp4");
    expect(SUBTYPE_EXTENSIONS.video).toContain(".webm");
  });

  it("audio includes common audio formats", () => {
    expect(SUBTYPE_EXTENSIONS.audio).toContain(".mp3");
    expect(SUBTYPE_EXTENSIONS.audio).toContain(".wav");
  });

  it("image includes common image formats", () => {
    expect(SUBTYPE_EXTENSIONS.image).toContain(".png");
    expect(SUBTYPE_EXTENSIONS.image).toContain(".jpg");
  });

  it("generic is empty array", () => {
    expect(SUBTYPE_EXTENSIONS.generic).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findControlByKey
// ---------------------------------------------------------------------------

describe("findControlByKey", () => {
  it("finds a control by key", () => {
    const controls: ControlSchema[] = [
      {
        key: "4.seed",
        nodeId: "4",
        inputKey: "seed",
        classType: "KSampler",
        kind: "seed",
        label: "Seed",
        group: "Sampling",
        defaultValue: 42,
        visible: true,
        order: 110,
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
    const ctrl = findControlByKey(controls, "4.steps");
    expect(ctrl).toBeDefined();
    expect(ctrl!.inputKey).toBe("steps");
  });

  it("returns undefined for missing key", () => {
    const controls: ControlSchema[] = [];
    const ctrl = findControlByKey(controls, "nonexistent");
    expect(ctrl).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration — buildControlSchema with validation
// ---------------------------------------------------------------------------

describe("Integration — build full workflow with extended categories", () => {
  it("produces model controls for all extended categories and validates them", () => {
    const workflow = makeWorkflow({
      "1": makeNode("CheckpointLoaderSimple", {
        ckpt_name: "sdxl_base.safetensors",
      }),
      "2": makeNode("HypernetworkLoader", {
        hypernetwork_name: "hyper.safetensors",
        strength: 1.0,
      }),
      "3": makeNode("GLIGENLoader", { gligen_name: "gligen_sd14.safetensors" }),
      "4": makeNode("StyleModelLoader", {
        style_model_name: "style.safetensors",
      }),
    });

    const result = buildControlSchema(workflow);

    // Check model categories
    const ckpt = result.controls.find((c) => c.inputKey === "ckpt_name");
    expect(ckpt?.kind).toBe("model");
    expect(ckpt?.modelCategory).toBe("checkpoint");

    const hyper = result.controls.find(
      (c) => c.inputKey === "hypernetwork_name",
    );
    expect(hyper?.kind).toBe("model");
    expect(hyper?.modelCategory).toBe("hypernetwork");

    const gligen = result.controls.find((c) => c.inputKey === "gligen_name");
    expect(gligen?.kind).toBe("model");
    expect(gligen?.modelCategory).toBe("gligen");

    const style = result.controls.find(
      (c) => c.inputKey === "style_model_name",
    );
    expect(style?.kind).toBe("model");
    expect(style?.modelCategory).toBe("style");

    // Validate against extended inventory
    const inventory: ModelInventory = {
      checkpoints: ["sdxl_base.safetensors"],
      hypernetworks: ["hyper.safetensors"],
      gligen: ["gligen_sd14.safetensors"],
      style_models: ["style.safetensors"],
    };
    const summary = validateAllControls(result.controls, inventory);
    expect(summary.total).toBe(4);
    expect(summary.valid).toBe(4);
    expect(summary.invalid).toBe(0);
  });

  it("detects invalid models across categories in validation summary", () => {
    const workflow = makeWorkflow({
      "1": makeNode("CheckpointLoaderSimple", {
        ckpt_name: "missing_checkpoint.safetensors",
      }),
      "2": makeNode("GLIGENLoader", {
        gligen_name: "missing_gligen.safetensors",
      }),
    });

    const result = buildControlSchema(workflow);
    const inventory: ModelInventory = {
      checkpoints: ["other_model.safetensors"],
      gligen: ["other_gligen.safetensors"],
    };

    const summary = validateAllControls(result.controls, inventory);
    expect(summary.total).toBe(2);
    expect(summary.invalid).toBe(2);
    expect(summary.valid).toBe(0);
    expect(summary.details).toHaveLength(2);
    expect(summary.details.every((d) => !d.isValid)).toBe(true);
  });
});

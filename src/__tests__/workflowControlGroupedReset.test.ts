/**
 * Tests for eleventh-pass slice B: grouped reset/apply affordances,
 * richer changed-control summary, and extended safe validation.
 *
 * Covers:
 * - resetGroupOverrides store action
 * - computeGroupedOverrideSummary
 * - collectGroupKeys
 * - validateAllControlsExtended (covers image + file validation)
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  computeGroupedOverrideSummary,
  collectGroupKeys,
  validateAllControlsExtended,
  validateAllControls,
  type ControlSchema,
  type LocalInventory,
  type GroupOverrideSummary,
  type ExtendedValidationSummary,
} from "@/lib/oj/workflowControlSchema";
import {
  useWorkflowControlStore,
  type ControlOverrides,
} from "@/store/workflowControlStore";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const samplingSeed: ControlSchema = {
  key: "4.seed",
  nodeId: "4",
  inputKey: "seed",
  classType: "KSampler",
  kind: "seed",
  label: "Seed",
  group: "Sampling",
  defaultValue: 42,
  min: 0,
  max: 0xffffffff,
  step: 1,
  visible: true,
  order: 110,
};

const samplingSteps: ControlSchema = {
  key: "4.steps",
  nodeId: "4",
  inputKey: "steps",
  classType: "KSampler",
  kind: "number",
  label: "Steps",
  group: "Sampling",
  defaultValue: 20,
  min: 1,
  max: 150,
  step: 1,
  visible: true,
  order: 120,
};

const samplingCfg: ControlSchema = {
  key: "4.cfg",
  nodeId: "4",
  inputKey: "cfg",
  classType: "KSampler",
  kind: "number",
  label: "CFG Scale",
  group: "Sampling",
  defaultValue: 7.0,
  min: 0,
  max: 30,
  step: 0.5,
  visible: true,
  order: 130,
};

const checkpointModel: ControlSchema = {
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

const loraModel: ControlSchema = {
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

const imageControl: ControlSchema = {
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

const maskControl: ControlSchema = {
  key: "6.mask",
  nodeId: "6",
  inputKey: "mask",
  classType: "LoadImageMask",
  kind: "image",
  label: "Mask",
  group: "Image Input",
  defaultValue: "mask_image.png",
  visible: true,
  order: 601,
};

const videoControl: ControlSchema = {
  key: "10.video_path",
  nodeId: "10",
  inputKey: "video_path",
  classType: "VHS_LoadVideo",
  kind: "file",
  label: "Video File",
  group: "Video",
  defaultValue: "input_video.mp4",
  visible: true,
  order: 530,
};

const widthControl: ControlSchema = {
  key: "5.width",
  nodeId: "5",
  inputKey: "width",
  classType: "EmptyLatentImage",
  kind: "number",
  label: "Width",
  group: "Dimensions",
  defaultValue: 1024,
  min: 64,
  max: 8192,
  step: 8,
  visible: true,
  order: 310,
};

const allControls: ControlSchema[] = [
  samplingSeed,
  samplingSteps,
  samplingCfg,
  checkpointModel,
  loraModel,
  imageControl,
  maskControl,
  videoControl,
  widthControl,
];

const richInventory: LocalInventory = {
  checkpoints: ["sdxl_base.safetensors", "dreamshaper_v8.safetensors"],
  loras: ["style_lora.safetensors"],
  vaes: ["vae-ft-mse.safetensors"],
  input_images: ["photo.png", "landscape.jpg", "portrait.webp", "mask_image.png"],
  input_videos: ["input_video.mp4"],
  input_audios: [],
};

const emptyInventory: LocalInventory = {};

// ---------------------------------------------------------------------------
// resetGroupOverrides
// ---------------------------------------------------------------------------

describe("resetGroupOverrides", () => {
  beforeEach(() => {
    useWorkflowControlStore.setState({ overrides: {} });
  });

  it("removes only overrides matching the provided group keys", () => {
    const store = useWorkflowControlStore.getState();
    store.setOverride("pack::flux::t2i", "4.seed", 999);
    store.setOverride("pack::flux::t2i", "4.steps", 50);
    store.setOverride("pack::flux::t2i", "5.width", 768);

    // Reset Sampling group (seed + steps)
    const samplingKeys = new Set(["4.seed", "4.steps"]);
    store.resetGroupOverrides("pack::flux::t2i", samplingKeys);

    const updated = useWorkflowControlStore.getState();
    const overrides = updated.overrides["pack::flux::t2i"];
    expect(overrides).toBeDefined();
    expect(overrides["4.seed"]).toBeUndefined();
    expect(overrides["4.steps"]).toBeUndefined();
    expect(overrides["5.width"]).toBe(768);
  });

  it("cleans up selection when all overrides are removed from a group", () => {
    const store = useWorkflowControlStore.getState();
    store.setOverride("pack::flux::t2i", "4.seed", 999);

    const samplingKeys = new Set(["4.seed"]);
    store.resetGroupOverrides("pack::flux::t2i", samplingKeys);

    const updated = useWorkflowControlStore.getState();
    // All overrides for this selection should be cleaned up
    expect(updated.overrides["pack::flux::t2i"]).toBeUndefined();
  });

  it("is a no-op when no overrides match the group keys", () => {
    const store = useWorkflowControlStore.getState();
    store.setOverride("pack::flux::t2i", "4.seed", 999);

    const dimensionKeys = new Set(["5.width"]);
    store.resetGroupOverrides("pack::flux::t2i", dimensionKeys);

    const updated = useWorkflowControlStore.getState();
    expect(updated.overrides["pack::flux::t2i"]["4.seed"]).toBe(999);
  });

  it("is a no-op when the selection has no overrides", () => {
    const store = useWorkflowControlStore.getState();
    const keys = new Set(["4.seed"]);
    store.resetGroupOverrides("pack::flux::t2i", keys);

    const updated = useWorkflowControlStore.getState();
    expect(updated.overrides["pack::flux::t2i"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeGroupedOverrideSummary
// ---------------------------------------------------------------------------

describe("computeGroupedOverrideSummary", () => {
  it("returns empty array when no overrides exist", () => {
    const summary = computeGroupedOverrideSummary(allControls, {});
    expect(summary).toEqual([]);
  });

  it("groups overrides by their control group", () => {
    const overrides = {
      "4.seed": 999,
      "4.steps": 50,
      "5.width": 768,
    };

    const summary = computeGroupedOverrideSummary(allControls, overrides);
    expect(summary).toHaveLength(2); // Sampling + Dimensions

    const samplingGroup = summary.find((g) => g.group === "Sampling");
    expect(samplingGroup).toBeDefined();
    expect(samplingGroup!.overrideCount).toBe(2);
    expect(samplingGroup!.changes).toHaveLength(2);
    expect(samplingGroup!.changes[0].label).toBe("Seed");
    expect(samplingGroup!.changes[1].label).toBe("Steps");

    const dimGroup = summary.find((g) => g.group === "Dimensions");
    expect(dimGroup).toBeDefined();
    expect(dimGroup!.overrideCount).toBe(1);
  });

  it("skips overrides whose key doesn't match any control", () => {
    const overrides = {
      "99.phantom": "ghost",
      "4.seed": 123,
    };
    const summary = computeGroupedOverrideSummary(allControls, overrides);
    expect(summary).toHaveLength(1);
    expect(summary[0].group).toBe("Sampling");
  });

  it("skips overrides that equal the default value", () => {
    const overrides = {
      "4.seed": 42, // same as default
      "4.steps": 50, // different from default
    };
    const summary = computeGroupedOverrideSummary(allControls, overrides);
    expect(summary).toHaveLength(1);
    expect(summary[0].overrideCount).toBe(1);
    expect(summary[0].changes[0].key).toBe("4.steps");
  });

  it("sorts groups in canonical order", () => {
    const overrides = {
      "5.width": 768,
      "4.seed": 999,
      "1.ckpt_name": "other_model.safetensors",
    };

    const summary = computeGroupedOverrideSummary(allControls, overrides);
    const groupNames = summary.map((g) => g.group);
    // Canonical order: Sampling (100) < Dimensions (300) < Model Loading (400)
    expect(groupNames.indexOf("Sampling")).toBeLessThan(groupNames.indexOf("Dimensions"));
    expect(groupNames.indexOf("Dimensions")).toBeLessThan(groupNames.indexOf("Model Loading"));
  });

  it("includes kind and both values in change details", () => {
    const overrides = { "4.cfg": 3.5 };
    const summary = computeGroupedOverrideSummary(allControls, overrides);
    expect(summary).toHaveLength(1);
    const change = summary[0].changes[0];
    expect(change.kind).toBe("number");
    expect(change.defaultValue).toBe(7.0);
    expect(change.overrideValue).toBe(3.5);
  });
});

// ---------------------------------------------------------------------------
// collectGroupKeys
// ---------------------------------------------------------------------------

describe("collectGroupKeys", () => {
  it("collects all keys for a given group", () => {
    const keys = collectGroupKeys(allControls, "Sampling");
    expect(keys.has("4.seed")).toBe(true);
    expect(keys.has("4.steps")).toBe(true);
    expect(keys.has("4.cfg")).toBe(true);
    expect(keys.size).toBe(3);
  });

  it("returns empty set for unknown group", () => {
    const keys = collectGroupKeys(allControls, "Nonexistent");
    expect(keys.size).toBe(0);
  });

  it("returns correct keys for Model Loading group", () => {
    const keys = collectGroupKeys(allControls, "Model Loading");
    expect(keys.has("1.ckpt_name")).toBe(true);
    expect(keys.size).toBe(1);
  });

  it("returns correct keys for Image Input group", () => {
    const keys = collectGroupKeys(allControls, "Image Input");
    expect(keys.has("6.image")).toBe(true);
    expect(keys.has("6.mask")).toBe(true);
    expect(keys.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// validateAllControlsExtended
// ---------------------------------------------------------------------------

describe("validateAllControlsExtended", () => {
  it("returns zero invalid when all models are present in inventory", () => {
    const summary = validateAllControlsExtended(allControls, richInventory);
    expect(summary.modelTotal).toBe(2); // checkpoint + lora
    expect(summary.modelValidation.valid).toBe(2);
    expect(summary.modelValidation.invalid).toBe(0);
    expect(summary.totalInvalid).toBe(0);
  });

  it("detects invalid model controls", () => {
    const controls: ControlSchema[] = [
      { ...checkpointModel, defaultValue: "missing_model.safetensors" },
    ];
    const summary = validateAllControlsExtended(controls, richInventory);
    expect(summary.modelValidation.invalid).toBe(1);
    expect(summary.totalInvalid).toBe(1);
  });

  it("detects invalid image controls", () => {
    const controls: ControlSchema[] = [
      { ...imageControl, defaultValue: "nonexistent_photo.png" },
    ];
    const summary = validateAllControlsExtended(controls, richInventory);
    expect(summary.fileTotal).toBe(1);
    expect(summary.fileValidation).toHaveLength(1);
    expect(summary.fileValidation[0].isValid).toBe(false);
    expect(summary.fileValidation[0].kind).toBe("image");
    expect(summary.totalInvalid).toBe(1);
  });

  it("detects invalid file controls (video)", () => {
    const controls: ControlSchema[] = [
      { ...videoControl, defaultValue: "missing_video.mp4" },
    ];
    const summary = validateAllControlsExtended(controls, richInventory);
    expect(summary.fileTotal).toBe(1);
    expect(summary.fileValidation).toHaveLength(1);
    expect(summary.fileValidation[0].isValid).toBe(false);
    expect(summary.fileValidation[0].kind).toBe("file");
    expect(summary.fileValidation[0].categoryLabel).toBe("Input Videos");
  });

  it("includes both model and file invalid in totalInvalid", () => {
    const controls: ControlSchema[] = [
      { ...checkpointModel, defaultValue: "missing.safetensors" },
      { ...imageControl, defaultValue: "missing_image.png" },
      { ...videoControl, defaultValue: "missing_video.mp4" },
    ];
    const summary = validateAllControlsExtended(controls, richInventory);
    // 1 invalid model + 1 invalid image + 1 invalid video
    expect(summary.totalInvalid).toBe(3);
    expect(summary.modelValidation.invalid).toBe(1);
    expect(summary.fileValidation).toHaveLength(2); // image + video invalid
  });

  it("returns valid for images present in inventory", () => {
    const controls: ControlSchema[] = [imageControl];
    const summary = validateAllControlsExtended(controls, richInventory);
    expect(summary.fileTotal).toBe(1);
    expect(summary.fileValidation).toHaveLength(0); // no invalid entries
    expect(summary.totalInvalid).toBe(0);
  });

  it("returns fileTotal=0 when inventory has no image/file data", () => {
    const controls: ControlSchema[] = [imageControl, videoControl];
    const emptyInv: LocalInventory = {};
    const summary = validateAllControlsExtended(controls, emptyInv);
    // No inventory data means unknown validity for images/videos
    expect(summary.fileTotal).toBe(0);
    expect(summary.fileValidation).toHaveLength(0);
    // Unknown means assumed valid
    expect(summary.totalInvalid).toBe(0);
  });

  it("handles mask controls (image subtype) with inventory", () => {
    const controls: ControlSchema[] = [maskControl];
    const summary = validateAllControlsExtended(controls, richInventory);
    expect(summary.fileTotal).toBe(1);
    // mask_image.png is in inventory
    expect(summary.fileValidation).toHaveLength(0);
  });

  it("detects invalid mask not in inventory", () => {
    const controls: ControlSchema[] = [
      { ...maskControl, defaultValue: "nonexistent_mask.png" },
    ];
    const summary = validateAllControlsExtended(controls, richInventory);
    expect(summary.fileTotal).toBe(1);
    expect(summary.fileValidation).toHaveLength(1);
    expect(summary.fileValidation[0].label).toBe("Mask");
  });

  it("skips non-model/image/file controls in validation", () => {
    const scalarControls: ControlSchema[] = [
      samplingSeed,
      samplingSteps,
      samplingCfg,
      widthControl,
    ];
    const summary = validateAllControlsExtended(scalarControls, richInventory);
    expect(summary.modelTotal).toBe(0);
    expect(summary.fileTotal).toBe(0);
    expect(summary.totalInvalid).toBe(0);
  });

  it("model modelValidation details include invalid models", () => {
    const controls: ControlSchema[] = [
      { ...checkpointModel, defaultValue: "not_found.safetensors" },
      { ...loraModel, defaultValue: "also_not_found.safetensors" },
    ];
    const summary = validateAllControlsExtended(controls, richInventory);
    expect(summary.modelValidation.invalid).toBe(2);
    expect(summary.modelValidation.details).toHaveLength(2);
    expect(summary.modelValidation.details[0].modelCategory).toBe("checkpoint");
    expect(summary.modelValidation.details[1].modelCategory).toBe("lora");
  });

  it("handles mixed valid and invalid controls across all types", () => {
    const controls: ControlSchema[] = [
      checkpointModel, // valid
      { ...loraModel, defaultValue: "missing_lora.safetensors" }, // invalid model
      imageControl, // valid
      { ...maskControl, defaultValue: "missing_mask.png" }, // invalid image
      videoControl, // valid
      samplingSeed, // not validated (seed kind)
    ];
    const summary = validateAllControlsExtended(controls, richInventory);
    // Models: 1 valid, 1 invalid
    expect(summary.modelValidation.valid).toBe(1);
    expect(summary.modelValidation.invalid).toBe(1);
    // Files: 3 total (2 images + 1 video), 1 invalid
    expect(summary.fileTotal).toBe(3);
    expect(summary.fileValidation).toHaveLength(1);
    expect(summary.totalInvalid).toBe(2); // 1 model + 1 image
  });
});

// ---------------------------------------------------------------------------
// Integration: group summary → group reset round-trip
// ---------------------------------------------------------------------------

describe("Integration: group summary → group reset round-trip", () => {
  beforeEach(() => {
    useWorkflowControlStore.setState({ overrides: {} });
  });

  it("computes summary, then resets a specific group via store", () => {
    const store = useWorkflowControlStore.getState();
    const sel = "pack::flux::t2i";

    // Set overrides across multiple groups
    store.setOverride(sel, "4.seed", 999);
    store.setOverride(sel, "4.steps", 50);
    store.setOverride(sel, "5.width", 768);
    store.setOverride(sel, "1.ckpt_name", "other_model.safetensors");

    const overrides = store.getOverridesForSelection(sel);

    // Compute grouped summary
    const summary = computeGroupedOverrideSummary(allControls, overrides);
    expect(summary).toHaveLength(3); // Sampling, Model Loading, Dimensions

    // Reset only Sampling group
    const samplingKeys = collectGroupKeys(allControls, "Sampling");
    store.resetGroupOverrides(sel, samplingKeys);

    const updated = useWorkflowControlStore.getState();
    const remaining = updated.overrides[sel];
    expect(remaining["4.seed"]).toBeUndefined();
    expect(remaining["4.steps"]).toBeUndefined();
    expect(remaining["5.width"]).toBe(768);
    expect(remaining["1.ckpt_name"]).toBe("other_model.safetensors");

    // After reset, re-compute summary should only have 2 groups
    const newOverrides = updated.overrides[sel];
    const newSummary = computeGroupedOverrideSummary(allControls, newOverrides);
    expect(newSummary).toHaveLength(2);
    expect(newSummary.find((g) => g.group === "Sampling")).toBeUndefined();
  });
});
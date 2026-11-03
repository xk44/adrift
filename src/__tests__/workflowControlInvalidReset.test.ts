/**
 * Tests for twelfth-pass slice B: invalid-control reset affordance helpers.
 *
 * Covers:
 * - computeGroupedInvalidSummary — grouped breakdown of invalid controls
 * - collectInvalidOverrideKeys — set of overridden keys whose override is invalid
 *   but whose default is valid (safe-to-reset keys)
 * - Integration: collectInvalidOverrideKeys → store resetGroupOverrides
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  computeGroupedInvalidSummary,
  collectInvalidOverrideKeys,
  validateAllControlsExtended,
  type ControlSchema,
  type LocalInventory,
  type GroupInvalidSummary,
} from "@/lib/oj/workflowControlSchema";
import {
  useWorkflowControlStore,
  type ControlOverrides,
} from "@/store/workflowControlStore";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

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

const vaeModel: ControlSchema = {
  key: "3.vae_name",
  nodeId: "3",
  inputKey: "vae_name",
  classType: "VAELoader",
  kind: "model",
  label: "VAE",
  group: "Model Loading",
  defaultValue: "vae-ft-mse.safetensors",
  modelCategory: "vae",
  visible: true,
  order: 401,
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

const allControls: ControlSchema[] = [
  checkpointModel,
  loraModel,
  vaeModel,
  imageControl,
  videoControl,
  samplingSeed,
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
// computeGroupedInvalidSummary
// ---------------------------------------------------------------------------

describe("computeGroupedInvalidSummary", () => {
  it("returns empty array when no controls are invalid", () => {
    const overrides: ControlOverrides = {};
    const summary = computeGroupedInvalidSummary(allControls, overrides, richInventory);
    expect(summary).toEqual([]);
  });

  it("detects a single invalid model control with default value", () => {
    const controls: ControlSchema[] = [
      { ...checkpointModel, defaultValue: "missing_model.safetensors" },
    ];
    const summary = computeGroupedInvalidSummary(controls, {}, richInventory);
    expect(summary).toHaveLength(1);
    expect(summary[0].group).toBe("Model Loading");
    expect(summary[0].invalidCount).toBe(1);
    expect(summary[0].overriddenInvalidCount).toBe(0);
    expect(summary[0].items).toHaveLength(1);
    expect(summary[0].items[0].key).toBe("1.ckpt_name");
    expect(summary[0].items[0].isOverridden).toBe(false);
    expect(summary[0].items[0].currentValue).toBe("missing_model.safetensors");
  });

  it("detects an invalid override and marks it as overridden", () => {
    const controls: ControlSchema[] = [checkpointModel, loraModel];
    const overrides: ControlOverrides = {
      "1.ckpt_name": "not_installed_model.safetensors",
    };
    const summary = computeGroupedInvalidSummary(controls, overrides, richInventory);
    expect(summary).toHaveLength(1);
    expect(summary[0].group).toBe("Model Loading");
    expect(summary[0].invalidCount).toBe(1);
    expect(summary[0].overriddenInvalidCount).toBe(1);
    expect(summary[0].items[0].isOverridden).toBe(true);
    expect(summary[0].items[0].currentValue).toBe("not_installed_model.safetensors");
  });

  it("groups invalid controls across multiple groups", () => {
    const controls: ControlSchema[] = [
      { ...checkpointModel, defaultValue: "missing_ckpt.safetensors" },
      { ...loraModel, defaultValue: "missing_lora.safetensors" },
      { ...imageControl, defaultValue: "missing_image.png" },
    ];
    const summary = computeGroupedInvalidSummary(controls, {}, richInventory);
    expect(summary).toHaveLength(3);
    const groups = summary.map((g) => g.group);
    // Sorted by canonical group order
    expect(groups.indexOf("Model Loading")).toBeLessThan(groups.indexOf("LoRA"));
    expect(groups.indexOf("LoRA")).toBeLessThan(groups.indexOf("Image Input"));
  });

  it("handles both overridden and default-invalid in same group", () => {
    const controls: ControlSchema[] = [
      checkpointModel, // default is valid: sdxl_base.safetensors
      vaeModel, // default is valid: vae-ft-mse.safetensors
    ];
    const overrides: ControlOverrides = {
      "1.ckpt_name": "missing_override.safetensors",
      // vae has valid default and no override
    };
    // Also make VAE default invalid
    const controlsWithInvalidDefault: ControlSchema[] = [
      { ...checkpointModel, defaultValue: "also_missing.safetensors" },
      vaeModel,
    ];
    const overrides2: ControlOverrides = {
      "3.vae_name": "missing_vae.safetensors",
    };
    const summary = computeGroupedInvalidSummary(
      controlsWithInvalidDefault,
      overrides2,
      richInventory,
    );
    // Both in "Model Loading" group
    expect(summary).toHaveLength(1);
    expect(summary[0].group).toBe("Model Loading");
    expect(summary[0].invalidCount).toBe(2);
    expect(summary[0].overriddenInvalidCount).toBe(1); // only vae is overridden-invalid
  });

  it("detects invalid image controls", () => {
    const controls: ControlSchema[] = [
      { ...imageControl, defaultValue: "nonexistent.png" },
    ];
    const summary = computeGroupedInvalidSummary(controls, {}, richInventory);
    expect(summary).toHaveLength(1);
    expect(summary[0].group).toBe("Image Input");
    expect(summary[0].invalidCount).toBe(1);
    expect(summary[0].items[0].kind).toBe("image");
  });

  it("detects invalid file controls (video)", () => {
    const controls: ControlSchema[] = [
      { ...videoControl, defaultValue: "nonexistent_video.mp4" },
    ];
    const summary = computeGroupedInvalidSummary(controls, {}, richInventory);
    expect(summary).toHaveLength(1);
    expect(summary[0].group).toBe("Video");
    expect(summary[0].invalidCount).toBe(1);
    expect(summary[0].items[0].kind).toBe("file");
  });

  it("returns empty when inventory has no data for the control kind", () => {
    // Empty inventory means unknown = no invalid entries
    const controls: ControlSchema[] = [
      checkpointModel,
      imageControl,
    ];
    const summary = computeGroupedInvalidSummary(controls, {}, emptyInventory);
    expect(summary).toEqual([]);
  });

  it("skips scalar controls (non-resource kinds)", () => {
    const controls: ControlSchema[] = [
      samplingSeed,
    ];
    const summary = computeGroupedInvalidSummary(controls, {}, richInventory);
    expect(summary).toEqual([]);
  });

  it("sorts groups in canonical order", () => {
    const controls: ControlSchema[] = [
      { ...videoControl, defaultValue: "missing_video.mp4" },
      { ...checkpointModel, defaultValue: "missing_ckpt.safetensors" },
      { ...loraModel, defaultValue: "missing_lora.safetensors" },
    ];
    const summary = computeGroupedInvalidSummary(controls, {}, richInventory);
    const groupNames = summary.map((g) => g.group);
    // Canonical order: Model Loading (400) < LoRA (410) < Video (530)
    expect(groupNames.indexOf("Model Loading")).toBeLessThan(groupNames.indexOf("LoRA"));
    expect(groupNames.indexOf("LoRA")).toBeLessThan(groupNames.indexOf("Video"));
  });
});

// ---------------------------------------------------------------------------
// collectInvalidOverrideKeys
// ---------------------------------------------------------------------------

describe("collectInvalidOverrideKeys", () => {
  it("returns empty set when no controls are invalid", () => {
    const overrides: ControlOverrides = {};
    const keys = collectInvalidOverrideKeys(allControls, overrides, richInventory);
    expect(keys.size).toBe(0);
  });

  it("returns empty set when override value is valid", () => {
    const overrides: ControlOverrides = {
      "1.ckpt_name": "dreamshaper_v8.safetensors", // valid override
    };
    const keys = collectInvalidOverrideKeys(allControls, overrides, richInventory);
    expect(keys.size).toBe(0);
  });

  it("returns key when override is invalid and default is valid", () => {
    const overrides: ControlOverrides = {
      "1.ckpt_name": "not_installed.safetensors", // invalid override
    };
    const keys = collectInvalidOverrideKeys(allControls, overrides, richInventory);
    expect(keys.size).toBe(1);
    expect(keys.has("1.ckpt_name")).toBe(true);
  });

  it("returns empty set when default is also invalid (resetting won't help)", () => {
    // If both default AND override are invalid, resetting to default is pointless
    const controls: ControlSchema[] = [
      { ...checkpointModel, defaultValue: "also_missing.safetensors" },
    ];
    const overrides: ControlOverrides = {
      "1.ckpt_name": "not_installed_either.safetensors",
    };
    const keys = collectInvalidOverrideKeys(controls, overrides, richInventory);
    // Default is also not in inventory, so resetting won't help
    expect(keys.size).toBe(0);
  });

  it("returns key for invalid image override when default is valid", () => {
    const overrides: ControlOverrides = {
      "6.image": "nonexistent_image.png", // invalid override
    };
    const keys = collectInvalidOverrideKeys(allControls, overrides, richInventory);
    expect(keys.size).toBe(1);
    expect(keys.has("6.image")).toBe(true);
  });

  it("returns key for invalid file override when default is valid", () => {
    const overrides: ControlOverrides = {
      "10.video_path": "not_a_video.mp4",
    };
    const keys = collectInvalidOverrideKeys(allControls, overrides, richInventory);
    expect(keys.size).toBe(1);
    expect(keys.has("10.video_path")).toBe(true);
  });

  it("does not include image key when default is also invalid", () => {
    const controls: ControlSchema[] = [
      { ...imageControl, defaultValue: "also_missing.png" },
    ];
    const overrides: ControlOverrides = {
      "6.image": "nonexistent_image.png",
    };
    const keys = collectInvalidOverrideKeys(controls, overrides, richInventory);
    // Default is also not in inventory, so resetting won't help
    expect(keys.size).toBe(0);
  });

  it("handles multiple invalid overrides across different kinds", () => {
    const overrides: ControlOverrides = {
      "1.ckpt_name": "missing_ckpt.safetensors",
      "2.lora_name": "missing_lora.safetensors",
      "6.image": "missing_image.png",
    };
    const keys = collectInvalidOverrideKeys(allControls, overrides, richInventory);
    expect(keys.size).toBe(3);
    expect(keys.has("1.ckpt_name")).toBe(true);
    expect(keys.has("2.lora_name")).toBe(true);
    expect(keys.has("6.image")).toBe(true);
  });

  it("does not include valid overrides or scalar controls", () => {
    const overrides: ControlOverrides = {
      "4.seed": 999, // scalar, never validated by inventory
      "1.ckpt_name": "dreamshaper_v8.safetensors", // valid override
    };
    const keys = collectInvalidOverrideKeys(allControls, overrides, richInventory);
    expect(keys.size).toBe(0);
  });

  it("returns empty set with empty inventory (no data to validate against)", () => {
    const overrides: ControlOverrides = {
      "1.ckpt_name": "anything.safetensors",
    };
    const keys = collectInvalidOverrideKeys(allControls, overrides, emptyInventory);
    expect(keys.size).toBe(0);
  });

  it("mixed: some invalid overrides resettable, some not", () => {
    // checkpoint override is invalid, default is valid → resettable
    // lora override is invalid AND default is invalid → NOT resettable
    const controls: ControlSchema[] = [
      checkpointModel, // default sdxl_base is in inventory
      { ...loraModel, defaultValue: "missing_default_lora.safetensors" },
    ];
    const overrides: ControlOverrides = {
      "1.ckpt_name": "not_found.safetensors",
      "2.lora_name": "also_not_found.safetensors",
    };
    const keys = collectInvalidOverrideKeys(controls, overrides, richInventory);
    // Only checkpoint override should be resettable (its default is valid)
    expect(keys.size).toBe(1);
    expect(keys.has("1.ckpt_name")).toBe(true);
    expect(keys.has("2.lora_name")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: collectInvalidOverrideKeys → store.resetGroupOverrides
// ---------------------------------------------------------------------------

describe("Integration: reset invalid overrides via store", () => {
  beforeEach(() => {
    useWorkflowControlStore.setState({ overrides: {} });
  });

  it("resets only invalid override keys, leaving valid overrides intact", () => {
    const store = useWorkflowControlStore.getState();
    const sel = "pack::flux::t2i";

    // Set overrides: one invalid (checkpoint), one valid (seed)
    store.setOverride(sel, "1.ckpt_name", "not_found.safetensors");
    store.setOverride(sel, "4.seed", 999);

    const overrides = store.getOverridesForSelection(sel);
    const invalidKeys = collectInvalidOverrideKeys(allControls, overrides, richInventory);

    // Only checkpoint override should be identified as invalid-resettable
    expect(invalidKeys.size).toBe(1);
    expect(invalidKeys.has("1.ckpt_name")).toBe(true);

    // Reset invalid overrides using store action
    store.resetGroupOverrides(sel, invalidKeys);

    // Check: invalid override removed, valid override kept
    const updated = useWorkflowControlStore.getState();
    const remaining = updated.overrides[sel];
    expect(remaining["1.ckpt_name"]).toBeUndefined();
    expect(remaining["4.seed"]).toBe(999);
  });

  it("resets multiple invalid overrides across groups at once", () => {
    const store = useWorkflowControlStore.getState();
    const sel = "pack::flux::t2i";

    store.setOverride(sel, "1.ckpt_name", "missing_ckpt.safetensors");
    store.setOverride(sel, "2.lora_name", "missing_lora.safetensors");
    store.setOverride(sel, "6.image", "missing_image.png");

    const overrides = store.getOverridesForSelection(sel);
    const invalidKeys = collectInvalidOverrideKeys(allControls, overrides, richInventory);

    expect(invalidKeys.size).toBe(3);

    store.resetGroupOverrides(sel, invalidKeys);

    const updated = useWorkflowControlStore.getState();
    // All invalid overrides should be removed; selection should be cleaned up
    expect(updated.overrides[sel]).toBeUndefined();
  });

  it("does not reset overrides whose default is also invalid", () => {
    const store = useWorkflowControlStore.getState();
    const sel = "pack::flux::t2i";

    // Create controls where default is also missing
    const controlsWithBadDefault: ControlSchema[] = [
      { ...checkpointModel, defaultValue: "also_missing.safetensors" },
    ];

    store.setOverride(sel, "1.ckpt_name", "missing_override.safetensors");

    const overrides = store.getOverridesForSelection(sel);
    const invalidKeys = collectInvalidOverrideKeys(
      controlsWithBadDefault,
      overrides,
      richInventory,
    );

    // Default is also invalid → key should NOT be in resettable set
    expect(invalidKeys.size).toBe(0);

    // No reset should happen
    store.resetGroupOverrides(sel, invalidKeys);

    const updated = useWorkflowControlStore.getState();
    // Override should still be present
    expect(updated.overrides[sel]["1.ckpt_name"]).toBe("missing_override.safetensors");
  });
});
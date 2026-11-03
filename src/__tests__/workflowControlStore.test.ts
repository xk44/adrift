/**
 * Tests for workflowControlStore — persisted per-workflow control overrides
 * and the computeEffectiveControls / getEditableControls helpers.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  useWorkflowControlStore,
  packSelectionKey,
  savedSelectionKey,
  computeEffectiveControls,
  getEditableControls,
  type ControlOverrides,
} from "@/store/workflowControlStore";
import type { ControlSchema } from "@/lib/oj/workflowControlSchema";

// Reset the store between tests
beforeEach(() => {
  useWorkflowControlStore.setState({
    overrides: {},
  });
});

// ---------------------------------------------------------------------------
// packSelectionKey / savedSelectionKey
// ---------------------------------------------------------------------------

describe("packSelectionKey", () => {
  it("creates a key from pack ID and kind", () => {
    expect(packSelectionKey("flux", "t2i")).toBe("pack::flux::t2i");
    expect(packSelectionKey("sdxl", "i2i")).toBe("pack::sdxl::i2i");
  });

  it("handles edge cases", () => {
    expect(packSelectionKey("", "")).toBe("pack::::");
    expect(packSelectionKey("a", "b")).toBe("pack::a::b");
  });
});

describe("savedSelectionKey", () => {
  it("creates a key from a saved workflow file", () => {
    expect(savedSelectionKey("t2i.json")).toBe("saved::t2i.json");
  });
});

// ---------------------------------------------------------------------------
// Store actions
// ---------------------------------------------------------------------------

describe("useWorkflowControlStore", () => {
  it("starts with empty overrides", () => {
    const state = useWorkflowControlStore.getState();
    expect(state.overrides).toEqual({});
  });

  it("setOverride adds an override", () => {
    const store = useWorkflowControlStore.getState();
    store.setOverride("pack::flux::t2i", "4.seed", 999);
    const updated = useWorkflowControlStore.getState();
    expect(updated.overrides["pack::flux::t2i"]).toEqual({ "4.seed": 999 });
  });

  it("setOverride merges into existing selection overrides", () => {
    const store = useWorkflowControlStore.getState();
    store.setOverride("pack::flux::t2i", "4.seed", 999);
    store.setOverride("pack::flux::t2i", "4.steps", 50);
    const updated = useWorkflowControlStore.getState();
    expect(updated.overrides["pack::flux::t2i"]).toEqual({
      "4.seed": 999,
      "4.steps": 50,
    });
  });

  it("resetOverride removes a specific override", () => {
    const store = useWorkflowControlStore.getState();
    store.setOverride("pack::flux::t2i", "4.seed", 999);
    store.setOverride("pack::flux::t2i", "4.steps", 50);
    store.resetOverride("pack::flux::t2i", "4.seed");
    const updated = useWorkflowControlStore.getState();
    expect(updated.overrides["pack::flux::t2i"]).toEqual({ "4.steps": 50 });
  });

  it("resetOverride is a no-op when key doesn't exist", () => {
    const store = useWorkflowControlStore.getState();
    store.setOverride("pack::flux::t2i", "4.seed", 999);
    store.resetOverride("pack::flux::t2i", "nonexistent");
    const updated = useWorkflowControlStore.getState();
    expect(updated.overrides["pack::flux::t2i"]).toEqual({ "4.seed": 999 });
  });

  it("resetOverride cleans up empty selection entries", () => {
    const store = useWorkflowControlStore.getState();
    store.setOverride("pack::flux::t2i", "4.seed", 999);
    store.resetOverride("pack::flux::t2i", "4.seed");
    const updated = useWorkflowControlStore.getState();
    expect(updated.overrides["pack::flux::t2i"]).toBeUndefined();
  });

  it("resetAllOverrides clears all overrides for a selection", () => {
    const store = useWorkflowControlStore.getState();
    store.setOverride("pack::flux::t2i", "4.seed", 999);
    store.setOverride("pack::flux::t2i", "4.steps", 50);
    store.setOverride("pack::sdxl::t2i", "4.cfg", 5.0);
    store.resetAllOverrides("pack::flux::t2i");
    const updated = useWorkflowControlStore.getState();
    expect(updated.overrides["pack::flux::t2i"]).toBeUndefined();
    // Other selections should be untouched
    expect(updated.overrides["pack::sdxl::t2i"]).toEqual({ "4.cfg": 5.0 });
  });

  it("setOverrides merges a batch of overrides", () => {
    const store = useWorkflowControlStore.getState();
    store.setOverrides("pack::flux::t2i", {
      "4.seed": 123,
      "4.steps": 30,
      "4.cfg": 3.5,
    });
    const updated = useWorkflowControlStore.getState();
    expect(updated.overrides["pack::flux::t2i"]).toEqual({
      "4.seed": 123,
      "4.steps": 30,
      "4.cfg": 3.5,
    });
  });

  it("setOverrides merges with existing overrides", () => {
    const store = useWorkflowControlStore.getState();
    store.setOverride("pack::flux::t2i", "4.seed", 999);
    store.setOverrides("pack::flux::t2i", { "4.steps": 50 });
    const updated = useWorkflowControlStore.getState();
    expect(updated.overrides["pack::flux::t2i"]).toEqual({
      "4.seed": 999,
      "4.steps": 50,
    });
  });
});

// ---------------------------------------------------------------------------
// getEffectiveValue / isOverridden
// ---------------------------------------------------------------------------

describe("getEffectiveValue and isOverridden", () => {
  it("returns default value when no override exists", () => {
    const store = useWorkflowControlStore.getState();
    expect(store.getEffectiveValue("pack::flux::t2i", "4.seed", 42)).toBe(42);
  });

  it("returns override value when one exists", () => {
    const store = useWorkflowControlStore.getState();
    store.setOverride("pack::flux::t2i", "4.seed", 999);
    expect(store.getEffectiveValue("pack::flux::t2i", "4.seed", 42)).toBe(999);
  });

  it("isOverridden returns false when no override", () => {
    const store = useWorkflowControlStore.getState();
    expect(store.isOverridden("pack::flux::t2i", "4.seed", 42)).toBe(false);
  });

  it("isOverridden returns true when override differs from default", () => {
    const store = useWorkflowControlStore.getState();
    store.setOverride("pack::flux::t2i", "4.seed", 999);
    expect(store.isOverridden("pack::flux::t2i", "4.seed", 42)).toBe(true);
  });

  it("isOverridden returns false when override equals default", () => {
    const store = useWorkflowControlStore.getState();
    store.setOverride("pack::flux::t2i", "4.seed", 42);
    // Default is also 42, so it's not "overridden" in effect
    expect(store.isOverridden("pack::flux::t2i", "4.seed", 42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getOverridesForSelection
// ---------------------------------------------------------------------------

describe("getOverridesForSelection", () => {
  it("returns empty object when no overrides exist", () => {
    const store = useWorkflowControlStore.getState();
    expect(store.getOverridesForSelection("pack::flux::t2i")).toEqual({});
  });

  it("returns overrides for a specific selection", () => {
    const store = useWorkflowControlStore.getState();
    store.setOverride("pack::flux::t2i", "4.seed", 999);
    store.setOverride("pack::sdxl::t2i", "4.cfg", 7.5);
    expect(store.getOverridesForSelection("pack::flux::t2i")).toEqual({
      "4.seed": 999,
    });
    expect(store.getOverridesForSelection("pack::sdxl::t2i")).toEqual({
      "4.cfg": 7.5,
    });
  });
});

// ---------------------------------------------------------------------------
// computeEffectiveControls
// ---------------------------------------------------------------------------

describe("computeEffectiveControls", () => {
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
      min: 0,
      max: 0xffffffff,
      step: 1,
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
      min: 1,
      max: 150,
      step: 1,
      visible: true,
      order: 120,
    },
    {
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
    },
    {
      key: "4.sampler_name",
      nodeId: "4",
      inputKey: "sampler_name",
      classType: "KSampler",
      kind: "enum",
      label: "Sampler",
      group: "Sampling",
      defaultValue: "euler",
      options: ["euler", "euler_ancestral", "dpm_2", "dpmpp_2m"],
      visible: true,
      order: 140,
    },
  ];

  it("returns defaults when overrides are empty", () => {
    const result = computeEffectiveControls(controls, {});
    expect(result).toHaveLength(4);
    expect(result[0].effectiveValue).toBe(42);
    expect(result[0].isOverridden).toBe(false);
    expect(result[1].effectiveValue).toBe(20);
    expect(result[1].isOverridden).toBe(false);
  });

  it("returns override values when overrides exist", () => {
    const overrides: ControlOverrides = {
      "4.seed": 999,
      "4.steps": 50,
    };
    const result = computeEffectiveControls(controls, overrides);
    expect(result[0].effectiveValue).toBe(999);
    expect(result[0].isOverridden).toBe(true);
    expect(result[1].effectiveValue).toBe(50);
    expect(result[1].isOverridden).toBe(true);
    expect(result[2].effectiveValue).toBe(7.0);
    expect(result[2].isOverridden).toBe(false);
  });

  it("marks isOverridden correctly even when override equals default", () => {
    const overrides: ControlOverrides = {
      "4.seed": 42, // same as default
    };
    const result = computeEffectiveControls(controls, overrides);
    // Override exists but equals default — isOverridden should be false
    expect(result[0].effectiveValue).toBe(42);
    expect(result[0].isOverridden).toBe(false);
  });

  it("handles string overrides", () => {
    const overrides: ControlOverrides = {
      "4.sampler_name": "dpmpp_2m",
    };
    const result = computeEffectiveControls(controls, overrides);
    expect(result[3].effectiveValue).toBe("dpmpp_2m");
    expect(result[3].isOverridden).toBe(true);
  });

  it("preserves all ControlSchema fields", () => {
    const result = computeEffectiveControls(controls, {});
    for (let i = 0; i < controls.length; i++) {
      expect(result[i].key).toBe(controls[i].key);
      expect(result[i].nodeId).toBe(controls[i].nodeId);
      expect(result[i].inputKey).toBe(controls[i].inputKey);
      expect(result[i].kind).toBe(controls[i].kind);
      expect(result[i].label).toBe(controls[i].label);
      expect(result[i].group).toBe(controls[i].group);
      expect(result[i].defaultValue).toBe(controls[i].defaultValue);
      expect(result[i].min).toBe(controls[i].min);
      expect(result[i].max).toBe(controls[i].max);
      expect(result[i].step).toBe(controls[i].step);
      expect(result[i].options).toBe(controls[i].options);
      expect(result[i].visible).toBe(controls[i].visible);
      expect(result[i].order).toBe(controls[i].order);
    }
  });
});

// ---------------------------------------------------------------------------
// getEditableControls
// ---------------------------------------------------------------------------

describe("getEditableControls", () => {
  const mixedControls: ControlSchema[] = [
    // Editable kinds
    {
      key: "4.seed", nodeId: "4", inputKey: "seed", classType: "KSampler",
      kind: "seed", label: "Seed", group: "Sampling", defaultValue: 42,
      visible: true, order: 110,
    },
    {
      key: "4.steps", nodeId: "4", inputKey: "steps", classType: "KSampler",
      kind: "number", label: "Steps", group: "Sampling", defaultValue: 20,
      visible: true, order: 120,
    },
    {
      key: "2.text", nodeId: "2", inputKey: "text", classType: "CLIPTextEncode",
      kind: "string", label: "Prompt", group: "Prompt", defaultValue: "hello",
      visible: true, order: 210,
    },
    {
      key: "4.sampler_name", nodeId: "4", inputKey: "sampler_name", classType: "KSampler",
      kind: "enum", label: "Sampler", group: "Sampling", defaultValue: "euler",
      options: ["euler", "dpm_2"], visible: true, order: 140,
    },
    {
      key: "4.add_noise", nodeId: "4", inputKey: "add_noise", classType: "KSamplerAdvanced",
      kind: "boolean", label: "Add Noise", group: "Sampling", defaultValue: true,
      visible: true, order: 100,
    },
    // Non-editable kinds
    {
      key: "1.ckpt_name", nodeId: "1", inputKey: "ckpt_name", classType: "CheckpointLoaderSimple",
      kind: "model", label: "Checkpoint", group: "Model Loading", defaultValue: "model.safetensors",
      visible: true, order: 400,
    },
    {
      key: "6.image", nodeId: "6", inputKey: "image", classType: "LoadImage",
      kind: "image", label: "Image", group: "Image Input", defaultValue: "photo.png",
      visible: true, order: 600,
    },
    // Hidden
    {
      key: "4.model", nodeId: "4", inputKey: "model", classType: "KSampler",
      kind: "link", label: "Model", group: "Sampling", defaultValue: null,
      visible: false, order: 150,
    },
  ];

  it("returns scalar and non-scalar editable controls (number, seed, string, enum, boolean, model, image)", () => {
    const result = getEditableControls(mixedControls);
    const kinds = result.map((c) => c.kind);
    expect(kinds).toContain("number");
    expect(kinds).toContain("seed");
    expect(kinds).toContain("string");
    expect(kinds).toContain("enum");
    expect(kinds).toContain("boolean");
    // model and image are now editable kinds (non-scalar selectors)
    expect(kinds).toContain("model");
    expect(kinds).toContain("image");
    // Should not include link or hidden
    expect(kinds).not.toContain("link");
    expect(kinds).not.toContain("hidden");
  });

  it("excludes hidden controls even if they are of an editable kind", () => {
    const result = getEditableControls(mixedControls);
    // The link control has visible: false
    expect(result.every((c) => c.visible)).toBe(true);
  });

  it("preserves all original schema fields", () => {
    const result = getEditableControls(mixedControls);
    // Should have exactly the 7 editable controls: 5 scalar + 1 model + 1 image
    expect(result).toHaveLength(7);
  });
});
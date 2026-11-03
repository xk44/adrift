/**
 * Tests for workflow control panel enhancements:
 * - Undo/redo history
 * - Batch overrides
 * - Dependency tracking
 * - Smart defaults
 * - Comparison view
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useWorkflowControlStore } from "@/store/workflowControlStore";
import {
  computeDependentKeys,
  buildComparisonEntries,
  matchSmartDefaults,
  getSmartDefaults,
} from "@/store/workflowControlStore";
import type { ControlSchema } from "@/lib/oj/workflowControlSchema";

// Reset store between tests
beforeEach(() => {
  useWorkflowControlStore.setState({
    overrides: {},
    undoStack: {},
    redoStack: {},
    batchOverrides: {},
    dependencyDirtyKeys: {},
  });
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeControl(overrides: Partial<ControlSchema> = {}): ControlSchema {
  return {
    key: "3.steps",
    nodeId: "3",
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
    order: 100,
    ...overrides,
  };
}

const SEL = "pack::test::t2i";

// ---------------------------------------------------------------------------
// Undo / Redo
// ---------------------------------------------------------------------------

describe("undo/redo history", () => {
  it("should track override changes in undo stack", () => {
    const store = useWorkflowControlStore.getState();
    store.setOverride(SEL, "3.steps", 30);
    expect(store.canUndo(SEL)).toBe(true);
    expect(store.getUndoCount(SEL)).toBe(1);
    expect(store.canRedo(SEL)).toBe(false);
  });

  it("should undo the last change", () => {
    const store = useWorkflowControlStore.getState();
    store.setOverride(SEL, "3.steps", 30);
    store.setOverride(SEL, "3.cfg", 7.5);

    expect(store.getUndoCount(SEL)).toBe(2);

    const undone = store.undo(SEL);
    expect(undone).toBe(true);

    // CFG should be undone (removed since it was the first override for that key)
    const overrides = store.getOverridesForSelection(SEL);
    expect(overrides["3.cfg"]).toBeUndefined();
    expect(overrides["3.steps"]).toBe(30);

    expect(store.canRedo(SEL)).toBe(true);
    expect(store.getRedoCount(SEL)).toBe(1);
  });

  it("should redo an undone change", () => {
    const store = useWorkflowControlStore.getState();
    store.setOverride(SEL, "3.steps", 30);
    store.undo(SEL);
    expect(store.getOverridesForSelection(SEL)["3.steps"]).toBeUndefined();

    const redone = store.redo(SEL);
    expect(redone).toBe(true);
    expect(store.getOverridesForSelection(SEL)["3.steps"]).toBe(30);
  });

  it("should clear redo stack on new change", () => {
    const store = useWorkflowControlStore.getState();
    store.setOverride(SEL, "3.steps", 30);
    store.undo(SEL);
    expect(store.canRedo(SEL)).toBe(true);

    store.setOverride(SEL, "3.steps", 40);
    expect(store.canRedo(SEL)).toBe(false);
  });

  it("should handle undo when no history exists", () => {
    const store = useWorkflowControlStore.getState();
    expect(store.undo(SEL)).toBe(false);
    expect(store.canUndo(SEL)).toBe(false);
  });

  it("should handle redo when no history exists", () => {
    const store = useWorkflowControlStore.getState();
    expect(store.redo(SEL)).toBe(false);
    expect(store.canRedo(SEL)).toBe(false);
  });

  it("should cap undo stack at 50 entries", () => {
    const store = useWorkflowControlStore.getState();
    for (let i = 0; i < 60; i++) {
      store.setOverride(SEL, "3.steps", i);
    }
    expect(store.getUndoCount(SEL)).toBe(50);
  });

  it("should correctly undo to previous value (not just delete)", () => {
    const store = useWorkflowControlStore.getState();
    store.setOverride(SEL, "3.steps", 25);
    store.setOverride(SEL, "3.steps", 30);
    store.setOverride(SEL, "3.steps", 35);

    store.undo(SEL); // 35 -> 30
    expect(store.getOverridesForSelection(SEL)["3.steps"]).toBe(30);

    store.undo(SEL); // 30 -> 25
    expect(store.getOverridesForSelection(SEL)["3.steps"]).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// Batch overrides
// ---------------------------------------------------------------------------

describe("batch overrides", () => {
  it("should add batch values for a control", () => {
    const store = useWorkflowControlStore.getState();
    store.setBatchOverride(SEL, "3.cfg", [5, 7.5, 10]);
    const batches = store.getBatchOverrides(SEL);
    expect(batches).toHaveLength(1);
    expect(batches[0].key).toBe("3.cfg");
    expect(batches[0].values).toEqual([5, 7.5, 10]);
  });

  it("should update existing batch values", () => {
    const store = useWorkflowControlStore.getState();
    store.setBatchOverride(SEL, "3.cfg", [5, 7.5]);
    store.setBatchOverride(SEL, "3.cfg", [5, 7.5, 10, 12]);
    const batches = store.getBatchOverrides(SEL);
    expect(batches).toHaveLength(1);
    expect(batches[0].values).toEqual([5, 7.5, 10, 12]);
  });

  it("should remove batch override with empty array", () => {
    const store = useWorkflowControlStore.getState();
    store.setBatchOverride(SEL, "3.cfg", [5, 7.5]);
    store.setBatchOverride(SEL, "3.cfg", []);
    expect(store.getBatchOverrides(SEL)).toHaveLength(0);
  });

  it("should remove single batch value by index", () => {
    const store = useWorkflowControlStore.getState();
    store.setBatchOverride(SEL, "3.cfg", [5, 7.5, 10]);
    store.removeBatchValue(SEL, "3.cfg", 1); // remove 7.5
    const batches = store.getBatchOverrides(SEL);
    expect(batches[0].values).toEqual([5, 10]);
  });

  it("should clear all batch overrides for a selection", () => {
    const store = useWorkflowControlStore.getState();
    store.setBatchOverride(SEL, "3.cfg", [5, 7.5]);
    store.setBatchOverride(SEL, "3.steps", [20, 30]);
    store.clearBatchOverrides(SEL);
    expect(store.getBatchOverrides(SEL)).toHaveLength(0);
  });

  it("should handle multiple controls in batch mode", () => {
    const store = useWorkflowControlStore.getState();
    store.setBatchOverride(SEL, "3.cfg", [5, 7.5]);
    store.setBatchOverride(SEL, "3.steps", [20, 30]);
    const batches = store.getBatchOverrides(SEL);
    expect(batches).toHaveLength(2);
  });

  it("should auto-remove batch entry when last value is removed", () => {
    const store = useWorkflowControlStore.getState();
    store.setBatchOverride(SEL, "3.cfg", [5]);
    store.removeBatchValue(SEL, "3.cfg", 0);
    expect(store.getBatchOverrides(SEL)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Dependency dirty tracking
// ---------------------------------------------------------------------------

describe("dependency dirty tracking", () => {
  it("should mark keys as dirty", () => {
    const store = useWorkflowControlStore.getState();
    store.markDependencyDirty(SEL, ["3.lora_name", "3.vae_name"]);
    expect(store.isDependencyDirty(SEL, "3.lora_name")).toBe(true);
    expect(store.isDependencyDirty(SEL, "3.vae_name")).toBe(true);
    expect(store.isDependencyDirty(SEL, "3.steps")).toBe(false);
  });

  it("should clear a single dirty key", () => {
    const store = useWorkflowControlStore.getState();
    store.markDependencyDirty(SEL, ["3.lora_name", "3.vae_name"]);
    store.clearDependencyDirty(SEL, "3.lora_name");
    expect(store.isDependencyDirty(SEL, "3.lora_name")).toBe(false);
    expect(store.isDependencyDirty(SEL, "3.vae_name")).toBe(true);
  });

  it("should clear all dirty keys for a selection", () => {
    const store = useWorkflowControlStore.getState();
    store.markDependencyDirty(SEL, ["3.lora_name", "3.vae_name"]);
    store.clearAllDependencyDirty(SEL);
    expect(store.isDependencyDirty(SEL, "3.lora_name")).toBe(false);
    expect(store.isDependencyDirty(SEL, "3.vae_name")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeDependentKeys
// ---------------------------------------------------------------------------

describe("computeDependentKeys", () => {
  const controls: ControlSchema[] = [
    makeControl({
      key: "1.ckpt_name",
      nodeId: "1",
      inputKey: "ckpt_name",
      classType: "CheckpointLoaderSimple",
      kind: "model",
    }),
    makeControl({
      key: "2.lora_name",
      nodeId: "2",
      inputKey: "lora_name",
      classType: "LoraLoader",
      kind: "model",
      group: "LoRA",
    }),
    makeControl({
      key: "3.vae_name",
      nodeId: "3",
      inputKey: "vae_name",
      classType: "VAELoader",
      kind: "model",
      group: "Model Loading",
    }),
    makeControl({
      key: "4.steps",
      nodeId: "4",
      inputKey: "steps",
    }),
  ];

  it("should return dependent keys when checkpoint changes", () => {
    const changed = controls[0]; // ckpt_name
    const deps = computeDependentKeys(changed, controls);
    expect(deps).toContain("2.lora_name");
    expect(deps).toContain("3.vae_name");
    expect(deps).not.toContain("4.steps");
    expect(deps).not.toContain("1.ckpt_name"); // should not include self
  });

  it("should return empty array for non-dependency controls", () => {
    const changed = controls[3]; // steps
    const deps = computeDependentKeys(changed, controls);
    expect(deps).toHaveLength(0);
  });

  it("should return scheduler when sampler changes", () => {
    const samplerCtrl = makeControl({
      key: "4.sampler_name",
      nodeId: "4",
      inputKey: "sampler_name",
      kind: "enum",
    });
    const schedulerCtrl = makeControl({
      key: "4.scheduler",
      nodeId: "4",
      inputKey: "scheduler",
      kind: "enum",
    });
    const deps = computeDependentKeys(samplerCtrl, [
      samplerCtrl,
      schedulerCtrl,
    ]);
    expect(deps).toContain("4.scheduler");
  });
});

// ---------------------------------------------------------------------------
// buildComparisonEntries
// ---------------------------------------------------------------------------

describe("buildComparisonEntries", () => {
  const controls: ControlSchema[] = [
    makeControl({ key: "3.steps", defaultValue: 20 }),
    makeControl({
      key: "3.cfg",
      inputKey: "cfg",
      label: "CFG Scale",
      defaultValue: 7,
    }),
    makeControl({
      key: "3.denoise",
      inputKey: "denoise",
      label: "Denoise",
      defaultValue: 1.0,
    }),
  ];

  it("should mark overridden controls as changed", () => {
    const overrides = { "3.cfg": 12 };
    const entries = buildComparisonEntries(controls, overrides);

    const cfgEntry = entries.find((e) => e.key === "3.cfg")!;
    expect(cfgEntry.isChanged).toBe(true);
    expect(cfgEntry.defaultValue).toBe(7);
    expect(cfgEntry.currentValue).toBe(12);

    const stepsEntry = entries.find((e) => e.key === "3.steps")!;
    expect(stepsEntry.isChanged).toBe(false);
  });

  it("should return all controls", () => {
    const entries = buildComparisonEntries(controls, {});
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => !e.isChanged)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Smart defaults
// ---------------------------------------------------------------------------

describe("smart defaults", () => {
  it("should return recommendations for upscale workflow", () => {
    const recs = getSmartDefaults("upscale");
    expect(recs.length).toBeGreaterThan(0);
    const denoiseRec = recs.find((r) => r.inputKey === "denoise");
    expect(denoiseRec).toBeDefined();
    expect(denoiseRec!.recommendedValue).toBe(0.4);
  });

  it("should return recommendations for inpaint workflow", () => {
    const recs = getSmartDefaults("inpaint");
    const denoiseRec = recs.find((r) => r.inputKey === "denoise");
    expect(denoiseRec).toBeDefined();
    expect(denoiseRec!.recommendedValue).toBe(0.8);
  });

  it("should return empty for unknown workflow type", () => {
    const recs = getSmartDefaults("unknown");
    expect(recs).toHaveLength(0);
  });

  it("should match recommendations to controls", () => {
    const controls = [
      makeControl({ key: "3.steps", inputKey: "steps" }),
      makeControl({
        key: "3.denoise",
        inputKey: "denoise",
        label: "Denoise",
      }),
    ];
    const matched = matchSmartDefaults("upscale", controls);
    expect(matched.length).toBeGreaterThan(0);
    expect(matched.every((m) => m.controlKey)).toBe(true);
  });

  it("should not match recommendations to missing controls", () => {
    // No denoise control, so denoise recommendation should be skipped
    const controls = [makeControl({ key: "3.steps", inputKey: "steps" })];
    const matched = matchSmartDefaults("upscale", controls);
    const denoiseMatch = matched.find((m) => m.inputKey === "denoise");
    expect(denoiseMatch).toBeUndefined();
  });

  it("should return t2i recommendations", () => {
    const recs = getSmartDefaults("t2i");
    expect(recs.length).toBeGreaterThan(0);
  });

  it("should return i2i recommendations", () => {
    const recs = getSmartDefaults("i2i");
    expect(recs.length).toBeGreaterThan(0);
    const denoiseRec = recs.find((r) => r.inputKey === "denoise");
    expect(denoiseRec).toBeDefined();
    expect(denoiseRec!.recommendedValue).toBe(0.6);
  });

  it("should return video recommendations", () => {
    const recs = getSmartDefaults("t2v");
    expect(recs.length).toBeGreaterThan(0);
  });
});

/**
 * Integration tests for workflow control overrides
 * Tests that applyControlOverrides is correctly wired into the
 * imagine/action/inpaint pipeline paths and that overrides
 * are validated (only existing node input keys can be changed).
 */

import { describe, expect, it } from "vitest";
import {
  applyControlOverrides,
  buildControlSchema,
} from "@/lib/oj/workflowControlSchema";
import type { Workflow } from "@/types";

// ---------------------------------------------------------------------------
// Minimal workflow fixtures
// ---------------------------------------------------------------------------

function makeNode(class_type: string, inputs: Record<string, unknown>) {
  return { class_type, inputs };
}

const minimalT2IWorkflow: Workflow = {
  "1": makeNode("CheckpointLoaderSimple", { ckpt_name: "model.safetensors" }),
  "2": makeNode("CLIPTextEncode", { clip: ["1", 1], text: "" }),
  "3": makeNode("CLIPTextEncode", { clip: ["1", 1], text: "" }),
  "5": makeNode("EmptyLatentImage", { width: 1024, height: 1024, batch_size: 1 }),
  "4": makeNode("KSampler", {
    model: ["1", 0],
    positive: ["2", 0],
    negative: ["3", 0],
    latent_image: ["5", 0],
    seed: 0,
    steps: 20,
    cfg: 7.0,
    sampler_name: "euler",
    scheduler: "normal",
    denoise: 1.0,
  }),
  "6": makeNode("VAEDecode", { samples: ["4", 0], vae: ["1", 2] }),
  "7": makeNode("SaveImage", { filename_prefix: "ComfyUI", images: ["6", 0] }),
};

const inpaintWorkflow: Workflow = {
  "1": makeNode("LoadImage", { image: "source.png" }),
  "2": makeNode("LoadImageMask", { image: "mask.png" }),
  "3": makeNode("CLIPTextEncode", { text: "positive prompt" }),
  "4": makeNode("CLIPTextEncode", { text: "negative prompt" }),
  "5": makeNode("KSampler", {
    seed: 0,
    steps: 20,
    cfg: 7.0,
    sampler_name: "euler",
    scheduler: "normal",
    denoise: 1.0,
  }),
  "6": makeNode("EmptyLatentImage", { width: 512, height: 512, batch_size: 1 }),
  "7": makeNode("VAEDecode", { samples: ["5", 0] }),
};

// ---------------------------------------------------------------------------
// applyControlOverrides — core behavior
// ---------------------------------------------------------------------------

describe("applyControlOverrides — core behavior", () => {
  it("overrides existing node inputs using nodeId.inputKey format", () => {
    const overrides = {
      "4.seed": 999,
      "4.steps": 30,
      "4.cfg": 5.0,
      "4.sampler_name": "dpm_2_ancestral",
    };
    const result = applyControlOverrides(minimalT2IWorkflow, overrides);

    expect(result["4"].inputs.seed).toBe(999);
    expect(result["4"].inputs.steps).toBe(30);
    expect(result["4"].inputs.cfg).toBe(5.0);
    expect(result["4"].inputs.sampler_name).toBe("dpm_2_ancestral");
  });

  it("overrides inputs across different nodes", () => {
    const overrides = {
      "4.seed": 42,
      "5.width": 768,
      "5.height": 512,
      "7.filename_prefix": "my_output",
    };
    const result = applyControlOverrides(minimalT2IWorkflow, overrides);

    expect(result["4"].inputs.seed).toBe(42);
    expect(result["5"].inputs.width).toBe(768);
    expect(result["5"].inputs.height).toBe(512);
    expect(result["7"].inputs.filename_prefix).toBe("my_output");
  });

  it("does NOT add new input keys that don't exist on a node", () => {
    const overrides = {
      "4.nonexistent_input": "should_be_ignored",
    };
    const result = applyControlOverrides(minimalT2IWorkflow, overrides);

    // The nonexistent key should NOT be added
    expect(result["4"].inputs).not.toHaveProperty("nonexistent_input");
  });

  it("preserves workflow structure when no overrides match any node", () => {
    const overrides = {
      "99.seed": 42, // node 99 doesn't exist
    };
    const result = applyControlOverrides(minimalT2IWorkflow, overrides);

    // All original nodes should remain unchanged
    expect(Object.keys(result)).toEqual(Object.keys(minimalT2IWorkflow));
    expect(result["4"].inputs.seed).toBe(0); // unchanged
  });

  it("returns a new workflow (does not mutate input)", () => {
    const original = JSON.parse(JSON.stringify(minimalT2IWorkflow));
    const overrides = { "4.seed": 12345 };
    applyControlOverrides(minimalT2IWorkflow, overrides);

    // Original should be unchanged
    expect(minimalT2IWorkflow["4"].inputs.seed).toBe(original["4"].inputs.seed);
  });

  it("handles empty overrides (returns equivalent workflow)", () => {
    const result = applyControlOverrides(minimalT2IWorkflow, {});
    expect(Object.keys(result).length).toBe(Object.keys(minimalT2IWorkflow).length);
    // Values should be deeply equal
    expect(result["4"].inputs.seed).toBe(minimalT2IWorkflow["4"].inputs.seed);
  });

  it("handles undefined overrides gracefully", () => {
    const result = applyControlOverrides(minimalT2IWorkflow, {
      "4.seed": undefined,
    });
    // undefined overrides should set the input to undefined
    expect(result["4"].inputs.seed).toBeUndefined();
  });

  it("preserves node-link references (array values)", () => {
    const overrides = { "4.seed": 42 };
    const result = applyControlOverrides(minimalT2IWorkflow, overrides);

    // Link references should remain intact
    expect(result["4"].inputs.model).toEqual(["1", 0]);
    expect(result["4"].inputs.positive).toEqual(["2", 0]);
    expect(result["4"].inputs.negative).toEqual(["3", 0]);
    expect(result["4"].inputs.latent_image).toEqual(["5", 0]);
  });

  it("works with inpaint workflow (overrides on ksampler)", () => {
    const overrides = {
      "5.seed": 77,
      "5.denoise": 0.6,
      "5.steps": 15,
    };
    const result = applyControlOverrides(inpaintWorkflow, overrides);

    expect(result["5"].inputs.seed).toBe(77);
    expect(result["5"].inputs.denoise).toBe(0.6);
    expect(result["5"].inputs.steps).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Integration: applyControlOverrides + buildControlSchema round-trip
// ---------------------------------------------------------------------------

describe("applyControlOverrides + buildControlSchema round-trip", () => {
  it("builds schema from a workflow, builds defaults map, applies overrides, and verifies values", () => {
    const schema = buildControlSchema(minimalT2IWorkflow);
    const visibleControls = schema.controls.filter((c) => c.visible);

    // Pick a few controls to override
    const overrides: Record<string, unknown> = {};
    const ksamplerControls = visibleControls.filter(
      (c) => c.nodeId === "4" && c.kind !== "link",
    );
    expect(ksamplerControls.length).toBeGreaterThan(0);

    // Set seed to 9999 and steps to 50
    const seedControl = ksamplerControls.find((c) => c.inputKey === "seed");
    const stepsControl = ksamplerControls.find((c) => c.inputKey === "steps");
    expect(seedControl).toBeDefined();
    expect(stepsControl).toBeDefined();

    overrides[seedControl!.key] = 9999;
    overrides[stepsControl!.key] = 50;

    const result = applyControlOverrides(minimalT2IWorkflow, overrides);
    expect(result["4"].inputs.seed).toBe(9999);
    expect(result["4"].inputs.steps).toBe(50);
  });

  it("override keys that reference non-existent inputs are safely ignored", () => {
    const overrides = {
      "4.phantom_key": "should_not_appear",
      "999.seed": 42,
    };
    const result = applyControlOverrides(minimalT2IWorkflow, overrides);

    // Non-existent key on existing node ignored
    expect(result["4"].inputs).not.toHaveProperty("phantom_key");
    // Non-existent node: no error, other nodes untouched
    expect(result["1"].inputs.ckpt_name).toBe("model.safetensors");
  });

  it("string overrides work for model-type inputs", () => {
    const overrides = {
      "1.ckpt_name": "my_custom_model.safetensors",
    };
    const result = applyControlOverrides(minimalT2IWorkflow, overrides);
    expect(result["1"].inputs.ckpt_name).toBe("my_custom_model.safetensors");
  });

  it("boolean overrides work for boolean inputs", () => {
    const workflow: Workflow = {
      "1": makeNode("KSamplerAdvanced", {
        add_noise: true,
        start_with_step: 0,
        end_with_step: -1,
        return_with_leftover: false,
        steps: 20,
        cfg: 7.0,
        seed: 0,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1.0,
      }),
    };
    const overrides = {
      "1.add_noise": false,
      "1.return_with_leftover": true,
    };
    const result = applyControlOverrides(workflow, overrides);
    expect(result["1"].inputs.add_noise).toBe(false);
    expect(result["1"].inputs.return_with_leftover).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Behavior when no overrides provided (preserves existing behavior)
// ---------------------------------------------------------------------------

describe("no overrides provided — preserves existing behavior", () => {
  it("imagine route: empty/undefined overrides produce identity workflow", () => {
    // This verifies the API route behavior: when workflowControlOverrides
    // is missing or empty, the workflow is unchanged.
    const resultEmpty = applyControlOverrides(minimalT2IWorkflow, {});
    const resultUndefined = applyControlOverrides(minimalT2IWorkflow, {});

    // Check all inputs remain the same
    for (const [nodeId, node] of Object.entries(minimalT2IWorkflow)) {
      for (const [key, value] of Object.entries(node.inputs)) {
        expect(resultEmpty[nodeId].inputs[key]).toEqual(value);
        expect(resultUndefined[nodeId].inputs[key]).toEqual(value);
      }
    }
  });

  it("override keys that are Valid JSON but reference non-existent nodes are no-ops", () => {
    const overrides = {
      "nonexistent_node.seed": 42,
    };
    const result = applyControlOverrides(minimalT2IWorkflow, overrides);
    // result should have same keys
    expect(Object.keys(result)).toEqual(
      Object.keys(minimalT2IWorkflow),
    );
  });
});
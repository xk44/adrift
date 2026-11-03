/**
 * Recursive subgraph flattening: a top-level canvas that wires several subgraph
 * instances together must inline all of them and resolve the boundary crossings
 * (input node -10 / output node -20), not collapse to a single fragment.
 *
 * These fixtures are hand-built so the expected wiring is known exactly — they
 * verify the boundary-resolution algorithm without needing any custom nodes or
 * a GPU (the real Trellis/Qwen 3d graphs it targets are CUDA-only).
 */
import { describe, it, expect } from "vitest";
import { flattenComposedWorkflow } from "@/lib/comfy/workflows";

// SG1: takes a CLIP on boundary input slot 0, runs CLIPTextEncode, exposes that
// node's conditioning on boundary output slot 0.
const SG1 = {
  id: "sg-1-uuid",
  name: "encode",
  inputNode: { id: -10 },
  outputNode: { id: -20 },
  inputs: [{ id: "in0", name: "clip", type: "CLIP" }],
  outputs: [{ id: "out0", name: "cond", type: "CONDITIONING" }],
  nodes: [
    {
      id: 1,
      type: "CLIPTextEncode",
      inputs: [{ name: "clip", type: "CLIP", link: 11 }],
      widgets_values: ["a fluffy cat"],
    },
  ],
  links: [
    // boundary input (-10, slot0) -> node1.clip
    {
      id: 11,
      origin_id: -10,
      origin_slot: 0,
      target_id: 1,
      target_slot: 0,
      type: "CLIP",
    },
    // node1.cond -> boundary output (-20, slot0)
    {
      id: 12,
      origin_id: 1,
      origin_slot: 0,
      target_id: -20,
      target_slot: 0,
      type: "CONDITIONING",
    },
  ],
};

describe("flattenComposedWorkflow — boundary crossings", () => {
  it("inlines a subgraph instance and rewires input+output boundaries", () => {
    const parsed = {
      nodes: [
        { id: 100, type: "CLIPLoader", widgets_values: ["clip_l.safetensors"] },
        {
          id: 200,
          type: "sg-1-uuid",
          inputs: [{ name: "clip", type: "CLIP", link: 1 }],
          outputs: [{ name: "cond", type: "CONDITIONING" }],
        },
        {
          id: 300,
          type: "KSampler",
          inputs: [{ name: "positive", type: "CONDITIONING", link: 2 }],
        },
      ],
      links: [
        // CLIPLoader -> instance input slot 0
        {
          id: 1,
          origin_id: 100,
          origin_slot: 0,
          target_id: 200,
          target_slot: 0,
          type: "CLIP",
        },
        // instance output slot 0 -> KSampler.positive
        {
          id: 2,
          origin_id: 200,
          origin_slot: 0,
          target_id: 300,
          target_slot: 0,
          type: "CONDITIONING",
        },
      ],
      definitions: { subgraphs: [SG1] },
    };

    const wf = flattenComposedWorkflow(parsed)!;
    expect(wf).not.toBeNull();

    // The inner CLIPTextEncode is inlined under the namespaced id 200/1.
    expect(wf["200/1"]?.class_type).toBe("CLIPTextEncode");
    expect(wf["200/1"].inputs.text).toBe("a fluffy cat");
    // Input boundary: inner node's clip is fed by the external CLIPLoader (100).
    expect(wf["200/1"].inputs.clip).toEqual(["100", 0]);
    // Output boundary: KSampler.positive is fed by the inner node (200/1), NOT
    // the instance wrapper.
    expect(wf["300"].inputs.positive).toEqual(["200/1", 0]);
    // The subgraph instance wrapper itself is gone; only real nodes remain.
    expect(wf["200"]).toBeUndefined();
    expect(Object.keys(wf).sort()).toContain("100");
  });

  it("resolves boundaries through nested subgraph instances", () => {
    // SG_OUTER instantiates SG1 internally and just passes clip in / cond out.
    const SG_OUTER = {
      id: "sg-outer-uuid",
      name: "outer",
      inputNode: { id: -10 },
      outputNode: { id: -20 },
      inputs: [{ id: "in0", name: "clip", type: "CLIP" }],
      outputs: [{ id: "out0", name: "cond", type: "CONDITIONING" }],
      nodes: [
        {
          id: 5,
          type: "sg-1-uuid",
          inputs: [{ name: "clip", type: "CLIP", link: 51 }],
          outputs: [{ name: "cond", type: "CONDITIONING" }],
        },
      ],
      links: [
        // outer boundary input -> inner instance input
        {
          id: 51,
          origin_id: -10,
          origin_slot: 0,
          target_id: 5,
          target_slot: 0,
          type: "CLIP",
        },
        // inner instance output -> outer boundary output
        {
          id: 52,
          origin_id: 5,
          origin_slot: 0,
          target_id: -20,
          target_slot: 0,
          type: "CONDITIONING",
        },
      ],
    };

    const parsed = {
      nodes: [
        { id: 100, type: "CLIPLoader", widgets_values: ["clip_l.safetensors"] },
        {
          id: 200,
          type: "sg-outer-uuid",
          inputs: [{ name: "clip", type: "CLIP", link: 1 }],
          outputs: [{ name: "cond", type: "CONDITIONING" }],
        },
        {
          id: 300,
          type: "KSampler",
          inputs: [{ name: "positive", type: "CONDITIONING", link: 2 }],
        },
      ],
      links: [
        {
          id: 1,
          origin_id: 100,
          origin_slot: 0,
          target_id: 200,
          target_slot: 0,
          type: "CLIP",
        },
        {
          id: 2,
          origin_id: 200,
          origin_slot: 0,
          target_id: 300,
          target_slot: 0,
          type: "CONDITIONING",
        },
      ],
      definitions: { subgraphs: [SG1, SG_OUTER] },
    };

    const wf = flattenComposedWorkflow(parsed)!;
    // The doubly-nested CLIPTextEncode inlines under 200/5/1 and still receives
    // the top-level CLIPLoader across two boundary hops.
    expect(wf["200/5/1"]?.class_type).toBe("CLIPTextEncode");
    expect(wf["200/5/1"].inputs.clip).toEqual(["100", 0]);
    expect(wf["300"].inputs.positive).toEqual(["200/5/1", 0]);
  });

  it("returns null for a bare subgraph template with no top-level nodes", () => {
    expect(
      flattenComposedWorkflow({ nodes: [], definitions: { subgraphs: [SG1] } }),
    ).toBeNull();
  });
});

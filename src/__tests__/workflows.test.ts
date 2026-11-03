/**
 * Workflow Parsing & Capabilities Tests
 * ======================================
 * parseWorkflowJson format detection, subgraph conversion, detectKind, extractCapabilities.
 */

import { describe, it, expect } from "vitest";
import { parseWorkflowJson, extractCapabilities } from "@/lib/comfy/workflows";
import type { Workflow } from "@/types";

// ---- Helpers to build workflow fixtures ----

function apiWorkflow(
  nodes: Record<
    string,
    { class_type: string; inputs: Record<string, unknown> }
  >,
): Workflow {
  return nodes as unknown as Workflow;
}

function uiWorkflow(
  nodes: Array<{
    id: number;
    type: string;
    inputs?: unknown[];
    widgets_values?: unknown[];
  }>,
  links: Array<[number, number, number, number, number, string]> = [],
) {
  return { nodes, links };
}

// ---- parseWorkflowJson ----

describe("parseWorkflowJson", () => {
  it("passes through API-format workflow unchanged", () => {
    const wf = apiWorkflow({
      "1": { class_type: "KSampler", inputs: { steps: 20 } },
      "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
    });
    const result = parseWorkflowJson(wf);
    expect(result["1"].class_type).toBe("KSampler");
    expect(result["2"].class_type).toBe("SaveImage");
  });

  it("converts UI-format workflow to API format", () => {
    const ui = uiWorkflow(
      [
        {
          id: 1,
          type: "CheckpointLoaderSimple",
          inputs: [
            { name: "ckpt_name", type: "COMBO", widget: { name: "ckpt_name" } },
          ],
          widgets_values: ["model.safetensors"],
        },
        {
          id: 2,
          type: "KSampler",
          inputs: [{ name: "model", type: "MODEL", link: 1 }],
        },
      ],
      [[1, 1, 0, 2, 0, "MODEL"]],
    );
    const result = parseWorkflowJson(ui);
    expect(result["1"].class_type).toBe("CheckpointLoaderSimple");
    expect(result["2"].class_type).toBe("KSampler");
    // Link should wire node 1 output to node 2 input
    expect(result["2"].inputs.model).toEqual(["1", 0]);
  });

  it("converts subgraph-format workflow", () => {
    const subgraphWf = {
      nodes: [{ id: 1, type: "my_subgraph" }],
      links: [],
      definitions: {
        subgraphs: [
          {
            id: "my_subgraph",
            name: "Test Subgraph",
            nodes: [
              { id: 10, type: "KSampler", inputs: [] },
              {
                id: 11,
                type: "SaveImage",
                inputs: [{ name: "images", type: "IMAGE", link: 100 }],
              },
            ],
            links: [[100, 10, 0, 11, 0, "IMAGE"]],
          },
        ],
      },
    };
    const result = parseWorkflowJson(subgraphWf);
    expect(result["10"].class_type).toBe("KSampler");
    expect(result["11"].class_type).toBe("SaveImage");
  });

  it("recovers unsurfaced widget inputs in new-style subgraph workflows", () => {
    // New-style frontend format: widget inputs appear in `inputs[]` only when
    // linked. Unlinked widgets exist solely as positions in widgets_values.
    // Mirrors the official image_krea2_turbo_t2i template shape.
    const subgraphWf = {
      nodes: [{ id: 30, type: "sg-uuid-1" }],
      links: [],
      definitions: {
        subgraphs: [
          {
            id: "sg-uuid-1",
            name: "Krea2-like",
            inputNode: { id: -10 },
            outputNode: { id: -20 },
            nodes: [
              {
                id: 10,
                type: "UNETLoader",
                // only unet_name surfaced, linked from the subgraph boundary
                inputs: [
                  {
                    name: "unet_name",
                    type: "COMBO",
                    link: 61,
                    widget: { name: "unet_name" },
                  },
                ],
                widgets_values: ["krea2_turbo_bf16.safetensors", "default"],
              },
              {
                id: 11,
                type: "CLIPLoader",
                inputs: [
                  {
                    name: "clip_name",
                    type: "COMBO",
                    link: 62,
                    widget: { name: "clip_name" },
                  },
                ],
                widgets_values: [
                  "qwen3vl_4b_bf16.safetensors",
                  "krea2",
                  "default",
                ],
              },
              {
                id: 17,
                type: "StringConcatenate",
                inputs: [],
                widgets_values: ["a", "b", ", "],
              },
              {
                id: 6,
                type: "CLIPTextEncode",
                inputs: [
                  { name: "clip", type: "CLIP", link: 10, widget: null },
                  {
                    name: "text",
                    type: "STRING",
                    link: 72,
                    widget: { name: "text" },
                  },
                ],
                widgets_values: ["widget default text"],
              },
              {
                id: 5,
                type: "EmptyLatentImage",
                // width/height linked from boundary; batch_size unsurfaced
                inputs: [
                  {
                    name: "width",
                    type: "INT",
                    link: 50,
                    widget: { name: "width" },
                  },
                  {
                    name: "height",
                    type: "INT",
                    link: 51,
                    widget: { name: "height" },
                  },
                ],
                widgets_values: [1024, 768, 1],
              },
              {
                id: 3,
                type: "KSampler",
                // only seed surfaced (boundary link); steps/cfg/etc. unsurfaced
                inputs: [
                  { name: "model", type: "MODEL", link: 30, widget: null },
                  {
                    name: "positive",
                    type: "CONDITIONING",
                    link: 4,
                    widget: null,
                  },
                  {
                    name: "latent_image",
                    type: "LATENT",
                    link: 2,
                    widget: null,
                  },
                  {
                    name: "seed",
                    type: "INT",
                    link: 56,
                    widget: { name: "seed" },
                  },
                ],
                widgets_values: [42, "randomize", 8, 1, "euler", "simple", 1],
              },
              {
                id: 8,
                type: "VAEDecode",
                inputs: [
                  { name: "samples", type: "LATENT", link: 7, widget: null },
                ],
              },
              {
                id: 9,
                type: "SaveImage",
                inputs: [
                  { name: "images", type: "IMAGE", link: 8, widget: null },
                ],
                widgets_values: ["ComfyUI"],
              },
            ],
            links: [
              // boundary links: origin is the subgraph input node (-10)
              [61, -10, 0, 10, 0, "COMBO"],
              [62, -10, 1, 11, 0, "COMBO"],
              [50, -10, 2, 5, 0, "INT"],
              [51, -10, 3, 5, 1, "INT"],
              [56, -10, 4, 3, 3, "INT"],
              // real inner links
              [10, 11, 0, 6, 0, "CLIP"],
              [72, 17, 0, 6, 1, "STRING"],
              [30, 10, 0, 3, 0, "MODEL"],
              [4, 6, 0, 3, 1, "CONDITIONING"],
              [2, 5, 0, 3, 2, "LATENT"],
              [7, 3, 0, 8, 0, "LATENT"],
              [8, 8, 0, 9, 0, "IMAGE"],
            ],
          },
        ],
      },
    };

    const result = parseWorkflowJson(subgraphWf);

    // Unsurfaced widget inputs recovered from widgets_values positions
    expect(result["3"].inputs.steps).toBe(8);
    expect(result["3"].inputs.cfg).toBe(1);
    expect(result["3"].inputs.sampler_name).toBe("euler");
    expect(result["3"].inputs.scheduler).toBe("simple");
    expect(result["3"].inputs.denoise).toBe(1);
    expect(result["10"].inputs.weight_dtype).toBe("default");
    expect(result["11"].inputs.type).toBe("krea2");
    expect(result["11"].inputs.device).toBe("default");
    expect(result["5"].inputs.batch_size).toBe(1);

    // UI-only widget never emitted
    expect(result["3"].inputs.control_after_generate).toBeUndefined();

    // Boundary-linked widget inputs keep their widget defaults
    expect(result["3"].inputs.seed).toBe(42);
    expect(result["5"].inputs.width).toBe(1024);
    expect(result["5"].inputs.height).toBe(768);
    expect(result["10"].inputs.unet_name).toBe("krea2_turbo_bf16.safetensors");

    // Widget input linked from a real inner node gets wired, not defaulted
    expect(result["6"].inputs.text).toEqual(["17", 0]);
    // Real links still wired
    expect(result["3"].inputs.model).toEqual(["10", 0]);
    expect(result["9"].inputs.images).toEqual(["8", 0]);
  });

  it("throws on empty object", () => {
    expect(() => parseWorkflowJson({})).toThrow(/Unrecognized workflow format/);
  });

  it("throws on null (crashes accessing properties)", () => {
    expect(() => parseWorkflowJson(null)).toThrow();
  });

  it("throws on array", () => {
    expect(() => parseWorkflowJson([1, 2, 3])).toThrow(
      /Unrecognized workflow format/,
    );
  });

  it("throws on UI workflow with empty nodes array", () => {
    expect(() => parseWorkflowJson({ nodes: [], links: [] })).toThrow(
      /Unrecognized workflow format/,
    );
  });

  it("includes label in error message when provided", () => {
    expect(() => parseWorkflowJson({}, "my-workflow.json")).toThrow(
      "my-workflow.json",
    );
  });

  it("skips display-only nodes (Note, Reroute)", () => {
    const ui = uiWorkflow(
      [
        { id: 1, type: "Note" },
        { id: 2, type: "Reroute" },
        { id: 3, type: "KSampler", inputs: [] },
        {
          id: 4,
          type: "VAEDecode",
          inputs: [{ name: "samples", type: "LATENT", link: 1 }],
        },
      ],
      [[1, 3, 0, 4, 0, "LATENT"]],
    );
    const result = parseWorkflowJson(ui);
    expect(result["1"]).toBeUndefined(); // Note skipped
    expect(result["2"]).toBeUndefined(); // Reroute skipped
    expect(result["3"].class_type).toBe("KSampler");
  });

  it("auto-adds SaveImage when output node is missing but VAEDecode exists", () => {
    const ui = uiWorkflow(
      [
        { id: 1, type: "KSampler", inputs: [] },
        {
          id: 2,
          type: "VAEDecode",
          inputs: [{ name: "samples", type: "LATENT", link: 1 }],
        },
      ],
      [[1, 1, 0, 2, 0, "LATENT"]],
    );
    const result = parseWorkflowJson(ui);
    // Should have auto-added a SaveImage node
    const classTypes = Object.values(result).map((n) => n.class_type);
    expect(classTypes).toContain("SaveImage");
  });
});

// ---- detectKind via extractCapabilities ----

describe("extractCapabilities / detectKind", () => {
  it("detects t2i workflow", () => {
    const wf = apiWorkflow({
      "1": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: "model.safetensors" },
      },
      "2": {
        class_type: "KSampler",
        inputs: {
          steps: 20,
          cfg: 7,
          sampler_name: "euler",
          scheduler: "normal",
          denoise: 1.0,
        },
      },
      "3": {
        class_type: "EmptyLatentImage",
        inputs: { width: 1024, height: 1024 },
      },
      "4": { class_type: "SaveImage", inputs: { images: ["2", 0] } },
    });
    const caps = extractCapabilities(wf);
    expect(caps.kind).toBe("t2i");
    expect(caps.hasSampler).toBe(true);
    expect(caps.loaderType).toBe("checkpoint");
    expect(caps.hasLatentDims).toBe(true);
    expect(caps.hasImageInput).toBe(false);
    expect(caps.canAddLoras).toBe(true);
  });

  it("detects i2i workflow", () => {
    const wf = apiWorkflow({
      "1": { class_type: "LoadImage", inputs: {} },
      "2": { class_type: "KSampler", inputs: { steps: 20 } },
      "3": { class_type: "SaveImage", inputs: {} },
    });
    const caps = extractCapabilities(wf);
    expect(caps.kind).toBe("i2i");
    expect(caps.hasImageInput).toBe(true);
  });

  it("detects upscale workflow (no sampler)", () => {
    const wf = apiWorkflow({
      "1": { class_type: "LoadImage", inputs: {} },
      "2": { class_type: "ImageUpscaleWithModel", inputs: {} },
      "3": { class_type: "SaveImage", inputs: {} },
    });
    const caps = extractCapabilities(wf);
    expect(caps.kind).toBe("upscale");
    expect(caps.hasSampler).toBe(false);
  });

  it("detects inpaint workflow", () => {
    const wf = apiWorkflow({
      "1": { class_type: "LoadImageMask", inputs: {} },
      "2": { class_type: "KSampler", inputs: {} },
      "3": { class_type: "SaveImage", inputs: {} },
    });
    const caps = extractCapabilities(wf);
    expect(caps.kind).toBe("inpaint");
    expect(caps.hasMask).toBe(true);
  });

  it("detects t2v workflow", () => {
    const wf = apiWorkflow({
      "1": { class_type: "KSampler", inputs: {} },
      "2": { class_type: "VHS_VideoCombine", inputs: {} },
    });
    expect(extractCapabilities(wf).kind).toBe("t2v");
  });

  it("detects i2v workflow", () => {
    const wf = apiWorkflow({
      "1": { class_type: "LoadImage", inputs: {} },
      "2": { class_type: "VHS_VideoCombine", inputs: {} },
    });
    expect(extractCapabilities(wf).kind).toBe("i2v");
  });

  it("detects t23d workflow", () => {
    const wf = apiWorkflow({
      "1": { class_type: "KSampler", inputs: {} },
      "2": { class_type: "SaveGLB", inputs: {} },
    });
    expect(extractCapabilities(wf).kind).toBe("t23d");
  });

  it("detects i23d workflow", () => {
    const wf = apiWorkflow({
      "1": { class_type: "LoadImage", inputs: {} },
      "2": { class_type: "TripoSRSampler", inputs: {} },
    });
    expect(extractCapabilities(wf).kind).toBe("i23d");
  });

  it("detects t2a workflow", () => {
    const wf = apiWorkflow({
      "1": { class_type: "KSampler", inputs: {} },
      "2": { class_type: "SaveAudio", inputs: {} },
    });
    expect(extractCapabilities(wf).kind).toBe("t2a");
  });

  it("returns unknown for unrecognized workflow", () => {
    const wf = apiWorkflow({
      "1": { class_type: "SomethingCustom", inputs: {} },
    });
    expect(extractCapabilities(wf).kind).toBe("unknown");
  });

  it("extracts default params from KSampler", () => {
    const wf = apiWorkflow({
      "1": {
        class_type: "KSampler",
        inputs: {
          steps: 30,
          cfg: 4.5,
          sampler_name: "dpmpp_2m",
          scheduler: "karras",
          denoise: 0.75,
        },
      },
      "2": {
        class_type: "EmptyLatentImage",
        inputs: { width: 768, height: 512 },
      },
      "3": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: "sdxl.safetensors" },
      },
    });
    const caps = extractCapabilities(wf);
    expect(caps.defaults.steps).toBe(30);
    expect(caps.defaults.cfg).toBe(4.5);
    expect(caps.defaults.sampler).toBe("dpmpp_2m");
    expect(caps.defaults.scheduler).toBe("karras");
    expect(caps.defaults.denoise).toBe(0.75);
    expect(caps.defaults.width).toBe(768);
    expect(caps.defaults.height).toBe(512);
    expect(caps.defaults.checkpoint).toBe("sdxl.safetensors");
  });

  it("detects unet loader type", () => {
    const wf = apiWorkflow({
      "1": {
        class_type: "UNETLoader",
        inputs: { unet_name: "flux.safetensors" },
      },
      "2": { class_type: "KSampler", inputs: {} },
    });
    const caps = extractCapabilities(wf);
    expect(caps.loaderType).toBe("unet");
    expect(caps.canAddLoras).toBe(true);
    expect(caps.defaults.checkpoint).toBe("flux.safetensors");
  });

  it("detects existing LoRA nodes", () => {
    const wf = apiWorkflow({
      "1": { class_type: "CheckpointLoaderSimple", inputs: {} },
      "2": { class_type: "LoraLoader", inputs: {} },
      "3": { class_type: "KSampler", inputs: {} },
    });
    const caps = extractCapabilities(wf);
    expect(caps.hasExistingLoras).toBe(true);
    expect(caps.canAddLoras).toBe(true);
  });

  it("detects VAE loader", () => {
    const wf = apiWorkflow({
      "1": { class_type: "VAELoader", inputs: {} },
      "2": { class_type: "KSampler", inputs: {} },
    });
    expect(extractCapabilities(wf).hasVaeLoader).toBe(true);
  });
});

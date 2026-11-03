/**
 * Tests for draft-then-upscale pipeline, krea2-inpaint-edit registry,
 * and Qwen-Image-2.1 pack scaffolding.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  getEditFamilies,
  getBuiltinEditLoras,
  editActionFor,
  isEditFamily,
  mergeEditLoras,
} from "@/lib/krea2/editLoras";
import { parseImagineInput } from "@/lib/oj/parser";
import { buildImagineRuns, extractWorkflowsFromRuns } from "@/lib/oj/engine";
import { getPack, getAllPacks, resolveWorkflow } from "@/lib/oj/packs";

// ---------------------------------------------------------------------------
// krea2-inpaint-edit registry
// ---------------------------------------------------------------------------

describe("krea2-inpaint-edit edit family", () => {
  it("registers the krea2inpaint family", () => {
    const families = getEditFamilies();
    expect(families).toHaveProperty("krea2inpaint");
    expect(families.krea2inpaint.label).toBe("Inpaint");
    expect(families.krea2inpaint.action).toBe("edit_inpaint");
    expect(families.krea2inpaint.nodes).toBe(
      "ComfyUI-Inpaint-CropAndStitch + ComfyUI-Krea2-Ostris-Edit",
    );
  });

  it("includes the inpaint-edit LoRA in the bundled registry", () => {
    const loras = getBuiltinEditLoras();
    const inpaint = loras.find((l) => l.id === "inpaint-edit");
    expect(inpaint).toBeDefined();
    expect(inpaint!.family).toBe("krea2inpaint");
    expect(inpaint!.base).toBe("krea2-raw");
    expect(inpaint!.file).toBe("edit_tools/krea2_inpaint_edit_v2_17500.safetensors");
  });

  it("editActionFor resolves the inpaint family action", () => {
    expect(editActionFor("krea2inpaint")).toBe("edit_inpaint");
  });

  it("isEditFamily accepts krea2inpaint", () => {
    expect(isEditFamily("krea2inpaint")).toBe(true);
    expect(isEditFamily("bogus")).toBe(false);
  });

  it("mergeEditLoras includes inpaint-edit entry", () => {
    const merged = mergeEditLoras(undefined);
    const ids = merged.map((l) => l.id);
    expect(ids).toContain("inpaint-edit");
    expect(ids).toContain("identity-edit");
  });

  it("krea2-edit pack has edit_inpaint workflow", () => {
    const pack = getPack("krea2-edit");
    expect(pack).toBeDefined();
    expect(pack!.workflows).toHaveProperty("edit_inpaint");
    expect(pack!.workflows.edit_inpaint).toBe(
      "packs/krea2-edit/edit_inpaint.json",
    );
  });
});

// ---------------------------------------------------------------------------
// Draft-then-upscale pipeline
// ---------------------------------------------------------------------------

describe("draft-then-upscale", () => {
  it("--draft flag is parsed correctly", () => {
    const result = parseImagineInput("a cat --draft");
    expect(result.params.draft).toBe(true);
    expect(result.prompt).toBe("a cat");
  });

  it("--draft_scale is parsed as a float", () => {
    const result = parseImagineInput("a cat --draft --draft_scale 0.75");
    expect(result.params.draft).toBe(true);
    expect(result.params.draft_scale).toBe(0.75);
  });

  it("--refiner is parsed as a string", () => {
    const result = parseImagineInput(
      "a cat --draft --refiner upscale_creative",
    );
    expect(result.params.refiner).toBe("upscale_creative");
  });

  it("buildImagineRuns sets draftUpscale fields when --draft", () => {
    const parseResult = parseImagineInput("a cat --draft --ar 16:9");
    // Use a minimal workflow that has the slots the engine expects
    const workflow = {
      "1": {
        class_type: "EmptySD3LatentImage",
        inputs: { width: 1024, height: 1024, batch_size: 1 },
      },
      "2": {
        class_type: "KSampler",
        inputs: {
          model: ["3", 0],
          positive: ["4", 0],
          negative: ["5", 0],
          latent_image: ["1", 0],
          seed: 0,
          steps: 20,
          cfg: 7,
          sampler_name: "euler",
          scheduler: "normal",
          denoise: 1.0,
        },
      },
      "3": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: "test.safetensors" },
      },
      "4": {
        class_type: "CLIPTextEncode",
        inputs: { text: "", clip: ["3", 1] },
      },
      "5": {
        class_type: "CLIPTextEncode",
        inputs: { text: "", clip: ["3", 1] },
      },
      "6": {
        class_type: "VAEDecode",
        inputs: { samples: ["2", 0], vae: ["3", 2] },
      },
      "7": {
        class_type: "SaveImage",
        inputs: { images: ["6", 0], filename_prefix: "test" },
      },
    } as any;

    const runs = buildImagineRuns(parseResult, workflow);
    expect(runs).toHaveLength(1);
    expect(runs[0].draftUpscale).toBe(true);
    expect(runs[0].refinerSlot).toBe("upscale_subtle");
    // Target dims should be the un-reduced aspect ratio dimensions
    expect(runs[0].draftTargetWidth).toBeGreaterThan(0);
    expect(runs[0].draftTargetHeight).toBeGreaterThan(0);
  });

  it("buildImagineRuns does NOT set draftUpscale when --draft is absent", () => {
    const parseResult = parseImagineInput("a cat");
    const workflow = {
      "1": {
        class_type: "EmptySD3LatentImage",
        inputs: { width: 1024, height: 1024, batch_size: 1 },
      },
      "2": {
        class_type: "KSampler",
        inputs: {
          model: ["3", 0],
          positive: ["4", 0],
          negative: ["5", 0],
          latent_image: ["1", 0],
          seed: 0,
          steps: 20,
          cfg: 7,
          sampler_name: "euler",
          scheduler: "normal",
          denoise: 1.0,
        },
      },
      "3": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: "test.safetensors" },
      },
      "4": {
        class_type: "CLIPTextEncode",
        inputs: { text: "", clip: ["3", 1] },
      },
      "5": {
        class_type: "CLIPTextEncode",
        inputs: { text: "", clip: ["3", 1] },
      },
      "6": {
        class_type: "VAEDecode",
        inputs: { samples: ["2", 0], vae: ["3", 2] },
      },
      "7": {
        class_type: "SaveImage",
        inputs: { images: ["6", 0], filename_prefix: "test" },
      },
    } as any;

    const runs = buildImagineRuns(parseResult, workflow);
    expect(runs[0].draftUpscale).toBeUndefined();
    expect(runs[0].refinerSlot).toBeUndefined();
  });

  it("--draft --refiner upscale_creative sets the custom refiner slot", () => {
    const parseResult = parseImagineInput(
      "a cat --draft --refiner upscale_creative",
    );
    const workflow = {
      "1": {
        class_type: "EmptySD3LatentImage",
        inputs: { width: 1024, height: 1024, batch_size: 1 },
      },
      "2": {
        class_type: "KSampler",
        inputs: {
          model: ["3", 0],
          positive: ["4", 0],
          negative: ["5", 0],
          latent_image: ["1", 0],
          seed: 0,
          steps: 20,
          cfg: 7,
          sampler_name: "euler",
          scheduler: "normal",
          denoise: 1.0,
        },
      },
      "3": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: "test.safetensors" },
      },
      "4": {
        class_type: "CLIPTextEncode",
        inputs: { text: "", clip: ["3", 1] },
      },
      "5": {
        class_type: "CLIPTextEncode",
        inputs: { text: "", clip: ["3", 1] },
      },
      "6": {
        class_type: "VAEDecode",
        inputs: { samples: ["2", 0], vae: ["3", 2] },
      },
      "7": {
        class_type: "SaveImage",
        inputs: { images: ["6", 0], filename_prefix: "test" },
      },
    } as any;

    const runs = buildImagineRuns(parseResult, workflow);
    expect(runs[0].refinerSlot).toBe("upscale_creative");
  });
});

// ---------------------------------------------------------------------------
// Qwen-Image-2.1 pack (feature-gated)
// ---------------------------------------------------------------------------

describe("Qwen-Image-2.1 pack scaffolding", () => {
  it("is NOT registered by default (no env var)", () => {
    // CJ_QWEN_IMAGE_21 should not be set in test env
    const pack = getPack("qwen-image-21");
    expect(pack).toBeUndefined();
  });

  it("all packs do NOT include qwen-image-21 by default", () => {
    const ids = getAllPacks().map((p) => p.id);
    expect(ids).not.toContain("qwen-image-21");
  });

  // The pack IS registered when CJ_QWEN_IMAGE_21 is set, but we can't test
  // that without module re-evaluation. We verify the pack definition is
  // syntactically correct by checking the packs module loads without error.
  it("packs module loads cleanly", () => {
    expect(getAllPacks().length).toBeGreaterThanOrEqual(7);
  });
});

// ---------------------------------------------------------------------------
// Turbo preset verification on ComfyUI 0.38
// ---------------------------------------------------------------------------

describe("turbo presets", () => {
  it("krea2 turbo pack has Euler/Simple/cfg1/8-step defaults", () => {
    const pack = getPack("krea2");
    expect(pack).toBeDefined();
    expect(pack!.defaultOverrides).toEqual({
      steps: 8,
      cfg: 1.0,
      sampler: "euler",
      scheduler: "simple",
      denoise: 1.0,
    });
  });

  it("krea2-raw turbo-distill pack has Euler/Simple/cfg0/8-step defaults", () => {
    const pack = getPack("krea2-raw");
    expect(pack).toBeDefined();
    expect(pack!.defaultOverrides).toEqual({
      steps: 8,
      cfg: 0,
      sampler: "euler",
      scheduler: "simple",
      denoise: 1.0,
    });
  });

  it("krea2 turbo workflows are resolved from the pack", () => {
    const resolved = resolveWorkflow({
      templateOrAction: "t2i",
      packId: "krea2",
    });
    expect(resolved.source).toBe("pack_workflow");
    expect(resolved.workflowPath).toContain("krea2");
  });
});

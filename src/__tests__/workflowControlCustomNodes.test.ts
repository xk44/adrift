/**
 * Tests for workflow control custom-node classification/mapping —
 * AnimateDiff, IP-Adapter, upscale, video, file-like, image-like,
 * and broadened heuristic detection.
 */

import { describe, expect, it } from "vitest";
import {
  buildControlSchema,
  detectControlKind,
  deriveLabel,
  determineVisibility,
  isImageLikeInput,
  isFileLikeInput,
  MODEL_CATEGORY_TO_INVENTORY_KEY,
  CLASS_TYPE_TO_MODEL_CATEGORY,
  KNOWN_KIND_OVERRIDES,
  KNOWN_ENUM_OPTIONS,
  type ControlSchema,
  type ModelCategory,
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

// ---------------------------------------------------------------------------
// Custom-node class_type → model category
// ---------------------------------------------------------------------------

describe("CLASS_TYPE_TO_MODEL_CATEGORY — custom node entries", () => {
  it("maps AnimateDiff loaders", () => {
    expect(CLASS_TYPE_TO_MODEL_CATEGORY.AnimateDiffLoaderWithContext).toBe("animatediff");
    expect(CLASS_TYPE_TO_MODEL_CATEGORY.AnimateDiffModelLoader).toBe("animatediff");
    expect(CLASS_TYPE_TO_MODEL_CATEGORY.AnimateDiffLoader_v3).toBe("animatediff");
    expect(CLASS_TYPE_TO_MODEL_CATEGORY.AnimateDiffUnifiedLoader).toBe("animatediff");
    expect(CLASS_TYPE_TO_MODEL_CATEGORY.AnimateDiffUnifiedLoader_v2).toBe("animatediff");
  });

  it("maps video nodes", () => {
    expect(CLASS_TYPE_TO_MODEL_CATEGORY.VHS_VideoCombine).toBe("video");
    expect(CLASS_TYPE_TO_MODEL_CATEGORY.VHS_LoadVideo).toBe("video");
    expect(CLASS_TYPE_TO_MODEL_CATEGORY.SVD_img2vid_Conditioning).toBe("video");
    expect(CLASS_TYPE_TO_MODEL_CATEGORY.FrameInterpolation).toBe("video");
  });

  it("maps embedding / gligen / hypernetwork / style / diffusers", () => {
    expect(CLASS_TYPE_TO_MODEL_CATEGORY.CLIPTextEncodeWithWeight).toBe("embedding");
    expect(CLASS_TYPE_TO_MODEL_CATEGORY.GLIGENLoader).toBe("gligen");
    expect(CLASS_TYPE_TO_MODEL_CATEGORY.HypernetworkLoader).toBe("hypernetwork");
    expect(CLASS_TYPE_TO_MODEL_CATEGORY.StyleModelLoader).toBe("style");
    expect(CLASS_TYPE_TO_MODEL_CATEGORY.CheckpointLoaderDiffusers).toBe("diffusers");
    expect(CLASS_TYPE_TO_MODEL_CATEGORY.DiffusersLoader).toBe("diffusers");
  });

  it("maps all categories to inventory keys", () => {
    const categories: Array<keyof typeof MODEL_CATEGORY_TO_INVENTORY_KEY> = [
      "checkpoint", "lora", "vae", "controlnet", "upscale", "clip", "unet",
      "ipadapter", "embedding", "gligen", "hypernetwork", "diffusers",
      "animatediff", "video", "style",
    ];
    for (const cat of categories) {
      expect(MODEL_CATEGORY_TO_INVENTORY_KEY[cat]).toBeDefined();
      expect(typeof MODEL_CATEGORY_TO_INVENTORY_KEY[cat]).toBe("string");
      expect(MODEL_CATEGORY_TO_INVENTORY_KEY[cat].length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// detectControlKind — custom node inputs
// ---------------------------------------------------------------------------

describe("detectControlKind — custom node input detection", () => {
  it("detects IPAdapter inputs", () => {
    expect(detectControlKind("ipadapter_file", "ip-adapter_sd15.safetensors", "IPAdapterModelLoader")).toBe("model");
    expect(detectControlKind("start_at", 0.0, "IPAdapterAdvanced")).toBe("number");
    expect(detectControlKind("end_at", 1.0, "IPAdapterAdvanced")).toBe("number");
    expect(detectControlKind("faceid_mode", "orthogonal", "IPAdapterApplyFaceID")).toBe("enum");
    expect(detectControlKind("ipadapter_weight_type", "standard", "IPAdapterAdvanced")).toBe("enum");
  });

  it("detects AnimateDiff inputs", () => {
    expect(detectControlKind("model_path", "v3_sd15_mm.ckpt", "AnimateDiffLoaderWithContext")).toBe("model");
    expect(detectControlKind("beta_schedule", "autoselect", "AnimateDiffLoaderWithContext")).toBe("enum");
    expect(detectControlKind("motion_model", "v3_sd15_mm.ckpt", "AnimateDiffLoader_v3")).toBe("model");
  });

  it("detects video/file inputs", () => {
    expect(detectControlKind("video_path", "input/video.mp4", "VHS_LoadVideo")).toBe("file");
    expect(detectControlKind("audio_path", "input/audio.mp3", "VHS_LoadAudio")).toBe("file");
  });

  it("detects file kind via KNOWN_KIND_OVERRIDES", () => {
    expect(KNOWN_KIND_OVERRIDES.video_path).toBe("file");
    expect(KNOWN_KIND_OVERRIDES.audio_path).toBe("file");
  });

  it("detects custom model inputs via pattern", () => {
    // _name ending pattern
    expect(detectControlKind("embed_name", "embedding.pt", "CLIPTextEncodeWithWeight")).toBe("model");
    expect(detectControlKind("gligen_name", "gligen_model.pt", "GLIGENLoader")).toBe("model");
    expect(detectControlKind("hypernetwork_name", "hyper.safetensors", "HypernetworkLoader")).toBe("model");
    expect(detectControlKind("style_model_name", "style.safetensors", "StyleModelLoader")).toBe("model");

    // _model ending pattern
    expect(detectControlKind("upscale_model", "4x-UltraSharp.pth", "UpscaleModelLoader")).toBe("model");
    expect(detectControlKind("motion_model", "v3_sd15_mm.ckpt", "AnimateDiffModelLoader")).toBe("model");
  });

  it("detects clip multi-loader inputs", () => {
    expect(detectControlKind("clip_name1", "t5xxl_fp16.safetensors", "DualCLIPLoader")).toBe("model");
    expect(detectControlKind("clip_name2", "clip_l.safetensors", "DualCLIPLoader")).toBe("model");
    expect(detectControlKind("clip_name3", "clip_g.safetensors", "TripleCLIPLoader")).toBe("model");
  });

  it("detects upscale method enum", () => {
    expect(detectControlKind("upscale_method", "bilinear", "ImageScale")).toBe("enum");
    expect(KNOWN_ENUM_OPTIONS.upscale_method).toBeDefined();
    expect(KNOWN_ENUM_OPTIONS.upscale_method).toContain("nearest");
    expect(KNOWN_ENUM_OPTIONS.upscale_method).toContain("lanczos");
  });

  it("detects weight_dtype enum", () => {
    expect(detectControlKind("weight_dtype", "fp8_e4m3fn", "UNETLoader")).toBe("enum");
    expect(KNOWN_ENUM_OPTIONS.weight_dtype).toBeDefined();
    expect(KNOWN_ENUM_OPTIONS.weight_dtype).toContain("fp16");
  });

  it("detects known link inputs", () => {
    expect(detectControlKind("control_net", ["3", 0], "ControlNetApply")).toBe("link");
    expect(detectControlKind("lora_stack", ["5", 0], "SomeNode")).toBe("link");
    expect(detectControlKind("conditioning", ["7", 0], "SomeNode")).toBe("link");
  });

  it("detects image-like pattern inputs", () => {
    expect(detectControlKind("reference_image", "photo.png", "IPAdapterApply")).toBe("image");
    expect(detectControlKind("input_image", "photo.png", "SomeNode")).toBe("image");
  });
});

// ---------------------------------------------------------------------------
// isImageLikeInput
// ---------------------------------------------------------------------------

describe("isImageLikeInput", () => {
  it("detects exact matches", () => {
    expect(isImageLikeInput("image")).toBe(true);
    expect(isImageLikeInput("mask")).toBe(true);
    expect(isImageLikeInput("source_image")).toBe(true);
    expect(isImageLikeInput("image_emb")).toBe(true);
    expect(isImageLikeInput("original_image")).toBe(true);
    expect(isImageLikeInput("target_image")).toBe(true);
    expect(isImageLikeInput("reference_image")).toBe(true);
    expect(isImageLikeInput("input_image")).toBe(true);
    expect(isImageLikeInput("input_mask")).toBe(true);
  });

  it("detects pattern matches", () => {
    expect(isImageLikeInput("source_image")).toBe(true);
    expect(isImageLikeInput("ref_mask")).toBe(true);
    expect(isImageLikeInput("text_img")).toBe(true);
  });

  it("rejects non-image keys", () => {
    expect(isImageLikeInput("steps")).toBe(false);
    expect(isImageLikeInput("ckpt_name")).toBe(false);
    expect(isImageLikeInput("model_path")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isFileLikeInput
// ---------------------------------------------------------------------------

describe("isFileLikeInput", () => {
  it("detects _path pattern", () => {
    expect(isFileLikeInput("video_path", "video.mp4")).toBe(true);
    expect(isFileLikeInput("audio_path", "audio.mp3")).toBe(true);
  });

  it("detects video- and audio- prefix patterns", () => {
    expect(isFileLikeInput("video_file", "vid.mp4")).toBe(true);
    expect(isFileLikeInput("audio_file", "aud.mp3")).toBe(true);
  });

  it("detects clip_ prefix pattern", () => {
    expect(isFileLikeInput("clip_path", "clip.bin")).toBe(true);
  });

  it("detects file extension heuristic", () => {
    expect(isFileLikeInput("unknown_input", "movie.mp4")).toBe(true);
    expect(isFileLikeInput("sound_input", "track.wav")).toBe(true);
  });

  it("does not flag model-like keys as file", () => {
    // The model_path is already handled by isModelSelectorInput which takes precedence in detectControlKind
    // but isFileLikeInput itself should still match (the priority logic in detectControlKind prevents false positives)
    expect(isFileLikeInput("ckpt_name", "model.safetensors")).toBe(false);
  });

  it("does not flag image-like keys", () => {
    expect(isFileLikeInput("image", "photo.png")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveLabel — new labels
// ---------------------------------------------------------------------------

describe("deriveLabel — custom node labels", () => {
  it("returns labels for IP-Adapter inputs", () => {
    expect(deriveLabel("start_at")).toBe("Start At");
    expect(deriveLabel("end_at")).toBe("End At");
    expect(deriveLabel("faceid_mode")).toBe("FaceID Mode");
    expect(deriveLabel("ipadapter_weight_type")).toBe("Weight Type");
    expect(deriveLabel("embed_name")).toBe("Embedding");
  });

  it("returns labels for multi-CLIP loaders", () => {
    expect(deriveLabel("clip_name1")).toBe("CLIP Model 1");
    expect(deriveLabel("clip_name2")).toBe("CLIP Model 2");
    expect(deriveLabel("clip_name3")).toBe("CLIP Model 3");
  });

  it("returns labels for AnimateDiff inputs", () => {
    expect(deriveLabel("model_path")).toBe("Motion Model");
    expect(deriveLabel("beta_schedule")).toBe("Beta Schedule");
    expect(deriveLabel("motion_model")).toBe("Motion Model");
    expect(deriveLabel("animdiff_model")).toBe("AnimateDiff Model");
  });

  it("returns labels for video inputs", () => {
    expect(deriveLabel("video_path")).toBe("Video File");
    expect(deriveLabel("audio_path")).toBe("Audio File");
    expect(deriveLabel("frame_rate")).toBe("Frame Rate");
  });

  it("returns labels for upscale / weight", () => {
    expect(deriveLabel("upscale_model")).toBe("Upscale Model");
    expect(deriveLabel("upscale_factor")).toBe("Upscale Factor");
    expect(deriveLabel("weight_dtype")).toBe("Weight Dtype");
  });

  it("returns labels for gligen / hypernetwork / style", () => {
    expect(deriveLabel("gligen_name")).toBe("GLIGEN Model");
    expect(deriveLabel("hypernetwork_name")).toBe("Hypernetwork");
    expect(deriveLabel("style_model_name")).toBe("Style Model");
    expect(deriveLabel("diffusers_model")).toBe("Diffusers Model");
  });
});

// ---------------------------------------------------------------------------
// determineVisibility — custom node wiring hidden
// ---------------------------------------------------------------------------

describe("determineVisibility — custom node wiring inputs", () => {
  it("hides common wiring inputs", () => {
    expect(determineVisibility("images", "link", [], "SaveImage")).toBe(false);
    expect(determineVisibility("conditioning", "link", [], "SomeNode")).toBe(false);
    expect(determineVisibility("t5xxl", "link", [], "DualCLIPLoader")).toBe(false);
    expect(determineVisibility("clip_l", "link", [], "DualCLIPLoader")).toBe(false);
  });

  it("hides custom output wiring keys", () => {
    expect(determineVisibility("latent_out", "link", [], "SomeNode")).toBe(false);
    expect(determineVisibility("image_out", "link", [], "SomeNode")).toBe(false);
    expect(determineVisibility("model_out", "link", [], "SomeNode")).toBe(false);
  });

  it("shows file-type controls", () => {
    expect(determineVisibility("video_path", "file", "video.mp4", "VHS_LoadVideo")).toBe(true);
    expect(determineVisibility("audio_path", "file", "audio.wav", "VHS_LoadAudio")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildControlSchema — custom node workflows
// ---------------------------------------------------------------------------

describe("buildControlSchema — AnimateDiff workflow", () => {
  const animWorkflow: Workflow = {
    "1": makeNode("CheckpointLoaderSimple", { ckpt_name: "sd15.safetensors", model: ["1", 0], clip: ["1", 1], vae: ["1", 2] }),
    "2": makeNode("AnimateDiffLoaderWithContext", {
      model_path: "v3_sd15_mm.ckpt",
      beta_schedule: "autoselect",
      model: ["1", 0],
    }),
    "3": makeNode("KSampler", {
      seed: 42, steps: 20, cfg: 7.0,
      sampler_name: "euler", scheduler: "normal", denoise: 1.0,
      model: ["2", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0],
    }),
  };

  it("detects AnimateDiff model as model kind", () => {
    const result = buildControlSchema(animWorkflow);
    const modelPath = result.controls.find((c) => c.inputKey === "model_path");
    expect(modelPath).toBeDefined();
    expect(modelPath!.kind).toBe("model");
    expect(modelPath!.modelCategory).toBe("animatediff");
  });

  it("detects beta_schedule as enum", () => {
    const result = buildControlSchema(animWorkflow);
    const betaCtrl = result.controls.find((c) => c.inputKey === "beta_schedule");
    expect(betaCtrl).toBeDefined();
    expect(betaCtrl!.kind).toBe("enum");
    expect(betaCtrl!.options).toBeDefined();
    expect(betaCtrl!.options).toContain("autoselect");
  });

  it("groups AnimateDiff loader into AnimateDiff group", () => {
    const result = buildControlSchema(animWorkflow);
    const modelPath = result.controls.find((c) => c.inputKey === "model_path");
    expect(modelPath!.group).toBe("AnimateDiff");
  });
});

describe("buildControlSchema — IPAdapter workflow", () => {
  const ipaWorkflow: Workflow = {
    "1": makeNode("IPAdapterModelLoader", { ipadapter_file: "ip-adapter_sd15.safetensors" }),
    "2": makeNode("IPAdapterAdvanced", {
      start_at: 0.0,
      end_at: 1.0,
      faceid_mode: "orthogonal",
      ipadapter_weight_type: "standard",
      image_emb: "reference.png",
    }),
  };

  it("detects IPAdapter file as model kind", () => {
    const result = buildControlSchema(ipaWorkflow);
    const ipaCtrl = result.controls.find((c) => c.inputKey === "ipadapter_file");
    expect(ipaCtrl).toBeDefined();
    expect(ipaCtrl!.kind).toBe("model");
    expect(ipaCtrl!.modelCategory).toBe("ipadapter");
  });

  it("detects IPAdapter numeric inputs with bounds", () => {
    const result = buildControlSchema(ipaWorkflow);
    const startCtrl = result.controls.find((c) => c.inputKey === "start_at");
    expect(startCtrl).toBeDefined();
    expect(startCtrl!.kind).toBe("number");
    expect(startCtrl!.min).toBe(0);
    expect(startCtrl!.max).toBe(1);

    const endCtrl = result.controls.find((c) => c.inputKey === "end_at");
    expect(endCtrl).toBeDefined();
    expect(endCtrl!.kind).toBe("number");
    expect(endCtrl!.max).toBe(1);
  });

  it("detects IPAdapter enum inputs", () => {
    const result = buildControlSchema(ipaWorkflow);
    const faceidCtrl = result.controls.find((c) => c.inputKey === "faceid_mode");
    expect(faceidCtrl).toBeDefined();
    expect(faceidCtrl!.kind).toBe("enum");

    const weightType = result.controls.find((c) => c.inputKey === "ipadapter_weight_type");
    expect(weightType).toBeDefined();
    expect(weightType!.kind).toBe("enum");
  });

  it("detects image_emb as image kind", () => {
    const result = buildControlSchema(ipaWorkflow);
    const imgCtrl = result.controls.find((c) => c.inputKey === "image_emb");
    // image_emb has a KNOWN_KIND_OVERRIDES entry as "image", but it's a string value
    // so detectControlKind should pick it up via the override
    expect(imgCtrl).toBeDefined();
    expect(imgCtrl!.kind).toBe("image");
  });
});

describe("buildControlSchema — Video workflow", () => {
  const videoWorkflow: Workflow = {
    "1": makeNode("VHS_LoadVideo", { video_path: "input/my_video.mp4", frame_rate: 24 }),
  };

  it("detects video_path as file kind", () => {
    const result = buildControlSchema(videoWorkflow);
    const videoCtrl = result.controls.find((c) => c.inputKey === "video_path");
    expect(videoCtrl).toBeDefined();
    expect(videoCtrl!.kind).toBe("file");
  });

  it("detects frame_rate as number", () => {
    const result = buildControlSchema(videoWorkflow);
    const fpsCtrl = result.controls.find((c) => c.inputKey === "frame_rate");
    expect(fpsCtrl).toBeDefined();
    expect(fpsCtrl!.kind).toBe("number");
  });

  it("labels video_path correctly", () => {
    const result = buildControlSchema(videoWorkflow);
    const videoCtrl = result.controls.find((c) => c.inputKey === "video_path");
    expect(videoCtrl!.label).toBe("Video File");
  });
});

describe("buildControlSchema — Gligen/Hypernetwork/Style", () => {
  it("detects GLIGEN loader model", () => {
    const wf: Workflow = {
      "1": makeNode("GLIGENLoader", { gligen_name: "gligen_sd14.safetensors" }),
    };
    const result = buildControlSchema(wf);
    const ctrl = result.controls.find((c) => c.inputKey === "gligen_name");
    expect(ctrl).toBeDefined();
    expect(ctrl!.kind).toBe("model");
    expect(ctrl!.modelCategory).toBe("gligen");
    expect(ctrl!.label).toBe("GLIGEN Model");
  });

  it("detects Hypernetwork loader model", () => {
    const wf: Workflow = {
      "1": makeNode("HypernetworkLoader", { hypernetwork_name: "hyper.safetensors", strength: 1.0 }),
    };
    const result = buildControlSchema(wf);
    const ctrl = result.controls.find((c) => c.inputKey === "hypernetwork_name");
    expect(ctrl).toBeDefined();
    expect(ctrl!.kind).toBe("model");
    expect(ctrl!.modelCategory).toBe("hypernetwork");
  });

  it("detects Style model loader", () => {
    const wf: Workflow = {
      "1": makeNode("StyleModelLoader", { style_model_name: "style.safetensors" }),
    };
    const result = buildControlSchema(wf);
    const ctrl = result.controls.find((c) => c.inputKey === "style_model_name");
    expect(ctrl).toBeDefined();
    expect(ctrl!.kind).toBe("model");
    expect(ctrl!.modelCategory).toBe("style");
  });
});

// ---------------------------------------------------------------------------
// Enum options coverage
// ---------------------------------------------------------------------------

describe("KNOWN_ENUM_OPTIONS — custom node enums", () => {
  it("has upscale_method options", () => {
    expect(KNOWN_ENUM_OPTIONS.upscale_method).toBeDefined();
    expect(KNOWN_ENUM_OPTIONS.upscale_method.length).toBeGreaterThanOrEqual(4);
    expect(KNOWN_ENUM_OPTIONS.upscale_method).toContain("nearest");
    expect(KNOWN_ENUM_OPTIONS.upscale_method).toContain("lanczos");
  });

  it("has weight_dtype options", () => {
    expect(KNOWN_ENUM_OPTIONS.weight_dtype).toBeDefined();
    expect(KNOWN_ENUM_OPTIONS.weight_dtype).toContain("fp16");
    expect(KNOWN_ENUM_OPTIONS.weight_dtype).toContain("bf16");
    expect(KNOWN_ENUM_OPTIONS.weight_dtype).toContain("fp8_e4m3fn");
  });

  it("has beta_schedule options", () => {
    expect(KNOWN_ENUM_OPTIONS.beta_schedule).toBeDefined();
    expect(KNOWN_ENUM_OPTIONS.beta_schedule.length).toBeGreaterThan(0);
  });

  it("has faceid_mode options", () => {
    expect(KNOWN_ENUM_OPTIONS.faceid_mode).toBeDefined();
    expect(KNOWN_ENUM_OPTIONS.faceid_mode).toContain("orthogonal");
    expect(KNOWN_ENUM_OPTIONS.faceid_mode).toContain("concat");
  });

  it("has ipadapter_weight_type options", () => {
    expect(KNOWN_ENUM_OPTIONS.ipadapter_weight_type).toBeDefined();
    expect(KNOWN_ENUM_OPTIONS.ipadapter_weight_type.length).toBeGreaterThan(0);
  });

  it("has crop options", () => {
    expect(KNOWN_ENUM_OPTIONS.crop).toBeDefined();
    expect(KNOWN_ENUM_OPTIONS.crop).toContain("disabled");
    expect(KNOWN_ENUM_OPTIONS.crop).toContain("center");
  });
});

// ---------------------------------------------------------------------------
// Detection heuristic — _name and _model patterns
// ---------------------------------------------------------------------------

describe("detectControlKind — pattern-based detection", () => {
  it("matches custom _name endings as model", () => {
    // These don't have explicit overrides but match the _name pattern
    expect(detectControlKind("custom_lora_name", "model.safetensors", "SomeNode")).toBe("model");
    expect(detectControlKind("embedding_name", "embed.pt", "SomeNode")).toBe("model");
  });

  it("matches _model suffix pattern", () => {
    expect(detectControlKind("custom_upscale_model", "4x-UltraSharp.pth", "SomeNode")).toBe("model");
  });

  it("matches _path suffix pattern", () => {
    expect(detectControlKind("custom_model_path", "model.ckpt", "SomeNode")).toBe("model");
  });

  it("excludes known non-model _name patterns", () => {
    // filename_name would be excluded but doesn't match the negative regex
    // The negative regex is ^(text|prompt|filename|folder)$
    expect(detectControlKind("text", "hello", "SomeNode")).toBe("string"); // explicit override
    expect(detectControlKind("prompt", "hello", "SomeNode")).toBe("string"); // explicit override
  });
});

// ---------------------------------------------------------------------------
// file kind integration
// ---------------------------------------------------------------------------

describe("buildControlSchema — file kind in full workflow", () => {
  it("file controls are visible by default", () => {
    const wf: Workflow = {
      "1": makeNode("VHS_LoadVideo", { video_path: "input/vid.mp4", frame_rate: 30 }),
    };
    const result = buildControlSchema(wf);
    const videoCtrl = result.controls.find((c) => c.inputKey === "video_path");
    expect(videoCtrl).toBeDefined();
    expect(videoCtrl!.visible).toBe(true);
  });

  it("file controls are editable", () => {
    const wf: Workflow = {
      "1": makeNode("VHS_LoadVideo", { video_path: "input/vid.mp4" }),
    };
    const result = buildControlSchema(wf);
    const editable = getEditableControls(result.controls);
    const fileCtrl = editable.find((c: ControlSchema) => c.inputKey === "video_path");
    expect(fileCtrl).toBeDefined();
  });
});
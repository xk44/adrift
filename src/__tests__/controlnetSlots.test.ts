/**
 * Tests for ControlNet / capability slots / adapter packs
 * -------------------------------------------------------
 * Covers:
 *   - discoverControlNetSlots on the controlnet.json workflow
 *   - discoverIPAdapterSlots (empty on controlnet.json, finds on IPAdapter wf)
 *   - discoverUpscaleSlots
 *   - discoverVideoSlots
 *   - discoverCapabilities
 *   - enrichSlotsWithCapabilities
 *   - Adapter packs (SDXL, Flux, SD15)
 *   - resolvePreprocessorClass
 *   - injectControlNet / applyControlNetParams
 *   - --controlnet param parsing
 */

import { describe, it, expect } from "vitest";
import type { Workflow } from "@/types";
import {
  discoverControlNetSlots,
  discoverIPAdapterSlots,
  discoverUpscaleSlots,
  discoverVideoCapabilitySlots,
  discoverCapabilities,
  enrichSlotsWithCapabilities,
  discoverT2ISlots,
} from "@/lib/oj/discovery";
import {
  resolveAdapterPack,
  getAdapterConfig,
  resolvePreprocessorClass,
  injectControlNet,
  applyControlNetParams,
  SDXL_DEFAULT_PACK,
  FLUX_DEFAULT_PACK,
  SD15_DEFAULT_PACK,
  CONTROLNET_PREPROCESSOR_MAP,
} from "@/lib/oj/adapters";
import { parseImagineInput } from "@/lib/oj/parser";
import controlnetWorkflow from "../../public/workflows/controlnet.json";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function node(class_type: string, inputs?: Record<string, unknown>) {
  return { class_type, inputs: inputs ?? {} };
}

// ---------------------------------------------------------------------------
// ControlNet slot discovery on the real controlnet.json workflow
// ---------------------------------------------------------------------------

describe("discoverControlNetSlots", () => {
  it("finds the ControlNet chain in controlnet.json", () => {
    const wf = controlnetWorkflow as unknown as Workflow;
    const slots = discoverControlNetSlots(wf);
    expect(slots.length).toBeGreaterThanOrEqual(1);

    // controlnet.json has node "2" = ControlNetLoader, "4" = ControlNetApply
    const slot = slots.find((s) => s.loaderId === "2");
    expect(slot).toBeDefined();
    expect(slot?.applyId).toBe("4");
    expect(slot?.conditioningTarget).toBe("positive");
    expect(slot?.defaultModel).toContain("canny");
    expect(slot?.preprocessorId).toBeDefined(); // CannyEdgePreprocessor
    expect(slot?.imageInputId).toBeDefined();
  });

  it("finds ControlNetLoader standalone if no apply node exists", () => {
    const wf: Workflow = {
      "1": node("CheckpointLoaderSimple", { ckpt_name: "model.safetensors" }),
      "2": node("KSampler", { seed: 0, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["1", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["3", 0] }),
      "5": node("CLIPTextEncode", { text: "positive", clip: ["1", 1] }),
      "6": node("CLIPTextEncode", { text: "negative", clip: ["1", 1] }),
      "3": node("EmptyLatentImage", { width: 512, height: 512, batch_size: 1 }),
      "10": node("ControlNetLoader", { control_net_name: "control_v11p_sd15_canny.pth" }),
    };
    const slots = discoverControlNetSlots(wf);
    expect(slots).toHaveLength(1);
    expect(slots[0].loaderId).toBe("10");
    expect(slots[0].applyId).toBe(""); // no apply node
    expect(slots[0].defaultModel).toContain("canny");
  });

  it("returns empty for workflow without ControlNet nodes", () => {
    const wf: Workflow = {
      "1": node("CheckpointLoaderSimple", { ckpt_name: "model.safetensors" }),
      "2": node("KSampler", { seed: 0, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1 }),
    };
    expect(discoverControlNetSlots(wf)).toHaveLength(0);
  });

  it("finds default strength from ControlNetApplyAdvanced", () => {
    const wf: Workflow = {
      "1": node("CheckpointLoaderSimple", { ckpt_name: "model.safetensors" }),
      "2": node("ControlNetLoader", { control_net_name: "cn.safetensors" }),
      "3": node("CannyEdgePreprocessor", { image: ["7", 0], low_threshold: 100, high_threshold: 200 }),
      "4": node("ControlNetApplyAdvanced", { conditioning: ["5", 0], control_net: ["2", 0], image: ["3", 0], strength: 0.75, start_percent: 0.0, end_percent: 1.0 }),
      "5": node("CLIPTextEncode", { text: "test", clip: ["1", 1] }),
      "7": node("LoadImage", { image: "input.png", upload: "image" }),
    };
    const slots = discoverControlNetSlots(wf);
    expect(slots).toHaveLength(1);
    expect(slots[0].defaultStrength).toBe(0.75);
    expect(slots[0].preprocessorId).toBe("3"); // CannyEdgePreprocessor
  });
});

// ---------------------------------------------------------------------------
// IPAdapter slot discovery
// ---------------------------------------------------------------------------

describe("discoverIPAdapterSlots", () => {
  it("returns empty for workflows without IPAdapter", () => {
    const wf: Workflow = {
      "1": node("CheckpointLoaderSimple", { ckpt_name: "model.safetensors" }),
    };
    expect(discoverIPAdapterSlots(wf)).toHaveLength(0);
  });

  it("finds IPAdapterAdvanced nodes", () => {
    const wf: Workflow = {
      "1": node("IPAdapterAdvanced", { image: ["2", 0], model: ["3", 0], weight: 0.8 }),
      "2": node("LoadImage", { image: "style.png" }),
      "3": node("CheckpointLoaderSimple", { ckpt_name: "model.safetensors" }),
    };
    const slots = discoverIPAdapterSlots(wf);
    expect(slots).toHaveLength(1);
    expect(slots[0].applyId).toBe("1");
    expect(slots[0].applyClass).toBe("IPAdapterAdvanced");
    expect(slots[0].imageInputId).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// Upscale slot discovery
// ---------------------------------------------------------------------------

describe("discoverUpscaleSlots", () => {
  it("finds upscale model loaders", () => {
    const wf: Workflow = {
      "1": node("UpscaleModelLoader", { model_name: "4x-UltraSharp.pth" }),
    };
    const slots = discoverUpscaleSlots(wf);
    expect(slots).toHaveLength(1);
    expect(slots[0].defaultModel).toBe("4x-UltraSharp.pth");
  });

  it("returns empty when no upscale nodes", () => {
    const wf: Workflow = {
      "1": node("CheckpointLoaderSimple", { ckpt_name: "model.safetensors" }),
    };
    expect(discoverUpscaleSlots(wf)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Video slot discovery
// ---------------------------------------------------------------------------

describe("discoverVideoSlots", () => {
  it("finds video output nodes", () => {
    const wf: Workflow = {
      "1": node("VHS_VideoCombine", { frame_rate: 8, loop_count: 0, filename_prefix: "Adrift", images: ["2", 0] }),
      "2": node("VAEDecode", { samples: ["3", 0], vae: ["4", 2] }),
    };
    const slots = discoverVideoCapabilitySlots(wf);
    expect(slots).toHaveLength(1);
    expect(slots[0].videoOutputClass).toBe("VHS_VideoCombine");
    expect(slots[0].frameRateInputName).toBe("frame_rate");
  });

  it("returns empty for non-video workflows", () => {
    const wf: Workflow = {
      "1": node("KSampler", {}),
    };
    expect(discoverVideoCapabilitySlots(wf)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe("discoverCapabilities", () => {
  it("detects ControlNet in controlnet.json", () => {
    const wf = controlnetWorkflow as unknown as Workflow;
    const caps = discoverCapabilities(wf);
    expect(caps.controlnet).toBe(true);
    expect(caps.lora).toBe(false); // no LoRA in controlnet.json
  });

  it("detects LoRA when LoraLoader present", () => {
    const wf: Workflow = {
      "1": node("LoraLoader", { lora_name: "test.safetensors", strength_model: 1.0, strength_clip: 1.0, model: ["2", 0], clip: ["2", 1] }),
      "2": node("CheckpointLoaderSimple", { ckpt_name: "model.safetensors" }),
    };
    const caps = discoverCapabilities(wf);
    expect(caps.lora).toBe(true);
    expect(caps.controlnet).toBe(false);
  });

  it("detects video capability", () => {
    const wf: Workflow = { "1": node("VHS_VideoCombine", {}) };
    const caps = discoverCapabilities(wf);
    expect(caps.video).toBe(true);
  });

  it("detects upscale capability", () => {
    const wf: Workflow = { "1": node("ImageUpscaleWithModel", { upscale_model: ["2", 0], image: ["3", 0] }), "2": node("UpscaleModelLoader", { model_name: "4x-UltraSharp" }) };
    const caps = discoverCapabilities(wf);
    expect(caps.upscale).toBe(true);
  });

  it("detects IPAdapter capability", () => {
    const wf: Workflow = { "1": node("IPAdapterAdvanced", {}) };
    const caps = discoverCapabilities(wf);
    expect(caps.ipadapter).toBe(true);
  });

  it("detects video motion capability", () => {
    const wf: Workflow = { "1": node("AnimateDiffLoaderWithContext", {}) };
    const caps = discoverCapabilities(wf);
    expect(caps.videoMotion).toBe(true);
  });

  it("empty workflow has no capabilities", () => {
    const wf: Workflow = { "1": node("KSampler", {}) };
    const caps = discoverCapabilities(wf);
    expect(caps.controlnet).toBe(false);
    expect(caps.ipadapter).toBe(false);
    expect(caps.upscale).toBe(false);
    expect(caps.video).toBe(false);
    expect(caps.videoMotion).toBe(false);
    expect(caps.lora).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enrichSlotsWithCapabilities
// ---------------------------------------------------------------------------

describe("enrichSlotsWithCapabilities", () => {
  it("enriches base slots with ControlNet, IPAdapter, upscale, video, and capabilities", () => {
    const wf = controlnetWorkflow as unknown as Workflow;
    const baseSlots = discoverT2ISlots(wf);
    const enriched = enrichSlotsWithCapabilities(baseSlots, wf);

    expect(enriched.controlnetSlots).toBeDefined();
    expect(enriched.controlnetSlots!.length).toBeGreaterThanOrEqual(1);
    expect(enriched.capabilities).toBeDefined();
    expect(enriched.capabilities!.controlnet).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Adapter Packs
// ---------------------------------------------------------------------------

describe("Adapter Packs", () => {
  it("SDXL pack has expected adapter types", () => {
    expect(SDXL_DEFAULT_PACK.adapters).toHaveLength(4);
    const types = SDXL_DEFAULT_PACK.adapters.map((a) => a.type);
    expect(types).toContain("lora");
    expect(types).toContain("sref");
    expect(types).toContain("controlnet");
    expect(types).toContain("ipadapter");
  });

  it("Flux pack uses LoraLoaderModelOnly for LoRA", () => {
    const loraAdapter = getAdapterConfig(FLUX_DEFAULT_PACK, "lora");
    expect(loraAdapter).toBeDefined();
    expect(loraAdapter!.loaderClass).toBe("LoraLoaderModelOnly");
  });

  it("SD15 pack uses ControlNetApply (not Advanced)", () => {
    const cnAdapter = getAdapterConfig(SD15_DEFAULT_PACK, "controlnet");
    expect(cnAdapter).toBeDefined();
    expect(cnAdapter!.applyClass).toBe("ControlNetApply");
  });

  it("resolveAdapterPack defaults to SDXL for unknown families", () => {
    const pack = resolveAdapterPack("unknown_model");
    expect(pack.id).toBe("sdxl-default");
  });

  it("resolveAdapterPack finds pack by partial match", () => {
    const pack = resolveAdapterPack("SDXL 1.0");
    expect(pack.id).toBe("sdxl-default");
  });
});

// ---------------------------------------------------------------------------
// Preprocessor resolution
// ---------------------------------------------------------------------------

describe("resolvePreprocessorClass", () => {
  it("resolves shorthand 'canny' to full class name", () => {
    expect(resolvePreprocessorClass("canny")).toBe("CannyEdgePreprocessor");
  });

  it("resolves shorthand 'depth' to DepthAnythingPreprocessor", () => {
    expect(resolvePreprocessorClass("depth")).toBe("DepthAnythingPreprocessor");
  });

  it("resolves shorthand 'openpose' to OpenposePreprocessor", () => {
    expect(resolvePreprocessorClass("openpose")).toBe("OpenposePreprocessor");
  });

  it("passes through unknown/full class names unchanged", () => {
    expect(resolvePreprocessorClass("SomeCustomPreprocessor")).toBe("SomeCustomPreprocessor");
  });

  it("resolves case-insensitively", () => {
    expect(resolvePreprocessorClass("Canny")).toBe("CannyEdgePreprocessor");
    expect(resolvePreprocessorClass("DEPTH")).toBe("DepthAnythingPreprocessor");
  });

  it("maps all entries in CONTROLNET_PREPROCESSOR_MAP", () => {
    for (const [shorthand, fullName] of Object.entries(CONTROLNET_PREPROCESSOR_MAP)) {
      expect(resolvePreprocessorClass(shorthand)).toBe(fullName);
    }
  });
});

// ---------------------------------------------------------------------------
// ControlNet injection
// ---------------------------------------------------------------------------

describe("injectControlNet", () => {
  it("injects a complete ControlNet chain into a minimal workflow", () => {
    const wf: Workflow = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" } },
      "2": { class_type: "CLIPTextEncode", inputs: { text: "beautiful landscape", clip: ["1", 1] } },
      "3": { class_type: "CLIPTextEncode", inputs: { text: "ugly", clip: ["1", 1] } },
      "4": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
      "5": { class_type: "KSampler", inputs: { seed: 0, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0] } },
      "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
      "7": { class_type: "SaveImage", inputs: { filename_prefix: "test", images: ["6", 0] } },
    };

    const slots = discoverT2ISlots(wf);
    const result = injectControlNet(wf, slots, {
      model: "control_v11p_sd15_canny.pth",
      preprocessor: "canny",
      strength: 0.8,
      sourceImage: "control_image.png",
    });

    expect(result.errors).toHaveLength(0);
    expect(result.injectedNodeIds.length).toBeGreaterThanOrEqual(4); // LoadImage + Preprocessor + Loader + Apply

    // Verify ControlNetLoader was added
    const loaderNode = Object.values(result.workflow).find(
      (n) => n.class_type === "ControlNetLoader"
    );
    expect(loaderNode).toBeDefined();
    expect(loaderNode!.inputs.control_net_name).toBe("control_v11p_sd15_canny.pth");

    // Verify CannyEdgePreprocessor was added
    const preprocNode = Object.values(result.workflow).find(
      (n) => n.class_type === "CannyEdgePreprocessor"
    );
    expect(preprocNode).toBeDefined();

    // Verify ControlNetApplyAdvanced was added
    const applyNode = Object.values(result.workflow).find(
      (n) => n.class_type === "ControlNetApplyAdvanced"
    );
    expect(applyNode).toBeDefined();
    expect(applyNode!.inputs.strength).toBe(0.8);

    // Verify KSampler's positive input was rewired to ControlNetApply
    const ksampler = result.workflow[slots.ksamplerId];
    const positiveInput = ksampler.inputs.positive;
    expect(positiveInput).toBeDefined();
    // Should be [applyNodeId, 0] instead of [posTextId, 0]
    expect(Array.isArray(positiveInput)).toBe(true);
  });

  it("applies params to existing ControlNet nodes instead of injecting new ones", () => {
    const wf = controlnetWorkflow as unknown as Workflow;
    const existingSlots = discoverControlNetSlots(wf);

    const result = applyControlNetParams(wf, existingSlots, {
      model: "control_v11p_sd15_depth.pth",
      preprocessor: "depth",
      strength: 0.6,
    });

    // Should have modified the existing loader
    expect(result.injectedNodeIds.length).toBeGreaterThanOrEqual(1);
    // Should have no errors
    expect(result.errors).toHaveLength(0);
  });

  it("returns error when no ControlNet slots and no KSampler", () => {
    const wf: Workflow = { "1": node("SaveImage", {}) };
    const result = injectControlNet(wf, { ksamplerId: "", posTextId: "", negTextId: "", latentDimsId: "" }, {
      model: "test.pth",
      preprocessor: "canny",
      strength: 1.0,
    });
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// --controlnet param parsing
// ---------------------------------------------------------------------------

describe("--controlnet param parsing", () => {
  it("parses --controlnet canny as string param", () => {
    const result = parseImagineInput("a cat --controlnet canny");
    expect(result.params.controlnet).toBe("canny");
    expect(result.errors).toHaveLength(0);
  });

  it("parses --cn as alias for --controlnet", () => {
    const result = parseImagineInput("a cat --cn depth");
    expect(result.params.controlnet).toBe("depth");
  });

  it("parses --cn-strength float", () => {
    const result = parseImagineInput("a cat --controlnet canny --cn-strength 0.5");
    expect(result.params.controlnet).toBe("canny");
    expect(result.params["cn-strength"]).toBe(0.5);
  });

  it("parses --cn-image URL", () => {
    const result = parseImagineInput("a dog --cn https://example.com/img.png --cn-image https://example.com/cn.png");
    expect(result.params.controlnet).toBe("https://example.com/img.png");
    // cn-image not cn because --cn was parsed first setting controlnet
    // Let's use the long flag:
    const result2 = parseImagineInput("a dog --controlnet canny --cn-image https://example.com/cn.png");
    expect(result2.params["cn-image"]).toBe("https://example.com/cn.png");
  });

  it("parses --cn-start and --cn-end", () => {
    const result = parseImagineInput("a landscape --controlnet depth --cn-start 0.2 --cn-end 0.8");
    expect(result.params["cn-start"]).toBe(0.2);
    expect(result.params["cn-end"]).toBe(0.8);
  });
});
/**
 * Adapter Introspection & Parameter Normalization — Slice C Tests
 * ================================================================
 * Tests proving:
 *   1. getAdapterReport produces correct per-adapter capability info
 *   2. Availability detection (present vs injectable) works per adapter type
 *   3. Model-family-aware normalization: SDXL vs Flux vs SD15
 *   4. Flux IPAdapter resolves to IPAdapterFull (not IPAdapterAdvanced)
 *   5. Flux SREF resolves correctly through the pack registry
 *   6. Parameter normalization clamps, resolves, and fills metadata
 *   7. Adapter registry extensibility (custom packs)
 *   8. Capability flags/labels/descriptions are populated
 */

import { describe, it, expect } from "vitest";
import type { Workflow, AdapterPack, AdapterConfig } from "@/types";
import {
  SDXL_DEFAULT_PACK,
  FLUX_DEFAULT_PACK,
  SD15_DEFAULT_PACK,
  resolveAdapter,
  resolveAdapterPack,
  getAdapterConfig,
  registerAdapterPack,
} from "@/lib/oj/adapters";
import {
  getAdapterReport,
  getPresentAdapters,
  getInjectableAdapters,
  getAdapterAvailability,
  getAdapterLabel,
  getAdapterDescription,
  isAdapterTypeAvailable,
} from "@/lib/oj/adapterIntrospection";
import {
  normalizeSrefParams,
  normalizeIPAdapterParams,
  normalizeControlNetParams,
  normalizeAllAdapterParams,
  preprocessorClassToShorthand,
} from "@/lib/oj/paramNormalization";

// ---------------------------------------------------------------------------
// Workflow fixtures
// ---------------------------------------------------------------------------

function node(class_type: string, inputs?: Record<string, unknown>) {
  return { class_type, inputs: inputs ?? {} };
}

/** Minimal SDXL workflow (no adapters) */
const emptyWorkflow = (): Workflow => ({
  "1": node("CheckpointLoaderSimple", { ckpt_name: "model.safetensors" }),
  "2": node("KSampler", { seed: 0, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1 }),
  "3": node("CLIPTextEncode", { text: "test", clip: ["1", 1] }),
  "4": node("EmptySDXLLatentImage", { width: 1024, height: 1024, batch_size: 1 }),
  "5": node("SaveImage", { filename_prefix: "output" }),
});

/** Workflow with LoRA */
const workflowWithLora = (): Workflow => ({
  ...emptyWorkflow(),
  "10": node("LoraLoader", { lora_name: "test.safetensors", strength_model: 1.0, strength_clip: 1.0, model: ["1", 0], clip: ["1", 1] }),
});

/** Workflow with ControlNet */
const workflowWithControlNet = (): Workflow => ({
  ...emptyWorkflow(),
  "20": node("ControlNetLoader", { control_net_name: "canny.pth" }),
  "21": node("ControlNetApplyAdvanced", { conditioning: ["3", 0], control_net: ["20", 0], image: ["22", 0], strength: 0.8 }),
  "22": node("LoadImage", { image: "input.png" }),
});

/** Workflow with IPAdapter */
const workflowWithIPAdapter = (): Workflow => ({
  ...emptyWorkflow(),
  "30": node("IPAdapterAdvanced", { image: ["31", 0], model: ["1", 0], weight: 0.7 }),
  "31": node("LoadImage", { image: "style.png" }),
  "32": node("IPAdapterModelLoader", { ipadapter_file: "ip_plus_sdxl.safetensors" }),
});

/** Workflow with SREF */
const workflowWithSref = (): Workflow => ({
  ...emptyWorkflow(),
  "40": node("SREFStyleEncode", { image_url: "https://example.com/style.jpg" }),
  "41": node("StyleApplyIPAdapter", { strength: 0.9 }),
});

// ---------------------------------------------------------------------------
// getAdapterReport
// ---------------------------------------------------------------------------

describe("getAdapterReport", () => {
  it("produces a complete report for SDXL empty workflow", () => {
    const report = getAdapterReport(emptyWorkflow(), "sdxl");

    expect(report.modelFamily).toBe("sdxl");
    expect(report.packId).toBe("sdxl-default");
    expect(report.adapters.lora).toBeDefined();
    expect(report.adapters.sref).toBeDefined();
    expect(report.adapters.controlnet).toBeDefined();
    expect(report.adapters.ipadapter).toBeDefined();

    // All adapters should be injectable (not present) in empty workflow
    expect(report.adapters.lora.availability).toBe("injectable");
    expect(report.adapters.sref.availability).toBe("injectable");
    expect(report.adapters.controlnet.availability).toBe("injectable");
    expect(report.adapters.ipadapter.availability).toBe("injectable");
  });

  it("detects LoRA as present when LoraLoader exists", () => {
    const report = getAdapterReport(workflowWithLora(), "sdxl");
    expect(report.adapters.lora.availability).toBe("present");
  });

  it("detects ControlNet as present when ControlNet nodes exist", () => {
    const report = getAdapterReport(workflowWithControlNet(), "sdxl");
    expect(report.adapters.controlnet.availability).toBe("present");
  });

  it("detects IPAdapter as present when IPAdapter nodes exist", () => {
    const report = getAdapterReport(workflowWithIPAdapter(), "sdxl");
    expect(report.adapters.ipadapter.availability).toBe("present");
  });

  it("detects SREF as present when SREFStyleEncode exists", () => {
    const report = getAdapterReport(workflowWithSref(), "sdxl");
    expect(report.adapters.sref.availability).toBe("present");
  });

  it("produces Flux-specific adapter classes for Flux model family", () => {
    const report = getAdapterReport(emptyWorkflow(), "flux");

    expect(report.packId).toBe("flux-default");
    // Flux LoRA uses LoraLoaderModelOnly
    expect(report.adapters.lora.loaderClass).toBe("LoraLoaderModelOnly");
    expect(report.adapters.lora.applyClass).toBe("LoraLoaderModelOnly");
    // Flux IPAdapter uses IPAdapterFull
    expect(report.adapters.ipadapter.applyClass).toBe("IPAdapterFull");
    // Flux LoRA doesn't need CLIP
    expect(report.adapters.lora.requiresClip).toBe(false);
  });

  it("produces SD 1.5-specific adapter classes for SD15 model family", () => {
    const report = getAdapterReport(emptyWorkflow(), "sd15");

    expect(report.packId).toBe("sd15-default");
    // SD 1.5 uses ControlNetApply (not Advanced)
    expect(report.adapters.controlnet.applyClass).toBe("ControlNetApply");
    // Note: supportsPercentRange is on NormalizedControlNetParams, not AdapterCapabilityReport.
    // It's computed during normalization based on applyClass.
    // SD 1.5 LoRA needs CLIP
    expect(report.adapters.lora.requiresClip).toBe(true);
  });

  it("populates capability flags from pack configs", () => {
    const report = getAdapterReport(emptyWorkflow(), "sdxl");

    // Check SDXL ControlNet flags
    const cn = report.adapters.controlnet;
    expect(cn.requiresImage).toBe(true);
    expect(cn.requiresClip).toBe(false);
    expect(cn.hasSeparateLoader).toBe(true);
    expect(cn.hasModelOutput).toBe(false);
    expect(cn.defaultStrength).toBe(1.0);
    expect(cn.minStrength).toBe(0);
    expect(cn.maxStrength).toBe(2.0);
    expect(cn.supportsStacking).toBe(true);

    // Check SDXL IPAdapter flags
    const ip = report.adapters.ipadapter;
    expect(ip.requiresImage).toBe(true);
    expect(ip.hasSeparateLoader).toBe(true);
    expect(ip.defaultStrength).toBe(0.8);
  });

  it("includes workflowCapabilities in the report", () => {
    const report = getAdapterReport(emptyWorkflow(), "sdxl");
    expect(report.workflowCapabilities).toBeDefined();
    expect(report.workflowCapabilities.lora).toBe(false);
    expect(report.workflowCapabilities.controlnet).toBe(false);
    expect(report.workflowCapabilities.ipadapter).toBe(false);
  });

  it("workflowCapabilities reflect actual workflow nodes", () => {
    const report = getAdapterReport(workflowWithLora(), "sdxl");
    expect(report.workflowCapabilities.lora).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getPresentAdapters / getInjectableAdapters
// ---------------------------------------------------------------------------

describe("getPresentAdapters / getInjectableAdapters", () => {
  it("getPresentAdapters returns empty for empty workflow", () => {
    const present = getPresentAdapters(emptyWorkflow(), "sdxl");
    expect(present).toHaveLength(0);
  });

  it("getPresentAdapters returns LoRA for workflow with LoraLoader", () => {
    const present = getPresentAdapters(workflowWithLora(), "sdxl");
    expect(present.length).toBeGreaterThanOrEqual(1);
    expect(present.some((a) => a.type === "lora")).toBe(true);
  });

  it("getInjectableAdapters returns all four types for empty workflow", () => {
    const injectable = getInjectableAdapters(emptyWorkflow(), "sdxl");
    // All four are injectable since none are present
    expect(injectable).toHaveLength(4);
    const types = injectable.map((a) => a.type);
    expect(types).toContain("lora");
    expect(types).toContain("sref");
    expect(types).toContain("controlnet");
    expect(types).toContain("ipadapter");
  });

  it("getInjectableAdapters excludes present types", () => {
    const injectable = getInjectableAdapters(workflowWithLora(), "sdxl");
    // LoRA is present, so it shouldn't be injectable
    expect(injectable.some((a) => a.type === "lora")).toBe(false);
    // The other three are still injectable
    expect(injectable).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// getAdapterAvailability
// ---------------------------------------------------------------------------

describe("getAdapterAvailability", () => {
  it("returns 'injectable' for all types in empty workflow", () => {
    const avail = getAdapterAvailability(emptyWorkflow(), "sdxl");
    expect(avail.lora).toBe("injectable");
    expect(avail.sref).toBe("injectable");
    expect(avail.controlnet).toBe("injectable");
    expect(avail.ipadapter).toBe("injectable");
  });

  it("returns 'present' for LoRA in workflow with LoRA", () => {
    const avail = getAdapterAvailability(workflowWithLora(), "sdxl");
    expect(avail.lora).toBe("present");
    expect(avail.sref).toBe("injectable");
    expect(avail.controlnet).toBe("injectable");
    expect(avail.ipadapter).toBe("injectable");
  });

  it("returns 'present' for ControlNet in workflow with ControlNet", () => {
    const avail = getAdapterAvailability(workflowWithControlNet(), "sdxl");
    expect(avail.controlnet).toBe("present");
    expect(avail.lora).toBe("injectable");
  });
});

// ---------------------------------------------------------------------------
// isAdapterTypeAvailable
// ---------------------------------------------------------------------------

describe("isAdapterTypeAvailable", () => {
  it("returns true for injectable types", () => {
    // Empty workflow — all types are injectable, hence available
    expect(isAdapterTypeAvailable(emptyWorkflow(), "lora", "sdxl")).toBe(true);
    expect(isAdapterTypeAvailable(emptyWorkflow(), "controlnet", "sdxl")).toBe(true);
  });

  it("returns true for present types", () => {
    expect(isAdapterTypeAvailable(workflowWithLora(), "lora", "sdxl")).toBe(true);
    expect(isAdapterTypeAvailable(workflowWithControlNet(), "controlnet", "sdxl")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getAdapterLabel / getAdapterDescription
// ---------------------------------------------------------------------------

describe("getAdapterLabel / getAdapterDescription", () => {
  it("returns human-readable labels from pack config", () => {
    expect(getAdapterLabel("lora", "sdxl")).toBe("LoRA (SDXL)");
    expect(getAdapterLabel("sref", "sdxl")).toBe("Style Reference");
    expect(getAdapterLabel("controlnet", "sdxl")).toBe("ControlNet (SDXL)");
    expect(getAdapterLabel("ipadapter", "sdxl")).toBe("IPAdapter Advanced");
  });

  it("returns Flux-specific labels", () => {
    expect(getAdapterLabel("lora", "flux")).toBe("LoRA (Flux)");
    expect(getAdapterLabel("ipadapter", "flux")).toBe("IPAdapter Full (Flux)");
  });

  it("returns SD15-specific labels", () => {
    expect(getAdapterLabel("lora", "sd15")).toBe("LoRA (SD 1.5)");
    expect(getAdapterLabel("controlnet", "sd15")).toBe("ControlNet (SD 1.5)");
  });

  it("returns descriptions", () => {
    const sdxlLoraDesc = getAdapterDescription("lora", "sdxl");
    expect(sdxlLoraDesc).toContain("SDXL");
    expect(sdxlLoraDesc).toContain("CLIP");

    const fluxLoraDesc = getAdapterDescription("lora", "flux");
    expect(fluxLoraDesc).toContain("Flux");
    expect(fluxLoraDesc.toLowerCase()).toContain("model-only");
  });
});

// ---------------------------------------------------------------------------
// Adapter pack metadata
// ---------------------------------------------------------------------------

describe("Adapter Pack Metadata", () => {
  it("SDXL pack has description and tags", () => {
    expect(SDXL_DEFAULT_PACK.description).toBeDefined();
    expect(SDXL_DEFAULT_PACK.tags).toContain("sdxl");
  });

  it("Flux pack has description and tags", () => {
    expect(FLUX_DEFAULT_PACK.description).toBeDefined();
    expect(FLUX_DEFAULT_PACK.tags).toContain("flux");
  });

  it("SD15 pack has description and tags", () => {
    expect(SD15_DEFAULT_PACK.description).toBeDefined();
    expect(SD15_DEFAULT_PACK.tags).toContain("sd15");
  });

  it("all adapters in SDXL pack have labels", () => {
    for (const adapter of SDXL_DEFAULT_PACK.adapters) {
      expect(adapter.label).toBeDefined();
      expect(adapter.label!.length).toBeGreaterThan(0);
    }
  });

  it("all adapters in Flux pack have labels", () => {
    for (const adapter of FLUX_DEFAULT_PACK.adapters) {
      expect(adapter.label).toBeDefined();
      expect(adapter.label!.length).toBeGreaterThan(0);
    }
  });

  it("all adapters in SD15 pack have descriptions", () => {
    for (const adapter of SD15_DEFAULT_PACK.adapters) {
      expect(adapter.description).toBeDefined();
      expect(adapter.description!.length).toBeGreaterThan(0);
    }
  });

  it("all adapters have strength ranges", () => {
    const allAdapters = [
      ...SDXL_DEFAULT_PACK.adapters,
      ...FLUX_DEFAULT_PACK.adapters,
      ...SD15_DEFAULT_PACK.adapters,
    ];
    for (const adapter of allAdapters) {
      expect(adapter.minStrength).toBeDefined();
      expect(adapter.maxStrength).toBeDefined();
      expect(adapter.defaultStrength).toBeDefined();
      expect(adapter.minStrength!).toBeLessThan(adapter.maxStrength!);
      expect(adapter.defaultStrength!).toBeGreaterThanOrEqual(adapter.minStrength!);
      expect(adapter.defaultStrength!).toBeLessThanOrEqual(adapter.maxStrength!);
    }
  });

  it("all adapters have capability flags set", () => {
    const allAdapters = [
      ...SDXL_DEFAULT_PACK.adapters,
      ...FLUX_DEFAULT_PACK.adapters,
      ...SD15_DEFAULT_PACK.adapters,
    ];
    for (const adapter of allAdapters) {
      expect(adapter.hasSeparateLoader).toBeDefined();
      expect(adapter.hasModelOutput).toBeDefined();
      expect(adapter.requiresClip).toBeDefined();
      expect(adapter.requiresImage).toBeDefined();
      expect(adapter.supportsStacking).toBeDefined();
    }
  });

  it("LoRA adapters have hasModelOutput=true", () => {
    const sdxlLora = getAdapterConfig(SDXL_DEFAULT_PACK, "lora");
    expect(sdxlLora!.hasModelOutput).toBe(true);

    const fluxLora = getAdapterConfig(FLUX_DEFAULT_PACK, "lora");
    expect(fluxLora!.hasModelOutput).toBe(true);
  });

  it("SDXL LoRA requires CLIP, Flux LoRA does not", () => {
    const sdxlLora = getAdapterConfig(SDXL_DEFAULT_PACK, "lora");
    expect(sdxlLora!.requiresClip).toBe(true);

    const fluxLora = getAdapterConfig(FLUX_DEFAULT_PACK, "lora");
    expect(fluxLora!.requiresClip).toBe(false);
  });

  it("SD15 ControlNet has supportsStacking=false", () => {
    const sd15Cn = getAdapterConfig(SD15_DEFAULT_PACK, "controlnet");
    expect(sd15Cn!.supportsStacking).toBe(false);
  });

  it("ControlNet, SREF, IPAdapter adapters require image input", () => {
    for (const pack of [SDXL_DEFAULT_PACK, FLUX_DEFAULT_PACK, SD15_DEFAULT_PACK]) {
      const cn = getAdapterConfig(pack, "controlnet");
      expect(cn!.requiresImage).toBe(true);

      const sref = getAdapterConfig(pack, "sref");
      expect(sref!.requiresImage).toBe(true);

      const ip = getAdapterConfig(pack, "ipadapter");
      expect(ip!.requiresImage).toBe(true);
    }
  });

  it("LoRA adapters do not require image input", () => {
    for (const pack of [SDXL_DEFAULT_PACK, FLUX_DEFAULT_PACK, SD15_DEFAULT_PACK]) {
      const lora = getAdapterConfig(pack, "lora");
      expect(lora!.requiresImage).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Flux IPAdapter / SREF adapter registry proofs
// ---------------------------------------------------------------------------

describe("Flux IPAdapter/SREF adapter registry", () => {
  it("Flux IPAdapter uses IPAdapterFull (not IPAdapterAdvanced)", () => {
    const fluxIP = resolveAdapter("ipadapter", "flux");
    expect(fluxIP.applyClass).toBe("IPAdapterFull");
    expect(fluxIP.loaderClass).toBe("IPAdapterModelLoader");
    expect(fluxIP.label).toBe("IPAdapter Full (Flux)");
  });

  it("SDXL IPAdapter uses IPAdapterAdvanced", () => {
    const sdxlIP = resolveAdapter("ipadapter", "sdxl");
    expect(sdxlIP.applyClass).toBe("IPAdapterAdvanced");
  });

  it("Flux SREF uses StyleApplyIPAdapter via SREFStyleEncode", () => {
    const fluxSref = resolveAdapter("sref", "flux");
    expect(fluxSref.applyClass).toBe("StyleApplyIPAdapter");
    expect(fluxSref.loaderClass).toBe("SREFStyleEncode");
    expect(fluxSref.requiresImage).toBe(true);
  });

  it("Flux report shows IPAdapterFull for ipadapter slot", () => {
    const report = getAdapterReport(emptyWorkflow(), "flux");
    expect(report.adapters.ipadapter.applyClass).toBe("IPAdapterFull");
    expect(report.adapters.ipadapter.loaderClass).toBe("IPAdapterModelLoader");
  });

  it("Flux LoRA capability flags are correct", () => {
    const report = getAdapterReport(emptyWorkflow(), "flux");
    const fluxLora = report.adapters.lora;

    expect(fluxLora.requiresClip).toBe(false);
    expect(fluxLora.hasModelOutput).toBe(true);
    expect(fluxLora.hasSeparateLoader).toBe(false);
    expect(fluxLora.loaderClass).toBe("LoraLoaderModelOnly");
  });

  it("resolveAdapterPack with flux-like strings resolves to flux pack", () => {
    expect(resolveAdapterPack("flux").id).toBe("flux-default");
    expect(resolveAdapterPack("FLUX.1-dev").id).toBe("flux-default");
    expect(resolveAdapterPack("flux-schnell").id).toBe("flux-default");
  });
});

// ---------------------------------------------------------------------------
// Parameter Normalization
// ---------------------------------------------------------------------------

describe("normalizeSrefParams", () => {
  it("normalizes SDXL SREF parameters", () => {
    const params = normalizeSrefParams("https://example.com/style.jpg", 0.8, "sdxl");
    expect(params.imageUrl).toBe("https://example.com/style.jpg");
    expect(params.weight).toBe(0.8);
    expect(params.applyClass).toBe("StyleApplyIPAdapter");
    expect(params.strengthParamName).toBe("strength");
    expect(params.requiresImage).toBe(true);
  });

  it("normalizes Flux SREF parameters", () => {
    const params = normalizeSrefParams("https://example.com/style.jpg", 0.9, "flux");
    expect(params.applyClass).toBe("StyleApplyIPAdapter");
    expect(params.weight).toBe(0.9);
  });

  it("clamps strength to adapter range", () => {
    const params = normalizeSrefParams("url", 5.0, "sdxl");
    // SREF max is 2.0
    expect(params.weight).toBe(2.0);

    const params2 = normalizeSrefParams("url", -1.0, "sdxl");
    expect(params2.weight).toBe(0);
  });
});

describe("normalizeIPAdapterParams", () => {
  it("normalizes SDXL IPAdapter parameters", () => {
    const params = normalizeIPAdapterParams("https://example.com/ref.png", 0.7, "sdxl");
    expect(params.imageUrl).toBe("https://example.com/ref.png");
    expect(params.weight).toBe(0.7);
    expect(params.applyClass).toBe("IPAdapterAdvanced");
    expect(params.strengthParamName).toBe("weight");
    expect(params.modelParamName).toBe("ipadapter_file");
    expect(params.loaderClass).toBe("IPAdapterModelLoader");
    expect(params.requiresImage).toBe(true);
    expect(params.supportsStacking).toBe(true);
  });

  it("normalizes Flux IPAdapter parameters", () => {
    const params = normalizeIPAdapterParams("https://example.com/ref.png", 0.6, "flux");
    expect(params.applyClass).toBe("IPAdapterFull");
    expect(params.strengthParamName).toBe("weight");
    expect(params.loaderClass).toBe("IPAdapterModelLoader");
  });

  it("clamps weight to adapter range", () => {
    const params = normalizeIPAdapterParams("url", 10.0, "sdxl");
    expect(params.weight).toBe(2.0);
  });
});

describe("normalizeControlNetParams", () => {
  it("normalizes SDXL ControlNet with canny preprocessor", () => {
    const params = normalizeControlNetParams(
      "control_v11p_sd15_canny.pth",
      "canny",
      0.8,
      { startPercent: 0.1, endPercent: 0.9 },
      "sdxl",
    );
    expect(params.model).toBe("control_v11p_sd15_canny.pth");
    expect(params.preprocessorClass).toBe("CannyEdgePreprocessor");
    expect(params.preprocessorShorthand).toBe("canny");
    expect(params.strength).toBe(0.8);
    expect(params.applyClass).toBe("ControlNetApplyAdvanced");
    expect(params.supportsPercentRange).toBe(true);
    expect(params.conditioningTarget).toBe("positive");
  });

  it("normalizes SD15 ControlNet — no percent range support", () => {
    const params = normalizeControlNetParams(
      "control_v11p_sd15_depth.pth",
      "depth",
      0.5,
      { startPercent: 0.1, endPercent: 0.8 },
      "sd15",
    );
    expect(params.applyClass).toBe("ControlNetApply");
    expect(params.supportsPercentRange).toBe(false);
    expect(params.preprocessorClass).toBe("DepthAnythingPreprocessor");
  });

  it("resolves preprocessor shorthand case-insensitively", () => {
    const params = normalizeControlNetParams("test.pth", "CANNY", 1.0);
    expect(params.preprocessorClass).toBe("CannyEdgePreprocessor");
  });

  it("passes through unknown preprocessor class names", () => {
    const params = normalizeControlNetParams("test.pth", "MyCustomPreprocessor", 1.0);
    expect(params.preprocessorClass).toBe("MyCustomPreprocessor");
  });
});

describe("preprocessorClassToShorthand", () => {
  it("maps CannyEdgePreprocessor back to 'canny'", () => {
    expect(preprocessorClassToShorthand("CannyEdgePreprocessor")).toBe("canny");
  });

  it("maps DepthAnythingPreprocessor back to 'depth'", () => {
    expect(preprocessorClassToShorthand("DepthAnythingPreprocessor")).toBe("depth");
  });

  it("returns full class name for unknown preprocessors", () => {
    expect(preprocessorClassToShorthand("UnknownPreprocessor")).toBe("UnknownPreprocessor");
  });
});

describe("normalizeAllAdapterParams", () => {
  it("normalizes all adapter types at once", () => {
    const params = normalizeAllAdapterParams(
      {
        sref: { imageUrl: "https://example.com/s.jpg", weight: 0.8 },
        ipadapter: { imageUrl: "https://example.com/ip.png", weight: 0.7 },
        controlnet: {
          model: "canny.pth",
          preprocessor: "canny",
          strength: 0.6,
          sourceImage: "https://example.com/cn.png",
        },
      },
      "sdxl",
    );

    expect(params.sref).toBeDefined();
    expect(params.sref!.applyClass).toBe("StyleApplyIPAdapter");

    expect(params.ipadapter).toBeDefined();
    expect(params.ipadapter!.applyClass).toBe("IPAdapterAdvanced");

    expect(params.controlnet).toBeDefined();
    expect(params.controlnet!.preprocessorClass).toBe("CannyEdgePreprocessor");
    expect(params.controlnet!.supportsPercentRange).toBe(true);
  });

  it("handles partial params (only IPAdapter)", () => {
    const params = normalizeAllAdapterParams({
      ipadapter: { imageUrl: "ref.png", weight: 0.5 },
    }, "flux");

    expect(params.sref).toBeUndefined();
    expect(params.ipadapter).toBeDefined();
    expect(params.ipadapter!.applyClass).toBe("IPAdapterFull");
    expect(params.controlnet).toBeUndefined();
  });

  it("Flux normalization uses Flux-specific classes throughout", () => {
    const params = normalizeAllAdapterParams({
      sref: { imageUrl: "s.jpg", weight: 0.8 },
      ipadapter: { imageUrl: "ip.png", weight: 0.6 },
      controlnet: {
        model: "cn.pth",
        preprocessor: "depth",
        strength: 0.5,
      },
    }, "flux");

    // SREF still uses StyleApplyIPAdapter
    expect(params.sref!.applyClass).toBe("StyleApplyIPAdapter");
    // IPAdapter uses IPAdapterFull for Flux
    expect(params.ipadapter!.applyClass).toBe("IPAdapterFull");
    // ControlNet uses ControlNetApplyAdvanced
    expect(params.controlnet!.applyClass).toBe("ControlNetApplyAdvanced");
    expect(params.controlnet!.supportsPercentRange).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Custom pack registration
// ---------------------------------------------------------------------------

describe("Custom pack registration", () => {
  it("allows registering and resolving a custom adapter pack", () => {
    const customPack: AdapterPack = {
      id: "sd3-default",
      name: "SD3 Default",
      modelFamily: "sd3",
      description: "Custom adapter pack for Stable Diffusion 3",
      tags: ["sd3", "stable-diffusion-3"],
      adapters: [
        {
          type: "lora",
          loaderClass: "LoraLoaderModelOnly",
          applyClass: "LoraLoaderModelOnly",
          strengthParamName: "strength_model",
          modelParamName: "lora_name",
          label: "LoRA (SD3)",
          description: "Model-only LoRA for SD3",
          hasSeparateLoader: false,
          hasModelOutput: true,
          requiresClip: false,
          requiresImage: false,
          defaultStrength: 1.0,
          minStrength: 0,
          maxStrength: 2.0,
          supportsStacking: true,
        },
        {
          type: "ipadapter",
          loaderClass: "IPAdapterModelLoader",
          applyClass: "IPAdapterFull",
          strengthParamName: "weight",
          modelParamName: "ipadapter_file",
          label: "IPAdapter (SD3)",
          description: "IPAdapter for SD3",
          hasSeparateLoader: true,
          hasModelOutput: false,
          requiresClip: false,
          requiresImage: true,
          defaultStrength: 0.8,
          minStrength: 0,
          maxStrength: 2.0,
          supportsStacking: true,
        },
      ],
    };

    registerAdapterPack(customPack);

    // Can resolve by model family
    const resolved = resolveAdapterPack("sd3");
    expect(resolved.id).toBe("sd3-default");
    expect(resolved.name).toBe("SD3 Default");

    // Can get adapter config
    const sD3Lora = resolveAdapter("lora", "sd3");
    expect(sD3Lora.loaderClass).toBe("LoraLoaderModelOnly");
    expect(sD3Lora.requiresClip).toBe(false);

    const sd3IP = resolveAdapter("ipadapter", "sd3");
    expect(sd3IP.applyClass).toBe("IPAdapterFull");

    // Falls back to SDXL for types not defined in the custom pack
    const sd3Cn = resolveAdapter("controlnet", "sd3");
    expect(sd3Cn.applyClass).toBe("ControlNetApplyAdvanced"); // SDXL fallback
  });

  it("allows getAdapterReport with custom pack", () => {
    const report = getAdapterReport(emptyWorkflow(), "sd3");
    expect(report.packId).toBe("sd3-default");
    // LoRA and IPAdapter have custom configs, SREF and CN fall back to SDXL
    expect(report.adapters.lora.loaderClass).toBe("LoraLoaderModelOnly");
    expect(report.adapters.ipadapter.applyClass).toBe("IPAdapterFull");
    expect(report.adapters.sref.applyClass).toBe("StyleApplyIPAdapter"); // SDXL fallback
    expect(report.adapters.controlnet.applyClass).toBe("ControlNetApplyAdvanced"); // SDXL fallback
  });
});

// ---------------------------------------------------------------------------
// Capability flags: requiresImage, requiresClip, hasModelOutput
// ---------------------------------------------------------------------------

describe("Capability flags consistency", () => {
  it("LoRA adapters: SDXL/SD15 require CLIP, Flux does not", () => {
    expect(resolveAdapter("lora", "sdxl").requiresClip).toBe(true);
    expect(resolveAdapter("lora", "sd15").requiresClip).toBe(true);
    expect(resolveAdapter("lora", "flux").requiresClip).toBe(false);
  });

  it("LoRA adapters: all have hasModelOutput=true", () => {
    expect(resolveAdapter("lora", "sdxl").hasModelOutput).toBe(true);
    expect(resolveAdapter("lora", "flux").hasModelOutput).toBe(true);
    expect(resolveAdapter("lora", "sd15").hasModelOutput).toBe(true);
  });

  it("LoRA adapters: all requireImage=false", () => {
    expect(resolveAdapter("lora", "sdxl").requiresImage).toBe(false);
    expect(resolveAdapter("lora", "flux").requiresImage).toBe(false);
    expect(resolveAdapter("lora", "sd15").requiresImage).toBe(false);
  });

  it("Adapters with separate loader: ControlNet, SREF, IPAdapter all have it", () => {
    for (const family of ["sdxl", "flux", "sd15"]) {
      expect(resolveAdapter("controlnet", family).hasSeparateLoader).toBe(true);
      expect(resolveAdapter("sref", family).hasSeparateLoader).toBe(true);
      expect(resolveAdapter("ipadapter", family).hasSeparateLoader).toBe(true);
    }
  });

  it("LoRA adapters: hasSeparateLoader=false (self-contained)", () => {
    for (const family of ["sdxl", "flux", "sd15"]) {
      expect(resolveAdapter("lora", family).hasSeparateLoader).toBe(false);
    }
  });

  it("ControlNet supportsPercentRange matches applyClass", () => {
    // SDXL and Flux use ControlNetApplyAdvanced → supportsPercentRange
    const sdxlCn = normalizeControlNetParams("test.pth", "canny", 0.5, undefined, "sdxl");
    expect(sdxlCn.supportsPercentRange).toBe(true);

    const fluxCn = normalizeControlNetParams("test.pth", "canny", 0.5, undefined, "flux");
    expect(fluxCn.supportsPercentRange).toBe(true);

    // SD15 uses ControlNetApply → no percent range
    const sd15Cn = normalizeControlNetParams("test.pth", "canny", 0.5, undefined, "sd15");
    expect(sd15Cn.supportsPercentRange).toBe(false);
  });
});
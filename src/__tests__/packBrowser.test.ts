/**
 * Tests for packBrowser module — pack card summaries, requirement extraction,
 * model validation, custom-node detection, and dynamic controls.
 */

import { describe, expect, it } from "vitest";
import {
  getKindLabel,
  getPackWorkflowEntries,
  extractRequirementsFromWorkflow,
  checkModelAvailability,
  validateRequirements,
  extractCustomNodeRequirements,
  discoverDynamicControls,
  buildPackBrowserEntries,
  getPackCardSummary,
  getAllPackCardSummaries,
  type PackRequirement,
} from "@/lib/oj/packBrowser";
import { getAllPacks, getPack } from "@/lib/oj/packs";
import type { Workflow, WorkflowNode } from "@/types";

// ---------------------------------------------------------------------------
// Kind labels
// ---------------------------------------------------------------------------

describe("getKindLabel", () => {
  it("returns human-readable labels for known kinds", () => {
    expect(getKindLabel("t2i")).toBe("Text → Image");
    expect(getKindLabel("i2i")).toBe("Image → Image");
    expect(getKindLabel("inpaint")).toBe("Inpaint");
    expect(getKindLabel("upscale_subtle")).toBe("Upscale (Subtle)");
    expect(getKindLabel("t2v")).toBe("Text → Video");
  });

  it("returns the raw kind for unknown kinds", () => {
    expect(getKindLabel("custom_kind")).toBe("custom_kind");
  });
});

// ---------------------------------------------------------------------------
// Pack workflow entries
// ---------------------------------------------------------------------------

describe("getPackWorkflowEntries", () => {
  it("returns entries for SDXL pack", () => {
    const sdxl = getPack("sdxl")!;
    const entries = getPackWorkflowEntries(sdxl);
    expect(entries.length).toBeGreaterThan(5);
    expect(entries[0]).toHaveProperty("kind");
    expect(entries[0]).toHaveProperty("file");
    expect(entries[0]).toHaveProperty("label");
    // First entry should be t2i
    const t2i = entries.find((e) => e.kind === "t2i");
    expect(t2i).toBeDefined();
    expect(t2i!.label).toBe("Text → Image");
  });

  it("returns entries for Flux pack", () => {
    const flux = getPack("flux")!;
    const entries = getPackWorkflowEntries(flux);
    expect(entries.length).toBe(1); // Flux only has t2i
    expect(entries[0].kind).toBe("t2i");
  });
});

// ---------------------------------------------------------------------------
// Requirement extraction from workflows
// ---------------------------------------------------------------------------

// Helper: create a minimal workflow node
function makeNode(class_type: string, inputs: Record<string, unknown> = {}): WorkflowNode {
  return { class_type, inputs };
}

describe("extractRequirementsFromWorkflow", () => {
  it("extracts checkpoint requirements", () => {
    const workflow: Workflow = {
      "1": makeNode("CheckpointLoaderSimple", { ckpt_name: "sd_xl_base_1.0.safetensors" }),
      "2": makeNode("KSampler", { steps: 20 }),
      "3": makeNode("SaveImage", {}),
    };
    const reqs = extractRequirementsFromWorkflow(workflow);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].category).toBe("checkpoint");
    expect(reqs[0].identifier).toBe("sd_xl_base_1.0.safetensors");
    expect(reqs[0].loaderClassType).toBe("CheckpointLoaderSimple");
    expect(reqs[0].status).toBe("unknown");
  });

  it("extracts UNET requirements (Flux-style)", () => {
    const workflow: Workflow = {
      "1": makeNode("UNETLoader", { unet_name: "flux1-dev.safetensors" }),
      "2": makeNode("KSampler", { steps: 20 }),
    };
    const reqs = extractRequirementsFromWorkflow(workflow);
    const unet = reqs.find((r) => r.category === "checkpoint");
    expect(unet).toBeDefined();
    expect(unet!.identifier).toBe("flux1-dev.safetensors");
  });

  it("extracts LoRA requirements", () => {
    const workflow: Workflow = {
      "1": makeNode("LoraLoader", { lora_name: "anime_style.safetensors", strength_model: 1.0 }),
    };
    const reqs = extractRequirementsFromWorkflow(workflow);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].category).toBe("lora");
    expect(reqs[0].identifier).toBe("anime_style.safetensors");
  });

  it("extracts VAE requirements", () => {
    const workflow: Workflow = {
      "1": makeNode("VAELoader", { vae_name: "sdxl_vae.safetensors" }),
    };
    const reqs = extractRequirementsFromWorkflow(workflow);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].category).toBe("vae");
  });

  it("extracts ControlNet requirements", () => {
    const workflow: Workflow = {
      "1": makeNode("ControlNetLoader", { control_net_name: "control_v11p_sd15_canny.pth" }),
    };
    const reqs = extractRequirementsFromWorkflow(workflow);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].category).toBe("controlnet");
  });

  it("extracts upscale model requirements", () => {
    const workflow: Workflow = {
      "1": makeNode("UpscaleModelLoader", { model_name: "4x-UltraSharp.pth" }),
    };
    const reqs = extractRequirementsFromWorkflow(workflow);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].category).toBe("upscale");
  });

  it("extracts multiple requirements from a complex workflow", () => {
    const workflow: Workflow = {
      "1": makeNode("CheckpointLoaderSimple", { ckpt_name: "sdxl_base.safetensors" }),
      "2": makeNode("LoraLoader", { lora_name: "style_lora.safetensors" }),
      "3": makeNode("VAELoader", { vae_name: "sdxl_vae.safetensors" }),
      "4": makeNode("KSampler", { steps: 20, cfg: 7.0 }),
    };
    const reqs = extractRequirementsFromWorkflow(workflow);
    expect(reqs).toHaveLength(3);
    const categories = reqs.map((r) => r.category);
    expect(categories).toContain("checkpoint");
    expect(categories).toContain("lora");
    expect(categories).toContain("vae");
  });

  it("ignores nodes without model names", () => {
    const workflow: Workflow = {
      "1": makeNode("KSampler", { steps: 20, cfg: 7.0 }),
      "2": makeNode("SaveImage", { filename_prefix: "comfy" }),
    };
    const reqs = extractRequirementsFromWorkflow(workflow);
    expect(reqs).toHaveLength(0);
  });

  it("handles UNETLoader with model_name", () => {
    const workflow: Workflow = {
      "1": makeNode("UNETLoaderFlux", { model_name: "flux1-dev.safetensors" }),
    };
    const reqs = extractRequirementsFromWorkflow(workflow);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].identifier).toBe("flux1-dev.safetensors");
  });
});

// ---------------------------------------------------------------------------
// Model availability checking
// ---------------------------------------------------------------------------

describe("checkModelAvailability", () => {
  it("returns available when model is found", () => {
    const result = checkModelAvailability("sdxl_base.safetensors", [
      "models/sdxl_base.safetensors",
      "models/other.safetensors",
    ]);
    expect(result).toBe("available");
  });

  it("returns missing when model is not found", () => {
    const result = checkModelAvailability("missing_model.safetensors", [
      "models/sdxl_base.safetensors",
    ]);
    expect(result).toBe("missing");
  });

  it("returns unknown when available list is null", () => {
    const result = checkModelAvailability("model.safetensors", null);
    expect(result).toBe("unknown");
  });

  it("performs case-insensitive match", () => {
    const result = checkModelAvailability("SDXL_Base.safetensors", [
      "models/sdxl_base.safetensors",
    ]);
    expect(result).toBe("available");
  });

  it("performs substring match", () => {
    const result = checkModelAvailability("sdxl_base", [
      "/models/checkpoints/sdxl_base_1.0.safetensors",
    ]);
    expect(result).toBe("available");
  });
});

// ---------------------------------------------------------------------------
// Requirement validation
// ---------------------------------------------------------------------------

describe("validateRequirements", () => {
  const reqs: PackRequirement[] = [
    {
      name: "SDXL Base",
      category: "checkpoint",
      identifier: "sdxl_base.safetensors",
      loaderClassType: "CheckpointLoaderSimple",
      status: "unknown",
    },
    {
      name: "Anime Style",
      category: "lora",
      identifier: "anime_style.safetensors",
      loaderClassType: "LoraLoader",
      status: "unknown",
    },
    {
      name: "SDXL VAE",
      category: "vae",
      identifier: "sdxl_vae.safetensors",
      loaderClassType: "VAELoader",
      status: "unknown",
    },
  ];

  it("marks models as available when found", () => {
    const validated = validateRequirements(reqs, {
      checkpoints: ["sdxl_base.safetensors", "other.safetensors"],
      loras: ["anime_style.safetensors"],
      vaes: ["sdxl_vae.safetensors"],
    });
    expect(validated[0].status).toBe("available");
    expect(validated[1].status).toBe("available");
    expect(validated[2].status).toBe("available");
  });

  it("marks models as missing when not in list", () => {
    const validated = validateRequirements(reqs, {
      checkpoints: ["other_model.safetensors"],
      loras: [],
      vaes: [],
    });
    expect(validated[0].status).toBe("missing");
    expect(validated[1].status).toBe("missing");
    expect(validated[2].status).toBe("missing");
  });

  it("returns unknown when available is null", () => {
    const validated = validateRequirements(reqs, null);
    validated.forEach((r) => {
      expect(r.status).toBe("unknown");
    });
  });

  it("handles partial availability lists", () => {
    const validated = validateRequirements(reqs, {
      checkpoints: ["sdxl_base.safetensors"],
      loras: [],  // explicitly empty — models not found
      vaes: [],   // explicitly empty — models not found
    });
    expect(validated[0].status).toBe("available");
    expect(validated[1].status).toBe("missing"); // empty array
    expect(validated[2].status).toBe("missing");
  });

  it("returns unknown for undefined availability categories", () => {
    const validated = validateRequirements(reqs, {
      checkpoints: ["sdxl_base.safetensors"],
      // loras and vaes keys omitted entirely — "unknown" status
    });
    expect(validated[0].status).toBe("available");
    expect(validated[1].status).toBe("unknown"); // no loras list provided
    expect(validated[2].status).toBe("unknown"); // no vaes list provided
  });
});

// ---------------------------------------------------------------------------
// Custom node detection
// ---------------------------------------------------------------------------

describe("extractCustomNodeRequirements", () => {
  it("identifies non-core node types as custom nodes", () => {
    const workflow: Workflow = {
      "1": makeNode("CheckpointLoaderSimple", { ckpt_name: "model.safetensors" }),
      "2": makeNode("IPAdapterAdvanced", { image: ["3", 0] }),
      "3": makeNode("KSampler", { steps: 20 }),
      "4": makeNode("SaveImage", {}),
    };
    const custom = extractCustomNodeRequirements(workflow);
    expect(custom.length).toBe(1);
    expect(custom[0].name).toBe("IPAdapterAdvanced");
    expect(custom[0].category).toBe("custom_node");
  });

  it("returns empty array for core-only workflows", () => {
    const workflow: Workflow = {
      "1": makeNode("CheckpointLoaderSimple", { ckpt_name: "model.safetensors" }),
      "2": makeNode("KSampler", { steps: 20 }),
      "3": makeNode("CLIPTextEncode", { text: "prompt" }),
      "4": makeNode("EmptySDXLLatentImage", { width: 1024, height: 1024 }),
      "5": makeNode("SaveImage", {}),
    };
    const custom = extractCustomNodeRequirements(workflow);
    expect(custom).toHaveLength(0);
  });

  it("identifies multiple custom node types", () => {
    const workflow: Workflow = {
      "1": makeNode("SomeCustomNode", {}),
      "2": makeNode("AnotherCustomNode", {}),
      "3": makeNode("KSampler", {}),
    };
    const custom = extractCustomNodeRequirements(workflow);
    expect(custom).toHaveLength(2);
    const names = custom.map((c) => c.name);
    expect(names).toContain("SomeCustomNode");
    expect(names).toContain("AnotherCustomNode");
  });
});

// ---------------------------------------------------------------------------
// Dynamic controls discovery
// ---------------------------------------------------------------------------

describe("discoverDynamicControls", () => {
  it("extracts controls from a minimal t2i workflow", () => {
    const workflow: Workflow = {
      "1": makeNode("KSampler", {
        steps: 20,
        cfg: 7.0,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1.0,
      }),
      "2": makeNode("CheckpointLoaderSimple", {
        ckpt_name: "sdxl_base.safetensors",
      }),
      "3": makeNode("CLIPTextEncode", { text: "beautiful landscape" }),
      "4": makeNode("EmptySDXLLatentImage", { width: 1024, height: 1024 }),
      "5": makeNode("SaveImage", {}),
    };
    const controls = discoverDynamicControls(workflow);
    expect(controls.workflowType).toBe("t2i");
    expect(controls.samplerClass).toBe("KSampler");
    expect(controls.defaults.steps).toBe(20);
    expect(controls.defaults.cfg).toBe(7.0);
    expect(controls.defaults.sampler).toBe("euler");
    expect(controls.defaults.width).toBe(1024);
    expect(controls.defaults.height).toBe(1024);
    expect(controls.nodeCount).toBe(5);
    expect(controls.capabilities.lora).toBe(false);
  });

  it("detects LoRA capability", () => {
    const workflow: Workflow = {
      "1": makeNode("KSampler", {}),
      "2": makeNode("LoraLoader", { lora_name: "style.safetensors" }),
      "3": makeNode("SaveImage", {}),
    };
    const controls = discoverDynamicControls(workflow);
    expect(controls.capabilities.lora).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pack browser entries and card summaries
// ---------------------------------------------------------------------------

describe("buildPackBrowserEntries", () => {
  it("returns entries for all registered packs", () => {
    const entries = buildPackBrowserEntries();
    const packs = getAllPacks();
    expect(entries.length).toBe(packs.length);
  });

  it("each entry has correct workflow count", () => {
    const entries = buildPackBrowserEntries();
    for (const entry of entries) {
      expect(entry.workflowCount).toBe(Object.keys(entry.pack.workflows).length);
      expect(entry.workflows.length).toBe(entry.workflowCount);
    }
  });

  it("SDXL entry has many workflows", () => {
    const entries = buildPackBrowserEntries();
    const sdxl = entries.find((e) => e.pack.id === "sdxl");
    expect(sdxl).toBeDefined();
    expect(sdxl!.workflowCount).toBeGreaterThanOrEqual(10);
  });

  it("Flux entry has t2i workflow", () => {
    const entries = buildPackBrowserEntries();
    const flux = entries.find((e) => e.pack.id === "flux");
    expect(flux).toBeDefined();
    const t2i = flux!.workflows.find((w) => w.kind === "t2i");
    expect(t2i).toBeDefined();
  });
});

describe("getPackCardSummary", () => {
  it("returns a compact summary for SDXL pack", () => {
    const sdxl = getPack("sdxl")!;
    const summary = getPackCardSummary(sdxl);
    expect(summary.id).toBe("sdxl");
    expect(summary.name).toBe("Stable Diffusion XL");
    expect(summary.modelFamily).toBe("sdxl");
    expect(summary.isDefault).toBe(false);
    expect(summary.baseResolution).toBe(1024);
    expect(summary.supportsNegativePrompt).toBe(true);
    expect(summary.supportsCfgScale).toBe(true);
    expect(summary.workflowCount).toBeGreaterThan(5);
    expect(summary.workflowKinds.length).toBeGreaterThan(5);
  });

  it("returns a compact summary for Flux pack", () => {
    const flux = getPack("flux")!;
    const summary = getPackCardSummary(flux);
    expect(summary.id).toBe("flux");
    expect(summary.name).toBe("Flux");
    expect(summary.modelFamily).toBe("flux");
    expect(summary.isDefault).toBe(false);
    expect(summary.supportsNegativePrompt).toBe(false);
    expect(summary.workflowCount).toBe(1);
    // Flux has custom adapter highlights
    expect(summary.adapterHighlights.length).toBeGreaterThan(0);
  });

  it("highlight differences are meaningful", () => {
    const flux = getPack("flux")!;
    const summary = getPackCardSummary(flux);
    // Flux uses FluxSampler, not KSampler
    expect(summary.adapterHighlights.some((h) => h.includes("FluxSampler"))).toBe(true);
    // Flux uses LoraLoaderModelOnly, not LoraLoader
    expect(summary.adapterHighlights.some((h) => h.includes("LoraLoaderModelOnly"))).toBe(true);
    // No negative prompt
    expect(summary.adapterHighlights.some((h) => h.includes("negative"))).toBe(true);
  });
});

describe("getAllPackCardSummaries", () => {
  it("returns summaries for all packs", () => {
    const summaries = getAllPackCardSummaries();
    expect(summaries.length).toBeGreaterThanOrEqual(2);
    const ids = summaries.map((s) => s.id);
    expect(ids).toContain("sdxl");
    expect(ids).toContain("flux");
  });
});
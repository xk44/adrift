/**
 * Workflow Injector Tests
 * ========================
 * Unit tests for the SREF workflow injection functionality.
 * 
 * Run with: npm test or npx vitest
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  injectSREFNodes,
  injectLoRANodes,
  injectStyleParams,
  insertTriggers,
  convertStyleWeight,
  serializeSREFMetadata,
  serializeLoRAMetadata,
} from "@/lib/sref/workflowInjector";
import type { SREFParams, LoRAParams } from "@/lib/sref/srefParser";
import type { Workflow } from "@/types";

// Mock workflow for testing
const createMockWorkflow = (): Workflow => ({
  "1": {
    class_type: "CheckpointLoaderSimple",
    inputs: {
      ckpt_name: "sd_xl_base_1.0.safetensors",
    },
  },
  "2": {
    class_type: "CLIPTextEncode",
    inputs: {
      text: "test prompt",
      clip: ["1", 1],
    },
    _meta: { title: "Positive Prompt" },
  },
  "3": {
    class_type: "CLIPTextEncode",
    inputs: {
      text: "",
      clip: ["1", 1],
    },
    _meta: { title: "Negative Prompt" },
  },
  "4": {
    class_type: "EmptyLatentImage",
    inputs: {
      width: 1024,
      height: 1024,
      batch_size: 1,
    },
  },
  "5": {
    class_type: "KSampler",
    inputs: {
      seed: 12345,
      steps: 20,
      cfg: 7.0,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1.0,
      model: ["1", 0],
      positive: ["2", 0],
      negative: ["3", 0],
      latent_image: ["4", 0],
    },
  },
  "6": {
    class_type: "VAEDecode",
    inputs: {
      samples: ["5", 0],
      vae: ["1", 2],
    },
  },
  "7": {
    class_type: "SaveImage",
    inputs: {
      images: ["6", 0],
      filename_prefix: "output",
    },
  },
});

describe("convertStyleWeight", () => {
  it("should return 0 for style weight 0", () => {
    expect(convertStyleWeight(0)).toBe(0);
  });

  it("should return 1.0 for style weight 100 (default)", () => {
    expect(convertStyleWeight(100)).toBe(1.0);
  });

  it("should return 0.5 for style weight 50", () => {
    expect(convertStyleWeight(50)).toBe(0.5);
  });

  it("should return ~5.0 for style weight 1000 (max)", () => {
    expect(convertStyleWeight(1000)).toBe(5.0);
  });

  it("should handle intermediate values", () => {
    const sw200 = convertStyleWeight(200);
    const sw500 = convertStyleWeight(500);
    const sw750 = convertStyleWeight(750);
    
    expect(sw200).toBeGreaterThan(1.0);
    expect(sw200).toBeLessThan(2.0);
    
    expect(sw500).toBeGreaterThan(2.0);
    expect(sw500).toBeLessThan(3.5);
    
    expect(sw750).toBeGreaterThan(3.0);
    expect(sw750).toBeLessThan(5.0);
  });
});

describe("insertTriggers", () => {
  const prompt = "a beautiful landscape with mountains";
  const triggers = "photo, realistic, detailed";

  it("should insert at beginning", () => {
    const result = insertTriggers(prompt, triggers, "beginning");
    expect(result).toBe("photo, realistic, detailed, a beautiful landscape with mountains");
  });

  it("should insert at end", () => {
    const result = insertTriggers(prompt, triggers, "end");
    expect(result).toBe("a beautiful landscape with mountains, photo, realistic, detailed");
  });

  it("should insert in middle after first comma", () => {
    const promptWithComma = "a beautiful, detailed landscape with mountains";
    const result = insertTriggers(promptWithComma, triggers, "middle");
    expect(result).toContain("photo, realistic, detailed");
    expect(result.indexOf("photo")).toBeGreaterThan(0);
  });

  it("should handle empty triggers", () => {
    const result = insertTriggers(prompt, "", "beginning");
    expect(result).toBe(prompt);
  });
});

describe("injectSREFNodes", () => {
  let workflow: Workflow;

  beforeEach(() => {
    workflow = createMockWorkflow();
  });

  it("should return unchanged workflow when SREF has no items", () => {
    const sref: SREFParams = {
      items: [],
      styleWeight: 100,
    };
    
    const result = injectSREFNodes(workflow, sref);
    
    expect(result.addedNodes).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("should add style encode node for URL item", () => {
    const sref: SREFParams = {
      items: [{ value: "https://example.com/style.jpg", type: "url", weight: 1.0 }],
      styleWeight: 100,
    };
    
    const result = injectSREFNodes(workflow, sref);
    
    expect(result.addedNodes.length).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
    
    // Check that a style encode node was added
    const addedNodeIds = result.addedNodes;
    const hasStyleEncode = addedNodeIds.some((id) => 
      result.workflow[id]?.class_type === "SREFStyleEncode"
    );
    expect(hasStyleEncode).toBe(true);
  });

  it("should add style lookup node for code item", () => {
    const sref: SREFParams = {
      items: [{ value: "1234567890", type: "code", weight: 1.0 }],
      styleWeight: 100,
    };
    
    const result = injectSREFNodes(workflow, sref);
    
    const addedNodeIds = result.addedNodes;
    const hasStyleLookup = addedNodeIds.some((id) =>
      result.workflow[id]?.class_type === "StyleCodeLookup"
    );
    expect(hasStyleLookup).toBe(true);
  });

  it("should add mixer node for multiple items", () => {
    const sref: SREFParams = {
      items: [
        { value: "1234567890", type: "code", weight: 1.0 },
        { value: "9876543210", type: "code", weight: 0.5 },
      ],
      styleWeight: 100,
    };
    
    const result = injectSREFNodes(workflow, sref);
    
    const hasMixer = result.addedNodes.some((id) =>
      result.workflow[id]?.class_type === "SREFMixerMulti"
    );
    expect(hasMixer).toBe(true);
  });

  it("should add style apply nodes", () => {
    const sref: SREFParams = {
      items: [{ value: "1234567890", type: "code", weight: 1.0 }],
      styleWeight: 100,
    };
    
    const result = injectSREFNodes(workflow, sref);
    
    const hasIPAdapter = result.addedNodes.some((id) =>
      result.workflow[id]?.class_type === "StyleApplyIPAdapter"
    );
    expect(hasIPAdapter).toBe(true);
  });

  it("should rewire KSampler model input", () => {
    const sref: SREFParams = {
      items: [{ value: "1234567890", type: "code", weight: 1.0 }],
      styleWeight: 100,
    };
    
    const result = injectSREFNodes(workflow, sref);
    
    // KSampler should now get model from style apply node, not checkpoint loader
    const ksamplerModelInput = result.workflow["5"]?.inputs?.model;
    expect(ksamplerModelInput).not.toEqual(["1", 0]); // Not original connection
  });

  it("should report error when model loader not found", () => {
    const badWorkflow: Workflow = {
      "1": { class_type: "SomeOtherNode", inputs: {} },
    };
    
    const sref: SREFParams = {
      items: [{ value: "1234567890", type: "code", weight: 1.0 }],
      styleWeight: 100,
    };
    
    const result = injectSREFNodes(badWorkflow, sref);
    
    expect(result.errors).toContain("Could not find model loader node in workflow");
  });
});

describe("injectLoRANodes", () => {
  let workflow: Workflow;

  beforeEach(() => {
    workflow = createMockWorkflow();
  });

  it("should return unchanged workflow when LoRA has no items", () => {
    const lora: LoRAParams = {
      items: [],
      autoTrigger: false,
      triggerPosition: "beginning",
    };
    
    const result = injectLoRANodes(workflow, lora);
    
    expect(result.addedNodes).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("should add LoRA loader node", () => {
    const lora: LoRAParams = {
      items: [{ name: "anime_style", strength: 1.0 }],
      autoTrigger: false,
      triggerPosition: "beginning",
    };
    
    const result = injectLoRANodes(workflow, lora);
    
    const hasLoraLoader = result.addedNodes.some((id) =>
      result.workflow[id]?.class_type === "LoraLoader"
    );
    expect(hasLoraLoader).toBe(true);
  });

  it("should chain multiple LoRA loaders", () => {
    const lora: LoRAParams = {
      items: [
        { name: "anime_style", strength: 0.8 },
        { name: "detail_enhancer", strength: 0.5 },
      ],
      autoTrigger: false,
      triggerPosition: "beginning",
    };
    
    const result = injectLoRANodes(workflow, lora);
    
    // Should have 2 LoRA loader nodes
    const loraLoaders = result.addedNodes.filter((id) =>
      result.workflow[id]?.class_type === "LoraLoader"
    );
    expect(loraLoaders).toHaveLength(2);
  });

  it("should rewire CLIP connections to go through LoRA", () => {
    const lora: LoRAParams = {
      items: [{ name: "anime_style", strength: 1.0 }],
      autoTrigger: false,
      triggerPosition: "beginning",
    };
    
    const result = injectLoRANodes(workflow, lora);
    
    // CLIP text encode should now get clip from LoRA loader, not checkpoint
    const clipInput = result.workflow["2"]?.inputs?.clip;
    expect(clipInput).not.toEqual(["1", 1]); // Not original connection
  });

  it("should return trigger words when autoTrigger enabled", () => {
    const lora: LoRAParams = {
      items: [{ name: "anime_style", strength: 1.0, triggers: ["anime", "cartoon"] }],
      autoTrigger: true,
      triggerPosition: "beginning",
    };
    
    const result = injectLoRANodes(workflow, lora);
    
    expect(result.modifiedPrompt).toContain("anime");
    expect(result.modifiedPrompt).toContain("cartoon");
  });
});

describe("injectStyleParams", () => {
  let workflow: Workflow;

  beforeEach(() => {
    workflow = createMockWorkflow();
  });

  it("should handle both SREF and LoRA together", () => {
    const sref: SREFParams = {
      items: [{ value: "1234567890", type: "code", weight: 1.0 }],
      styleWeight: 100,
    };
    
    const lora: LoRAParams = {
      items: [{ name: "anime_style", strength: 0.8 }],
      autoTrigger: false,
      triggerPosition: "beginning",
    };
    
    const result = injectStyleParams(workflow, sref, lora, "test prompt");
    
    // Should have nodes from both injections
    expect(result.addedNodes.length).toBeGreaterThan(1);
    expect(result.errors).toHaveLength(0);
    expect(new Set(result.addedNodes).size).toBe(result.addedNodes.length);
    for (const id of result.addedNodes) {
      expect(result.workflow[id]).toBeDefined();
    }
  });

  it("should seed generated IDs above existing workflow nodes", () => {
    const sref: SREFParams = {
      items: [{ value: "1234567890", type: "code", weight: 1.0 }],
      styleWeight: 100,
    };
    const lora: LoRAParams = {
      items: [{ name: "anime_style", strength: 0.8 }],
      autoTrigger: false,
      triggerPosition: "beginning",
    };
    workflow["1000"] = { class_type: "PreviewImage", inputs: {} };

    const result = injectStyleParams(workflow, sref, lora, "test prompt");

    expect(result.addedNodes).not.toContain("1000");
    expect(new Set(Object.keys(result.workflow)).size).toBe(
      Object.keys(result.workflow).length,
    );
  });

  it("should insert trigger words in prompt", () => {
    const lora: LoRAParams = {
      items: [{ name: "anime_style", strength: 1.0, triggers: ["anime", "cartoon"] }],
      autoTrigger: true,
      triggerPosition: "beginning",
    };
    
    const result = injectStyleParams(workflow, null, lora, "a beautiful landscape");
    
    expect(result.modifiedPrompt).toBe("anime, cartoon, a beautiful landscape");
  });

  it("should handle null SREF", () => {
    const lora: LoRAParams = {
      items: [{ name: "anime_style", strength: 1.0 }],
      autoTrigger: false,
      triggerPosition: "beginning",
    };
    
    const result = injectStyleParams(workflow, null, lora, "test prompt");
    
    expect(result.errors).toHaveLength(0);
  });

  it("should handle null LoRA", () => {
    const sref: SREFParams = {
      items: [{ value: "1234567890", type: "code", weight: 1.0 }],
      styleWeight: 100,
    };
    
    const result = injectStyleParams(workflow, sref, null, "test prompt");
    
    expect(result.errors).toHaveLength(0);
  });

  it("should handle both null", () => {
    const result = injectStyleParams(workflow, null, null, "test prompt");
    
    expect(result.addedNodes).toHaveLength(0);
    expect(result.modifiedPrompt).toBe("test prompt");
  });
});

describe("serializeSREFMetadata", () => {
  it("should serialize SREF params to metadata", () => {
    const sref: SREFParams = {
      items: [
        { value: "1234567890", type: "code", weight: 1.0 },
        { value: "https://example.com/style.jpg", type: "url", weight: 0.5 },
        { value: "random", type: "random", weight: 1.0, resolved: "9999999999" },
      ],
      styleWeight: 200,
      styleVersion: 3,
    };
    
    const metadata = serializeSREFMetadata(sref);
    
    expect(metadata.sref_items).toHaveLength(3);
    expect(metadata.sref_items[0]).toEqual({
      value: "1234567890",
      type: "code",
      weight: 1.0,
    });
    expect(metadata.sref_items[2].value).toBe("9999999999"); // Uses resolved
    expect(metadata.sref_style_weight).toBe(200);
    expect(metadata.sref_version).toBe(3);
  });
});

describe("serializeLoRAMetadata", () => {
  it("should serialize LoRA params to metadata", () => {
    const lora: LoRAParams = {
      items: [
        { name: "anime_style", strength: 0.8, clipStrength: 0.5, triggers: ["anime"] },
        { name: "detail_enhancer", strength: 0.6 },
      ],
      autoTrigger: true,
      triggerPosition: "middle",
    };
    
    const metadata = serializeLoRAMetadata(lora);
    
    expect(metadata.lora_items).toHaveLength(2);
    expect(metadata.lora_items[0]).toEqual({
      name: "anime_style",
      strength: 0.8,
      clip_strength: 0.5,
      triggers: ["anime"],
    });
    expect(metadata.lora_auto_trigger).toBe(true);
    expect(metadata.lora_trigger_position).toBe("middle");
  });
});

describe("Workflow integrity", () => {
  it("should not modify original workflow", () => {
    const workflow = createMockWorkflow();
    const originalJson = JSON.stringify(workflow);
    
    const sref: SREFParams = {
      items: [{ value: "1234567890", type: "code", weight: 1.0 }],
      styleWeight: 100,
    };
    
    injectSREFNodes(workflow, sref);
    
    expect(JSON.stringify(workflow)).toBe(originalJson);
  });

  it("should produce valid workflow JSON", () => {
    const workflow = createMockWorkflow();
    
    const sref: SREFParams = {
      items: [{ value: "1234567890", type: "code", weight: 1.0 }],
      styleWeight: 100,
    };
    
    const result = injectSREFNodes(workflow, sref);
    
    // Should be valid JSON
    expect(() => JSON.stringify(result.workflow)).not.toThrow();
    
    // All nodes should have class_type
    for (const [nodeId, node] of Object.entries(result.workflow)) {
      expect(node.class_type).toBeDefined();
      expect(typeof node.class_type).toBe("string");
    }
  });
});

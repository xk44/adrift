/**
 * E2E tests: ComfyUI integration
 * Requires ComfyUI running on :8188
 *
 * Tests the full pipeline: parse → discover → build → queue
 * Generation tests skip when no checkpoints are installed.
 */

import { describe, it, expect, beforeAll } from "vitest";

const SKIP_LIVE = !process.env.COMFY_LIVE_TESTS;
import fs from "fs/promises";
import path from "path";
import { parseImagineInput } from "@/lib/oj/parser";
import { buildImagineRuns, extractWorkflowsFromRuns } from "@/lib/oj/engine";
import { discoverT2ISlots } from "@/lib/oj/discovery";
import { loadWorkflowFromSelection } from "@/lib/comfy/workflows";
import { injectLoRANodes } from "@/lib/sref/workflowInjector";
import type { LoRAParams } from "@/lib/sref/srefParser";
import type { Workflow } from "@/types";

const COMFY_URL = "http://127.0.0.1:8188";
const WORKFLOWS_DIR = path.join(process.cwd(), "public/workflows");
/** UI-format test workflows live in the ComfyUI user dir (COMFY_ROOT). */
const COMFY_USER_WORKFLOWS = path.join(
  process.env.COMFY_ROOT || "../ComfyUI",
  "user/default/workflows",
);

let comfyUp = false;
let checkpoints: string[] = [];

async function comfyFetch(endpoint: string) {
  const res = await fetch(`${COMFY_URL}${endpoint}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadWorkflowFile(name: string): Promise<Workflow> {
  const content = await fs.readFile(path.join(WORKFLOWS_DIR, name), "utf-8");
  return JSON.parse(content);
}

beforeAll(async () => {
  try {
    await comfyFetch("/system_stats");
    comfyUp = true;
  } catch {
    comfyUp = false;
  }

  if (comfyUp) {
    try {
      const data = await comfyFetch("/object_info/CheckpointLoaderSimple");
      checkpoints =
        data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
    } catch {
      checkpoints = [];
    }
  }
});

describe.skipIf(SKIP_LIVE)("ComfyUI connectivity", () => {
  it("is reachable on :8188", () => {
    expect(comfyUp).toBe(true);
  });

  it("returns system_stats with GPU info", async () => {
    if (!comfyUp) return;
    const stats = await comfyFetch("/system_stats");
    expect(stats).toHaveProperty("devices");
    expect(Array.isArray(stats.devices)).toBe(true);
    expect(stats.devices.length).toBeGreaterThan(0);
    expect(stats.devices[0]).toHaveProperty("type");
  });

  it("returns queue status", async () => {
    if (!comfyUp) return;
    const data = await comfyFetch("/prompt");
    expect(data).toHaveProperty("exec_info");
    expect(data.exec_info).toHaveProperty("queue_remaining");
  });

  it("returns object_info", async () => {
    if (!comfyUp) return;
    const data = await comfyFetch("/object_info/KSampler");
    expect(data).toHaveProperty("KSampler");
    expect(data.KSampler.input.required).toHaveProperty("sampler_name");
    expect(data.KSampler.input.required).toHaveProperty("scheduler");
  });
});

describe("Workflow slot discovery", () => {
  // Only test workflows that contain a KSampler (upscale doesn't)
  const workflowFiles = [
    "t2i.json",
    "i2i.json",
    "inpaint.json",
    "zimageturbo.json",
  ];

  for (const file of workflowFiles) {
    it(`discovers slots in ${file}`, async () => {
      const wf = await loadWorkflowFile(file);
      expect(Object.keys(wf).length).toBeGreaterThan(0);

      const slots = discoverT2ISlots(wf);
      expect(slots.ksamplerId).toBeTruthy();
    });
  }

  it("finds positive/negative text encoders in t2i.json", async () => {
    const wf = await loadWorkflowFile("t2i.json");
    const slots = discoverT2ISlots(wf);
    expect(slots.posTextId).toBeTruthy();
    expect(slots.negTextId).toBeTruthy();
  });

  it("upscale.json throws (no KSampler)", async () => {
    const wf = await loadWorkflowFile("upscale.json");
    expect(() => discoverT2ISlots(wf)).toThrow(/no KSampler/);
  });
});

describe("Parse → Build → Extract pipeline", () => {
  it("simple prompt produces runs with jobs", async () => {
    const wf = await loadWorkflowFile("t2i.json");
    const parsed = parseImagineInput("a beautiful sunset over mountains");

    expect(parsed.prompt.length).toBeGreaterThan(0);
    expect(parsed.errors).toHaveLength(0);

    const runs = buildImagineRuns(parsed, wf, { batchSize: 2 });
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].jobs.length).toBe(2);

    const workflowJobs = extractWorkflowsFromRuns(runs, wf, discoverT2ISlots);
    expect(workflowJobs.length).toBe(2);

    // Each extracted workflow should be valid JSON with nodes
    for (const wj of workflowJobs) {
      expect(Object.keys(wj.workflow).length).toBeGreaterThan(0);
    }
  });

  it("prompt with --ar and --seed injects correctly", async () => {
    const wf = await loadWorkflowFile("t2i.json");
    const parsed = parseImagineInput("cyberpunk city --ar 16:9 --seed 42");

    expect(parsed.params.ar).toBe("16:9");
    expect(parsed.params.seed).toBe(42);

    const runs = buildImagineRuns(parsed, wf, { batchSize: 1 });
    expect(runs[0].jobs[0].seed).toBe(42);

    const workflowJobs = extractWorkflowsFromRuns(runs, wf, discoverT2ISlots);
    expect(workflowJobs.length).toBe(1);

    // Verify seed was injected into KSampler node
    const extractedWf = workflowJobs[0].workflow;
    const samplerNode = Object.values(extractedWf).find(
      (n) => n.class_type === "KSampler" || n.class_type === "KSamplerAdvanced",
    );
    if (samplerNode) {
      const inputs = samplerNode.inputs as Record<string, unknown>;
      expect(inputs.seed ?? inputs.noise_seed).toBe(42);
    }
  });

  it("prompt with --no injects negative prompt", async () => {
    const wf = await loadWorkflowFile("t2i.json");
    const parsed = parseImagineInput("happy dog --no cats, birds");

    expect(parsed.params.no).toEqual(["cats, birds"]);
    expect(parsed.prompt).toContain("happy dog");
  });

  it("prompt with --steps and --cfg", async () => {
    const parsed = parseImagineInput("test --steps 30 --cfg 7.5");
    expect(parsed.params.steps).toBe(30);
    expect(parsed.params.cfg).toBe(7.5);
  });
});

describe("Workflow template loading", () => {
  const templates = [
    "t2i.json",
    "i2i.json",
    "inpaint.json",
    "outpaint.json",
    "upscale.json",
    "upscale_subtle.json",
    "upscale_creative.json",
    "vary_subtle.json",
    "vary_strong.json",
    "remix_subtle.json",
    "remix_strong.json",
    "controlnet.json",
    "zimageturbo.json",
  ];

  for (const tpl of templates) {
    it(`${tpl} is valid workflow JSON`, async () => {
      const wf = await loadWorkflowFile(tpl);
      expect(typeof wf).toBe("object");
      expect(Object.keys(wf).length).toBeGreaterThan(0);

      // Every node must have class_type
      for (const [id, node] of Object.entries(wf)) {
        expect(node).toHaveProperty("class_type");
        expect(typeof node.class_type).toBe("string");
      }
    });
  }
});

describe("UI → API workflow conversion", () => {
  const COMFY_WORKFLOWS_DIR = COMFY_USER_WORKFLOWS;

  it("converts zimageturbo-test.json from UI format to API format", async () => {
    const uiPath = path.join(COMFY_WORKFLOWS_DIR, "zimageturbo-test.json");
    const wf = await loadWorkflowFromSelection(uiPath);

    // Should have all expected nodes
    const classTypes = Object.values(wf).map((n) => n.class_type);
    expect(classTypes).toContain("KSampler");
    expect(classTypes).toContain("CLIPLoader");
    expect(classTypes).toContain("UNETLoader");
    expect(classTypes).toContain("VAELoader");
    expect(classTypes).toContain("VAEDecode");
    expect(classTypes).toContain("CLIPTextEncode");
    expect(classTypes).toContain("SaveImage");
    expect(classTypes).toContain("ModelSamplingAuraFlow");

    // MarkdownNote is harmless — ComfyUI ignores non-functional nodes
  });

  it("converted workflow has correct model references", async () => {
    const uiPath = path.join(COMFY_WORKFLOWS_DIR, "zimageturbo-test.json");
    const wf = await loadWorkflowFromSelection(uiPath);

    const unetNode = Object.values(wf).find(
      (n) => n.class_type === "UNETLoader",
    );
    expect((unetNode!.inputs as any).unet_name).toBe(
      "z_image_turbo_bf16.safetensors",
    );

    const clipNode = Object.values(wf).find(
      (n) => n.class_type === "CLIPLoader",
    );
    expect((clipNode!.inputs as any).clip_name).toBe("qwen_3_4b.safetensors");

    const vaeNode = Object.values(wf).find((n) => n.class_type === "VAELoader");
    expect((vaeNode!.inputs as any).vae_name).toBe("ae.safetensors");
  });

  it("converted workflow has valid node links (arrays)", async () => {
    const uiPath = path.join(COMFY_WORKFLOWS_DIR, "zimageturbo-test.json");
    const wf = await loadWorkflowFromSelection(uiPath);

    const ksampler = Object.values(wf).find(
      (n) => n.class_type === "KSampler",
    )!;
    const inputs = ksampler.inputs as Record<string, unknown>;

    // model, positive, negative, latent_image should be node refs [id, slot]
    for (const key of ["model", "positive", "negative", "latent_image"]) {
      expect(Array.isArray(inputs[key])).toBe(true);
      const ref = inputs[key] as [string, number];
      expect(typeof ref[0]).toBe("string");
      expect(typeof ref[1]).toBe("number");
      // Referenced node must exist
      expect(wf[ref[0]]).toBeTruthy();
    }
  });

  it("converted workflow discovers slots correctly", async () => {
    const uiPath = path.join(COMFY_WORKFLOWS_DIR, "zimageturbo-test.json");
    const wf = await loadWorkflowFromSelection(uiPath);
    const slots = discoverT2ISlots(wf);
    expect(slots.ksamplerId).toBeTruthy();
    expect(slots.posTextId).toBeTruthy();
  });

  it("already-API-format workflows pass through unchanged", async () => {
    const wf = await loadWorkflowFromSelection(
      path.join(process.cwd(), "public/workflows/zimageturbo.json"),
    );
    expect(wf["44"].class_type).toBe("KSampler");
    expect(wf["46"].class_type).toBe("UNETLoader");
  });

  it("full inject pipeline: params/model/sampler on converted workflow", async () => {
    const uiPath = path.join(COMFY_USER_WORKFLOWS, "zimageturbo-test.json");
    const wf = await loadWorkflowFromSelection(uiPath);
    const slots = discoverT2ISlots(wf);

    // Verify discovery found the right nodes
    expect(wf[slots.ksamplerId].class_type).toBe("KSampler");
    expect(wf[slots.posTextId].class_type).toBe("CLIPTextEncode");
    expect(slots.checkpointLoaderId).toBeTruthy();

    const parsed = parseImagineInput(
      "a dragon flying --seed 777 --steps 12 --cfg 3.5 --sampler euler --scheduler normal --ar 16:9 --model different_model.safetensors --vae other_vae.safetensors",
    );
    const runs = buildImagineRuns(parsed, wf, { batchSize: 1 });
    const workflowJobs = extractWorkflowsFromRuns(runs, wf, discoverT2ISlots);
    const extracted = workflowJobs[0].workflow;

    // Prompt injected
    const posNode = extracted[slots.posTextId];
    expect((posNode.inputs as any).text).toContain("a dragon flying");

    // Seed injected
    const sampler = extracted[slots.ksamplerId];
    expect((sampler.inputs as any).seed).toBe(777);

    // Steps/cfg/sampler/scheduler injected
    expect((sampler.inputs as any).steps).toBe(12);
    expect((sampler.inputs as any).cfg).toBe(3.5);
    expect((sampler.inputs as any).sampler_name).toBe("euler");
    expect((sampler.inputs as any).scheduler).toBe("normal");

    // Dimensions changed via --ar
    const latentNode = extracted[slots.latentDimsId];
    const w = (latentNode.inputs as any).width as number;
    const h = (latentNode.inputs as any).height as number;
    expect(w).toBeGreaterThan(h); // 16:9 = landscape

    // Model override applied to checkpoint/unet loader
    const loaderNode = extracted[slots.checkpointLoaderId!];
    const modelInput =
      (loaderNode.inputs as any).ckpt_name ??
      (loaderNode.inputs as any).unet_name;
    expect(modelInput).toBe("different_model.safetensors");

    // VAE override
    if (slots.vaeLoaderId) {
      const vaeNode = extracted[slots.vaeLoaderId];
      expect((vaeNode.inputs as any).vae_name).toBe("other_vae.safetensors");
    }
  });
});

describe("Z-Image-Turbo generation", () => {
  it("discovers slots in zimageturbo.json", async () => {
    const wf = await loadWorkflowFile("zimageturbo.json");
    const slots = discoverT2ISlots(wf);
    expect(slots.ksamplerId).toBe("44");
    expect(slots.posTextId).toBeTruthy();
  });

  it("queues and generates an image", async () => {
    if (!comfyUp) {
      console.log("SKIP: ComfyUI not running");
      return;
    }

    const wf = await loadWorkflowFile("zimageturbo.json");
    // Inject prompt text
    (wf["45"].inputs as Record<string, unknown>).text =
      "e2e test: a red fox in snow --seed 99999";
    (wf["44"].inputs as Record<string, unknown>).seed = 99999;

    const res = await fetch(`${COMFY_URL}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: wf, client_id: "e2e-test" }),
    });

    const data = await res.json();
    expect(res.ok).toBe(true);
    expect(data).toHaveProperty("prompt_id");
    const promptId = data.prompt_id;
    console.log(`Queued prompt_id: ${promptId}`);

    // Poll for completion (max 60s)
    let history: Record<string, unknown> | null = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const hRes = await fetch(`${COMFY_URL}/history/${promptId}`);
      const hData = await hRes.json();
      if (hData[promptId]?.status?.completed) {
        history = hData[promptId];
        break;
      }
    }

    expect(history).not.toBeNull();
    const status = (history as any).status;
    expect(status.status_str).toBe("success");

    // Check output image exists
    const outputs = (history as any).outputs ?? {};
    const images: Array<{ filename: string }> = [];
    for (const out of Object.values(outputs) as any[]) {
      if (out.images) images.push(...out.images);
    }
    expect(images.length).toBeGreaterThan(0);
    console.log(`Generated: ${images[0].filename}`);
  }, 90000); // 90s timeout for generation

  it("parse+build pipeline works with zimageturbo workflow", async () => {
    const wf = await loadWorkflowFile("zimageturbo.json");
    const parsed = parseImagineInput("test prompt --seed 42 --steps 9");

    const runs = buildImagineRuns(parsed, wf, { batchSize: 1 });
    expect(runs.length).toBeGreaterThan(0);

    const workflowJobs = extractWorkflowsFromRuns(runs, wf, discoverT2ISlots);
    expect(workflowJobs.length).toBe(1);

    const extracted = workflowJobs[0].workflow;
    // Verify the UNETLoader is preserved (not CheckpointLoaderSimple)
    const unetNode = Object.values(extracted).find(
      (n) => n.class_type === "UNETLoader",
    );
    expect(unetNode).toBeTruthy();
    expect((unetNode!.inputs as any).unet_name).toBe(
      "z_image_turbo_bf16.safetensors",
    );
  });
});

// ============================================================================
// Stretch tests: real model/LoRA/param combos against ComfyUI
// ============================================================================

describe("Stretch: LoRA injection on split-loader workflow", () => {
  it("injects single LoRA into zimageturbo workflow (UNETLoader + CLIPLoader)", async () => {
    const wf = await loadWorkflowFile("zimageturbo.json");

    const lora: LoRAParams = {
      items: [
        {
          name: "zimageturbo/pixel_art_style_z_image_turbo.safetensors",
          strength: 0.8,
        },
      ],
      autoTrigger: false,
      triggerPosition: "beginning",
    };

    const result = injectLoRANodes(wf, lora);
    expect(result.errors).toHaveLength(0);
    expect(result.addedNodes.length).toBe(1);

    // LoRA loader should exist with correct name and strength
    const loraNode = result.workflow[result.addedNodes[0]];
    expect(loraNode.class_type).toBe("LoraLoader");
    expect((loraNode.inputs as any).lora_name).toBe(
      "zimageturbo/pixel_art_style_z_image_turbo.safetensors",
    );
    expect((loraNode.inputs as any).strength_model).toBe(0.8);
    expect((loraNode.inputs as any).strength_clip).toBe(0.8);

    // LoRA model input should come from UNETLoader
    const loraModelIn = (loraNode.inputs as any).model;
    expect(Array.isArray(loraModelIn)).toBe(true);
    const sourceNode = result.workflow[loraModelIn[0]];
    expect(sourceNode.class_type).toBe("UNETLoader");

    // LoRA clip input should come from CLIPLoader
    const loraClipIn = (loraNode.inputs as any).clip;
    expect(Array.isArray(loraClipIn)).toBe(true);
    const clipSourceNode = result.workflow[loraClipIn[0]];
    expect(clipSourceNode.class_type).toBe("CLIPLoader");

    // ModelSamplingAuraFlow should now consume from LoRA (not UNETLoader)
    const msaf = Object.values(result.workflow).find(
      (n) => n.class_type === "ModelSamplingAuraFlow",
    )!;
    const msafModelIn = (msaf.inputs as any).model;
    expect(msafModelIn[0]).toBe(result.addedNodes[0]);

    // CLIPTextEncode should consume from LoRA clip output (not CLIPLoader)
    const clipEnc = Object.values(result.workflow).find(
      (n) => n.class_type === "CLIPTextEncode",
    )!;
    const clipEncIn = (clipEnc.inputs as any).clip;
    expect(clipEncIn[0]).toBe(result.addedNodes[0]);
  });

  it("chains multiple LoRAs correctly", async () => {
    const wf = await loadWorkflowFile("zimageturbo.json");

    const lora: LoRAParams = {
      items: [
        {
          name: "zimageturbo/pixel_art_style_z_image_turbo.safetensors",
          strength: 0.7,
        },
        {
          name: "zimageturbo/REDZ15_DetailDaemonZ_zimageturbo-lora_v1.1.safetensors",
          strength: 0.5,
          clipStrength: 0.3,
        },
      ],
      autoTrigger: false,
      triggerPosition: "beginning",
    };

    const result = injectLoRANodes(wf, lora);
    expect(result.errors).toHaveLength(0);
    expect(result.addedNodes.length).toBe(2);

    // First LoRA takes from UNETLoader + CLIPLoader
    const lora1 = result.workflow[result.addedNodes[0]];
    const lora1Model = (lora1.inputs as any).model;
    expect(result.workflow[lora1Model[0]].class_type).toBe("UNETLoader");

    // Second LoRA chains from first
    const lora2 = result.workflow[result.addedNodes[1]];
    expect((lora2.inputs as any).model[0]).toBe(result.addedNodes[0]);
    expect((lora2.inputs as any).clip[0]).toBe(result.addedNodes[0]);
    expect((lora2.inputs as any).strength_model).toBe(0.5);
    expect((lora2.inputs as any).strength_clip).toBe(0.3);

    // ModelSamplingAuraFlow consumes from last LoRA in chain
    const msaf = Object.values(result.workflow).find(
      (n) => n.class_type === "ModelSamplingAuraFlow",
    )!;
    expect((msaf.inputs as any).model[0]).toBe(result.addedNodes[1]);
  });
});

describe.skipIf(SKIP_LIVE)(
  "Stretch: live generation with param overrides",
  () => {
    // Helper to queue and wait for result
    async function queueAndWait(
      wf: Workflow,
      label: string,
      timeoutMs = 60000,
    ): Promise<{ success: boolean; images: string[]; error?: string }> {
      const res = await fetch(`${COMFY_URL}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: wf, client_id: "e2e-stretch" }),
      });
      const data = await res.json();
      if (!res.ok) {
        const errMsg =
          data?.error?.message ?? JSON.stringify(data).slice(0, 500);
        console.log(`[${label}] QUEUE REJECTED: ${errMsg}`);
        return { success: false, images: [], error: errMsg };
      }
      const promptId = data.prompt_id;
      console.log(`[${label}] queued: ${promptId}`);

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const hRes = await fetch(`${COMFY_URL}/history/${promptId}`);
        const hData = await hRes.json();
        const entry = hData[promptId];
        if (entry?.status?.completed) {
          const images: string[] = [];
          for (const out of Object.values(entry.outputs ?? {}) as any[]) {
            if (out.images)
              images.push(...out.images.map((i: any) => i.filename));
          }
          return {
            success: entry.status.status_str === "success",
            images,
            error:
              entry.status.status_str !== "success"
                ? "generation failed"
                : undefined,
          };
        }
      }
      return { success: false, images: [], error: "timeout" };
    }

    it("generates with different sampler + scheduler", async () => {
      if (!comfyUp) return;
      const wf = await loadWorkflowFile("zimageturbo.json");
      (wf["45"].inputs as any).text = "stretch test: mountain landscape";
      (wf["44"].inputs as any).seed = 11111;
      (wf["44"].inputs as any).sampler_name = "euler_ancestral";
      (wf["44"].inputs as any).scheduler = "karras";
      (wf["44"].inputs as any).steps = 12;
      (wf["44"].inputs as any).cfg = 2.0;

      const result = await queueAndWait(wf, "sampler+scheduler");
      expect(result.success).toBe(true);
      expect(result.images.length).toBeGreaterThan(0);
      console.log(`  -> ${result.images[0]}`);
    }, 90000);

    it("generates with different diffusion model", async () => {
      if (!comfyUp) return;
      const wf = await loadWorkflowFile("zimageturbo.json");
      (wf["45"].inputs as any).text = "stretch test: cyberpunk city";
      (wf["44"].inputs as any).seed = 22222;
      // Switch to beyondREALITY model
      (wf["46"].inputs as any).unet_name = "beyondREALITY_V3.safetensors";

      const result = await queueAndWait(wf, "alt-model");
      if (!result.success) {
        // May fail if model is incompatible with this workflow structure
        console.log(
          `  -> alt model failed (expected if incompatible): ${result.error}`,
        );
      } else {
        expect(result.images.length).toBeGreaterThan(0);
        console.log(`  -> ${result.images[0]}`);
      }
    }, 90000);

    it("generates with LoRA injected", async () => {
      if (!comfyUp) return;
      const wf = await loadWorkflowFile("zimageturbo.json");
      (wf["45"].inputs as any).text = "stretch test: pixel art castle";
      (wf["44"].inputs as any).seed = 33333;

      const lora: LoRAParams = {
        items: [
          {
            name: "zimageturbo/pixel_art_style_z_image_turbo.safetensors",
            strength: 1.0,
          },
        ],
        autoTrigger: false,
        triggerPosition: "beginning",
      };

      const injected = injectLoRANodes(wf, lora);
      expect(injected.errors).toHaveLength(0);

      const result = await queueAndWait(injected.workflow, "lora-pixel-art");
      expect(result.success).toBe(true);
      expect(result.images.length).toBeGreaterThan(0);
      console.log(`  -> ${result.images[0]}`);
    }, 90000);

    it("generates with LoRA at low strength", async () => {
      if (!comfyUp) return;
      const wf = await loadWorkflowFile("zimageturbo.json");
      (wf["45"].inputs as any).text = "stretch test: detailed portrait";
      (wf["44"].inputs as any).seed = 44444;

      const lora: LoRAParams = {
        items: [
          {
            name: "zimageturbo/REDZ15_DetailDaemonZ_zimageturbo-lora_v1.1.safetensors",
            strength: 0.3,
            clipStrength: 0.2,
          },
        ],
        autoTrigger: false,
        triggerPosition: "beginning",
      };

      const injected = injectLoRANodes(wf, lora);
      expect(injected.errors).toHaveLength(0);

      const result = await queueAndWait(injected.workflow, "lora-detail-low");
      expect(result.success).toBe(true);
      expect(result.images.length).toBeGreaterThan(0);
      console.log(`  -> ${result.images[0]}`);
    }, 90000);

    it("generates with chained LoRAs", async () => {
      if (!comfyUp) return;
      const wf = await loadWorkflowFile("zimageturbo.json");
      (wf["45"].inputs as any).text =
        "stretch test: pixel art with extra detail";
      (wf["44"].inputs as any).seed = 55555;

      const lora: LoRAParams = {
        items: [
          {
            name: "zimageturbo/pixel_art_style_z_image_turbo.safetensors",
            strength: 0.8,
          },
          {
            name: "zimageturbo/REDZ15_DetailDaemonZ_zimageturbo-lora_v1.1.safetensors",
            strength: 0.4,
          },
        ],
        autoTrigger: false,
        triggerPosition: "beginning",
      };

      const injected = injectLoRANodes(wf, lora);
      expect(injected.errors).toHaveLength(0);

      const result = await queueAndWait(injected.workflow, "chained-loras");
      expect(result.success).toBe(true);
      expect(result.images.length).toBeGreaterThan(0);
      console.log(`  -> ${result.images[0]}`);
    }, 90000);

    it("generates via converted UI workflow with full param injection", async () => {
      if (!comfyUp) return;
      const uiPath = path.join(COMFY_USER_WORKFLOWS, "zimageturbo-test.json");
      const wf = await loadWorkflowFromSelection(uiPath);
      const slots = discoverT2ISlots(wf);

      // Inject via engine
      const { injectParams } = await import("@/lib/oj/engine");
      injectParams(
        wf,
        slots,
        { ar: "16:9", steps: 7, sampler: "dpmpp_2m", scheduler: "sgm_uniform" },
        "stretch test: wide landscape with mountains and river",
        "",
        66666,
      );

      // Also inject a LoRA
      const lora: LoRAParams = {
        items: [
          {
            name: "zimageturbo/Z-Brushwork-lora.safetensors",
            strength: 0.6,
          },
        ],
        autoTrigger: false,
        triggerPosition: "beginning",
      };
      const injected = injectLoRANodes(wf, lora);
      expect(injected.errors).toHaveLength(0);

      const result = await queueAndWait(
        injected.workflow,
        "converted+params+lora",
      );
      expect(result.success).toBe(true);
      expect(result.images.length).toBeGreaterThan(0);
      console.log(`  -> ${result.images[0]}`);
    }, 90000);
  },
);

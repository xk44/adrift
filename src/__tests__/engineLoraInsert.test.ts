/**
 * --lora on graphs without a LoRA slot: the engine splices LoraLoaderModelOnly
 * nodes after the single model loader (public Krea 2 t2i/draft ship without the
 * private filter-LoRA node that --lora used to ride).
 */

import { describe, it, expect } from "vitest";
import { injectParams, insertModelLoraChain } from "@/lib/oj/engine";
import { discoverT2ISlots } from "@/lib/oj/discovery";
import type { Workflow } from "@/types";

function krea2Public(): Workflow {
  return {
    "1": {
      class_type: "UNETLoader",
      inputs: { unet_name: "krea2.safetensors" },
    },
    "3": { class_type: "ComfyUI-Krea2T-Enhancer", inputs: { model: ["1", 0] } },
    "4": { class_type: "CLIPLoader", inputs: { clip_name: "te.safetensors" } },
    "6": { class_type: "CLIPTextEncode", inputs: { clip: ["4", 0], text: "" } },
    "8": { class_type: "CLIPTextEncode", inputs: { clip: ["4", 0], text: "" } },
    "9": {
      class_type: "EmptySD3LatentImage",
      inputs: { width: 1024, height: 1024, batch_size: 1 },
    },
    "10": {
      class_type: "KSampler",
      inputs: {
        model: ["3", 0],
        positive: ["6", 0],
        negative: ["8", 0],
        latent_image: ["9", 0],
        seed: 1,
        steps: 8,
        cfg: 1,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1,
      },
    },
    "12": { class_type: "VAEDecode", inputs: { samples: ["10", 0] } },
    "13": { class_type: "SaveImage", inputs: { images: ["12", 0] } },
  } as unknown as Workflow;
}

describe("insertModelLoraChain", () => {
  it("chains loaders after the model loader and rewires consumers", () => {
    const wf = krea2Public();
    const ids = insertModelLoraChain(wf, 2);
    expect(ids).toEqual(["14", "15"]);
    expect(wf["14"].inputs.model).toEqual(["1", 0]);
    expect(wf["15"].inputs.model).toEqual(["14", 0]);
    expect(wf["3"].inputs.model).toEqual(["15", 0]);
  });

  it("skips graphs with several model loaders", () => {
    const wf = krea2Public();
    wf["20"] = {
      class_type: "UNETLoader",
      inputs: { unet_name: "b" },
    } as Workflow[string];
    expect(insertModelLoraChain(wf, 1)).toEqual([]);
  });
});

describe("injectParams --lora without a slot", () => {
  it("applies --lora name::strength on an inserted loader", () => {
    const wf = krea2Public();
    const slots = discoverT2ISlots(wf);
    expect(slots.loraLoaderIds).toBeUndefined();
    injectParams(wf, slots, { lora: "mystyle::0.7" }, "a cat", "", 5);
    const loras = Object.values(wf).filter(
      (n) => n.class_type === "LoraLoaderModelOnly",
    );
    expect(loras).toHaveLength(1);
    expect(loras[0].inputs.lora_name).toBe("mystyle");
    expect(loras[0].inputs.strength_model).toBe(0.7);
    expect(wf["3"].inputs.model).toEqual(["14", 0]);
  });

  it("leaves the graph alone when no --lora is given", () => {
    const wf = krea2Public();
    injectParams(wf, discoverT2ISlots(wf), {}, "a cat", "", 5);
    expect(
      Object.values(wf).some((n) => n.class_type === "LoraLoaderModelOnly"),
    ).toBe(false);
  });
});

import { crc32 } from "zlib";
import type { Workflow } from "@/types";

/** SD-style text-to-image API graph. */
export function t2iGraph(): Workflow {
  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "sdxl_base.safetensors" },
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: "a red fox", clip: ["1", 1] },
      _meta: { title: "CLIP Text Encode (Prompt)" },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: "blurry", clip: ["1", 1] },
    },
    "4": {
      class_type: "EmptyLatentImage",
      inputs: { width: 1024, height: 768, batch_size: 1 },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed: 42,
        steps: 20,
        cfg: 7,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0],
      },
    },
    "6": {
      class_type: "VAEDecode",
      inputs: { samples: ["5", 0], vae: ["1", 2] },
    },
    "7": {
      class_type: "SaveImage",
      inputs: { images: ["6", 0], filename_prefix: "fox" },
    },
  };
}

/** Image edit graph with a LoRA and a custom node. */
export function editGraph(): Workflow {
  return {
    "10": {
      class_type: "LoadImage",
      inputs: { image: "photo.png", upload: "image" },
      _meta: { title: "Your photo" },
    },
    "11": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "sdxl_base.safetensors" },
    },
    "12": {
      class_type: "LoraLoader",
      inputs: {
        lora_name: "styles/ink_wash.safetensors",
        strength_model: 0.8,
        strength_clip: 0.8,
        model: ["11", 0],
        clip: ["11", 1],
      },
    },
    "13": {
      class_type: "CLIPTextEncode",
      inputs: { text: "ink wash painting", clip: ["12", 1] },
    },
    "14": {
      class_type: "CLIPTextEncode",
      inputs: { text: "", clip: ["12", 1] },
    },
    "15": {
      class_type: "VAEEncode",
      inputs: { pixels: ["10", 0], vae: ["11", 2] },
    },
    "16": {
      class_type: "KSampler",
      inputs: {
        seed: 7,
        steps: 25,
        cfg: 5.5,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 0.6,
        model: ["12", 0],
        positive: ["13", 0],
        negative: ["14", 0],
        latent_image: ["15", 0],
      },
    },
    "17": {
      class_type: "FancyColorGrade",
      inputs: { image: ["18", 0], strength: 0.5 },
    },
    "18": {
      class_type: "VAEDecode",
      inputs: { samples: ["16", 0], vae: ["11", 2] },
    },
    "19": {
      class_type: "SaveImage",
      inputs: { images: ["17", 0], filename_prefix: "ink" },
    },
  };
}

/** UI-format (litegraph) LoadImage -> SaveImage canvas. */
export function uiGraph(): Record<string, unknown> {
  return {
    last_node_id: 2,
    last_link_id: 1,
    nodes: [
      {
        id: 1,
        type: "LoadImage",
        mode: 0,
        inputs: [
          {
            name: "image",
            type: "COMBO",
            widget: { name: "image" },
            link: null,
          },
        ],
        outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }],
        widgets_values: ["cat.png", "image"],
      },
      {
        id: 2,
        type: "SaveImage",
        mode: 0,
        inputs: [{ name: "images", type: "IMAGE", link: 1 }],
        outputs: [],
        widgets_values: ["copy"],
      },
    ],
    links: [[1, 1, 0, 2, 0, "IMAGE"]],
    version: 0.4,
  };
}

/** Minimal object_info covering the classes above (not FancyColorGrade). */
export function objectInfo(): Record<string, unknown> {
  return {
    CheckpointLoaderSimple: {
      input: {
        required: {
          ckpt_name: [["sdxl_base.safetensors", "other.safetensors"]],
        },
      },
    },
    CLIPTextEncode: {
      input: {
        required: {
          text: ["STRING", { multiline: true, dynamicPrompts: true }],
          clip: ["CLIP"],
        },
      },
    },
    EmptyLatentImage: {
      input: {
        required: {
          width: ["INT", { default: 512, min: 16, max: 16384, step: 8 }],
          height: ["INT", { default: 512, min: 16, max: 16384, step: 8 }],
          batch_size: ["INT", { default: 1, min: 1, max: 4096 }],
        },
      },
    },
    KSampler: {
      input: {
        required: {
          model: ["MODEL"],
          seed: [
            "INT",
            {
              default: 0,
              min: 0,
              max: 18446744073709551615,
              control_after_generate: true,
            },
          ],
          steps: ["INT", { default: 20, min: 1, max: 10000 }],
          cfg: ["FLOAT", { default: 8, min: 0, max: 100, step: 0.1 }],
          sampler_name: [["euler", "dpmpp_2m"]],
          scheduler: [["normal", "karras"]],
          positive: ["CONDITIONING"],
          negative: ["CONDITIONING"],
          latent_image: ["LATENT"],
          denoise: ["FLOAT", { default: 1, min: 0, max: 1, step: 0.01 }],
        },
      },
    },
    VAEDecode: { input: { required: { samples: ["LATENT"], vae: ["VAE"] } } },
    VAEEncode: { input: { required: { pixels: ["IMAGE"], vae: ["VAE"] } } },
    SaveImage: {
      input: {
        required: {
          images: ["IMAGE"],
          filename_prefix: ["STRING", { default: "ComfyUI" }],
        },
      },
    },
    LoadImage: {
      input: { required: { image: [["a.png"], { image_upload: true }] } },
    },
    LoraLoader: {
      input: {
        required: {
          model: ["MODEL"],
          clip: ["CLIP"],
          lora_name: [["detail.safetensors"]],
          strength_model: [
            "FLOAT",
            { default: 1, min: -100, max: 100, step: 0.01 },
          ],
          strength_clip: [
            "FLOAT",
            { default: 1, min: -100, max: 100, step: 0.01 },
          ],
        },
      },
    },
  };
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0, 0);
  return Buffer.concat([len, td, crc]);
}

/** A 1x1 PNG with tEXt chunks. */
export function pngWithText(text: Record<string, string>): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const parts = [sig, chunk("IHDR", ihdr)];
  for (const [k, v] of Object.entries(text)) {
    parts.push(
      chunk(
        "tEXt",
        Buffer.concat([
          Buffer.from(k, "latin1"),
          Buffer.from([0]),
          Buffer.from(v, "utf8"),
        ]),
      ),
    );
  }
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

import { describe, expect, it, vi } from "vitest";
import { buildModelInventory } from "@/lib/comfy/modelInventory";
import {
  comboStrings,
  extractEnumOptionsInventory,
  extractInputList,
  type ObjectInfoResponse,
} from "@/lib/oj/localInventory";
import {
  listComfyModelFolder,
  parseModelFolderListing,
} from "@/lib/comfy/modelFolders";

// Shapes copied from ComfyUI 0.42 /object_info: V3 nodes use
// ["COMBO", {options}], legacy nodes use [[...options]].
const OBJECT_INFO: ObjectInfoResponse = {
  UpscaleModelLoader: {
    input: {
      required: {
        model_name: [
          "COMBO",
          { options: ["4x-UltraSharp.pth", "RealESRGAN_x4plus.pth"] },
        ],
      },
    },
  },
  HypernetworkLoader: {
    input: {
      required: {
        model: ["MODEL", {}],
        hypernetwork_name: ["COMBO", { options: ["hn_style.pt"] }],
        strength: ["FLOAT", { default: 1 }],
      },
    },
  },
  TripleCLIPLoader: {
    input: {
      required: {
        clip_name1: [
          "COMBO",
          { options: ["clip_l.safetensors", "t5xxl.safetensors"] },
        ],
        clip_name2: [
          "COMBO",
          { options: ["clip_l.safetensors", "t5xxl.safetensors"] },
        ],
        clip_name3: [
          "COMBO",
          { options: ["clip_l.safetensors", "t5xxl.safetensors"] },
        ],
      },
    },
  },
  LatentUpscaleModelLoader: {
    input: {
      required: {
        model_name: [
          "COMBO",
          { options: ["ltx-2.5-latent-spatial-upscaler.safetensors"] },
        ],
      },
    },
  },
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [["sdxl.safetensors"]] } },
  },
  CLIPVisionLoader: {
    input: { required: { clip_name: [["clip_vision_h.safetensors"]] } },
  },
  RemoteThing: {
    input: { required: { choice: ["COMBO", { remote: { route: "/x" } }] } },
  },
};

describe("COMBO-aware inventory parsing", () => {
  it("reads both legacy and COMBO option specs", () => {
    expect(comboStrings([["a", "b"]])).toEqual(["a", "b"]);
    expect(comboStrings(["COMBO", { options: ["c"] }])).toEqual(["c"]);
    expect(comboStrings(["COMBO", { remote: {} }])).toEqual([]);
    expect(comboStrings(["INT", { default: 1 }])).toEqual([]);
    expect(comboStrings(undefined)).toEqual([]);
  });

  it("extractInputList handles COMBO and optional inputs", () => {
    expect(
      extractInputList(OBJECT_INFO, "UpscaleModelLoader", "model_name"),
    ).toEqual(["4x-UltraSharp.pth", "RealESRGAN_x4plus.pth"]);
    const withOptional: ObjectInfoResponse = {
      X: { input: { optional: { pick: ["COMBO", { options: ["o1"] }] } } },
    };
    expect(extractInputList(withOptional, "X", "pick")).toEqual(["o1"]);
  });

  it("fills upscaler, hypernetwork, text-encoder and latent upscaler inventories", () => {
    const inv = buildModelInventory(OBJECT_INFO);
    expect(inv.upscale_models).toEqual([
      "4x-UltraSharp.pth",
      "RealESRGAN_x4plus.pth",
    ]);
    expect(inv.hypernetworks).toEqual(["hn_style.pt"]);
    expect(inv.latent_upscale_models).toEqual([
      "ltx-2.5-latent-spatial-upscaler.safetensors",
    ]);
    expect(inv.text_encoders).toEqual([
      "clip_l.safetensors",
      "t5xxl.safetensors",
    ]);
    expect(inv.clip_vision).toEqual(["clip_vision_h.safetensors"]);
    expect(inv.checkpoints).toEqual(["sdxl.safetensors"]);
  });

  it("enum inventory includes COMBO-format inputs", () => {
    const enums = extractEnumOptionsInventory(OBJECT_INFO);
    expect(enums.UpscaleModelLoader?.model_name).toHaveLength(2);
    expect(enums.TripleCLIPLoader?.clip_name3).toHaveLength(2);
    expect(enums.HypernetworkLoader?.model).toBeUndefined();
    expect(enums.RemoteThing).toBeUndefined();
  });
});

describe("model folder listing", () => {
  it("parses only string arrays", () => {
    expect(parseModelFolderListing(["a.pt", 3, "b.safetensors"])).toEqual([
      "a.pt",
      "b.safetensors",
    ]);
    expect(parseModelFolderListing({ nope: true })).toEqual([]);
  });

  it("fetches /models/<folder> and rejects odd folder names", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(["neg.pt"]), { status: 200 }),
    );
    await expect(listComfyModelFolder("embeddings", fetcher)).resolves.toEqual([
      "neg.pt",
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "/models/embeddings",
      expect.any(Object),
    );
    await expect(listComfyModelFolder("../etc", fetcher)).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns [] when ComfyUI errors", async () => {
    const fetcher = vi.fn(async () => new Response("x", { status: 500 }));
    await expect(listComfyModelFolder("embeddings", fetcher)).resolves.toEqual(
      [],
    );
  });
});

/**
 * detectModelFamily(Strict): gated qwen-image-21 / flux3 / moss_image packs
 * resolve to their own family even when their env gate is off; unmatched names
 * are "unknown" (strict) or the default pack (legacy). Plus the callers: LoRA
 * base-mismatch stays quiet for unknown, clip-skip gating stays SD-only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Workflow } from "@/types";

const GATES = ["CJ_QWEN_IMAGE_21", "CJ_FLUX3", "CJ_MOSS_IMAGE", "CJ_DEFAULT_PACK"];

async function load() {
  vi.resetModules();
  const packs = await import("@/lib/oj/packs");
  const gc = await import("@/lib/oj/graphControls");
  const lm = await import("@/lib/loraMetadata");
  return { ...packs, ...gc, ...lm };
}

const WF_DIR = path.join(process.cwd(), "public/workflows");
const t2i = (ckpt: string): Workflow => {
  const wf = JSON.parse(
    fs.readFileSync(path.join(WF_DIR, "t2i.json"), "utf8"),
  ) as Workflow;
  wf["4"].inputs.ckpt_name = ckpt;
  return wf;
};
const unetGraph = (unet: string): Workflow =>
  ({
    "1": { class_type: "UNETLoader", inputs: { unet_name: unet, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "t5.safetensors", type: "flux" } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "x", clip: ["2", 0] } },
    "4": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["6", 0] } },
  }) as unknown as Workflow;

describe("model family detection (gates off)", () => {
  beforeEach(() => {
    for (const g of GATES) vi.stubEnv(g, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["qwen_image_2.1_bf16.safetensors", "qwen-image-21"],
    ["Qwen-Image-21-fp8.safetensors", "qwen-image-21"],
    ["flux3_image_klein_bf16.safetensors", "flux3"],
    ["FLUX.3-dev.safetensors", "flux3"],
    ["moss_image_sft_bf16.safetensors", "moss_image"],
    ["flux1-dev.safetensors", "flux"],
    ["sd_xl_base_1.0.safetensors", "sdxl"],
  ])("%s -> %s", async (name, family) => {
    const { detectModelFamily, detectModelFamilyStrict } = await load();
    expect(detectModelFamilyStrict(name)).toBe(family);
    expect(detectModelFamily(name)).toBe(family);
  });

  it("unmatched: strict says unknown, legacy keeps the default pack", async () => {
    const { detectModelFamily, detectModelFamilyStrict } = await load();
    expect(detectModelFamilyStrict("myMerge_v7.safetensors")).toBe("unknown");
    expect(detectModelFamilyStrict("")).toBe("unknown");
    expect(detectModelFamily("myMerge_v7.safetensors")).toBe("sdxl");
    expect(detectModelFamily("")).toBe("krea2");
  });

  it("LoRA mismatch never fires for an unknown model family", async () => {
    const { loraBaseMismatch, detectModelFamilyStrict } = await load();
    const unknown = detectModelFamilyStrict("myMerge_v7.safetensors");
    expect(loraBaseMismatch("SDXL 1.0", unknown).mismatch).toBe(false);
    expect(loraBaseMismatch("Flux.1 D", unknown).mismatch).toBe(false);
    // Known families still warn / match correctly.
    const flux3 = detectModelFamilyStrict("flux3_image_klein_bf16.safetensors");
    expect(loraBaseMismatch("Flux.1 D", flux3).mismatch).toBe(true);
    expect(loraBaseMismatch("flux-3", flux3).mismatch).toBe(false);
    const qwen = detectModelFamilyStrict("qwen_image_2.1_bf16.safetensors");
    expect(loraBaseMismatch("Qwen-Image", qwen).mismatch).toBe(false);
    expect(loraBaseMismatch("SDXL 1.0", qwen).mismatch).toBe(true);
  });

  it("clip-skip: unknown SD merges keep it, gated families don't", async () => {
    const { getGraphControlSupport } = await load();
    expect(getGraphControlSupport(t2i("myMerge_v7.safetensors"))).toMatchObject({
      family: "sdxl",
      clipSkip: true,
    });
    for (const [ckpt, family] of [
      ["flux3_image_klein_bf16.safetensors", "flux3"],
      ["moss_image_sft_bf16.safetensors", "moss_image"],
      ["qwen_image_2.1_bf16.safetensors", "qwen-image-21"],
    ]) {
      expect(getGraphControlSupport(t2i(ckpt))).toMatchObject({
        family,
        clipSkip: false,
      });
    }
  });

  it("UNET graphs: own family or unknown, never a guessed sdxl", async () => {
    const { getGraphControlSupport } = await load();
    expect(
      getGraphControlSupport(unetGraph("flux3_image_klein_bf16.safetensors")),
    ).toMatchObject({ family: "flux3", clipSkip: false });
    expect(
      getGraphControlSupport(unetGraph("mystery_dit.safetensors")),
    ).toMatchObject({ family: "unknown", clipSkip: false });
  });
});

/**
 * MiniMax H3 pack tests
 * ---------------------
 * H3 graphs are structurally unusual for us:
 *   - prompt lives on MiniMaxH3ImageToVideo (conditioning+latent node), not CLIPTextEncode
 *   - BasicGuider only — no negative conditioning anywhere in the graph
 *   - joint AV latent, dual VAE decode (video + audio) muxed by CreateVideo
 * These tests lock the discovery behavior those quirks depend on.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Workflow } from "@/types";
import { discoverT2ISlots, discoverVideoSlots } from "@/lib/oj/discovery";
import { getPack, resolveWorkflow } from "@/lib/oj/packs";
import { injectParams } from "@/lib/oj/engine";

function loadWorkflow(rel: string): Workflow {
  const p = join(process.cwd(), "public", "workflows", rel);
  return JSON.parse(readFileSync(p, "utf-8")) as Workflow;
}

describe("MiniMax H3 workflow discovery", () => {
  const t2v = loadWorkflow("packs/minimax/t2v.json");
  const i2v = loadWorkflow("packs/minimax/i2v.json");

  it("discovers prompt on the MiniMaxH3ImageToVideo node with input name `prompt`", () => {
    const slots = discoverT2ISlots(t2v);
    expect(slots.posTextId).toBe("5");
    expect(slots.posTextInputName).toBe("prompt");
  });

  it("aliases negative to positive on the guider-only graph (no negative encoder)", () => {
    const slots = discoverT2ISlots(t2v);
    // engine skips negative injection when negTextId === posTextId
    expect(slots.negTextId).toBe(slots.posTextId);
  });

  it("finds latent dims (width/height/length) on the same node", () => {
    const slots = discoverT2ISlots(t2v);
    expect(slots.latentDimsId).toBe("5");
    const latent = t2v[slots.latentDimsId];
    expect(latent.inputs.width).toBe(864);
    expect(latent.inputs.height).toBe(480);
    expect(latent.inputs.length).toBe(73);
  });

  it("discovers custom-sampling slots (RandomNoise seed, BasicScheduler steps)", () => {
    const slots = discoverT2ISlots(t2v);
    expect(slots.customSampling?.noiseId).toBe("8");
    expect(slots.customSampling?.sigmasId).toBe("7");
    expect(slots.customSampling?.guiderId).toBe("9");
  });

  it("discovers the video output chain on both t2v and i2v", () => {
    for (const wf of [t2v, i2v]) {
      const slots = discoverVideoSlots(wf);
      // first video-output-class node in the chain (CreateVideo), per existing convention
      expect(slots.videoOutputId).toBe("13");
    }
  });

  it("i2v routes first_frame from LoadImage into the H3 node", () => {
    const node = i2v["5"];
    expect(node.inputs.first_frame).toEqual(["15", 0]);
    expect(i2v["15"].class_type).toBe("LoadImage");
  });
});

describe("MiniMax H3 pack registration", () => {
  it("is registered with negative/cfg unsupported", () => {
    const pack = getPack("minimax");
    expect(pack).toBeDefined();
    expect(pack!.adapterConfig.supportsNegativePrompt).toBe(false);
    expect(pack!.adapterConfig.supportsCfgScale).toBe(false);
    expect(pack!.defaultOverrides.steps).toBe(20);
  });

  it("resolves t2v/i2v/r2v via explicit packId", () => {
    for (const kind of ["t2v", "i2v", "r2v"] as const) {
      const resolved = resolveWorkflow({
        templateOrAction: kind,
        packId: "minimax",
      });
      expect(resolved.workflowPath).toBe(`packs/minimax/${kind}.json`);
    }
  });

  it("auto-detects the pack from the model filename", () => {
    const resolved = resolveWorkflow({
      templateOrAction: "t2v",
      checkpointName: "minimax_h3_fl2va_pruned_bf16.safetensors",
    });
    expect(resolved.workflowPath).toBe("packs/minimax/t2v.json");
  });
});

describe("MiniMax H3 r2v (reference) workflow", () => {
  const r2v = loadWorkflow("packs/minimax/r2v.json");

  it("discovers prompt + latent dims on the reference node", () => {
    const slots = discoverT2ISlots(r2v);
    expect(slots.posTextId).toBe("5");
    expect(slots.posTextInputName).toBe("prompt");
    expect(slots.latentDimsId).toBe("5");
    expect(slots.negTextId).toBe(slots.posTextId); // guider-only graph
  });

  it("loads the ref2va checkpoint and wires audio VAE + reference image", () => {
    // int8_convrot is what GPU hosts install; MPS hosts fall back to bf16.
    expect(r2v["1"].inputs.unet_name).toBe(
      "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    );
    expect(r2v["5"].class_type).toBe("MiniMaxH3ReferenceToVideo");
    expect(r2v["5"].inputs.audio_vae).toEqual(["4", 0]);
    // V3 Autogrow inputs use dotted container paths in API format, 0-based
    // (ref_images.ref_image_0) even though prompt tags are 1-based (<Picture 1>).
    expect(r2v["5"].inputs["ref_images.ref_image_0"]).toEqual(["15", 0]);
    expect(r2v["15"].class_type).toBe("LoadImage");
  });

  it("discovers the video output chain", () => {
    const slots = discoverVideoSlots(r2v);
    expect(slots.videoOutputId).toBe("13");
  });
});

describe("MiniMax H3 canvas adaptation", () => {
  function injectAt(width: number, height: number) {
    const wf = loadWorkflow("packs/minimax/t2v.json");
    const slots = discoverT2ISlots(wf);
    wf[slots.latentDimsId].inputs.width = width;
    wf[slots.latentDimsId].inputs.height = height;
    injectParams(wf, slots, {}, "test prompt", "", 42);
    return {
      width: wf[slots.latentDimsId].inputs.width,
      height: wf[slots.latentDimsId].inputs.height,
    };
  }

  it("clamps a square 1024x1024 request to the native 768 short edge", () => {
    expect(injectAt(1024, 1024)).toEqual({ width: 768, height: 768 });
  });

  it("keeps the native 16:9 max canvas as-is", () => {
    expect(injectAt(1344, 768)).toEqual({ width: 1344, height: 768 });
  });

  it("does not upscale the MPS-friendly workflow canvas", () => {
    expect(injectAt(864, 480)).toEqual({ width: 864, height: 480 });
  });

  it("keeps portrait 9:16 at the native canvas", () => {
    expect(injectAt(768, 1344)).toEqual({ width: 768, height: 1344 });
  });

  it("maps an oversized 1920x1080 request onto the capped 16:9 canvas", () => {
    expect(injectAt(1920, 1080)).toEqual({ width: 1344, height: 768 });
  });
});

describe("MiniMax H3 clip length", () => {
  function lengthFor(rel: string, params: Record<string, unknown>) {
    const wf = loadWorkflow(rel);
    const slots = discoverT2ISlots(wf);
    injectParams(wf, slots, params, "test prompt", "", 42);
    return wf[slots.latentDimsId].inputs.length;
  }

  it("defaults t2v/i2v/r2v to 73 frames (~3 s on the 17k+5 grid)", () => {
    for (const rel of ["t2v", "i2v", "r2v"])
      expect(lengthFor(`packs/minimax/${rel}.json`, {})).toBe(73);
  });

  it("keeps the 22-frame preview as the Draft tier", () => {
    expect(lengthFor("packs/minimax/t2v.json", { speedTier: "draft" })).toBe(
      22,
    );
    expect(lengthFor("packs/minimax/r2v.json", { speedTier: "draft" })).toBe(
      22,
    );
  });

  it("an explicit --bs / --motion wins over the Draft tier", () => {
    expect(
      lengthFor("packs/minimax/t2v.json", { speedTier: "draft", bs: 124 }),
    ).toBe(124);
    expect(
      lengthFor("packs/minimax/i2v.json", {
        speedTier: "draft",
        motion: "low",
      }),
    ).toBe(49);
  });

  it("the Quality tier keeps the pack length", () => {
    expect(lengthFor("packs/minimax/t2v.json", { speedTier: "quality" })).toBe(
      73,
    );
  });
});

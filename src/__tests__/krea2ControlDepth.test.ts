/**
 * Krea 2 ControlNet auto-depth: packs/krea2/controlnet.json estimates depth
 * in-graph with core Depth Anything 3 unless the control image already is a
 * depth map (grayscale, or --cn-depthmap).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import {
  applyKrea2ControlStrength,
  bypassKrea2DepthEstimator,
  hasKrea2DepthEstimator,
  isGrayscalePixels,
  isKrea2ControlGraph,
  krea2ControlImageLoaderId,
  looksLikeDepthMap,
  pickKrea2ControlImageUrl,
  wireKrea2ControlImage,
} from "@/lib/oj/krea2ControlDepth";
import { parseImagineInput } from "@/lib/oj/parser";
import { resolveWorkflow } from "@/lib/oj/packs";
import type { ImageAttachment, Workflow } from "@/types";

const PACK = "packs/krea2/controlnet.json";

function load(): Workflow {
  return JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "public", "workflows", PACK),
      "utf-8",
    ),
  );
}

function refsOf(wf: Workflow): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  for (const [id, n] of Object.entries(wf)) {
    for (const [k, v] of Object.entries(n.inputs ?? {})) {
      if (Array.isArray(v) && v.length === 2 && typeof v[1] === "number") {
        out.push([id, k, String(v[0])]);
      }
    }
  }
  return out;
}

function dangling(wf: Workflow): string[] {
  return refsOf(wf)
    .filter(([, , src]) => !wf[src])
    .map(([id, k, src]) => `${id}.${k}->${src}`);
}

describe("krea2 controlnet pack graph", () => {
  it("is the krea2 controlnet action", () => {
    expect(resolveWorkflow({ packId: "krea2", templateOrAction: "controlnet" })
        .workflowPath).toBe(
      PACK,
    );
  });

  it("wires LoadImage -> DA3 depth -> Krea2ControlImageEncode", () => {
    const wf = load();
    expect(isKrea2ControlGraph(wf)).toBe(true);
    expect(dangling(wf)).toEqual([]);
    const enc = Object.values(wf).find(
      (n) => n.class_type === "Krea2ControlImageEncode",
    )!;
    const renderId = String((enc.inputs.control_image as [string, number])[0]);
    expect(wf[renderId].class_type).toBe("DA3Render");
    expect(wf[renderId].inputs.output).toBe("depth");
    const infId = String(
      (wf[renderId].inputs.da3_geometry as [string, number])[0],
    );
    expect(wf[infId].class_type).toBe("DA3Inference");
    expect(wf[infId].inputs.mode).toBe("mono");
    const modelId = String((wf[infId].inputs.da3_model as [string, number])[0]);
    expect(wf[modelId].class_type).toBe("LoadDA3Model");
    expect(wf[modelId].inputs.model_name).toBe(
      "depth_anything_3_base.safetensors",
    );
    const loaderId = String((wf[infId].inputs.image as [string, number])[0]);
    expect(wf[loaderId].class_type).toBe("LoadImage");
    expect(krea2ControlImageLoaderId(wf)).toBe(loaderId);
    expect(hasKrea2DepthEstimator(wf)).toBe(true);
    // No comfyui_controlnet_aux preprocessors.
    expect(
      Object.values(wf).some((n) => /Preprocessor/.test(n.class_type)),
    ).toBe(false);
  });

  it("validates against live object_info when available", () => {
    const oiPath = process.env.LIVE_OBJECT_INFO;
    if (!oiPath || !fs.existsSync(oiPath)) return;
    const oi = JSON.parse(fs.readFileSync(oiPath, "utf-8")) as Record<
      string,
      { input?: { required?: Record<string, unknown[]> } }
    >;
    const wf = load();
    for (const n of Object.values(wf)) expect(oi[n.class_type]).toBeDefined();
    const da3 = oi.LoadDA3Model.input!.required!.model_name as [
      string,
      { options: string[] },
    ];
    expect(da3[1].options).toContain("depth_anything_3_base.safetensors");
    const lora = oi.Krea2ControlLoRALoader.input!.required!.lora_name as [
      string[],
    ];
    expect(lora[0]).toContain(
      "krea2_control/krea2_depth_control_lora.safetensors",
    );
  });
});

describe("bypassKrea2DepthEstimator", () => {
  it("feeds the LoadImage straight into the encoder and drops DA3 nodes", () => {
    const wf = load();
    const loaderId = krea2ControlImageLoaderId(wf)!;
    expect(bypassKrea2DepthEstimator(wf)).toBe(true);
    const enc = Object.values(wf).find(
      (n) => n.class_type === "Krea2ControlImageEncode",
    )!;
    expect(enc.inputs.control_image).toEqual([loaderId, 0]);
    expect(
      Object.values(wf).some((n) =>
        /^(LoadDA3Model|DA3Inference|DA3Render)$/.test(n.class_type),
      ),
    ).toBe(false);
    expect(dangling(wf)).toEqual([]);
    expect(hasKrea2DepthEstimator(wf)).toBe(false);
    expect(krea2ControlImageLoaderId(wf)).toBe(loaderId);
    // idempotent
    expect(bypassKrea2DepthEstimator(wf)).toBe(false);
  });

  it("keeps an estimator node something else still consumes", () => {
    const wf = load();
    const renderId = Object.keys(wf).find(
      (id) => wf[id].class_type === "DA3Render",
    )!;
    wf["99"] = {
      class_type: "PreviewImage",
      inputs: { images: [renderId, 0] },
    };
    bypassKrea2DepthEstimator(wf);
    expect(wf[renderId]).toBeDefined();
    expect(dangling(wf)).toEqual([]);
  });
});

describe("wireKrea2ControlImage", () => {
  it("normal image: sets LoadImage, keeps auto depth", () => {
    const wf = load();
    const r = wireKrea2ControlImage(wf, "cn_x.png", { looksDepth: false });
    expect(r.estimateDepth).toBe(true);
    expect(wf[krea2ControlImageLoaderId(wf)!].inputs.image).toBe("cn_x.png");
  });

  it("grayscale image: skips estimation", () => {
    const wf = load();
    const r = wireKrea2ControlImage(wf, "d.png", { looksDepth: true });
    expect(r.estimateDepth).toBe(false);
    expect(wf[krea2ControlImageLoaderId(wf)!].inputs.image).toBe("d.png");
  });

  it("--cn-depthmap marks depth; explicit false keeps estimation", () => {
    const parsed = parseImagineInput("a cat --controlnet depth --cn-depthmap");
    expect(parsed.params["cn-depthmap"]).toBeTruthy();
    const wf = load();
    expect(
      wireKrea2ControlImage(wf, "d.png", {
        markedDepth: parsed.params["cn-depthmap"],
        looksDepth: false,
      }).estimateDepth,
    ).toBe(false);
    const wf2 = load();
    expect(
      wireKrea2ControlImage(wf2, "d.png", { markedDepth: "false" })
        .estimateDepth,
    ).toBe(true);
  });

  it("throws on a graph with no control LoadImage", () => {
    expect(() => wireKrea2ControlImage({}, "x.png", {})).toThrow();
  });
});

describe("applyKrea2ControlStrength", () => {
  it("sets and clamps the control LoRA strength", () => {
    const wf = load();
    const id = Object.keys(wf).find(
      (k) => wf[k].class_type === "Krea2ControlLoRALoader",
    )!;
    applyKrea2ControlStrength(wf, 0.6);
    expect(wf[id].inputs.strength).toBe(0.6);
    applyKrea2ControlStrength(wf, 9);
    expect(wf[id].inputs.strength).toBe(2);
    applyKrea2ControlStrength(wf, undefined);
    expect(wf[id].inputs.strength).toBe(2);
  });
});

describe("pickKrea2ControlImageUrl", () => {
  const att = (
    mode: ImageAttachment["mode"],
    url: string,
  ): ImageAttachment => ({
    id: mode,
    url,
    mode,
    weight: 1,
  });
  it("prefers the Control attachment, then --cn-image", () => {
    expect(
      pickKrea2ControlImageUrl({ "cn-image": "https://e.test/b.png" }, [
        att("image_prompt", "data:image/png;base64,AA"),
        att("control", "data:image/png;base64,BB"),
      ]),
    ).toBe("data:image/png;base64,BB");
    expect(
      pickKrea2ControlImageUrl({ "cn-image": "https://e.test/b.png" }, [
        att("image_prompt", "data:image/png;base64,AA"),
      ]),
    ).toBe("https://e.test/b.png");
    expect(
      pickKrea2ControlImageUrl({ "cn-image": "nope" }, undefined),
    ).toBeUndefined();
  });
});

describe("depth-map detection", () => {
  it("isGrayscalePixels", () => {
    expect(isGrayscalePixels(new Uint8Array([10, 200]), 1)).toBe(true);
    expect(
      isGrayscalePixels(new Uint8Array([10, 12, 9, 200, 200, 201]), 3),
    ).toBe(true);
    expect(
      isGrayscalePixels(new Uint8Array([10, 120, 9, 200, 200, 201]), 3),
    ).toBe(false);
    expect(isGrayscalePixels(new Uint8Array([]), 3)).toBe(false);
  });

  it("single-channel and gray RGB count as depth, color does not", async () => {
    const gradient = Buffer.alloc(32 * 32);
    for (let i = 0; i < gradient.length; i++) gradient[i] = i % 256;
    const gray1 = await sharp(gradient, {
      raw: { width: 32, height: 32, channels: 1 },
    })
      .png()
      .toBuffer();
    expect(await looksLikeDepthMap(gray1)).toBe(true);

    const rgbGray = Buffer.alloc(32 * 32 * 3);
    for (let i = 0; i < 32 * 32; i++) rgbGray.fill(i % 256, i * 3, i * 3 + 3);
    const grayRgb = await sharp(rgbGray, {
      raw: { width: 32, height: 32, channels: 3 },
    })
      .png()
      .toBuffer();
    expect(await looksLikeDepthMap(grayRgb)).toBe(true);

    const color = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: { r: 200, g: 40, b: 90 },
      },
    })
      .png()
      .toBuffer();
    expect(await looksLikeDepthMap(color)).toBe(false);
    expect(await looksLikeDepthMap(Buffer.from("not an image"))).toBe(false);
  });
});

/**
 * --clipskip / tiled VAE decode: graph snapshots per family, family gating,
 * auto thresholds, parser flags, and the settings -> flags bridge.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  applyGraphControls,
  detectWorkflowFamily,
  estimateDecodePixels,
  getGraphControlSupport,
  graphControlFlagsFromSettings,
  resolveTiledVae,
  DEFAULT_TILED_VAE_AUTO_PIXELS,
} from "@/lib/oj/graphControls";
import { injectParams } from "@/lib/oj/engine";
import { discoverT2ISlots } from "@/lib/oj/discovery";
import { parseImagineInput } from "@/lib/oj/parser";
import type { Workflow } from "@/types";

const WF_DIR = path.join(process.cwd(), "public/workflows");
const load = (rel: string): Workflow =>
  JSON.parse(fs.readFileSync(path.join(WF_DIR, rel), "utf8")) as Workflow;

/** SD t2i.json with a named checkpoint. */
const sdGraph = (ckpt: string): Workflow => {
  const wf = load("t2i.json");
  wf["4"].inputs.ckpt_name = ckpt;
  return wf;
};

/** Only the nodes these controls touch, for compact snapshots. */
const controlView = (wf: Workflow) =>
  Object.fromEntries(
    Object.entries(wf).filter(([, n]) =>
      /CLIPSetLastLayer|VAEDecode|CLIPTextEncode|LoraLoader$/.test(
        n.class_type,
      ),
    ),
  );

const fluxGraph = (): Workflow => ({
  "1": {
    class_type: "UNETLoader",
    inputs: { unet_name: "flux1-dev-fp8.safetensors", weight_dtype: "default" },
  },
  "2": {
    class_type: "DualCLIPLoader",
    inputs: {
      clip_name1: "clip_l.safetensors",
      clip_name2: "t5xxl_fp16.safetensors",
      type: "flux",
    },
  },
  "3": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
  "4": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["2", 0] } },
  "5": {
    class_type: "EmptySD3LatentImage",
    inputs: { width: 1024, height: 1024, batch_size: 1 },
  },
  "6": {
    class_type: "KSampler",
    inputs: {
      model: ["1", 0],
      positive: ["4", 0],
      negative: ["4", 0],
      latent_image: ["5", 0],
      seed: 0,
      steps: 20,
      cfg: 1,
      sampler_name: "euler",
      scheduler: "simple",
      denoise: 1,
    },
  },
  "7": {
    class_type: "VAEDecode",
    inputs: { samples: ["6", 0], vae: ["3", 0] },
  },
  "8": {
    class_type: "SaveImage",
    inputs: { images: ["7", 0], filename_prefix: "x" },
  },
});

afterEach(() => {
  delete process.env.CJ_LOW_VRAM;
  delete process.env.CJ_TILED_VAE_AUTO_PIXELS;
});

describe("family detection + gating", () => {
  it.each([
    ["sd_xl_base_1.0.safetensors", "sdxl", true],
    ["sd15_dreamshaper_8.safetensors", "sd15", true],
    ["ponyDiffusionV6XL.safetensors", "pony", true],
    ["illustriousXL_v01.safetensors", "illustrious", true],
    ["flux1-dev-fp8.safetensors", "flux", false],
    ["ltxv-2b-0.9.8-distilled.safetensors", "ltxv", false],
  ])("checkpoint %s -> %s, clipSkip=%s", (ckpt, family, clip) => {
    const support = getGraphControlSupport(sdGraph(ckpt));
    expect(support.family).toBe(family);
    expect(support.clipSkip).toBe(clip);
  });

  it("shipped packs: clip skip off, tiled VAE only where valid", () => {
    const cases: Array<[string, string, boolean]> = [
      ["packs/krea2/t2i.json", "krea2", true],
      // pack is env-gated (CJ_QWEN_IMAGE_21) -> family may fall back to the
      // default; UNETLoader structure still blocks clip skip.
      ["packs/qwen-image-21/t2i.json", "", true],
      ["packs/flux3/t2i.json", "", true], // generic flux pattern wins; both non-CLIP-skip
      ["packs/moss-image/t2i.json", "", true], // env-gated pack
      ["packs/wan/t2v.json", "wan", true],
      ["packs/ltxv/t2v.json", "ltxv", true],
      ["packs/minimax/t2v.json", "minimax", false],
    ];
    for (const [rel, family, tiled] of cases) {
      const s = getGraphControlSupport(load(rel));
      if (family) expect([rel, s.family]).toEqual([rel, family]);
      expect([rel, s.clipSkip]).toEqual([rel, false]);
      expect([rel, s.tiledVae]).toEqual([rel, tiled]);
    }
  });

  it("flux checkpoint-less UNET graph: no clip skip even with CLIPTextEncode", () => {
    const s = getGraphControlSupport(fluxGraph());
    expect(s).toMatchObject({
      family: "flux",
      clipSkip: false,
      tiledVae: true,
    });
  });

  it("remote/API node graphs get nothing", () => {
    const s = getGraphControlSupport(sdGraph("sd_xl_base_1.0.safetensors"), {
      apiNode: true,
    });
    expect(s.clipSkip).toBe(false);
    expect(s.tiledVae).toBe(false);
  });

  it("unnamed SD checkpoint falls back to the default pack family", () => {
    expect(detectWorkflowFamily(load("t2i.json")).family).toBe("sdxl");
  });
});

describe("graph snapshots", () => {
  it("SDXL baseline (no flags) is untouched", () => {
    const wf = sdGraph("sd_xl_base_1.0.safetensors");
    const before = JSON.stringify(wf);
    const r = applyGraphControls(wf, {});
    expect(JSON.stringify(wf)).toBe(before);
    expect(r.clipSkipApplied).toBeUndefined();
    expect(r.tiledVae).toBeUndefined();
  });

  it("SDXL --clipskip 2", () => {
    const wf = sdGraph("sd_xl_base_1.0.safetensors");
    const r = applyGraphControls(wf, { clipskip: 2 });
    expect(r.clipSkipApplied).toBe(2);
    expect(controlView(wf)).toMatchSnapshot();
    expect(wf["6"].inputs.clip).toEqual(["cj_clip_skip_4", 0]);
    expect(wf["7"].inputs.clip).toEqual(["cj_clip_skip_4", 0]);
  });

  it("SD1.5 --clipskip 2 --tiledvae", () => {
    const wf = sdGraph("sd15_dreamshaper_8.safetensors");
    applyGraphControls(wf, { clipskip: 2, tiledvae: true });
    expect(controlView(wf)).toMatchSnapshot();
  });

  it("clip skip rewires through a LoraLoader chain", () => {
    const wf = sdGraph("ponyDiffusionV6XL.safetensors");
    wf["20"] = {
      class_type: "LoraLoader",
      inputs: {
        model: ["4", 0],
        clip: ["4", 1],
        lora_name: "x.safetensors",
        strength_model: 1,
        strength_clip: 1,
      },
    };
    wf["6"].inputs.clip = ["20", 1];
    wf["7"].inputs.clip = ["20", 1];
    applyGraphControls(wf, { clipskip: 2 });
    expect(wf["20"].inputs.clip).toEqual(["cj_clip_skip_4", 0]);
    expect(wf["6"].inputs.clip).toEqual(["20", 1]);
    expect(wf["cj_clip_skip_4"].inputs).toEqual({
      clip: ["4", 1],
      stop_at_clip_layer: -2,
    });
  });

  it("existing CLIPSetLastLayer is updated, not duplicated", () => {
    const wf = sdGraph("sd_xl_base_1.0.safetensors");
    wf["30"] = {
      class_type: "CLIPSetLastLayer",
      inputs: { clip: ["4", 1], stop_at_clip_layer: -1 },
    };
    wf["6"].inputs.clip = ["30", 0];
    wf["7"].inputs.clip = ["30", 0];
    applyGraphControls(wf, { clipskip: 3 });
    expect(wf["30"].inputs.stop_at_clip_layer).toBe(-3);
    expect(
      Object.values(wf).filter((n) => n.class_type === "CLIPSetLastLayer"),
    ).toHaveLength(1);
  });

  it("--clipskip 1 is a no-op without an existing node", () => {
    const wf = sdGraph("sd_xl_base_1.0.safetensors");
    applyGraphControls(wf, { clipskip: 1 });
    expect(wf["cj_clip_skip_4"]).toBeUndefined();
  });

  it("Krea2 --clipskip 2 --tiledvae: clip skip ignored, decode tiled", () => {
    const wf = load("packs/krea2/t2i.json");
    const r = applyGraphControls(wf, { clipskip: 2, tiledvae: true });
    expect(r.clipSkipApplied).toBeUndefined();
    expect(
      Object.values(wf).some((n) => n.class_type === "CLIPSetLastLayer"),
    ).toBe(false);
    expect(controlView(wf)).toMatchSnapshot();
  });

  it("Flux --tilesize 1024 (implies tiled)", () => {
    const wf = fluxGraph();
    const r = applyGraphControls(wf, { clipskip: 2, vaetile: 1024 });
    expect(r.tiledVae).toEqual({
      reason: "manual",
      tileSize: 1024,
      nodeIds: ["7"],
    });
    expect(wf["7"]).toMatchSnapshot();
  });

  it("MiniMax H3: tiled VAE never applied, even forced", () => {
    const wf = load("packs/minimax/t2v.json");
    const before = JSON.stringify(wf);
    applyGraphControls(wf, { tiledvae: true, lowvram: true });
    expect(JSON.stringify(wf)).toBe(before);
  });
});

describe("tiled VAE auto thresholds", () => {
  it("resolveTiledVae precedence: off > manual > lowvram > pixels", () => {
    const big = DEFAULT_TILED_VAE_AUTO_PIXELS;
    expect(resolveTiledVae({}, big - 1)).toBeUndefined();
    expect(resolveTiledVae({}, big)).toBe("pixels");
    expect(resolveTiledVae({ lowvram: true }, 0)).toBe("lowvram");
    expect(resolveTiledVae({}, 0, { lowVram: true })).toBe("lowvram");
    expect(resolveTiledVae({ tiledvae: true }, 0)).toBe("manual");
    expect(resolveTiledVae({ notiledvae: true, tiledvae: true }, big)).toBe(
      undefined,
    );
    expect(resolveTiledVae({ notiledvae: true, lowvram: true }, big)).toBe(
      undefined,
    );
  });

  it("1024² SDXL stays untiled; 2048² auto-tiles", () => {
    const small = sdGraph("sd_xl_base_1.0.safetensors");
    expect(applyGraphControls(small, {}).tiledVae).toBeUndefined();
    const big = sdGraph("sd_xl_base_1.0.safetensors");
    big["5"].inputs.width = 2048;
    big["5"].inputs.height = 2048;
    expect(applyGraphControls(big, {}).tiledVae?.reason).toBe("pixels");
    expect(big["8"].class_type).toBe("VAEDecodeTiled");
  });

  it("CJ_LOW_VRAM=1 and CJ_TILED_VAE_AUTO_PIXELS env", () => {
    process.env.CJ_LOW_VRAM = "1";
    const a = sdGraph("sd_xl_base_1.0.safetensors");
    expect(applyGraphControls(a, {}).tiledVae?.reason).toBe("lowvram");
    delete process.env.CJ_LOW_VRAM;
    process.env.CJ_TILED_VAE_AUTO_PIXELS = String(1024 * 1024);
    const b = sdGraph("sd_xl_base_1.0.safetensors");
    expect(applyGraphControls(b, {}).tiledVae?.reason).toBe("pixels");
  });

  it("pixel estimate ignores CLIPTextEncodeSDXL conditioning sizes", () => {
    const wf = sdGraph("sd_xl_base_1.0.safetensors");
    wf["40"] = {
      class_type: "CLIPTextEncodeSDXL",
      inputs: { width: 4096, height: 4096, target_width: 4096 },
    };
    expect(estimateDecodePixels(wf)).toBe(1024 * 1024);
  });

  it("pixel estimate follows megapixels and LatentUpscaleBy", () => {
    expect(
      estimateDecodePixels({
        a: { class_type: "ImageScaleToTotalPixels", inputs: { megapixels: 2 } },
      }),
    ).toBe(2 * 1024 * 1024);
    expect(
      estimateDecodePixels({
        a: {
          class_type: "EmptyLatentImage",
          inputs: { width: 1024, height: 1024 },
        },
        b: { class_type: "LatentUpscaleBy", inputs: { scale_by: 2 } },
      }),
    ).toBe(4 * 1024 * 1024);
  });
});

describe("parser + injectParams integration", () => {
  it("parses the new flags", () => {
    const r = parseImagineInput(
      "a cat --clipskip 2 --tiledvae --tilesize 768 --lowvram --tiledvae-off",
    );
    expect(r.errors).toEqual([]);
    expect(r.unknownFlags).toEqual([]);
    expect(r.prompt).toBe("a cat");
    expect(r.params).toMatchObject({
      clipskip: 2,
      tiledvae: true,
      vaetile: 768,
      lowvram: true,
      notiledvae: true,
    });
  });

  it("rejects out-of-range clip skip / tile size", () => {
    expect(parseImagineInput("x --clipskip 0").errors).toHaveLength(1);
    expect(parseImagineInput("x --tilesize 64").errors).toHaveLength(1);
  });

  it("injectParams applies clip skip + --hd-free auto tiling on SDXL t2i", () => {
    const wf = load("t2i.json");
    const slots = discoverT2ISlots(wf);
    const { params } = parseImagineInput(
      "a cat --model sd_xl_base_1.0.safetensors --clipskip 2 --ar 1:1 --tiledvae",
    );
    injectParams(wf, slots, params, "a cat", "", 1);
    expect(wf["cj_clip_skip_4"]?.class_type).toBe("CLIPSetLastLayer");
    expect(wf["8"].class_type).toBe("VAEDecodeTiled");
  });

  it("injectParams on a native Krea2 graph ignores --clipskip", () => {
    const wf = load("packs/krea2/t2i.json");
    const slots = discoverT2ISlots(wf);
    injectParams(wf, slots, { clipskip: 2 }, "a cat", "", 1);
    expect(
      Object.values(wf).some((n) => n.class_type === "CLIPSetLastLayer"),
    ).toBe(false);
  });
});

describe("settings -> flags", () => {
  it("emits defaults only when the prompt has none", () => {
    expect(graphControlFlagsFromSettings({}, "a")).toEqual([]);
    expect(
      graphControlFlagsFromSettings({ clipSkip: 2, tiledVae: "on" }, "a"),
    ).toEqual(["--clipskip 2", "--tiledvae"]);
    expect(graphControlFlagsFromSettings({ tiledVae: "off" }, "a")).toEqual([
      "--tiledvae-off",
    ]);
    expect(
      graphControlFlagsFromSettings(
        { clipSkip: 2, tiledVae: "on" },
        "a --clip-skip 3 --tiledvae-off",
      ),
    ).toEqual([]);
    expect(graphControlFlagsFromSettings({ clipSkip: 1 }, "a")).toEqual([]);
  });
});

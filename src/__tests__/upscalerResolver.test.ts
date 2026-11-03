/**
 * Upscaler of choice: catalog, preference merge/resolution, and the
 * submit-time graph resolver (per-type choice, missing-model fallback,
 * fixed overrides, size preservation). Nothing is queued.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import type { ImagineRun, Workflow } from "@/types";
import {
  DEFAULT_CHAINS,
  canBeDefault,
  describeUpscaler,
  matchesStem,
} from "@/lib/upscale/upscalerCatalog";
import {
  contentFromModelNames,
  mergeUpscalerPref,
  resolveAllDefaults,
  resolveDefaultModel,
  sanitizeUpscalerPref,
  upscalerPatchError,
} from "@/lib/upscale/upscalerPref";
import {
  graphUpscaleContent,
  resolveGraphUpscalers,
} from "@/lib/upscale/resolveUpscalers";
import { liveUpscalerFiles } from "@/lib/upscale/applyUpscalerPref";
import {
  buildUpscaleCreativeWorkflow,
  buildUpscaleSubtleWorkflow,
} from "@/lib/oj/upscaleBuilder";
import { upscaleModelScale } from "@/lib/upscale/upscaleModels";

/** The GPU box's upscale_models listing. */
const LIVE = [
  "1x-Kim2091-DeJpeg-v0.pth",
  "1x_GainRESV3_Natural.pth",
  "2xSudo_shuffle_cugan_9.584.969.pth",
  "4X_KCJPUNK_1.0_233089_G.pth",
  "4x-AnimeSharp.pth",
  "4x-UltraMix_Balanced.pth",
  "4x-UltraSharp.pth",
  "4x_NMKD-Siax_200k.pth",
  "4x_NickelbackFS_72000_G.pth",
  "4x_Nickelback_70000G.pth",
  "4x_UniversalUpscalerV2-Neutral_115000_swaG.pth",
  "4x_foolhardy_Remacri.pth",
  "8x_NMKD-Faces_160000_G.pth",
  "GFPGANv1.4.pth",
  "OmniSR-Helaman-HFA2k-2x.pth",
  "RealESRGAN_x2plus.pth",
  "RealESRGAN_x4plus.pth",
  "RealESRGAN_x4plus_anime_6B.pth",
  "lollypop.pth",
  "x1_ITF_SkinDiffDetail_Lite_v1.pth",
];
/** A fresh install: only the starter pack's model. */
const STARTER = ["RealESRGAN_x4plus.pth"];

const load = (rel: string): Workflow =>
  JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "public/workflows", rel), "utf-8"),
  );

type G = Record<
  string,
  {
    class_type: string;
    inputs: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }
>;

const loaderModel = (g: object, id: string) => (g as G)[id].inputs.model_name;

function graph(
  model: string,
  meta?: Record<string, unknown>,
  extra: G = {},
): G {
  return {
    "1": { class_type: "LoadImage", inputs: { image: "a.png" } },
    "2": {
      class_type: "UpscaleModelLoader",
      inputs: { model_name: model },
      ...(meta ? { _meta: meta } : {}),
    },
    "3": {
      class_type: "ImageUpscaleWithModel",
      inputs: { image: ["1", 0], upscale_model: ["2", 0] },
    },
    "4": { class_type: "SaveImage", inputs: { images: ["3", 0] } },
    ...extra,
  };
}

describe("upscaler catalog", () => {
  it("matches stems through extensions and training suffixes", () => {
    expect(describeUpscaler("4x_NickelbackFS_72000_G.pth", null).name).toBe(
      "Nickelback FS",
    );
    expect(describeUpscaler("4x_Nickelback_70000G.pth", null).name).toBe(
      "Nickelback",
    );
    expect(describeUpscaler("sub/4x-UltraSharp.safetensors", 4)).toMatchObject({
      name: "UltraSharp",
      category: "photo",
      tags: ["sharp"],
    });
    expect(matchesStem("4xLSDIRplus.pth", "4xlsdir")).toBe(false);
    expect(matchesStem("4x_NMKD-Siax_200k.pth", "4x_nmkd-siax_200k")).toBe(
      true,
    );
  });

  it("categorises every listed model sensibly", () => {
    const cat = (f: string) =>
      describeUpscaler(f, upscaleModelScale(f)).category;
    expect(cat("1x-Kim2091-DeJpeg-v0.pth")).toBe("cleanup");
    expect(cat("x1_ITF_SkinDiffDetail_Lite_v1.pth")).toBe("cleanup");
    expect(cat("2xSudo_shuffle_cugan_9.584.969.pth")).toBe("2x");
    expect(cat("4x-AnimeSharp.pth")).toBe("illustration");
    expect(cat("8x_NMKD-Faces_160000_G.pth")).toBe("faces");
    expect(cat("lollypop.pth")).toBe("photo");
    expect(describeUpscaler("lollypop.pth", null).scale).toBe(4);
  });

  it("classifies unknown files by name", () => {
    expect(describeUpscaler("2x_Mystery.pth", 2).category).toBe("2x");
    expect(describeUpscaler("4x_SomeAnime.pth", 4)).toMatchObject({
      category: "illustration",
      tags: ["anime"],
    });
    expect(describeUpscaler("4x_Mystery.pth", 4).category).toBe("photo");
  });

  it("defaults exclude cleanup and face models", () => {
    expect(canBeDefault({ category: "cleanup", scale: 1 })).toBe(false);
    expect(canBeDefault({ category: "faces", scale: 8 })).toBe(false);
    expect(canBeDefault({ category: "2x", scale: 2 })).toBe(true);
    for (const chain of Object.values(DEFAULT_CHAINS)) {
      expect(chain.length).toBeGreaterThan(0);
    }
  });
});

describe("upscaler preference", () => {
  it("sanitizes and drops junk", () => {
    expect(sanitizeUpscalerPref(null)).toBeNull();
    expect(sanitizeUpscalerPref({})).toBeNull();
    expect(
      sanitizeUpscalerPref({
        photo: "4x-UltraSharp.pth",
        illustration: "../x.pth",
        video: 3,
        scale: 3,
        lock: true,
        extra: 1,
      }),
    ).toEqual({ photo: "4x-UltraSharp.pth" });
    expect(sanitizeUpscalerPref({ scale: 2, lock: false })).toEqual({
      scale: 2,
      lock: false,
    });
  });

  it("merges PUT patches (null clears, lock true is the default)", () => {
    const a = mergeUpscalerPref(null, {
      photo: "4x-UltraSharp.pth",
      lock: false,
    });
    expect(a).toEqual({ photo: "4x-UltraSharp.pth", lock: false });
    const b = mergeUpscalerPref(a, {
      illustration: "4x-AnimeSharp.pth",
      lock: true,
    });
    expect(b).toEqual({
      photo: "4x-UltraSharp.pth",
      illustration: "4x-AnimeSharp.pth",
    });
    expect(mergeUpscalerPref(b, { photo: null, illustration: "" })).toBeNull();
    expect(mergeUpscalerPref({ scale: 4 }, { scale: null })).toBeNull();
  });

  it("validates patches", () => {
    expect(upscalerPatchError({ photo: "4x-UltraSharp.pth", scale: 2 })).toBe(
      "",
    );
    expect(upscalerPatchError({ photo: null, lock: true })).toBe("");
    expect(upscalerPatchError({ photo: "/etc/x.pth" })).toMatch(/photo/);
    expect(upscalerPatchError({ scale: 3 })).toMatch(/scale/);
    expect(upscalerPatchError({ lock: "yes" })).toMatch(/lock/);
    expect(
      upscalerPatchError({ photo: "1x-Kim2091-DeJpeg-v0.pth" }),
    ).toMatch(/photo/);
    expect(upscalerPatchError({ video: "8x_NMKD-Faces_160000_G.pth" })).toMatch(
      /video/,
    );
  });

  it("resolves the table per content type", () => {
    expect(resolveAllDefaults(null, LIVE)).toEqual({
      photo: { file: "4x-UltraSharp.pth", source: "table" },
      illustration: { file: "4x-AnimeSharp.pth", source: "table" },
      video: { file: "RealESRGAN_x4plus.pth", source: "table" },
    });
  });

  it("prefers Nomos2 DAT2 for photos once it is installed", () => {
    const live = [
      ...LIVE,
      "4xNomos2_hq_dat2.pth",
      "4xNomos2_hq_mosr.pth",
      "4xRealWebPhoto_v4_drct-l.pth",
    ];
    expect(resolveAllDefaults(null, live)).toEqual({
      photo: { file: "4xNomos2_hq_dat2.pth", source: "table" },
      illustration: { file: "4x-AnimeSharp.pth", source: "table" },
      video: { file: "RealESRGAN_x4plus.pth", source: "table" },
    });
    expect(
      resolveDefaultModel(
        "photo",
        null,
        live.filter((f) => !/dat2/.test(f)),
      )?.file,
    ).toBe("4xNomos2_hq_mosr.pth");
    expect(
      resolveDefaultModel(
        "illustration",
        null,
        live.filter((f) => !/AnimeSharp/.test(f)),
      )?.file,
    ).toBe("4xNomos2_hq_dat2.pth");
    expect(describeUpscaler("4xNomos2_hq_dat2.pth", 4)).toMatchObject({
      name: "Nomos2 DAT2",
      category: "photo",
    });
    expect(describeUpscaler("4xRealWebPhoto_v4_drct-l.pth", 4).tags).toContain(
      "slow",
    );
    expect(describeUpscaler("1xDeH264_realplksr.safetensors", 1).category).toBe(
      "cleanup",
    );
  });

  it("walks the chain when the first choice is missing", () => {
    const live = LIVE.filter((f) => !/UltraSharp|AnimeSharp/.test(f));
    expect(resolveDefaultModel("photo", null, live)?.file).toBe(
      "4x_NMKD-Siax_200k.pth",
    );
    expect(resolveDefaultModel("illustration", null, live)?.file).toBe(
      "RealESRGAN_x4plus_anime_6B.pth",
    );
    expect(resolveDefaultModel("photo", null, [])).toBeNull();
  });

  it("uses the user's choice when installed, by stem across extensions", () => {
    const pref = { photo: "4x_foolhardy_Remacri.pt" };
    expect(resolveDefaultModel("photo", pref, LIVE)).toEqual({
      file: "4x_foolhardy_Remacri.pth",
      source: "choice",
    });
    expect(
      resolveDefaultModel("photo", { photo: "nope_4x.pth" }, LIVE),
    ).toEqual({
      file: "4x-UltraSharp.pth",
      source: "table",
    });
  });

  it("never resolves to a cleanup or face model", () => {
    expect(
      resolveDefaultModel("photo", { photo: "1x-Kim2091-DeJpeg-v0.pth" }, LIVE)
        ?.source,
    ).toBe("table");
    expect(
      resolveDefaultModel(
        "photo",
        { photo: "8x_NMKD-Faces_160000_G.pth" },
        LIVE,
      )?.source,
    ).toBe("table");
  });

  it("detects illustration sources from model names", () => {
    expect(contentFromModelNames(["illustriousXL_v20.safetensors"])).toBe(
      "illustration",
    );
    expect(contentFromModelNames([undefined, "flux1-dev.safetensors"])).toBe(
      "photo",
    );
  });
});

describe("resolveGraphUpscalers", () => {
  it("is a no-op without a live list or a loader", () => {
    const g = graph("RealESRGAN_x4plus.pth");
    const r = resolveGraphUpscalers(g, { pref: null, live: null });
    expect(r.prompt).toBe(g);
    const plain = { "1": { class_type: "SaveImage", inputs: {} } };
    expect(
      resolveGraphUpscalers(plain, { pref: null, live: LIVE }).prompt,
    ).toBe(plain);
  });

  it("applies the table default when locked (default) and never mutates input", () => {
    const g = graph("RealESRGAN_x4plus.pth");
    const before = JSON.stringify(g);
    const r = resolveGraphUpscalers(g, { pref: null, live: LIVE });
    expect(loaderModel(r.prompt, "2")).toBe("4x-UltraSharp.pth");
    expect(r.swaps).toEqual([
      {
        nodeId: "2",
        from: "RealESRGAN_x4plus.pth",
        to: "4x-UltraSharp.pth",
        content: "photo",
        source: "table",
        rescale: 1,
      },
    ]);
    expect(JSON.stringify(g)).toBe(before);
    expect(Object.keys(r.prompt)).toHaveLength(4);
  });

  it("keeps the graph's model on a fresh install (table model missing)", () => {
    const g = graph("RealESRGAN_x4plus.pth");
    const r = resolveGraphUpscalers(g, { pref: null, live: STARTER });
    expect(r.prompt).toBe(g);
    expect(r.swaps).toEqual([]);
  });

  it("falls back and warns when the chosen model is missing", () => {
    const g = graph("RealESRGAN_x4plus.pth");
    const r = resolveGraphUpscalers(g, {
      pref: { photo: "4x_Valar_v1.pth" },
      live: STARTER,
    });
    expect(r.prompt).toBe(g);
    expect(r.warnings).toEqual([
      "Upscaler 4x_Valar_v1.pth is not installed; using RealESRGAN_x4plus.pth.",
    ]);
  });

  it("uses the per-type choice: illustration graphs get the illustration model", () => {
    const g = graph("RealESRGAN_x4plus.pth", undefined, {
      "9": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: "noobaiXL_v11.safetensors" },
      },
    });
    expect(graphUpscaleContent(g)).toBe("illustration");
    const pref = {
      photo: "4x_NMKD-Siax_200k.pth",
      illustration: "4x_fatal_Anime.pth",
    };
    const r = resolveGraphUpscalers(g, {
      pref,
      live: [...LIVE, "4x_fatal_Anime_500000_G.pth"],
    });
    // Stem match through the training-step suffix.
    expect(loaderModel(r.prompt, "2")).toBe("4x_fatal_Anime_500000_G.pth");
    const r2 = resolveGraphUpscalers(g, {
      pref: { ...pref, illustration: "4x_Missing.pth" },
      live: [...LIVE, "4x_fatal_Anime_500000_G.pth"],
    });
    expect(loaderModel(r2.prompt, "2")).toBe("4x-AnimeSharp.pth");
    expect(r2.swaps[0]).toMatchObject({
      content: "illustration",
      source: "table",
    });
    expect(r.swaps[0]).toMatchObject({
      content: "illustration",
      source: "choice",
    });
    expect(r2.warnings).toEqual([
      "Upscaler 4x_Missing.pth is not installed; using 4x-AnimeSharp.pth.",
    ]);
  });

  it("uses the video choice for graphs with video nodes", () => {
    const g = graph("4x-UltraSharp.pth", undefined, {
      "4": {
        class_type: "VHS_VideoCombine",
        inputs: { images: ["3", 0], frame_rate: 24 },
      },
    });
    const r = resolveGraphUpscalers(g, {
      pref: { video: "4x-UltraMix_Balanced.pth" },
      live: LIVE,
    });
    expect(loaderModel(r.prompt, "2")).toBe("4x-UltraMix_Balanced.pth");
    expect(r.swaps[0].content).toBe("video");
  });

  it("keeps a clip's 2x model when a bigger one would sit on every frame", () => {
    const g = graph("RealESRGAN_x2plus.pth", undefined, {
      "4": {
        class_type: "VHS_VideoCombine",
        inputs: { images: ["3", 0], frame_rate: 24 },
      },
    });
    const r = resolveGraphUpscalers(g, {
      pref: { video: "4x-UltraMix_Balanced.pth" },
      live: LIVE,
    });
    expect(r.prompt).toBe(g);
    expect(r.swaps).toEqual([]);
  });

  it("names the model actually used when a missing choice's fallback is skipped", () => {
    const g = graph("RealESRGAN_x2plus.pth", undefined, {
      "3": {
        class_type: "SomeCustomUpscale",
        inputs: { image: ["1", 0], upscale_model: ["2", 0] },
      },
    });
    const r = resolveGraphUpscalers(g, {
      pref: { photo: "4x_Missing.pth" },
      live: LIVE,
    });
    expect(r.prompt).toBe(g);
    expect(r.warnings).toEqual([
      "Upscaler 4x_Missing.pth is not installed; using RealESRGAN_x2plus.pth.",
    ]);
  });

  it("_meta.upscaleContent wins over graph inference", () => {
    const g = graph("RealESRGAN_x4plus.pth", {
      upscaleContent: "illustration",
    });
    const r = resolveGraphUpscalers(g, { pref: null, live: LIVE });
    expect(loaderModel(r.prompt, "2")).toBe("4x-AnimeSharp.pth");
  });

  it("respects a tool-level fixed upscaler", () => {
    const g = graph("RealESRGAN_x4plus.pth", { upscaler: "fixed" });
    const r = resolveGraphUpscalers(g, {
      pref: { photo: "4x-UltraSharp.pth" },
      live: LIVE,
    });
    expect(r.prompt).toBe(g);
  });

  it("leaves 1x cleanup and face loaders alone", () => {
    for (const m of [
      "1x-Kim2091-DeJpeg-v0.pth",
      "8x_NMKD-Faces_160000_G.pth",
    ]) {
      const g = graph(m);
      expect(resolveGraphUpscalers(g, { pref: null, live: LIVE }).prompt).toBe(
        g,
      );
    }
  });

  it("unlocked: only loaders marked default follow the choice", () => {
    const pref = { photo: "4x_NMKD-Siax_200k.pth", lock: false as const };
    const plain = graph("RealESRGAN_x4plus.pth");
    expect(resolveGraphUpscalers(plain, { pref, live: LIVE }).prompt).toBe(
      plain,
    );
    const marked = graph("RealESRGAN_x4plus.pth", { upscaler: "default" });
    expect(
      loaderModel(
        resolveGraphUpscalers(marked, { pref, live: LIVE }).prompt,
        "2",
      ),
    ).toBe("4x_NMKD-Siax_200k.pth");
  });

  it("keeps the graph's size: 2x graph + 4x choice inserts a 0.5 rescale", () => {
    const g = graph("RealESRGAN_x2plus.pth");
    const r = resolveGraphUpscalers(g, { pref: null, live: LIVE });
    const p = r.prompt as G;
    expect(p["2"].inputs.model_name).toBe("4x-UltraSharp.pth");
    expect(p["5"]).toMatchObject({
      class_type: "ImageScaleBy",
      inputs: { image: ["3", 0], upscale_method: "lanczos", scale_by: 0.5 },
    });
    expect(p["4"].inputs.images).toEqual(["5", 0]);
    expect(r.swaps[0].rescale).toBe(0.5);
  });

  it("adjusts an existing ImageScaleBy instead of adding one", () => {
    const g = graph("RealESRGAN_x2plus.pth", undefined, {
      "4": {
        class_type: "ImageScaleBy",
        inputs: { image: ["3", 0], upscale_method: "lanczos", scale_by: 1 },
      },
      "5": { class_type: "SaveImage", inputs: { images: ["4", 0] } },
    });
    const p = resolveGraphUpscalers(g, { pref: null, live: LIVE }).prompt as G;
    expect(p["4"].inputs.scale_by).toBe(0.5);
    expect(Object.keys(p)).toHaveLength(5);
  });

  it("uses string ids when the graph has non-numeric ids", () => {
    const g: G = {
      load: { class_type: "LoadImage", inputs: { image: "a.png" } },
      up_m: {
        class_type: "UpscaleModelLoader",
        inputs: { model_name: "RealESRGAN_x2plus.pth" },
      },
      up: {
        class_type: "ImageUpscaleWithModel",
        inputs: { image: ["load", 0], upscale_model: ["up_m", 0] },
      },
      save: { class_type: "SaveImage", inputs: { images: ["up", 0] } },
    };
    const p = resolveGraphUpscalers(g, { pref: null, live: LIVE }).prompt as G;
    expect(p.up_rescale.inputs.scale_by).toBe(0.5);
    expect(p.save.inputs.images).toEqual(["up_rescale", 0]);
  });

  it("swaps under a self-resizing consumer without rescaling", () => {
    const g = load("packs/krea2/upscale_detail.json") as unknown as G;
    const r = resolveGraphUpscalers(g, { pref: null, live: LIVE });
    expect(loaderModel(r.prompt, "22")).toBe("4x-UltraSharp.pth");
    expect((r.prompt as G)["23"].inputs.upscale_by).toBe(2);
    expect(Object.keys(r.prompt)).toHaveLength(Object.keys(g).length);
  });

  it("skips a size-changing swap with an unknown consumer", () => {
    const g = graph("RealESRGAN_x2plus.pth", undefined, {
      "3": {
        class_type: "SomeCustomUpscaler",
        inputs: { image: ["1", 0], upscale_model: ["2", 0] },
      },
    });
    expect(resolveGraphUpscalers(g, { pref: null, live: LIVE }).prompt).toBe(g);
  });

  it("allows a same-scale swap with an unknown consumer", () => {
    const g = graph("RealESRGAN_x4plus.pth", undefined, {
      "3": {
        class_type: "SomeCustomUpscaler",
        inputs: { image: ["1", 0], upscale_model: ["2", 0] },
      },
    });
    const r = resolveGraphUpscalers(g, { pref: null, live: LIVE });
    expect(loaderModel(r.prompt, "2")).toBe("4x-UltraSharp.pth");
  });

  it("skips a swap when the original factor is unknown", () => {
    const g = graph("mystery_model.pth");
    expect(
      resolveGraphUpscalers(g, {
        pref: null,
        live: [...LIVE, "mystery_model.pth"],
      }).prompt,
    ).toBe(g);
  });

  it("Faithful pref scale: 4x model to 2x output", () => {
    const g = graph("RealESRGAN_x4plus.pth", {
      upscaler: "default",
      upscaleScale: "pref",
    });
    const r = resolveGraphUpscalers(g, { pref: { scale: 2 }, live: LIVE });
    const p = r.prompt as G;
    expect(p["2"].inputs.model_name).toBe("4x-UltraSharp.pth");
    expect(p["5"].inputs.scale_by).toBe(0.5);
    // No preferred scale: size follows the model.
    const r2 = resolveGraphUpscalers(g, { pref: null, live: LIVE });
    expect(Object.keys(r2.prompt)).toHaveLength(4);
  });

  it("Faithful pref scale also applies to a per-run fixed model", () => {
    const g = graph("RealESRGAN_x2plus.pth", {
      upscaler: "fixed",
      upscaleScale: "pref",
    });
    const r = resolveGraphUpscalers(g, { pref: { scale: 4 }, live: LIVE });
    const p = r.prompt as G;
    expect(p["2"].inputs.model_name).toBe("RealESRGAN_x2plus.pth");
    expect(p["5"].inputs.scale_by).toBe(2);
    expect(r.swaps[0].source).toBe("scale");
  });

  it("rewrites every shipped workflow loader to an installed model", () => {
    for (const rel of [
      "upscale.json",
      "upscale_subtle.json",
      "upscale_creative.json",
      "packs/krea2/upscale_creative.json",
      "packs/krea2/upscale_detail.json",
      "packs/krea2/upscale_subtle.json",
    ]) {
      const g = load(rel);
      const r = resolveGraphUpscalers(g, { pref: null, live: LIVE });
      for (const n of Object.values(r.prompt as G)) {
        if (n.class_type === "UpscaleModelLoader")
          expect(LIVE).toContain(n.inputs.model_name);
      }
      expect(r.swaps.length).toBeGreaterThan(0);
    }
  });

  it("krea2 Faithful (2x → VAEEncode) keeps 2x with a 4x default", () => {
    const g = load("packs/krea2/upscale_subtle.json") as unknown as G;
    const p = resolveGraphUpscalers(g, { pref: null, live: LIVE }).prompt as G;
    const enc = Object.values(p).find((n) => n.class_type === "VAEEncode")!;
    const scaleId = String((enc.inputs.pixels as unknown[])[0]);
    expect(p[scaleId]).toMatchObject({
      class_type: "ImageScaleBy",
      inputs: { image: ["21", 0], scale_by: 0.5 },
    });
  });
});

describe("liveUpscalerFiles", () => {
  it("lists every model_name option, unfiltered", () => {
    expect(
      liveUpscalerFiles({
        UpscaleModelLoader: {
          input: {
            required: {
              model_name: ["COMBO", { options: ["a.pth", "GFPGANv1.4.pth"] }],
            },
          },
        },
      }),
    ).toEqual(["a.pth", "GFPGANv1.4.pth"]);
    expect(liveUpscalerFiles({})).toBeNull();
  });
});

describe("upscale builders mark loaders for the resolver", () => {
  const SRC =
    "http://127.0.0.1:8188/view?filename=Adrift_00001_.png&subfolder=&type=output";
  const run = (extra: Partial<ImagineRun> = {}): ImagineRun =>
    ({
      run_id: "r1",
      prompt: "a fox",
      parsedPrompt: "a fox",
      width: 1024,
      height: 1024,
      jobs: [
        {
          seed: 1,
          index: 0,
          status: "completed",
          progress: 100,
          images: [SRC],
        },
      ],
      createdAt: "",
      status: "completed",
      params: {},
      ...extra,
    }) as unknown as ImagineRun;
  const loaderMeta = (wf: Workflow) =>
    Object.values(wf).find((n) => n.class_type === "UpscaleModelLoader")!._meta;

  it("Faithful without a pick follows the default and the preferred scale", () => {
    const { workflow } = buildUpscaleSubtleWorkflow(
      load("upscale_subtle.json"),
      run(),
      0,
    );
    expect(loaderMeta(workflow)).toMatchObject({
      upscaler: "default",
      upscaleContent: "photo",
      upscaleScale: "pref",
    });
  });

  it("a per-run pick is fixed; anime sources are illustration", () => {
    const { workflow } = buildUpscaleCreativeWorkflow(
      load("upscale_creative.json"),
      run({ model: "animagineXL40.safetensors" }),
      0,
      { upscale_model: "4x-UltraSharp.pth" },
    );
    expect(loaderMeta(workflow)).toMatchObject({
      upscaler: "fixed",
      upscaleContent: "illustration",
    });
    expect(loaderMeta(workflow)?.upscaleScale).toBeUndefined();
  });

  it("Creative default: resolver keeps the 2x target with any model", () => {
    const { workflow } = buildUpscaleCreativeWorkflow(
      load("packs/krea2/upscale_creative.json"),
      run(),
      0,
    );
    const p = resolveGraphUpscalers(workflow, { pref: null, live: LIVE })
      .prompt as G;
    expect(p["20"].inputs.model_name).toBe("4x-UltraSharp.pth");
    expect(p["22"].inputs.scale_by).toBe(0.5);
  });
});

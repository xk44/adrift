/**
 * Upscale workstream: model choice (UpscaleModelLoader options), Faithful vs
 * Creative graphs, builder overrides, loader maps.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import type { ImagineRun, Workflow } from "@/types";
import {
  CREATIVITY_DEFAULT,
  UPSCALE_MODE_HINTS,
  clampCreativity,
  creativeRescale,
  creativityDenoise,
  isImageUpscaler,
  sanitizeUpscaleModel,
  toUpscaleModelOptions,
  upscaleModelLabel,
  upscaleModelOptionsFromObjectInfo,
  upscaleModelScale,
  upscaleRequestParams,
} from "@/lib/upscale/upscaleModels";
import {
  buildUpscaleCreativeWorkflow,
  buildUpscaleSubtleWorkflow,
} from "@/lib/oj/upscaleBuilder";
import { actionBuilderFor } from "@/lib/oj/actionBuilders";
import { buildWorkflowForAction } from "@/lib/oj/actionWorkflow";
import { resolveWorkflow } from "@/lib/oj/packs";
import { workflowModelRequirements } from "@/lib/tools/modelStatus";
import { missingAgainstObjectInfo } from "@/lib/comfy/backendModels";

const load = (rel: string): Workflow =>
  JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "public/workflows", rel), "utf-8"),
  );

const SRC =
  "http://127.0.0.1:8188/view?filename=Adrift_00001_.png&subfolder=&type=output";

const run = (params: Record<string, unknown> = {}): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "a fox in snow",
    parsedPrompt: "a fox in snow",
    width: 1024,
    height: 1024,
    jobs: [
      { seed: 42, index: 0, status: "completed", progress: 100, images: [SRC] },
    ],
    createdAt: new Date().toISOString(),
    status: "completed",
    params,
  }) as unknown as ImagineRun;

const ofClass = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(([, n]) => n.class_type === cls);

const OBJECT_INFO_V3 = {
  UpscaleModelLoader: {
    input: {
      required: {
        model_name: [
          "COMBO",
          {
            options: [
              "RealESRGAN_x4plus.pth",
              "4x-UltraSharp.pth",
              "RealESRGAN_x2plus.pth",
              "GFPGANv1.4.pth",
              "codeformer-v0.1.0.pth",
              "detection_Resnet50_Final.pth",
              "parsing_parsenet.pth",
              "1x_ReFocus_V3.pth",
            ],
          },
        ],
      },
    },
  },
};

describe("upscale model helpers", () => {
  it("reads the factor from common names", () => {
    expect(upscaleModelScale("4x-UltraSharp.pth")).toBe(4);
    expect(upscaleModelScale("RealESRGAN_x2plus.pth")).toBe(2);
    expect(upscaleModelScale("RealESRGAN_x4plus.pth")).toBe(4);
    expect(upscaleModelScale("8x_NMKD-Faces_160000_G.pth")).toBe(8);
    expect(upscaleModelScale("1x_ReFocus_V3.pth")).toBe(1);
    expect(upscaleModelScale("sub/2x_Foo.safetensors")).toBe(2);
    expect(upscaleModelScale("HAT_SRx4_ImageNet-pretrain.pth")).toBe(4);
    expect(upscaleModelScale("mystery.pth")).toBeNull();
  });

  it("filters face-restore and detection weights", () => {
    expect(isImageUpscaler("4x-UltraSharp.pth")).toBe(true);
    expect(isImageUpscaler("GFPGANv1.4.pth")).toBe(false);
    expect(isImageUpscaler("codeformer-v0.1.0.pth")).toBe(false);
    expect(isImageUpscaler("detection_Resnet50_Final.pth")).toBe(false);
    expect(isImageUpscaler("readme.txt")).toBe(false);
  });

  it("labels with the factor", () => {
    expect(upscaleModelLabel("4x-UltraSharp.pth")).toBe("4x-UltraSharp · 4×");
    expect(upscaleModelLabel("mystery.pth")).toBe("mystery");
  });

  it("reads options from the ComfyUI 0.4x COMBO format", () => {
    const opts = upscaleModelOptionsFromObjectInfo(OBJECT_INFO_V3);
    expect(opts?.map((o) => o.file)).toEqual([
      "1x_ReFocus_V3.pth",
      "4x-UltraSharp.pth",
      "RealESRGAN_x2plus.pth",
      "RealESRGAN_x4plus.pth",
    ]);
  });

  it("reads options from the legacy [[...]] format", () => {
    const opts = upscaleModelOptionsFromObjectInfo({
      UpscaleModelLoader: {
        input: { required: { model_name: [["b_x2.pth", "a_4x.pth"]] } },
      },
    });
    expect(opts?.map((o) => o.file)).toEqual(["a_4x.pth", "b_x2.pth"]);
  });

  it("returns null when the node is missing", () => {
    expect(upscaleModelOptionsFromObjectInfo({})).toBeNull();
    expect(upscaleModelOptionsFromObjectInfo(null)).toBeNull();
  });

  it("dedupes options", () => {
    expect(toUpscaleModelOptions(["a_4x.pth", "a_4x.pth", 3])).toHaveLength(1);
  });

  it("sanitizes model names", () => {
    expect(sanitizeUpscaleModel("4x-UltraSharp.pth")).toBe("4x-UltraSharp.pth");
    expect(sanitizeUpscaleModel(" sub/x_2x.safetensors ")).toBe(
      "sub/x_2x.safetensors",
    );
    for (const bad of [
      "../../etc/passwd.pth",
      "/abs/x.pth",
      "C:\\x.pth",
      "a/./b.pth",
      "x.exe",
      "",
      42,
      null,
      'q"x.pth',
    ]) {
      expect(sanitizeUpscaleModel(bad)).toBeUndefined();
    }
  });

  it("maps creativity to denoise and clamps", () => {
    expect(creativityDenoise(0)).toBe(0.1);
    expect(creativityDenoise(100)).toBe(0.5);
    expect(creativityDenoise(35)).toBe(0.2);
    expect(creativityDenoise(50)).toBe(0.27);
    expect(creativityDenoise(500)).toBe(0.5);
    expect(clampCreativity("nope")).toBe(CREATIVITY_DEFAULT);
    expect(clampCreativity("70")).toBe(70);
    expect(clampCreativity(-5)).toBe(0);
  });

  it("rescales model output to 2x", () => {
    expect(creativeRescale("RealESRGAN_x4plus.pth")).toBe(0.5);
    expect(creativeRescale("RealESRGAN_x2plus.pth")).toBe(1);
    expect(creativeRescale("8x_NMKD.pth")).toBe(0.25);
    expect(creativeRescale("mystery.pth")).toBe(0.5);
    expect(creativeRescale(undefined)).toBe(0.5);
  });

  it("builds request params per mode", () => {
    expect(upscaleRequestParams("upscale_subtle", { model: "" })).toEqual({});
    expect(
      upscaleRequestParams("upscale_subtle", {
        model: "4x-UltraSharp.pth",
        creativity: 80,
      }),
    ).toEqual({ upscale_model: "4x-UltraSharp.pth" });
    expect(
      upscaleRequestParams("upscale_creative", { model: "../x.pth" }),
    ).toEqual({ creativity: CREATIVITY_DEFAULT });
  });

  it("has plain-language mode hints", () => {
    expect(UPSCALE_MODE_HINTS.upscale_subtle).toMatch(
      /Faithful keeps every pixel honest/,
    );
    expect(UPSCALE_MODE_HINTS.upscale_creative).toMatch(
      /Creative invents fine detail/,
    );
  });
});

describe("Faithful vs Creative graphs", () => {
  it("are genuinely different graphs", () => {
    const faithful = load("upscale_subtle.json");
    const creative = load("upscale_creative.json");
    expect(JSON.stringify(faithful)).not.toBe(JSON.stringify(creative));
    const kinds = (wf: Workflow) => Object.values(wf).map((n) => n.class_type);
    expect(kinds(faithful)).not.toContain("KSampler");
    for (const wf of [creative, load("packs/krea2/upscale_creative.json")]) {
      expect(kinds(wf)).toEqual(
        expect.arrayContaining([
          "ImageUpscaleWithModel",
          "SplitImageToTileList",
          "KSampler",
          "ImageMergeTileList",
          "GetImageSize",
        ]),
      );
    }
  });

  it.each([
    ["sd_xl_base_1.0.safetensors", "upscale_subtle.json"],
    ["krea2_turbo_bf16.safetensors", "upscale_subtle.json"],
    ["krea2_raw_bf16.safetensors", "upscale_subtle.json"],
  ])("Faithful on %s resolves to the model-only graph", (ckpt, expected) => {
    expect(
      resolveWorkflow({
        templateOrAction: "upscale_subtle",
        checkpointName: ckpt,
      }).workflowPath,
    ).toBe(expected);
  });

  it("both actions have custom builders", () => {
    expect(actionBuilderFor("upscale_subtle")).toBe(buildUpscaleSubtleWorkflow);
    expect(actionBuilderFor("upscale_creative")).toBe(
      buildUpscaleCreativeWorkflow,
    );
  });
});

describe("upscale builders", () => {
  it("Faithful builds a sampler-less graph (generic builder would throw)", () => {
    const { workflow, seed } = buildUpscaleSubtleWorkflow(
      load("upscale_subtle.json"),
      run(),
      0,
      { upscale_model: "4x-UltraSharp.pth" },
    );
    expect(ofClass(workflow, "LoadImage")[0][1].inputs.image).toBe(
      "Adrift_00001_.png [output]",
    );
    expect(
      ofClass(workflow, "UpscaleModelLoader")[0][1].inputs.model_name,
    ).toBe("4x-UltraSharp.pth");
    expect(seed).toBe(42);
  });

  it("Faithful keeps the graph default without a choice and ignores bad names", () => {
    for (const params of [{}, { upscale_model: "../evil.pth" }]) {
      const { workflow } = buildUpscaleSubtleWorkflow(
        load("upscale_subtle.json"),
        run(),
        0,
        params,
      );
      expect(
        ofClass(workflow, "UpscaleModelLoader")[0][1].inputs.model_name,
      ).toBe("RealESRGAN_x4plus.pth");
    }
  });

  it("Faithful throws clearly when the source has no image", () => {
    const r = run();
    r.jobs[0].images = [];
    expect(() =>
      buildUpscaleSubtleWorkflow(load("upscale_subtle.json"), r, 0, {}),
    ).toThrow(/no image/);
  });

  it("Faithful on a refine graph still overrides the model", () => {
    const { workflow } = buildUpscaleSubtleWorkflow(
      load("packs/krea2/upscale_subtle.json"),
      run(),
      0,
      { upscale_model: "4x-UltraSharp.pth" },
    );
    expect(
      ofClass(workflow, "UpscaleModelLoader")[0][1].inputs.model_name,
    ).toBe("4x-UltraSharp.pth");
  });

  it.each(["upscale_creative.json", "packs/krea2/upscale_creative.json"])(
    "Creative (%s): model, creativity → denoise, 2x rescale, tuned sampler",
    (rel) => {
      const base = load(rel);
      const [ksId, ksTemplate] = ofClass(base, "KSampler")[0];
      const { workflow, slots } = buildUpscaleCreativeWorkflow(
        base,
        // A source run's own sampler settings must not leak into the tile pass.
        run({ steps: 50, cfg: 9, sampler: "dpmpp_sde" }),
        0,
        { upscale_model: "4x-UltraSharp.pth", creativity: 100 },
      );
      expect(slots.ksamplerId).toBe(ksId);
      const ks = workflow[ksId].inputs;
      expect(ks.denoise).toBe(0.5);
      expect(ks.steps).toBe(ksTemplate.inputs.steps);
      expect(ks.cfg).toBe(ksTemplate.inputs.cfg);
      expect(ks.sampler_name).toBe(ksTemplate.inputs.sampler_name);
      expect(
        ofClass(workflow, "UpscaleModelLoader")[0][1].inputs.model_name,
      ).toBe("4x-UltraSharp.pth");
      expect(ofClass(workflow, "ImageScaleBy")[0][1].inputs.scale_by).toBe(0.5);
      expect(ofClass(workflow, "LoadImage")[0][1].inputs.image).toBe(
        "Adrift_00001_.png [output]",
      );
      // Prompt guides the re-render.
      expect(workflow[slots.posTextId].inputs.text).toBe("a fox in snow");
      // Tile wiring untouched: merge size follows the measured image.
      const [, merge] = ofClass(workflow, "ImageMergeTileList")[0];
      const [sizeId] = ofClass(workflow, "GetImageSize")[0];
      expect(merge.inputs.final_width).toEqual([sizeId, 0]);
      expect(merge.inputs.final_height).toEqual([sizeId, 1]);
      // Generic injection must not resize the tile encode.
      for (const [, n] of ofClass(workflow, "VAEEncode")) {
        expect(n.inputs.width).toBeUndefined();
      }
    },
  );

  it("Creative defaults: creativity 35, graph model, rescale from graph model", () => {
    const { workflow } = buildUpscaleCreativeWorkflow(
      load("packs/krea2/upscale_creative.json"),
      run(),
      0,
      {},
    );
    expect(ofClass(workflow, "KSampler")[0][1].inputs.denoise).toBe(
      creativityDenoise(CREATIVITY_DEFAULT),
    );
    // RealESRGAN_x2plus → already 2x.
    expect(ofClass(workflow, "ImageScaleBy")[0][1].inputs.scale_by).toBe(1);
  });

  it("Creative with a 2x model on the SDXL graph keeps scale 1", () => {
    const { workflow } = buildUpscaleCreativeWorkflow(
      load("upscale_creative.json"),
      run(),
      0,
      { upscale_model: "RealESRGAN_x2plus.pth", creativity: 0 },
    );
    expect(ofClass(workflow, "ImageScaleBy")[0][1].inputs.scale_by).toBe(1);
    expect(ofClass(workflow, "KSampler")[0][1].inputs.denoise).toBe(0.1);
  });

  it("routes through buildWorkflowForAction as a custom builder", () => {
    const built = buildWorkflowForAction(
      "upscale_subtle",
      { upscale_model: "4x-UltraSharp.pth" },
      { baseWorkflow: load("upscale_subtle.json"), sourceRun: run() },
    );
    expect(built.builder).toBe("custom");
    expect(
      ofClass(built.workflow, "UpscaleModelLoader")[0][1].inputs.model_name,
    ).toBe("4x-UltraSharp.pth");
  });
});

describe("model status lists upscale models", () => {
  it("workflowModelRequirements includes UpscaleModelLoader files", () => {
    const reqs = workflowModelRequirements(load("upscale_subtle.json")).map(
      (r) => `${r.dir}/${r.file}`,
    );
    expect(reqs).toContain("upscale_models/RealESRGAN_x4plus.pth");
  });

  it("missingAgainstObjectInfo flags a missing upscale model", () => {
    const info = {
      LoadImage: { input: { required: {} } },
      ImageUpscaleWithModel: { input: { required: {} } },
      SaveImage: { input: { required: {} } },
      UpscaleModelLoader: {
        input: {
          required: {
            model_name: ["COMBO", { options: ["4x-UltraSharp.pth"] }],
          },
        },
      },
    };
    expect(missingAgainstObjectInfo(load("upscale_subtle.json"), info)).toEqual(
      ["upscale_models/RealESRGAN_x4plus.pth"],
    );
  });
});

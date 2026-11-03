/**
 * Upscale modes: Faithful sizes + "Clean up first", Re-detail (tiled
 * UltimateSDUpscale on every pack's img2img graph), the per-frame video
 * upscale, and the one-click "Upscale result" request. Every built graph is
 * linted against the GPU box's object_info (LIVE_OBJECT_INFO, else the
 * scratchpad dump; skipped when neither exists) and run through the
 * submit-time upscaler resolver. Nothing is queued.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import { ACTION_BUILDERS, VIDEO_INPUT_ACTIONS } from "@/lib/oj/actionBuilders";
import {
  buildUpscaleRedetailWorkflow,
  buildUpscaleSubtleWorkflow,
} from "@/lib/oj/upscaleBuilder";
import {
  buildVideoUpscaleWorkflow,
  videoDownscaleRatio,
  videoUpscaleResizeInputs,
} from "@/lib/oj/videoUpscale";
import { resolveGraphUpscalers } from "@/lib/upscale/resolveUpscalers";
import {
  CLEANUP_MODELS,
  UPSCALE_ACTIONS,
  UPSCALE_REDETAIL_ACTION,
  UPSCALE_SUBTLE_ACTION,
  VIDEO_UPSCALE_ACTION,
  redetailDenoise,
  redetailFactor,
  upscaleRequestParams,
  upscaleSize,
  videoUpscaleScale,
} from "@/lib/upscale/upscaleModels";
import { upscaleActionParams } from "@/lib/upscale/upscalePrefs";
import {
  upscaleResultAction,
  upscaleResultRequest,
} from "@/lib/upscale/upscaleResult";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
  sliderVisible,
} from "@/lib/tools/toolsPage";
import { formatLintIssue, lintErrors, lintGraph } from "@/lib/tools/graphLint";

const ROOT = path.join(process.cwd(), "public/workflows");
const load = (rel: string) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf-8")) as Workflow;

const OI_PATH =
  process.env.LIVE_OBJECT_INFO ??
  "/private/tmp/claude-501/-Users-cj/847c965d-f597-424e-b3b0-8fe883a04ebb/scratchpad/oi_p11.json";
const objectInfo: Record<string, unknown> | null = fs.existsSync(OI_PATH)
  ? JSON.parse(fs.readFileSync(OI_PATH, "utf-8"))
  : null;
const withOI = objectInfo ? describe : describe.skip;

/** The GPU box's upscale_models (subset). */
const LIVE = [
  "1x-Kim2091-DeJpeg-v0.pth",
  "1x_GainRESV3_Natural.pth",
  "4x-UltraSharp.pth",
  "8x_NMKD-Faces_160000_G.pth",
  "GFPGANv1.4.pth",
  "RealESRGAN_x2plus.pth",
  "RealESRGAN_x4plus.pth",
];

const IMG =
  "http://127.0.0.1:8188/view?filename=Adrift_00001_.png&subfolder=&type=output";
const VID =
  "http://127.0.0.1:8188/view?filename=Adrift_00002_.mp4&subfolder=video&type=output";

const run = (extra: Partial<ImagineRun> = {}): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "a fox in snow",
    parsedPrompt: "a fox in snow",
    width: 1024,
    height: 768,
    jobs: [
      {
        seed: 7,
        index: 0,
        status: "completed",
        progress: 100,
        images: [IMG],
        videos: [VID],
      },
    ],
    createdAt: "",
    status: "completed",
    params: {},
    ...extra,
  }) as unknown as ImagineRun;

type G = Record<
  string,
  {
    class_type: string;
    inputs: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }
>;
const nodesOf = (wf: object, cls: string) =>
  Object.entries(wf as G).filter(([, n]) => n.class_type === cls);
const only = (wf: object, cls: string) => {
  const hits = nodesOf(wf, cls);
  expect(hits.length, cls).toBe(1);
  return hits[0];
};

function lintClean(wf: object) {
  const errors = lintErrors(lintGraph(wf, objectInfo!)).map(formatLintIssue);
  expect(errors).toEqual([]);
  for (const [id, n] of Object.entries(wf as G))
    if (!id.startsWith("_"))
      expect(objectInfo![n.class_type], n.class_type).toBeDefined();
}

const PACK_I2I = [
  "i2i.json",
  "packs/flux3/i2i.json",
  "packs/krea2/i2i.json",
  "packs/moss-image/i2i.json",
  "packs/qwen-image-21/i2i.json",
];

describe("registration", () => {
  it("registers the new actions and template", () => {
    expect(ACTION_BUILDERS[UPSCALE_REDETAIL_ACTION]).toBe(
      buildUpscaleRedetailWorkflow,
    );
    expect(ACTION_BUILDERS[VIDEO_UPSCALE_ACTION]).toBe(
      buildVideoUpscaleWorkflow,
    );
    expect(VIDEO_INPUT_ACTIONS.has(VIDEO_UPSCALE_ACTION)).toBe(true);
    const actions = registry.actions as Record<string, { template: string }>;
    const templates = registry.templates as Record<string, { file: string }>;
    expect(actions[UPSCALE_REDETAIL_ACTION].template).toBe("i2i");
    expect(templates[actions[VIDEO_UPSCALE_ACTION].template].file).toBe(
      "packs/utility/video_upscale.json",
    );
    expect(UPSCALE_ACTIONS.has(UPSCALE_REDETAIL_ACTION)).toBe(true);
    expect(UPSCALE_ACTIONS.has(VIDEO_UPSCALE_ACTION)).toBe(true);
  });
});

describe("request params", () => {
  it("parses sizes, cleanup and re-detail strength", () => {
    expect(upscaleSize("2x")).toEqual({ kind: "factor", factor: 2 });
    expect(upscaleSize("3840")).toEqual({ kind: "long", px: 3840 });
    expect(upscaleSize("bogus")).toEqual({ kind: "model" });
    expect(redetailFactor("1.5x")).toBe(1.5);
    expect(redetailFactor("2048")).toBe(2);
    expect(redetailDenoise(5)).toBe(0.1);
    expect(redetailDenoise(90)).toBe(0.4);
    expect(redetailDenoise(undefined)).toBe(0.2);
    expect(videoUpscaleScale("4K")).toBe("4k");
    expect(videoUpscaleScale("8k")).toBe("2x");
  });

  it("only sends what each mode reads", () => {
    expect(
      upscaleRequestParams(UPSCALE_SUBTLE_ACTION, { size: "model" }),
    ).toEqual({});
    expect(
      upscaleRequestParams(UPSCALE_SUBTLE_ACTION, {
        size: "3x",
        cleanup: "dejpeg",
      }),
    ).toEqual({ size: "3x", cleanup: "dejpeg" });
    expect(
      upscaleRequestParams(UPSCALE_REDETAIL_ACTION, {
        size: "2048",
        redetail: 40,
        cleanup: "nope",
      }),
    ).toEqual({ size: "2x", redetail: 40 });
    expect(
      upscaleRequestParams(VIDEO_UPSCALE_ACTION, {
        size: "1080p",
        cleanup: "dejpeg",
        model: "4x-UltraSharp.pth",
      }),
    ).toEqual({ size: "1080p", upscale_model: "4x-UltraSharp.pth" });
  });

  it("Upscale tool: Re-detail mode sends size and strength", () => {
    const spec = getActionTool("upscale")!;
    const s = defaultSettings(spec);
    s.picks.mode = UPSCALE_REDETAIL_ACTION;
    s.picks.detail_size = "3x";
    s.picks.cleanup = "gainres";
    s.picks.redetail = "35";
    expect(
      sliderVisible(spec.sliders!.find((x) => x.key === "redetail")!, spec, s),
    ).toBe(true);
    const req = buildActionRequest(spec, s, null);
    expect(req.action).toBe(UPSCALE_REDETAIL_ACTION);
    expect(req.params).toMatchObject({
      size: "3x",
      redetail: 35,
      cleanup: "gainres",
    });
  });

  it("Upscale video: Fast queues the per-frame graph, Best SeedVR2", () => {
    const spec = getActionTool("upscale_video")!;
    const s = defaultSettings(spec);
    s.picks.scale = "4k";
    const fast = buildActionRequest(spec, s, null);
    expect(fast.action).toBe(VIDEO_UPSCALE_ACTION);
    expect(fast.params).toMatchObject({ size: "4k" });
    s.picks.engine = "best";
    expect(buildActionRequest(spec, s, null).action).not.toBe(VIDEO_UPSCALE_ACTION);
  });

  it("one-click Upscale result picks the action by media kind", () => {
    expect(upscaleResultAction("image")).toBe(UPSCALE_SUBTLE_ACTION);
    expect(upscaleResultAction("video")).toBe(VIDEO_UPSCALE_ACTION);
    expect(
      upscaleResultRequest({
        runId: "r1",
        jobIndex: 2,
        kind: "video",
        clientId: "c",
      }),
    ).toEqual({
      run_id: "r1",
      job_index: 2,
      action: VIDEO_UPSCALE_ACTION,
      client_id: "c",
      params: { size: "2x" },
    });
    expect(upscaleActionParams(UPSCALE_REDETAIL_ACTION)).toEqual({
      size: "2x",
      redetail: 20,
    });
  });
});

describe("Faithful: exact size and clean-up pass", () => {
  it("2x with the 4x placeholder halves after the model; resolver keeps 2x", () => {
    const { workflow } = buildUpscaleSubtleWorkflow(
      load("upscale_subtle.json"),
      run(),
      0,
      { size: "2x" },
    );
    const [, scale] = only(workflow, "ImageScaleBy");
    expect(scale.inputs.scale_by).toBe(0.5);
    const [loaderId, loader] = only(workflow, "UpscaleModelLoader");
    expect(loader._meta?.upscaleScale).toBeUndefined();
    const p = resolveGraphUpscalers(workflow, {
      pref: { photo: "RealESRGAN_x2plus.pth" },
      live: LIVE,
    }).prompt as G;
    expect(p[loaderId].inputs.model_name).toBe("RealESRGAN_x2plus.pth");
    expect(only(p, "ImageScaleBy")[1].inputs.scale_by).toBe(1);
  });

  it("long edge uses ImageScaleToMaxDimension", () => {
    const { workflow } = buildUpscaleSubtleWorkflow(
      load("upscale_subtle.json"),
      run(),
      0,
      { size: "3840" },
    );
    expect(only(workflow, "ImageScaleToMaxDimension")[1].inputs).toMatchObject({
      largest_size: 3840,
      upscale_method: "lanczos",
    });
  });

  it("clean-up runs first on a fixed 1x loader the resolver never swaps", () => {
    const { workflow } = buildUpscaleSubtleWorkflow(
      load("upscale_subtle.json"),
      run(),
      0,
      { cleanup: "dejpeg" },
    );
    const loaders = nodesOf(workflow, "UpscaleModelLoader");
    expect(loaders).toHaveLength(2);
    const [cleanId] = loaders.find(
      ([, n]) => n.inputs.model_name === CLEANUP_MODELS.dejpeg.file,
    )!;
    const [loadId] = only(workflow, "LoadImage");
    const ups = nodesOf(workflow, "ImageUpscaleWithModel");
    const first = ups.find(
      ([, n]) => String(n.inputs.image?.[0 as never]) === loadId,
    );
    expect((first![1].inputs.upscale_model as unknown[])[0]).toBe(cleanId);
    const r = resolveGraphUpscalers(workflow, { pref: null, live: LIVE });
    expect((r.prompt as G)[cleanId].inputs.model_name).toBe(
      CLEANUP_MODELS.dejpeg.file,
    );
    expect(r.swaps.map((s) => s.nodeId)).not.toContain(cleanId);
  });
});

describe("Re-detail on every pack's img2img graph", () => {
  it.each(PACK_I2I)("%s", (rel) => {
    const { workflow } = buildUpscaleRedetailWorkflow(load(rel), run(), 0, {
      size: "3x",
      redetail: 30,
      cleanup: "gainres",
    });
    expect(nodesOf(workflow, "KSampler")).toHaveLength(0);
    expect(nodesOf(workflow, "VAEDecode")).toHaveLength(0);
    const [usduId, usdu] = only(workflow, "UltimateSDUpscale");
    expect(usdu.inputs).toMatchObject({
      upscale_by: 3,
      denoise: 0.3,
      mode_type: "Chess",
      // the Half Tile seam pass left blocky patches on fine texture
      seam_fix_mode: "None",
    });
    expect(typeof usdu.inputs.seed).toBe("number");
    const save = nodesOf(workflow, "SaveImage");
    expect(save.length).toBeGreaterThan(0);
    expect(
      save.some(([, n]) => (n.inputs.images as unknown[])[0] === usduId),
    ).toBe(true);
    const r = resolveGraphUpscalers(workflow, {
      pref: { photo: "RealESRGAN_x2plus.pth" },
      live: LIVE,
    });
    const models = nodesOf(r.prompt, "UpscaleModelLoader").map(
      ([, n]) => n.inputs.model_name,
    );
    expect(models.sort()).toEqual(
      [CLEANUP_MODELS.gainres.file, "RealESRGAN_x2plus.pth"].sort(),
    );
    // UltimateSDUpscale sizes itself: no extra resize after a swap.
    expect(nodesOf(r.prompt, "ImageScaleBy")).toHaveLength(
      nodesOf(workflow, "ImageScaleBy").length,
    );
  });
});

describe("video upscale (per-frame)", () => {
  const base = load("packs/utility/video_upscale.json");

  it("maps targets to resize inputs and batch ratios", () => {
    expect(videoUpscaleResizeInputs("2x")).toBeNull();
    expect(videoUpscaleResizeInputs("1080p")).toMatchObject({
      "resize_type.shorter_size": 1080,
    });
    expect(videoDownscaleRatio("2x", 4)).toBe(0.5);
    expect(videoDownscaleRatio("2x", 2)).toBe(1);
    expect(videoDownscaleRatio("1080p", 4, { width: 960, height: 540 })).toBe(
      0.5,
    );
    expect(videoDownscaleRatio("4k", 4, { width: 1280, height: 720 })).toBe(
      0.75,
    );
  });

  it("2x: no resize node, CreateVideo reads the batched upscale", () => {
    const { workflow } = buildVideoUpscaleWorkflow(base, run(), 0, {
      size: "2x",
    });
    expect(nodesOf(workflow, "ResizeImageMaskNode")).toHaveLength(0);
    const [upId, up] = only(workflow, "ImageUpscaleWithModelBatched");
    expect(up.inputs.downscale_ratio).toBe(0.5);
    expect(
      (only(workflow, "CreateVideo")[1].inputs.images as unknown[])[0],
    ).toBe(upId);
    expect(only(workflow, "UpscaleModelLoader")[1]._meta).toMatchObject({
      upscaler: "default",
      upscaleContent: "video",
    });
  });

  it("resolver swaps the video default and rescales downscale_ratio", () => {
    const { workflow } = buildVideoUpscaleWorkflow(base, run(), 0, {
      size: "2x",
    });
    const p = resolveGraphUpscalers(workflow, {
      pref: { video: "RealESRGAN_x2plus.pth" },
      live: LIVE,
    }).prompt as G;
    expect(only(p, "UpscaleModelLoader")[1].inputs.model_name).toBe(
      "RealESRGAN_x2plus.pth",
    );
    expect(
      only(p, "ImageUpscaleWithModelBatched")[1].inputs.downscale_ratio,
    ).toBe(1);
    expect(nodesOf(p, "ImageScaleBy")).toHaveLength(0);
  });

  it("a pinned model is fixed", () => {
    const { workflow } = buildVideoUpscaleWorkflow(base, run(), 0, {
      upscale_model: "4x-UltraSharp.pth",
    });
    const [, loader] = only(workflow, "UpscaleModelLoader");
    expect(loader.inputs.model_name).toBe("4x-UltraSharp.pth");
    expect(loader._meta?.upscaler).toBe("fixed");
  });

  it("refuses a source without a video", () => {
    const still = run({
      jobs: [{ seed: 1, index: 0, status: "completed", images: [IMG] }],
    } as unknown as Partial<ImagineRun>);
    expect(() => buildVideoUpscaleWorkflow(base, still, 0)).toThrow(/no video/);
  });
});

withOI("graphs lint clean against the GPU box's object_info", () => {
  it("video_upscale.json template", () => {
    const g = Object.fromEntries(
      Object.entries(base()).filter(([k]) => !k.startsWith("_")),
    );
    const errors = lintErrors(
      lintGraph(g, objectInfo!, { templateSlots: true }),
    ).map(formatLintIssue);
    expect(errors).toEqual([]);
  });

  it.each(["2x", "1080p", "4k"])("video upscale %s", (size) => {
    const { workflow } = buildVideoUpscaleWorkflow(base(), run(), 0, { size });
    lintClean(workflow);
    lintClean(
      resolveGraphUpscalers(workflow, {
        pref: { video: "4x-UltraSharp.pth" },
        live: LIVE,
      }).prompt,
    );
  });

  it.each(["model", "1.5x", "4x", "2048", "3840"])(
    "Faithful %s + clean-up",
    (size) => {
      const { workflow } = buildUpscaleSubtleWorkflow(
        load("upscale_subtle.json"),
        run(),
        0,
        { size, cleanup: "gainres" },
      );
      lintClean(workflow);
      lintClean(
        resolveGraphUpscalers(workflow, {
          pref: { photo: "RealESRGAN_x2plus.pth" },
          live: LIVE,
        }).prompt,
      );
    },
  );

  it.each(PACK_I2I)("Re-detail %s", (rel) => {
    const { workflow } = buildUpscaleRedetailWorkflow(load(rel), run(), 0, {
      cleanup: "dejpeg",
    });
    lintClean(workflow);
    lintClean(
      resolveGraphUpscalers(workflow, { pref: null, live: LIVE }).prompt,
    );
  });

  function base() {
    return load("packs/utility/video_upscale.json");
  }
});

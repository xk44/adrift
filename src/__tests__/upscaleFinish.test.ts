/**
 * Upscale finishing pass: Strength (blend back toward the source) and
 * Sharpen, both core nodes spliced in front of SaveImage for the image
 * upscalers only. Built graphs are linted against object_info when present.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import { stripWorkflowMetaKeys } from "@/lib/comfy/workflowMeta";
import {
  UPSCALE_FINISH_ACTIONS,
  buildWorkflowForAction,
} from "@/lib/oj/actionWorkflow";
import {
  UPSCALE_SHARPEN_PARAM,
  UPSCALE_STRENGTH_PARAM,
  applyUpscaleFinish,
  sharpenAmount,
  upscaleFinishParams,
  upscaleStrength,
} from "@/lib/upscale/upscaleFinish";
import {
  UPSCALE_CREATIVE_ACTION,
  UPSCALE_REDETAIL_ACTION,
  UPSCALE_SUBTLE_ACTION,
  upscaleRequestParams,
} from "@/lib/upscale/upscaleModels";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";
import { formatLintIssue, lintErrors, lintGraph } from "@/lib/tools/graphLint";

const OI_PATH = process.env.LIVE_OBJECT_INFO ?? "";
const objectInfo: Record<string, unknown> | null =
  OI_PATH && fs.existsSync(OI_PATH)
    ? JSON.parse(fs.readFileSync(OI_PATH, "utf-8"))
    : null;

const SRC = "/api/comfy/view?filename=src.png&subfolder=&type=input";
const RUN = {
  id: "src",
  prompt: "a red bicycle",
  params: {},
  jobs: [{ seed: 7, images: [SRC], videos: [] }],
} as unknown as ImagineRun;

function template(action: string): Workflow {
  const reg = registry as {
    templates: Record<string, { file: string }>;
    actions?: Record<string, { template?: string }>;
  };
  const key = reg.templates[action] ? action : reg.actions?.[action]?.template;
  const file = reg.templates[key ?? action].file;
  return stripWorkflowMetaKeys(
    JSON.parse(fs.readFileSync(path.join("public/workflows", file), "utf8")),
  ) as Workflow;
}

function build(action: string, params: Record<string, unknown>) {
  return buildWorkflowForAction(action, params, {
    baseWorkflow: template(action),
    sourceRun: RUN,
  }).workflow;
}

const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(([, n]) => n?.class_type === cls);

function tiny(): Workflow {
  return {
    "1": { class_type: "LoadImage", inputs: { image: "a.png" } },
    "2": { class_type: "UpscaleModelLoader", inputs: { model_name: "x.pth" } },
    "3": {
      class_type: "ImageUpscaleWithModel",
      inputs: { upscale_model: ["2", 0], image: ["1", 0] },
    },
    "4": {
      class_type: "SaveImage",
      inputs: { images: ["3", 0], filename_prefix: "u" },
    },
  } as unknown as Workflow;
}

describe("upscale finish params", () => {
  it("clamps and defaults", () => {
    expect(sharpenAmount(undefined)).toBe(0);
    expect(sharpenAmount("40")).toBe(40);
    expect(sharpenAmount(250)).toBe(100);
    expect(sharpenAmount("")).toBe(0);
    expect(upscaleStrength(undefined)).toBe(100);
    expect(upscaleStrength(-5)).toBe(0);
    expect(upscaleStrength("bogus")).toBe(100);
  });

  it("leaves defaults out of the request", () => {
    expect(upscaleFinishParams({ sharpen: 0, strength: 100 })).toEqual({});
    expect(upscaleFinishParams({ sharpen: 30, strength: 70 })).toEqual({
      sharpen: 30,
      strength: 70,
    });
    expect(
      upscaleRequestParams(UPSCALE_SUBTLE_ACTION, {
        sharpen: 20,
        strength: 100,
      }),
    ).toEqual({ sharpen: 20 });
  });
});

describe("applyUpscaleFinish", () => {
  it("is a no-op at defaults", () => {
    const wf = tiny();
    expect(applyUpscaleFinish(wf, {})).toEqual([]);
    expect(wf).toEqual(tiny());
  });

  it("chains Sharpen then Strength in front of SaveImage", () => {
    const wf = tiny();
    const added = applyUpscaleFinish(wf, {
      [UPSCALE_SHARPEN_PARAM]: 50,
      [UPSCALE_STRENGTH_PARAM]: 70,
    });
    expect(added).toHaveLength(2);
    const [[sid, sharpen]] = byClass(wf, "ImageSharpen");
    const [[bid, blend]] = byClass(wf, "ImageBlend");
    // 50 % of SHARPEN_ALPHA_MAX (0.3).
    expect(sharpen.inputs).toMatchObject({ image: ["3", 0], alpha: 0.15 });
    // image1 = the upscale (sharpened), image2 = the untouched source.
    expect(blend.inputs).toMatchObject({
      image1: [sid, 0],
      image2: ["1", 0],
      blend_factor: 0.3,
      blend_mode: "normal",
    });
    expect(wf["4"].inputs.images).toEqual([bid, 0]);
  });

  it("100 % sharpen stays in the measured useful range", () => {
    const wf = tiny();
    applyUpscaleFinish(wf, { sharpen: 100 });
    const [[, sharpen]] = byClass(wf, "ImageSharpen");
    expect(sharpen.inputs.alpha).toBe(0.3);
    const low = tiny();
    applyUpscaleFinish(low, { sharpen: 5 });
    expect(byClass(low, "ImageSharpen")[0][1].inputs.alpha).toBe(0.015);
  });

  it("strength alone skips the sharpen node", () => {
    const wf = tiny();
    applyUpscaleFinish(wf, { strength: 0 });
    expect(byClass(wf, "ImageSharpen")).toHaveLength(0);
    const [[, blend]] = byClass(wf, "ImageBlend");
    expect(blend.inputs).toMatchObject({ image1: ["3", 0], blend_factor: 1 });
  });

  it("leaves graphs without SaveImage alone", () => {
    const wf = tiny();
    delete (wf as Record<string, unknown>)["4"];
    expect(applyUpscaleFinish(wf, { sharpen: 50, strength: 50 })).toEqual([]);
  });
});

describe("finish pass through buildWorkflowForAction", () => {
  const params = { sharpen: 40, strength: 80 };

  for (const action of [
    UPSCALE_SUBTLE_ACTION,
    UPSCALE_CREATIVE_ACTION,
    UPSCALE_REDETAIL_ACTION,
    "seedvr2_upscale",
    "upscale_vosr2",
  ]) {
    it(`${action} gets the finish nodes on its SaveImage`, () => {
      expect(UPSCALE_FINISH_ACTIONS.has(action)).toBe(true);
      const wf = build(action, params);
      const saves = byClass(wf, "SaveImage");
      expect(saves.length).toBeGreaterThan(0);
      for (const [, save] of saves) {
        const feed = save.inputs.images as [string, number];
        expect(wf[feed[0]].class_type).toBe("ImageBlend");
        const blend = wf[feed[0]].inputs;
        expect(blend.blend_factor).toBe(0.2);
        expect(wf[(blend.image2 as [string, number])[0]].class_type).toBe(
          "LoadImage",
        );
        expect(wf[(blend.image1 as [string, number])[0]].class_type).toBe(
          "ImageSharpen",
        );
      }
      if (objectInfo) {
        // Only the finish nodes are ours; prompt text is filled at submit.
        const errs = lintErrors(lintGraph(wf, objectInfo))
          .map(formatLintIssue)
          .filter((e) => /_sharpen|_strength|ImageSharpen|ImageBlend/.test(e));
        expect(errs).toEqual([]);
      }
    });
  }

  it("other actions ignore the params", () => {
    const wf = build("vary_subtle", params);
    expect(byClass(wf, "ImageSharpen")).toHaveLength(0);
    expect(byClass(wf, "ImageBlend")).toHaveLength(0);
  });
});

describe("tool cards", () => {
  it("Upscale sends sharpen and strength (all modes)", () => {
    const spec = getActionTool("upscale")!;
    const s = defaultSettings(spec);
    expect(buildActionRequest(spec, s, null).params).not.toHaveProperty(
      "sharpen",
    );
    s.picks.sharpen = "25";
    s.picks.strength = "60";
    for (const mode of [UPSCALE_SUBTLE_ACTION, UPSCALE_REDETAIL_ACTION]) {
      s.picks.mode = mode;
      expect(buildActionRequest(spec, s, null).params).toMatchObject({
        sharpen: 25,
        strength: 60,
      });
    }
    const advanced = spec.sliders!.filter((x) => x.advanced).map((x) => x.key);
    expect(advanced).toEqual(["strength", "sharpen"]);
  });

  it("Photo upscale (VOSR2) card sends them", () => {
    const spec = getActionTool("upscale_vosr2")!;
    const s = defaultSettings(spec);
    expect(buildActionRequest(spec, s, null).params).toEqual({
      scale: "4x",
      color: "wavelet",
    });
    s.picks.sharpen = "15";
    s.picks.strength = "90";
    expect(buildActionRequest(spec, s, null).params).toMatchObject({
      sharpen: 15,
      strength: 90,
    });
  });

  it("Upscale (SeedVR2) image card sends them; the video engine does not", () => {
    const spec = getActionTool("upscale_seedvr2")!;
    const s = defaultSettings(spec);
    s.picks.strength = "85";
    expect(buildActionRequest(spec, s, null).params).toMatchObject({
      strength: 85,
    });
    const video = getActionTool("upscale_video")!;
    const v = defaultSettings(video);
    v.picks.engine = "best";
    v.picks.strength = "50";
    expect(buildActionRequest(video, v, null).params).not.toHaveProperty(
      "strength",
    );
  });
});

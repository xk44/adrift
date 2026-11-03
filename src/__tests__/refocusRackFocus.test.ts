/**
 * Refocus (photo) and Rack focus (clip): DA3 depth -> CJRefocus /
 * CJRackFocus graphs, builders, param sanitizers, registry, routing, tool
 * cards (Photo/Video variants), hub and the click-to-focus picker math.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import registry from "@/lib/oj/registry.json";
import { resolveWorkflow } from "@/lib/oj/packs";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  RACK_FOCUS_ACTION,
  RACK_FOCUS_MAX_FRAMES,
  REFOCUS_ACTION,
  REFOCUS_DEPTH_MODELS,
  buildRackFocusWorkflow,
  buildRefocusWorkflow,
  focusPoint,
  rackFocusEase,
  rackFocusPoints,
  refocusBlurAmount,
  refocusFocusRange,
  refocusHighlights,
} from "@/lib/oj/refocus";
import { DEFAULT_VIDEO_PACKS, routeBackend } from "@/lib/comfy/backends";
import { CARD_OVERRIDES } from "@/lib/tools/hub";
import { mediaVariants } from "@/lib/tools/toolRegistry";
import {
  ToolInputError,
  buildActionRequest,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";
import { normalizedClick } from "@/components/tools/FocusPointPicker";
import type { ImagineRun, Workflow } from "@/types";

const WORKFLOWS_DIR = path.join(process.cwd(), "public/workflows");
const IMG_FILE = "packs/image-tools/refocus.json";
const VID_FILE = "packs/image-tools/rack_focus.json";
const load = (file: string): Workflow => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(WORKFLOWS_DIR, file), "utf-8"),
  );
  delete raw._meta;
  return raw;
};

const run = (media: { images?: string[]; videos?: string[] }): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "src",
    width: 1024,
    height: 1024,
    jobs: [
      {
        seed: 7,
        index: 0,
        status: "completed",
        progress: 100,
        images: media.images ?? [],
        videos: media.videos,
      },
    ],
    createdAt: new Date().toISOString(),
    status: "completed",
    params: {},
  }) as unknown as ImagineRun;

const IMG = "/api/comfy/view?filename=portrait.png&subfolder=&type=input";
const VID = "/api/comfy/view?filename=clip.mp4&subfolder=&type=input";

const one = (wf: Workflow, cls: string) => {
  const hits = Object.entries(wf).filter(([, n]) => n.class_type === cls);
  expect(hits, cls).toHaveLength(1);
  return hits[0];
};

function expectLinksResolve(wf: Workflow) {
  for (const [id, node] of Object.entries(wf)) {
    for (const [k, v] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(v) && typeof v[0] === "string") {
        expect(wf[v[0]], `${id}.${k} → ${v[0]}`).toBeDefined();
      }
    }
  }
}

describe("param sanitizers", () => {
  it("clamps focus points and keeps times", () => {
    expect(focusPoint({ x: 1.4, y: -2 })).toEqual({ x: 1, y: 0 });
    expect(focusPoint({ x: "0.25", y: 0.5, t: 1.234 })).toEqual({
      x: 0.25,
      y: 0.5,
      t: 1.23,
    });
    expect(focusPoint({ x: 0.5 })).toBeNull();
    expect(focusPoint(null)).toBeNull();
  });

  it("maps the 0..100 sliders to node units", () => {
    expect(refocusBlurAmount(100)).toBe(6);
    expect(refocusBlurAmount(50)).toBe(3);
    expect(refocusBlurAmount(500)).toBe(6);
    expect(refocusBlurAmount(undefined)).toBeCloseTo(2.4);
    expect(refocusHighlights(30)).toBe(0.3);
    expect(refocusHighlights(-5)).toBe(0);
    expect(refocusFocusRange("shallow")).toBeLessThan(
      refocusFocusRange("normal"),
    );
    expect(refocusFocusRange("bogus")).toBe(refocusFocusRange("normal"));
    expect(rackFocusEase("ease_out")).toBe("ease_out");
    expect(rackFocusEase("bounce")).toBe("smooth");
  });

  it("orders rack points by time and defaults missing times", () => {
    const r = rackFocusPoints(
      { x: 0.1, y: 0.1, t: 3 },
      { x: 0.9, y: 0.9, t: 1 },
    );
    expect(r.a).toEqual({ x: 0.9, y: 0.9, t: 1 });
    expect(r.b).toEqual({ x: 0.1, y: 0.1, t: 3 });
    const d = rackFocusPoints({ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 });
    expect([d.a.t, d.b.t]).toEqual([0, 2]);
    expect(() => rackFocusPoints({ x: 0.2, y: 0.2 }, undefined)).toThrow();
  });
});

describe("refocus graph + builder", () => {
  it("is LoadImage -> DA3 depth -> CJRefocus -> SaveImage", () => {
    const wf = load(IMG_FILE);
    expectLinksResolve(wf);
    const [loadId] = one(wf, "LoadImage");
    const [depthId] = one(wf, "DA3Render");
    const [, lens] = one(wf, "CJRefocus");
    const [, save] = one(wf, "SaveImage");
    const [, loader] = one(wf, "LoadDA3Model");
    expect(lens.inputs.image).toEqual([loadId, 0]);
    expect(lens.inputs.depth).toEqual([depthId, 0]);
    expect(wf[depthId].inputs.output).toBe("depth");
    expect(Object.values(REFOCUS_DEPTH_MODELS)).toContain(
      loader.inputs.model_name,
    );
    expect(String(save.inputs.filename_prefix)).toMatch(/^CJ_Refocus\//);
  });

  it("patches the image, focus point, lens and depth model", () => {
    const { workflow, slots } = buildRefocusWorkflow(
      load(IMG_FILE),
      run({ images: [IMG] }),
      0,
      {
        focus: { x: 0.3, y: 0.7 },
        blur: 100,
        highlights: 0,
        depthOfField: "deep",
        depthModel: "fast",
      },
    );
    const [loadId, loadNode] = one(workflow, "LoadImage");
    const [, lens] = one(workflow, "CJRefocus");
    const [, loader] = one(workflow, "LoadDA3Model");
    const [, infer] = one(workflow, "DA3Inference");
    expect(slots.imageInputId).toBe(loadId);
    expect(loadNode.inputs.image).toBe("portrait.png [input]");
    expect(lens.inputs).toMatchObject({
      focus_x: 0.3,
      focus_y: 0.7,
      blur_amount: 6,
      highlights: 0,
      focus_range: refocusFocusRange("deep"),
    });
    expect(loader.inputs.model_name).toBe(REFOCUS_DEPTH_MODELS.fast);
    expect(Number(infer.inputs.resolution) % 14).toBe(0);
  });

  it("refuses a run without an image", () => {
    expect(() => buildRefocusWorkflow(load(IMG_FILE), run({}), 0, {})).toThrow(
      /no image/,
    );
  });
});

describe("rack focus graph + builder", () => {
  it("is LoadVideo -> cap -> components -> DA3 per frame -> CJRackFocus -> CreateVideo (fps + audio)", () => {
    const wf = load(VID_FILE);
    expectLinksResolve(wf);
    const [compId] = one(wf, "GetVideoComponents");
    const [depthId] = one(wf, "DA3Render");
    const [lensId, lens] = one(wf, "CJRackFocus");
    const [, create] = one(wf, "CreateVideo");
    const [, infer] = one(wf, "DA3Inference");
    one(wf, "SaveVideo");
    expect(infer.inputs.image).toEqual([compId, 0]);
    expect(infer.inputs.mode).toBe("mono");
    expect(lens.inputs.images).toEqual([compId, 0]);
    expect(lens.inputs.depth).toEqual([depthId, 0]);
    expect(lens.inputs.fps).toEqual([compId, 2]);
    expect(create.inputs).toMatchObject({
      images: [lensId, 0],
      fps: [compId, 2],
      audio: [compId, 1],
    });
  });

  it("patches the clip, the cap, both points, times and ease", () => {
    const { workflow, slots, seed } = buildRackFocusWorkflow(
      load(VID_FILE),
      run({ videos: [VID] }),
      0,
      {
        focusA: { x: 0.8, y: 0.2, t: 2.5 },
        focusB: { x: 0.1, y: 0.6, t: 0.5 },
        ease: "linear",
        blur: 50,
      },
    );
    const [videoId, video] = one(workflow, "LoadVideo");
    const [, cap] = one(workflow, "VideoTemporalCrop");
    const [, lens] = one(workflow, "CJRackFocus");
    expect(slots.imageInputId).toBe(videoId);
    expect(seed).toBe(7);
    expect(video.inputs.file).toBe("clip.mp4 [input]");
    expect(cap.inputs).toMatchObject({
      start_frame: 0,
      length: RACK_FOCUS_MAX_FRAMES,
    });
    expect(lens.inputs).toMatchObject({
      a_x: 0.1,
      a_y: 0.6,
      a_time: 0.5,
      b_x: 0.8,
      b_y: 0.2,
      b_time: 2.5,
      ease: "linear",
      blur_amount: 3,
    });
  });

  it("refuses a run without a video or without both points", () => {
    expect(() =>
      buildRackFocusWorkflow(load(VID_FILE), run({ images: [IMG] }), 0, {}),
    ).toThrow(/no video/);
    expect(() =>
      buildRackFocusWorkflow(load(VID_FILE), run({ videos: [VID] }), 0, {
        focusA: { x: 0.5, y: 0.5 },
      }),
    ).toThrow(/point A and point B/);
  });
});

describe("registration", () => {
  it("registers templates, actions, builders and the video-input flag", () => {
    const reg = registry as unknown as {
      templates: Record<string, { file: string }>;
      actions: Record<string, { template: string; requiresImage: boolean }>;
    };
    expect(reg.templates.refocus.file).toBe(IMG_FILE);
    expect(reg.templates.rack_focus.file).toBe(VID_FILE);
    expect(reg.actions.refocus).toMatchObject({
      template: "refocus",
      requiresImage: true,
    });
    expect(reg.actions.rack_focus).toMatchObject({
      template: "rack_focus",
      requiresImage: false,
    });
    expect(actionBuilderFor(REFOCUS_ACTION)).toBe(buildRefocusWorkflow);
    expect(actionBuilderFor(RACK_FOCUS_ACTION)).toBe(buildRackFocusWorkflow);
    expect(VIDEO_INPUT_ACTIONS.has(RACK_FOCUS_ACTION)).toBe(true);
    expect(VIDEO_INPUT_ACTIONS.has(REFOCUS_ACTION)).toBe(false);
    expect(
      resolveWorkflow({ templateOrAction: REFOCUS_ACTION }).workflowPath,
    ).toBe(IMG_FILE);
    expect(
      resolveWorkflow({ templateOrAction: RACK_FOCUS_ACTION }).workflowPath,
    ).toBe(VID_FILE);
  });

  it("routes both to the video host (where the nodes and DA3 live)", () => {
    expect(DEFAULT_VIDEO_PACKS).toContain("image-tools");
    const prev = process.env.COMFY_VIDEO_HTTP_URL;
    process.env.COMFY_VIDEO_HTTP_URL = "http://10.0.0.2:8188";
    try {
      expect(
        routeBackend({ action: REFOCUS_ACTION, workflowPath: IMG_FILE }),
      ).toBe("video");
      expect(
        routeBackend({ action: RACK_FOCUS_ACTION, workflowPath: VID_FILE }),
      ).toBe("video");
    } finally {
      if (prev === undefined) delete process.env.COMFY_VIDEO_HTTP_URL;
      else process.env.COMFY_VIDEO_HTTP_URL = prev;
    }
  });

  it("is one Photo/Video card on the hub", () => {
    expect(mediaVariants("refocus")?.map((v) => v.id)).toEqual([
      "refocus",
      "rack_focus",
    ]);
    expect(CARD_OVERRIDES["action:refocus"]).toMatchObject({ hub: "Edit" });
    expect(CARD_OVERRIDES["action:rack_focus"]).toMatchObject({ hub: "Video" });
  });
});

describe("tool specs → requests", () => {
  it("refocus needs a click and sends the point + lens", () => {
    const spec = getActionTool("refocus")!;
    expect(spec.modelCheck).toEqual({ pack: "image-tools", action: "refocus" });
    const s = defaultSettings(spec);
    expect(() => buildActionRequest(spec, s, null)).toThrow(ToolInputError);
    s.focusPoints = [{ x: 0.4, y: 0.6 }];
    s.picks.blur = "80";
    const req = buildActionRequest(spec, s, null);
    expect(req.action).toBe("refocus");
    expect(req.params).toMatchObject({
      focus: { x: 0.4, y: 0.6 },
      blur: 80,
      highlights: 30,
      depthOfField: "normal",
      depthModel: "quality",
    });
  });

  it("rack focus needs A and B and sends both with times", () => {
    const spec = getActionTool("rack_focus")!;
    expect(spec.videoInput).toBeTruthy();
    const s = defaultSettings(spec);
    s.focusPoints = [{ x: 0.2, y: 0.3, t: 0 }];
    expect(() => buildActionRequest(spec, s, null)).toThrow(ToolInputError);
    s.focusPoints.push({ x: 0.7, y: 0.4, t: 1.5 });
    s.picks.ease = "ease_out";
    const req = buildActionRequest(spec, s, null);
    expect(req.action).toBe("rack_focus");
    expect(req.params).toMatchObject({
      focusA: { x: 0.2, y: 0.3, t: 0 },
      focusB: { x: 0.7, y: 0.4, t: 1.5 },
      ease: "ease_out",
    });
  });
});

describe("focus picker click math", () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 };
  it("normalizes clicks inside the media", () => {
    expect(normalizedClick(300, 150, rect)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizedClick(100, 250, rect)).toEqual({ x: 0, y: 1 });
  });
  it("ignores clicks outside or on an unsized element", () => {
    expect(normalizedClick(99, 150, rect)).toBeNull();
    expect(normalizedClick(300, 150, { ...rect, width: 0 })).toBeNull();
  });
});

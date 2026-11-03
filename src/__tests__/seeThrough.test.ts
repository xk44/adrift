/**
 * Layer Split (see-through): graph shape, builder knobs (detail, steps, seed,
 * left/right split, low VRAM), node specs recorded from the GPU box,
 * registry, routing, hub card and tool spec → request.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import registry from "@/lib/oj/registry.json";
import { resolveWorkflow } from "@/lib/oj/packs";
import { actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  SEE_THROUGH_ACTION,
  SEE_THROUGH_ID,
  SEE_THROUGH_PREFIX,
  buildSeeThroughWorkflow,
  seeThroughResolution,
  seeThroughSeed,
  seeThroughSteps,
} from "@/lib/oj/seeThrough";
import { DEFAULT_VIDEO_PACKS, routeBackend } from "@/lib/comfy/backends";
import { validatePrompt } from "@/lib/comfy/validatePrompt";
import { CARD_OVERRIDES } from "@/lib/tools/hub";
import { TOOL_NAMES } from "@/lib/tools/toolNames";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";
import type { ImagineRun, Workflow } from "@/types";

const FILE = "packs/image-tools/see_through.json";
const RAW = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "public/workflows", FILE), "utf-8"),
);
const load = (): Workflow => {
  const { _meta, ...wf } = structuredClone(RAW);
  return wf as Workflow;
};

const { _meta: _infoMeta, ...INFO } = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/seeThroughNodes.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, any>;

const IMG = "/api/comfy/view?filename=chara.png&subfolder=&type=input";
const run = (images: string[]): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "src",
    width: 1024,
    height: 1024,
    jobs: [{ seed: 3, index: 0, status: "done", progress: 100, images }],
    createdAt: new Date().toISOString(),
    status: "done",
    params: {},
  }) as unknown as ImagineRun;

const build = (params: Record<string, unknown> = {}) =>
  buildSeeThroughWorkflow(load(), run([IMG]), 0, params);

function expectLinksResolve(wf: Workflow) {
  for (const [id, node] of Object.entries(wf)) {
    for (const [k, v] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(v) && typeof v[0] === "string")
        expect(wf[v[0]], `${id}.${k} → ${v[0]}`).toBeDefined();
    }
  }
}

describe("see_through graph", () => {
  it("is LoadImage -> layers -> depth -> post -> SavePSD + CJLayerPreview", () => {
    const wf = load();
    expectLinksResolve(wf);
    const I = SEE_THROUGH_ID;
    expect(wf[I.layerModel].inputs).toMatchObject({
      model: "layerdifforg/seethroughv0.0.2_layerdiff3d",
      quant_mode: "none",
      auto_download: false,
      group_offload: false,
    });
    expect(wf[I.depthModel].inputs).toMatchObject({
      model: "layerdifforg/seethroughv0.0.1_marigold",
      auto_download: false,
    });
    expect(wf[I.layers].inputs).toMatchObject({
      image: [I.loadImage, 0],
      layerdiff_model: [I.layerModel, 0],
      resolution: 1280,
      num_inference_steps: 30,
    });
    expect(wf[I.depth].inputs).toMatchObject({
      layers: [I.layers, 0],
      depth_model: [I.depthModel, 0],
      resolution_depth: -1,
    });
    expect(wf[I.post].inputs).toMatchObject({
      layers_depth: [I.depth, 0],
      tblr_split: true,
      use_lama: false,
    });
    expect(wf[I.save]).toMatchObject({
      class_type: "SeeThrough_SavePSD",
      inputs: { parts: [I.post, 0], filename_prefix: SEE_THROUGH_PREFIX },
    });
    expect(wf[I.manifest]).toMatchObject({
      class_type: "PreviewAny",
      inputs: { source: [I.save, 0] },
    });
    expect(wf[I.previewRender]).toMatchObject({
      class_type: "CJLayerPreview",
      inputs: { parts: [I.post, 0], height: 1024 },
    });
    expect(wf[I.preview]).toMatchObject({
      class_type: "SaveImage",
      inputs: { images: [I.previewRender, 0] },
    });
    expect(SEE_THROUGH_PREFIX).not.toContain("/");
  });

  it("validates against the recorded node specs", () => {
    for (const params of [
      {},
      { detail: "fast", steps: 20, split: false, lowVram: true, seed: 9 },
    ]) {
      const wf = build(params).workflow;
      for (const node of Object.values(wf))
        expect(INFO[node.class_type], node.class_type).toBeDefined();
      const problems = validatePrompt(wf, INFO).filter(
        (p) => !(p.classType === "LoadImage" && p.input === "image"),
      );
      expect(problems).toEqual([]);
    }
    const opts = JSON.stringify(
      INFO.SeeThrough_LoadLayerDiffModel.input.required.model,
    );
    expect(opts).toContain("layerdifforg/seethroughv0.0.2_layerdiff3d");
  });
});

describe("see_through builder", () => {
  it("patches the source image and keeps the defaults", () => {
    const { workflow, slots, seed } = build({ seed: 1234 });
    const I = SEE_THROUGH_ID;
    expect(workflow[I.loadImage].inputs.image).toBe("chara.png [input]");
    expect(slots.imageInputId).toBe(I.loadImage);
    expect(seed).toBe(1234);
    expect(workflow[I.layers].inputs.seed).toBe(1234);
    expect(workflow[I.depth].inputs.seed).toBe(1234);
    expect(workflow[I.layers].inputs.resolution).toBe(1280);
    expect(workflow[I.layers].inputs.num_inference_steps).toBe(30);
    expect(workflow[I.post].inputs.tblr_split).toBe(true);
    expect(workflow[I.layerModel].inputs.group_offload).toBe(false);
    expect(workflow[I.depthModel].inputs.group_offload).toBe(false);
  });

  it("fast detail, 20 steps, no split, low VRAM on both loaders", () => {
    const { workflow } = build({
      detail: "fast",
      steps: 20,
      split: false,
      lowVram: true,
    });
    const I = SEE_THROUGH_ID;
    expect(workflow[I.layers].inputs.resolution).toBe(1024);
    expect(workflow[I.layers].inputs.num_inference_steps).toBe(20);
    expect(workflow[I.post].inputs.tblr_split).toBe(false);
    expect(workflow[I.layerModel].inputs.group_offload).toBe(true);
    expect(workflow[I.depthModel].inputs.group_offload).toBe(true);
  });

  it("accepts pick strings for the toggles and steps", () => {
    const { workflow } = build({ split: "off", lowVram: "on", steps: "20" });
    const I = SEE_THROUGH_ID;
    expect(workflow[I.post].inputs.tblr_split).toBe(false);
    expect(workflow[I.layerModel].inputs.group_offload).toBe(true);
    expect(workflow[I.layers].inputs.num_inference_steps).toBe(20);
  });

  it("sanitizes params", () => {
    expect(seeThroughResolution("FAST")).toBe(1024);
    expect(seeThroughResolution("bogus")).toBe(1280);
    expect(seeThroughSteps(7)).toBe(30);
    expect(seeThroughSteps("20")).toBe(20);
    expect(seeThroughSeed(5.7)).toBe(5);
    expect(seeThroughSeed(2 ** 32 + 2)).toBe(2);
    for (const bad of [undefined, -1, "", "x", NaN]) {
      const s = seeThroughSeed(bad);
      expect(Number.isInteger(s) && s >= 0 && s < 2 ** 32).toBe(true);
    }
  });

  it("refuses a run without an image or a graph missing a node", () => {
    expect(() => buildSeeThroughWorkflow(load(), run([]), 0, {})).toThrow(
      /no image/,
    );
    const wf = load();
    delete wf[SEE_THROUGH_ID.manifest];
    expect(() => buildSeeThroughWorkflow(wf, run([IMG]), 0, {})).toThrow(
      /missing node 8/,
    );
  });
});

describe("see_through registration", () => {
  it("is registered, routed to the video host and on the Edit hub", () => {
    const reg = registry as unknown as {
      templates: Record<string, { file: string }>;
      actions: Record<string, { template: string; requiresImage: boolean }>;
    };
    expect(reg.templates.see_through.file).toBe(FILE);
    expect(reg.actions.see_through).toMatchObject({
      template: "see_through",
      requiresImage: true,
    });
    expect(actionBuilderFor(SEE_THROUGH_ACTION)).toBe(buildSeeThroughWorkflow);
    expect(
      resolveWorkflow({ templateOrAction: SEE_THROUGH_ACTION }).workflowPath,
    ).toBe(FILE);
    expect(DEFAULT_VIDEO_PACKS).toContain("image-tools");
    const prev = process.env.COMFY_VIDEO_HTTP_URL;
    process.env.COMFY_VIDEO_HTTP_URL = "http://10.0.0.2:8188";
    try {
      expect(
        routeBackend({ action: SEE_THROUGH_ACTION, workflowPath: FILE }),
      ).toBe("video");
    } finally {
      if (prev === undefined) delete process.env.COMFY_VIDEO_HTTP_URL;
      else process.env.COMFY_VIDEO_HTTP_URL = prev;
    }
    expect(CARD_OVERRIDES["action:see_through"]).toMatchObject({ hub: "Edit" });
    expect(TOOL_NAMES["action:see_through"].title).toBe("Layer Split");
  });

  it("tool spec sends the picks and the seed", () => {
    const spec = getActionTool("see_through")!;
    expect(spec.title).toBe("Layer Split");
    expect(spec.credit).toBe(
      "Layers by see-through (shitagaki-lab, MIT node pack; weights RAIL++-M)",
    );
    expect(spec.modelCheck).toEqual({
      pack: "image-tools",
      action: "see_through",
    });
    const s = defaultSettings(spec);
    expect(buildActionRequest(spec, s, null)).toEqual({
      action: "see_through",
      params: { detail: "max", steps: 30, split: true, lowVram: false },
      overrides: {},
    });
    s.picks.detail = "fast";
    s.picks.steps = "20";
    s.picks.split = "off";
    s.picks.lowVram = "on";
    s.seed = 77;
    expect(buildActionRequest(spec, s, null).params).toEqual({
      detail: "fast",
      steps: 20,
      split: false,
      lowVram: true,
      seed: 77,
    });
  });
});

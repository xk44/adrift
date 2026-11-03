/**
 * Layers (Qwen-Image-Layered RGBA decomposition) and Edit video (Lucy Edit
 * Dev via core InstructPixToPixConditioning): graphs, builders, registry,
 * routing and tool wiring.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import registry from "@/lib/oj/registry.json";
import { resolveWorkflow } from "@/lib/oj/packs";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  LAYERS_ACTION,
  buildLayersWorkflow,
  layersCount,
  layersResolution,
} from "@/lib/oj/qwenLayers";
import {
  VIDEO_EDIT_ACTION,
  buildVideoEditWorkflow,
  videoEditDims,
} from "@/lib/oj/lucyEdit";
import { DEFAULT_VIDEO_PACKS, routeBackend } from "@/lib/comfy/backends";
import { workflowModelRequirements } from "@/lib/tools/modelStatus";
import { CARD_OVERRIDES } from "@/lib/tools/hub";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";
import type { ImagineRun, Workflow } from "@/types";

const WORKFLOWS_DIR = path.join(process.cwd(), "public/workflows");
const LAYERS_FILE = "packs/qwen-layered/layers.json";
const EDIT_FILE = "packs/wan22/video_edit.json";
const load = (file: string): Workflow => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(WORKFLOWS_DIR, file), "utf-8"),
  );
  delete raw._meta;
  return raw;
};

const run = (
  media: { images?: string[]; videos?: string[] },
  extra: Partial<ImagineRun> = {},
): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "src",
    width: 1024,
    height: 1024,
    jobs: [
      { seed: 11, index: 0, status: "completed", progress: 100, ...media },
    ],
    createdAt: new Date().toISOString(),
    status: "completed",
    params: {},
    ...extra,
  }) as unknown as ImagineRun;

const IMG = "/api/comfy/view?filename=bike.png&subfolder=&type=input";
const VID = "/api/comfy/view?filename=dance.mp4&subfolder=&type=input";

const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf)
    .filter(([, n]) => n.class_type === cls)
    .sort(([a], [b]) => Number(a) - Number(b));

function expectLinksResolve(wf: Workflow) {
  for (const [id, node] of Object.entries(wf)) {
    for (const [k, v] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(v) && typeof v[0] === "string") {
        expect(wf[v[0]], `${id}.${k} → ${v[0]}`).toBeDefined();
      }
    }
  }
}

describe("layers graph + builder", () => {
  it("saves the flattened preview first, then the RGBA layers", () => {
    const wf = load(LAYERS_FILE);
    expectLinksResolve(wf);
    const saves = byClass(wf, "SaveImage");
    expect(saves).toHaveLength(2);
    const [[, preview], [, layers]] = saves;
    expect(preview.inputs.filename_prefix).toBe("CJ_Layers/preview");
    expect(layers.inputs.filename_prefix).toBe("CJ_Layers/layer");
    // preview: frame 0 only, alpha dropped
    const split = wf[(preview.inputs.images as [string, number])[0]];
    expect(split.class_type).toBe("SplitImageWithAlpha");
    const cuts = byClass(wf, "LatentCut").map(([, n]) => n.inputs);
    expect(cuts).toEqual([
      expect.objectContaining({ dim: "t", index: 0, amount: 1 }),
      expect.objectContaining({ dim: "t", index: 1 }),
    ]);
    expect(JSON.stringify(wf)).not.toMatch(/\/Users\/|\/home\//);
  });

  it("needs the layered model, layered VAE and Qwen2.5-VL", () => {
    expect(
      workflowModelRequirements(load(LAYERS_FILE)).map(
        (r) => `${r.dir}/${r.file}`,
      ),
    ).toEqual([
      "diffusion_models/qwen_image_layered_fp8mixed.safetensors",
      "text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
      "vae/qwen_image_layered_vae.safetensors",
    ]);
  });

  it("patches image, layer count, resolution, caption, speed and seed", () => {
    const { workflow, slots, seed } = buildLayersWorkflow(
      load(LAYERS_FILE),
      run({ images: [IMG] }),
      0,
      {
        layers: 6,
        resolution: 1024,
        speed: "best",
        text: "  a  bike ",
        seed: 7,
      },
    );
    expect(seed).toBe(7);
    expect(byClass(workflow, "LoadImage")[0][1].inputs.image).toBe(
      "bike.png [input]",
    );
    expect(
      byClass(workflow, "ImageScaleToMaxDimension")[0][1].inputs.largest_size,
    ).toBe(1024);
    expect(
      byClass(workflow, "EmptyQwenImageLayeredLatentImage")[0][1].inputs.layers,
    ).toBe(6);
    const k = workflow[slots.ksamplerId].inputs;
    expect([k.steps, k.cfg, k.seed]).toEqual([50, 4, 7]);
    expect(workflow[slots.posTextId].inputs.text).toBe("a bike");
  });

  it("defaults: 4 layers, 640 px, 20 steps cfg 2.5, empty caption", () => {
    const { workflow, slots } = buildLayersWorkflow(
      load(LAYERS_FILE),
      run({ images: [IMG] }),
      0,
    );
    expect(
      byClass(workflow, "EmptyQwenImageLayeredLatentImage")[0][1].inputs.layers,
    ).toBe(4);
    expect(workflow[slots.ksamplerId].inputs.steps).toBe(20);
    expect(workflow[slots.ksamplerId].inputs.cfg).toBe(2.5);
    expect(workflow[slots.posTextId].inputs.text).toBe("");
    expect(layersCount("99")).toBe(8);
    expect(layersCount(1)).toBe(2);
    expect(layersResolution("777")).toBe(640);
  });

  it("throws without a source image", () => {
    expect(() =>
      buildLayersWorkflow(load(LAYERS_FILE), run({ images: [] }), 0),
    ).toThrow(/no image/);
  });
});

describe("video_edit graph + builder", () => {
  it("is core-only Lucy: ip2p concat latent, Wan2.2 VAE, no Lucy node", () => {
    const wf = load(EDIT_FILE);
    expectLinksResolve(wf);
    const classes = Object.values(wf).map((n) => n.class_type);
    expect(classes.some((c) => /lucy/i.test(c))).toBe(false);
    const [[condId]] = byClass(wf, "InstructPixToPixConditioning");
    const k = byClass(wf, "KSampler")[0][1].inputs;
    expect(k.latent_image).toEqual([condId, 2]);
    expect(k.positive).toEqual([condId, 0]);
    expect(k.negative).toEqual([condId, 1]);
    expect(JSON.stringify(wf)).not.toMatch(/\/Users\/|\/home\//);
    expect(
      workflowModelRequirements(wf).map((r) => `${r.dir}/${r.file}`),
    ).toEqual([
      "diffusion_models/lucy-edit-dev-cui-fp16.safetensors",
      "text_encoders/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
      "vae/wan2.2_vae.safetensors",
    ]);
  });

  it("sets clip, window, dims (x32), prompt, speed and seed", () => {
    const { workflow, slots, seed } = buildVideoEditWorkflow(
      load(EDIT_FILE),
      run({ videos: [VID] }, { width: 480, height: 832 }),
      0,
      {
        prompt: "Change the shirt to red",
        video_seconds: 3.2,
        speed: "fast",
        seed: 5,
      },
    );
    expect(seed).toBe(5);
    expect(byClass(workflow, "LoadVideo")[0][1].inputs.file).toBe(
      "dance.mp4 [input]",
    );
    expect(byClass(workflow, "VideoFrameSample")[0][1].inputs.num_frames).toBe(
      49,
    );
    expect(byClass(workflow, "Video Slice")[0][1].inputs.duration).toBe(
      49 / 16,
    );
    const scale = byClass(workflow, "ImageScale")[0][1].inputs;
    expect([scale.width, scale.height]).toEqual([480, 832]);
    expect(workflow[slots.posTextId].inputs.text).toBe(
      "Change the shirt to red",
    );
    expect(workflow[slots.ksamplerId].inputs.steps).toBe(20);
    expect(workflow[slots.ksamplerId].inputs.seed).toBe(5);
  });

  it("dims are 480 short edge, multiples of 32, long edge <= 832", () => {
    expect(videoEditDims(1920, 1080)).toEqual({ width: 832, height: 480 });
    expect(videoEditDims(1080, 1920)).toEqual({ width: 480, height: 832 });
    expect(videoEditDims(1440, 1080)).toEqual({ width: 640, height: 480 });
    expect(videoEditDims(1080, 1080)).toEqual({ width: 480, height: 480 });
    const d = videoEditDims(1500, 1000);
    expect(d.width % 32).toBe(0);
  });

  it("requires a prompt and a source clip", () => {
    expect(() =>
      buildVideoEditWorkflow(load(EDIT_FILE), run({ videos: [VID] }), 0, {}),
    ).toThrow(/prompt/);
    expect(() =>
      buildVideoEditWorkflow(load(EDIT_FILE), run({ images: [IMG] }), 0, {
        prompt: "x",
      }),
    ).toThrow(/no video/);
  });
});

describe("registry, routing, tools page, hub", () => {
  const templates = registry.templates as Record<string, { file: string }>;
  const actions = registry.actions as Record<string, Record<string, unknown>>;

  it("registers both actions with builders; only video_edit takes a clip", () => {
    expect(templates[LAYERS_ACTION].file).toBe(LAYERS_FILE);
    expect(templates[VIDEO_EDIT_ACTION].file).toBe(EDIT_FILE);
    expect(actions[LAYERS_ACTION]).toMatchObject({ requiresImage: true });
    expect(actions[VIDEO_EDIT_ACTION]).toMatchObject({ requiresImage: false });
    expect(actionBuilderFor(LAYERS_ACTION)).toBe(buildLayersWorkflow);
    expect(actionBuilderFor(VIDEO_EDIT_ACTION)).toBe(buildVideoEditWorkflow);
    expect(VIDEO_INPUT_ACTIONS.has(VIDEO_EDIT_ACTION)).toBe(true);
    expect(VIDEO_INPUT_ACTIONS.has(LAYERS_ACTION)).toBe(false);
    expect(
      resolveWorkflow({ templateOrAction: LAYERS_ACTION }).workflowPath,
    ).toBe(LAYERS_FILE);
    expect(
      resolveWorkflow({ templateOrAction: VIDEO_EDIT_ACTION }).workflowPath,
    ).toBe(EDIT_FILE);
  });

  it("routes both packs to the video host", () => {
    expect(DEFAULT_VIDEO_PACKS).toContain("qwen-layered");
    const prev = process.env.COMFY_VIDEO_HTTP_URL;
    process.env.COMFY_VIDEO_HTTP_URL = "http://10.0.0.2:8188";
    try {
      expect(
        routeBackend({ action: LAYERS_ACTION, workflowPath: LAYERS_FILE }),
      ).toBe("video");
      expect(
        routeBackend({ action: VIDEO_EDIT_ACTION, workflowPath: EDIT_FILE }),
      ).toBe("video");
    } finally {
      if (prev === undefined) delete process.env.COMFY_VIDEO_HTTP_URL;
      else process.env.COMFY_VIDEO_HTTP_URL = prev;
    }
  });

  it("tool specs map settings to action params", () => {
    const layers = getActionTool("layers")!;
    expect(layers.modelCheck).toEqual({
      pack: "qwen-layered",
      action: "layers",
    });
    expect(buildActionRequest(layers, defaultSettings(layers), null)).toEqual({
      action: "layers",
      params: { layers: 4, resolution: 640, speed: "fast" },
      overrides: {},
    });
    expect(
      buildActionRequest(
        layers,
        { ...defaultSettings(layers), text: "a bike", picks: { layers: "6" } },
        null,
      ).params,
    ).toMatchObject({ layers: 6, text: "a bike" });

    const edit = getActionTool("video_edit")!;
    expect(edit.videoInput).toBeTruthy();
    expect(edit.modelCheck).toEqual({ pack: "wan22", action: "video_edit" });
    expect(() =>
      buildActionRequest(edit, defaultSettings(edit), null),
    ).toThrow();
    expect(
      buildActionRequest(
        edit,
        { ...defaultSettings(edit), text: "Add a hat" },
        null,
      ),
    ).toEqual({
      action: "video_edit",
      params: { prompt: "Add a hat", speed: "balanced" },
      overrides: {},
    });
  });

  it("hub: video_edit carries the non-commercial badge, layers does not", () => {
    expect(CARD_OVERRIDES["action:video_edit"]).toMatchObject({
      hub: "Video",
      nc: true,
    });
    expect(CARD_OVERRIDES["action:layers"]).toMatchObject({ hub: "Edit" });
    expect(CARD_OVERRIDES["action:layers"].nc).toBeFalsy();
  });
});

/**
 * LTX VFX tools (src/lib/oj/ltxVfx.ts, packs/ltx25/vfx_*.json): thirteen LTX-2.5
 * LoRA tools. Packs are checked against an object_info snapshot of the pc's
 * core ComfyUI (LTX-2.5 nodes), builders against the model-card settings.
 */
import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { COMFY_HTTP_URL: "http://mac:8188", COMFY_ROOT: "/nonexistent" },
}));

import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import ltxNodes from "./fixtures/ltxVfxNodes.objectInfo.json";
import { validatePrompt } from "@/lib/comfy/validatePrompt";
import { routeBackend } from "@/lib/comfy/backends";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  LTX_ADD_WATER_ACTION,
  LTX_ALPHA_MATTE_ACTION,
  LTX_BLOCKOUT_RENDER_ACTION,
  LTX_CINEMAGRAPH_ACTION,
  LTX_CLEAN_PLATE_ACTION,
  LTX_DAY_TO_NIGHT_ACTION,
  LTX_EDGE_CONTROL_ACTION,
  LTX_EXPLODED_VIEW_ACTION,
  LTX_FLUID_TRIGGER,
  LTX_LAYOUT_RENDER_ACTION,
  LTX_PAINT_FLUID_ACTION,
  LTX_RIPPLE_ACTION,
  LTX_RIPPLE_PROMPT,
  LTX_SDR_TO_HDR_ACTION,
  LTX_SDR_TO_HDR_PROMPT,
  LTX_SLOW_MOTION_ACTION,
  LTX_VFX_ACTIONS,
  LTX_VFX_IC_IMAGE_ACTIONS,
  LTX_VFX_VIDEO_ACTIONS,
  ltxSlowmoMotionFps,
  ltxSlowmoSpeed,
  ltxVfxDims,
  ltxVfxFrames,
  ltxVfxPrompt,
  ltxVfxStrength,
  stripSlowMotionWords,
} from "@/lib/oj/ltxVfx";
import {
  CATEGORY_ORDER,
  actionAvailability,
  buildActionRequest,
  buildToolCards,
  defaultSettings,
  getActionTool,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import { toHubCard } from "@/lib/tools/hub";
import { isNewCard } from "@/lib/tools/hubVisuals";
import { BOARD_TOOLS } from "@/lib/tools/board";
import {
  MASTER_SUBFOLDER,
  addMasterOutputs,
  isMasterNode,
} from "@/lib/output/saveNodes";

const PACKS = path.join(process.cwd(), "public/workflows");
const reg = registry as unknown as {
  templates: Record<string, { file: string }>;
  actions: Record<
    string,
    { template: string; requiresImage?: boolean; group?: string }
  >;
};
const raw = (action: string): Record<string, unknown> =>
  JSON.parse(
    fs.readFileSync(
      path.join(PACKS, reg.templates[reg.actions[action].template].file),
      "utf8",
    ),
  );
/** As the server loads packs: the top-level "_meta" key is stripped. */
const load = (action: string): Workflow =>
  Object.fromEntries(
    Object.entries(raw(action)).filter(([k]) => !k.startsWith("_")),
  ) as Workflow;

const INFO = ltxNodes as unknown as Record<
  string,
  {
    input: {
      required?: Record<string, unknown>;
      optional?: Record<string, unknown>;
    };
  }
>;

/** "parent.child": a sub-input of the picked COMFY_DYNAMICCOMBO_V3 option. */
function dynamicSubInput(
  declared: Record<string, unknown>,
  inputs: Record<string, unknown>,
  key: string,
): boolean {
  const dot = key.indexOf(".");
  if (dot < 0) return false;
  const parent = key.slice(0, dot);
  const spec = declared[parent] as
    | [string, { options?: { key: string; inputs?: Record<string, Record<string, unknown>> }[] }]
    | undefined;
  if (!spec || spec[0] !== "COMFY_DYNAMICCOMBO_V3") return false;
  const picked = spec[1].options?.find((o) => o.key === inputs[parent]);
  const sub = { ...picked?.inputs?.required, ...picked?.inputs?.optional };
  return key.slice(dot + 1) in sub;
}

/** validatePrompt plus: every input key is declared by its class. */
function problems(wf: Workflow): string[] {
  const out = validatePrompt(wf, INFO).map(
    (p) => `${p.nodeId} ${p.kind}: ${p.message}`,
  );
  for (const [id, node] of Object.entries(wf)) {
    const info = INFO[node.class_type];
    if (!info) continue;
    const declared = { ...info.input.required, ...info.input.optional };
    for (const key of Object.keys(node.inputs))
      if (!(key in declared) && !dynamicSubInput(declared, node.inputs, key))
        out.push(`${id}.${key}: undeclared input`);
  }
  return out;
}

const byClass = (wf: Workflow, cls: string) =>
  Object.keys(wf).filter((id) => wf[id].class_type === cls);
const one = (wf: Workflow, cls: string) => {
  const ids = byClass(wf, cls);
  expect(ids).toHaveLength(1);
  return wf[ids[0]].inputs;
};

const clipRun = (over: Partial<ImagineRun> = {}): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "",
    parsedPrompt: "",
    width: 1920,
    height: 1080,
    createdAt: "2026-10-25T00:00:00Z",
    status: "done",
    params: { video_seconds: 3 },
    jobs: [
      {
        seed: 0,
        index: 0,
        status: "done",
        progress: 100,
        images: [],
        videos: [
          "http://127.0.0.1:8188/view?filename=street.mp4&subfolder=&type=input",
        ],
      },
    ],
    ...over,
  }) as unknown as ImagineRun;

const photoRun = (over: Partial<ImagineRun> = {}): ImagineRun =>
  ({
    ...clipRun(),
    params: {},
    jobs: [
      {
        seed: 0,
        index: 0,
        status: "done",
        progress: 100,
        images: [
          "http://127.0.0.1:8188/view?filename=photo.png&subfolder=&type=output",
        ],
      },
    ],
    ...over,
  }) as unknown as ImagineRun;

const build = (
  action: string,
  run: ImagineRun,
  params: Record<string, unknown> = {},
) => actionBuilderFor(action)!(load(action), run, 0, { seed: 7, ...params });

const PARAMS: Record<string, Record<string, unknown>> = {
  [LTX_ALPHA_MATTE_ACTION]: {},
  [LTX_CLEAN_PLATE_ACTION]: {},
  [LTX_DAY_TO_NIGHT_ACTION]: { prompt: "warm street lamps" },
  [LTX_ADD_WATER_ACTION]: { prompt: "the street floods", strength: 1.25 },
  [LTX_CINEMAGRAPH_ACTION]: { prompt: "the waterfall", frames: 49 },
  [LTX_SLOW_MOTION_ACTION]: { prompt: "a dancer spins", speed: 0.05 },
  [LTX_RIPPLE_ACTION]: { secondRefImage: "edit.png [input]" },
  [LTX_EDGE_CONTROL_ACTION]: { prompt: "a watercolor painting" },
  [LTX_BLOCKOUT_RENDER_ACTION]: { prompt: "a rainy neon street" },
  [LTX_EXPLODED_VIEW_ACTION]: { prompt: "the camera" },
  [LTX_PAINT_FLUID_ACTION]: { secondRefImage: "end.png [input]" },
  [LTX_SDR_TO_HDR_ACTION]: { exr: "float" },
  [LTX_LAYOUT_RENDER_ACTION]: {
    prompt: "a sunlit courtyard",
    secondRefImage: "look.png [input]",
  },
};

const runFor = (action: string) =>
  LTX_VFX_VIDEO_ACTIONS.includes(action) ? clipRun() : photoRun();

describe("LTX VFX registry and packs", () => {
  it("registers thirteen actions on packs/ltx25/vfx_*.json", () => {
    expect(LTX_VFX_ACTIONS).toHaveLength(13);
    for (const action of LTX_VFX_ACTIONS) {
      const file = reg.templates[reg.actions[action].template].file;
      expect(file).toMatch(/^packs\/ltx25\/vfx_[a-z_]+\.json$/);
      expect(actionBuilderFor(action)).toBeTypeOf("function");
      const video = LTX_VFX_VIDEO_ACTIONS.includes(action);
      expect(VIDEO_INPUT_ACTIONS.has(action)).toBe(video);
      expect(reg.actions[action].requiresImage).toBe(!video);
    }
    expect(LTX_VFX_VIDEO_ACTIONS).toEqual([
      LTX_ALPHA_MATTE_ACTION,
      LTX_CLEAN_PLATE_ACTION,
      LTX_DAY_TO_NIGHT_ACTION,
      LTX_ADD_WATER_ACTION,
      LTX_RIPPLE_ACTION,
      LTX_EDGE_CONTROL_ACTION,
      LTX_BLOCKOUT_RENDER_ACTION,
      LTX_SDR_TO_HDR_ACTION,
      LTX_LAYOUT_RENDER_ACTION,
    ]);
  });

  it("raw packs validate against the LTX-2.5 object_info", () => {
    for (const action of LTX_VFX_ACTIONS) {
      const meta = raw(action)._meta as {
        title?: string;
        description?: string;
      };
      expect(meta.title).toMatch(/^LTX VFX/);
      expect(meta.description).toMatch(/LTX-2(\.x)? Community License/i);
      expect(problems(load(action)), action).toEqual([]);
    }
  });

  it("each pack loads its own LoRA on the distilled LTX-2.5 model", () => {
    const loras = new Set<string>();
    for (const action of LTX_VFX_ACTIONS) {
      const wf = load(action);
      expect(one(wf, "UNETLoader").unet_name).toMatch(
        /^ltx-2\.5-22b-distilled/,
      );
      const lora = String(one(wf, "LoraLoaderModelOnly").lora_name);
      expect(lora).toMatch(/^ltx25\//);
      loras.add(lora);
      const ic = byClass(wf, "GetICLoRAParameters").length === 1;
      expect(ic).toBe(
        LTX_VFX_VIDEO_ACTIONS.includes(action) ||
          LTX_VFX_IC_IMAGE_ACTIONS.has(action),
      );
      expect(byClass(wf, "SaveVideo")).toHaveLength(1);
    }
    expect(loras.size).toBe(12);
  });

  it("built workflows validate for every tool", () => {
    for (const action of LTX_VFX_ACTIONS) {
      const { workflow } = build(action, runFor(action), PARAMS[action]);
      expect(problems(workflow), action).toEqual([]);
    }
  });
});

describe("LTX VFX builders", () => {
  it("video tools follow the source clip length and orientation", () => {
    const { workflow, slots, seed } = build(LTX_CLEAN_PLATE_ACTION, clipRun());
    expect(seed).toBe(7);
    expect(one(workflow, "LoadVideo").file).toBe("street.mp4 [input]");
    expect(slots.imageInputId).toBe(byClass(workflow, "LoadVideo")[0]);
    // 3 s at 25 fps = 75 frames -> 73 (8n+1).
    expect(one(workflow, "VideoFrameSample").num_frames).toBe(73);
    expect(one(workflow, "Video Slice").duration).toBeCloseTo(73 / 25, 3);
    expect(one(workflow, "EmptyLTXVLatentVideo")).toMatchObject({
      width: 1024,
      height: 576,
      length: 73,
    });
    expect(one(workflow, "ImageScale")).toMatchObject({
      width: 1024,
      height: 576,
    });
    expect(one(workflow, "LTXVEmptyLatentAudio").frames_number).toBe(73);
    expect(one(workflow, "LTXVConditioning").frame_rate).toBe(25);
    expect(one(workflow, "CreateVideo").fps).toBe(25);

    const portrait = build(
      LTX_ALPHA_MATTE_ACTION,
      clipRun({ width: 1080, height: 1920, params: {} }),
    ).workflow;
    expect(one(portrait, "EmptyLTXVLatentVideo")).toMatchObject({
      width: 544,
      height: 960,
      length: 97,
    });
  });

  it("frame helpers stay 8n+1 within card limits", () => {
    expect(ltxVfxFrames(undefined, 24, 97)).toBe(97);
    expect(ltxVfxFrames(60, 24, 121)).toBe(121);
    expect(ltxVfxFrames(0.2, 24, 97)).toBe(17);
    expect((ltxVfxFrames(2.5, 24, 97) - 1) % 8).toBe(0);
    expect(ltxVfxDims(LTX_DAY_TO_NIGHT_ACTION, 1000, 1000)).toEqual({
      width: 768,
      height: 448,
    });
  });

  it("alpha matte always sends an empty prompt", () => {
    const { workflow, slots } = build(LTX_ALPHA_MATTE_ACTION, clipRun(), {
      prompt: "ignored",
    });
    expect(workflow[slots.posTextId].inputs.text).toBe("");
  });

  it("prompts use the model-card templates", () => {
    expect(ltxVfxPrompt(LTX_ADD_WATER_ACTION, "the street floods.")).toContain(
      "ADD WATER the street floods.",
    );
    expect(ltxVfxPrompt(LTX_CLEAN_PLATE_ACTION, "")).toMatch(
      /^An empty clean plate of the exact same location:/,
    );
    expect(ltxVfxPrompt(LTX_DAY_TO_NIGHT_ACTION, "lit windows")).toMatch(
      /^A realistic nighttime scene: lit windows\./,
    );
    expect(ltxVfxPrompt(LTX_CINEMAGRAPH_ACTION, "the waterfall")).toMatch(
      /^CINEMAGRAPH_MOTION, .*only the waterfall moves/,
    );
    expect(
      stripSlowMotionWords("a dancer spins in slow motion, hair flying"),
    ).toBe("a dancer spins hair flying");
    expect(stripSlowMotionWords("super slow-mo splash")).toBe("splash");
  });

  it("add water sets the LoRA strength (clamped)", () => {
    const { workflow } = build(LTX_ADD_WATER_ACTION, clipRun(), {
      prompt: "rain",
      strength: 1.45,
    });
    expect(one(workflow, "LoraLoaderModelOnly").strength_model).toBe(1.45);
    expect(ltxVfxStrength(LTX_ADD_WATER_ACTION, "9")).toBe(2);
    expect(ltxVfxStrength(LTX_CINEMAGRAPH_ACTION, undefined)).toBe(1.1);
  });

  it("cinemagraph animates the photo with a picked loop length", () => {
    const { workflow } = build(LTX_CINEMAGRAPH_ACTION, photoRun(), {
      prompt: "steam from the cup",
      frames: 97,
    });
    expect(one(workflow, "LoadImage").image).toBe("photo.png [output]");
    expect(one(workflow, "EmptyLTXVLatentVideo")).toMatchObject({
      width: 704,
      height: 512,
      length: 97,
    });
    const odd = build(LTX_CINEMAGRAPH_ACTION, photoRun(), {
      prompt: "x",
      frames: 50,
    }).workflow;
    expect(one(odd, "EmptyLTXVLatentVideo").length).toBe(25);
  });

  it("slow motion conditions on 24 / speed and samples two stages", () => {
    const { workflow, slots } = build(LTX_SLOW_MOTION_ACTION, photoRun(), {
      prompt: "a glass shatters in slow motion",
      speed: 0.05,
    });
    expect(one(workflow, "LTXVConditioning").frame_rate).toBe(480);
    expect(one(workflow, "LTXVEmptyLatentAudio").frame_rate).toBe(480);
    expect(one(workflow, "CreateVideo").fps).toBe(24);
    // Stage 1 at half size; the latent upsampler doubles it.
    expect(one(workflow, "EmptyLTXVLatentVideo")).toMatchObject({
      width: 640,
      height: 352,
      length: 121,
    });
    const seeds = byClass(workflow, "RandomNoise").map(
      (id) => workflow[id].inputs.noise_seed,
    );
    expect(seeds).toEqual([7, 7]);
    expect(workflow[slots.posTextId].inputs.text).toBe("a glass shatters");
    expect(ltxSlowmoSpeed("0.5")).toBe(0.5);
    expect(ltxSlowmoSpeed(0.3)).toBe(0.2);
    expect(ltxSlowmoMotionFps(0.2)).toBe(120);
  });

  it("rejects a missing source or prompt", () => {
    expect(() => build(LTX_ALPHA_MATTE_ACTION, photoRun())).toThrow(/no video/);
    expect(() =>
      build(LTX_CINEMAGRAPH_ACTION, clipRun(), { prompt: "x" }),
    ).toThrow(/no image/);
    expect(() => build(LTX_ADD_WATER_ACTION, clipRun())).toThrow(
      /prompt is required/,
    );
  });
});

describe("LTX community LoRA tools", () => {
  const guideImage = (wf: Workflow) =>
    String((one(wf, "LTXVAddGuide").image as unknown[])[0]);

  it("ripple guides on the edited frame + source frames, clip length", () => {
    const { workflow, slots } = build(LTX_RIPPLE_ACTION, clipRun(), {
      secondRefImage: "edit.png [input]",
      prompt: "the lanterns turn cyan",
    });
    expect(one(workflow, "LoadVideo").file).toBe("street.mp4 [input]");
    expect(one(workflow, "LoadImage").image).toBe("edit.png [input]");
    const cut = guideImage(workflow);
    expect(workflow[cut].class_type).toBe("ImageFromBatch");
    expect(workflow[cut].inputs).toMatchObject({ batch_index: 0, length: 65 });
    const batch = String((workflow[cut].inputs.image as unknown[])[0]);
    expect(workflow[batch].class_type).toBe("ImageBatch");
    expect(one(workflow, "LoraLoaderModelOnly")).toMatchObject({
      lora_name: "ltx25/LTX25_Ripple_v11.safetensors",
      strength_model: 1.35,
    });
    expect(workflow[slots.posTextId].inputs.text).toBe(
      `${LTX_RIPPLE_PROMPT} the lanterns turn cyan.`,
    );
    expect(() => build(LTX_RIPPLE_ACTION, clipRun())).toThrow(/secondRefImage/);
    expect(() =>
      build(LTX_RIPPLE_ACTION, clipRun(), { secondRefImage: "../x.png" }),
    ).toThrow(/secondRefImage/);
  });

  it("blockout render guides on core Depth Anything 3 depth of the clip", () => {
    const { workflow, slots } = build(LTX_BLOCKOUT_RENDER_ACTION, clipRun(), {
      prompt: "a rainy neon street",
    });
    const depth = guideImage(workflow);
    expect(workflow[depth].class_type).toBe("DA3Render");
    expect(workflow[depth].inputs.output).toBe("depth");
    const infer = String((workflow[depth].inputs.da3_geometry as unknown[])[0]);
    expect(workflow[infer].class_type).toBe("DA3Inference");
    expect(byClass(workflow, "Canny")).toHaveLength(0);
    expect(one(workflow, "LoadDA3Model").model_name).toBe(
      "depth_anything_3_mono_large.safetensors",
    );
    expect(String(one(workflow, "LoraLoaderModelOnly").lora_name)).toMatch(
      /union-control/,
    );
    const { width, height } = one(workflow, "EmptyLTXVLatentVideo") as {
      width: number;
      height: number;
    };
    expect(width % 64).toBe(0);
    expect(height % 64).toBe(0);
    expect(workflow[slots.posTextId].inputs.text).toMatch(
      /^a rainy neon street\. A fully rendered, finished shot/,
    );
    expect(() => build(LTX_BLOCKOUT_RENDER_ACTION, clipRun())).toThrow(
      /prompt is required/,
    );
  });

  it("layout to render: layout clip guides both stages, look frame optional", () => {
    const { workflow, slots } = build(
      LTX_LAYOUT_RENDER_ACTION,
      clipRun({ params: { video_seconds: 10 } }),
      { prompt: "a sunlit courtyard at golden hour.", secondRefImage: "look.png [input]" },
    );
    expect(one(workflow, "LoraLoaderModelOnly")).toMatchObject({
      lora_name: "ltx25/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors",
      strength_model: 1,
    });
    // Card: stage 1 960x544, latent x2 -> 1920x1088, 81 frames at 24 fps.
    expect(one(workflow, "EmptyLTXVLatentVideo")).toMatchObject({
      width: 960,
      height: 544,
      length: 81,
    });
    for (const id of byClass(workflow, "ImageScale")) {
      expect(workflow[id].inputs).toMatchObject({ width: 1920, height: 1088 });
    }
    expect(one(workflow, "VideoFrameSample").num_frames).toBe(81);
    expect(one(workflow, "LoadImage").image).toBe("look.png [input]");
    expect(byClass(workflow, "LTXVLatentUpsampler")).toHaveLength(1);
    const guides = byClass(workflow, "LTXVAddGuide");
    expect(guides).toHaveLength(2);
    const layout = String((workflow[guides[0]].inputs.image as unknown[])[0]);
    for (const id of guides) {
      expect(workflow[id].inputs).toMatchObject({ frame_idx: 0, strength: 1 });
      expect((workflow[id].inputs.image as unknown[])[0]).toBe(layout);
      expect(workflow[id].inputs.iclora_parameters).toBeDefined();
    }
    expect(workflow[layout].inputs.image).toEqual([
      byClass(workflow, "GetVideoComponents")[0],
      0,
    ]);
    expect(
      byClass(workflow, "LTXVImgToVideoInplace").map(
        (id) => workflow[id].inputs.strength,
      ),
    ).toEqual([0.7, 1]);
    expect(byClass(workflow, "LTXVCropGuides")).toHaveLength(2);
    expect(workflow[slots.posTextId].inputs.text).toBe(
      "a sunlit courtyard at golden hour.",
    );

    const bare = build(LTX_LAYOUT_RENDER_ACTION, clipRun(), {
      prompt: "a sunlit courtyard",
    }).workflow;
    expect(problems(bare)).toEqual([]);
    for (const cls of ["LoadImage", "LTXVPreprocess", "LTXVImgToVideoInplace"])
      expect(byClass(bare, cls), cls).toEqual([]);
    expect(byClass(bare, "ImageScale")).toHaveLength(1);
    const [g1, g2] = byClass(bare, "LTXVAddGuide").map((id) => bare[id].inputs);
    expect(bare[String((g1.latent as unknown[])[0])].class_type).toBe(
      "EmptyLTXVLatentVideo",
    );
    expect(bare[String((g2.latent as unknown[])[0])].class_type).toBe(
      "LTXVLatentUpsampler",
    );
    expect(() => build(LTX_LAYOUT_RENDER_ACTION, clipRun())).toThrow(
      /prompt is required/,
    );
  });

  it("edge control guides on core Canny edges of the clip, /64 size", () => {
    const { workflow, slots } = build(LTX_EDGE_CONTROL_ACTION, clipRun(), {
      prompt: "a watercolor painting",
    });
    const canny = guideImage(workflow);
    expect(workflow[canny].class_type).toBe("Canny");
    const { width, height } = one(workflow, "EmptyLTXVLatentVideo") as {
      width: number;
      height: number;
    };
    expect(width % 64).toBe(0);
    expect(height % 64).toBe(0);
    expect(String(one(workflow, "LoraLoaderModelOnly").lora_name)).toMatch(
      /union-control/,
    );
    expect(workflow[slots.posTextId].inputs.text).toBe(
      "a watercolor painting.",
    );
    expect(() => build(LTX_EDGE_CONTROL_ACTION, clipRun())).toThrow(
      /prompt is required/,
    );
  });

  it("exploded view: card template, strength 0.5, extra LoRA allowed", () => {
    const { workflow, slots } = build(LTX_EXPLODED_VIEW_ACTION, photoRun(), {
      prompt: "the camera",
    });
    expect(workflow[slots.posTextId].inputs.text).toMatch(
      /^The camera separates into an ordered exploded view\./,
    );
    expect(ltxVfxPrompt(LTX_EXPLODED_VIEW_ACTION, "")).toMatch(/^The object /);
    expect(
      ltxVfxPrompt(LTX_EXPLODED_VIEW_ACTION, "A watch in exploded view"),
    ).toBe("A watch in exploded view.");
    expect(one(workflow, "LoraLoaderModelOnly").strength_model).toBe(0.5);
    expect(one(workflow, "EmptyLTXVLatentVideo")).toMatchObject({
      length: 121,
    });
    expect(byClass(workflow, "GetICLoRAParameters")).toEqual([]);
  });

  it("paint fluid: first, black frames, last; optional last frame", () => {
    const { workflow, slots } = build(LTX_PAINT_FLUID_ACTION, photoRun(), {
      secondRefImage: "end.png [input]",
      prompt: "orange fire",
    });
    const loads = byClass(workflow, "LoadImage").map(
      (id) => workflow[id].inputs.image,
    );
    expect(loads.sort()).toEqual(["end.png [input]", "photo.png [output]"]);
    const black = one(workflow, "EmptyImage") as Record<string, number>;
    const latent = one(workflow, "EmptyLTXVLatentVideo") as Record<
      string,
      number
    >;
    expect(black.batch_size).toBe(latent.length - 2);
    expect([black.width, black.height]).toEqual([latent.width, latent.height]);
    expect(workflow[guideImage(workflow)].class_type).toBe("ImageBatch");
    expect(workflow[slots.posTextId].inputs.text).toBe(
      `${LTX_FLUID_TRIGGER}, orange fire`,
    );
    expect(ltxVfxPrompt(LTX_PAINT_FLUID_ACTION, "AINVFXFLUID, steam")).toBe(
      `${LTX_FLUID_TRIGGER}, steam`,
    );
    const solo = build(LTX_PAINT_FLUID_ACTION, photoRun()).workflow;
    expect(
      byClass(solo, "LoadImage").map((id) => solo[id].inputs.image),
    ).toEqual(["photo.png [output]", "photo.png [output]"]);
    expect(problems(solo)).toEqual([]);
  });
});

describe("LTX SDR to HDR (video)", () => {
  const input = (wf: Workflow, id: string, key: string) =>
    String((wf[id].inputs[key] as unknown[])[0]);
  const colorSpaces = (wf: Workflow) =>
    byClass(wf, "ImageColorSpace").map(
      (id) => `${wf[id].inputs.source} -> ${wf[id].inputs.destination}`,
    );

  it("guides in ACEScct and saves HLG video plus an ACEScg EXR master", () => {
    const { workflow, slots } = build(LTX_SDR_TO_HDR_ACTION, clipRun(), {
      prompt: "ignored",
    });
    expect(one(workflow, "LoraLoaderModelOnly")).toMatchObject({
      lora_name: "ltx25/ltx-2.5-22b-ic-lora-sdr-to-hdr-1.0.safetensors",
      strength_model: 1,
    });
    expect(one(workflow, "LTXVAddGuide").strength).toBe(1);
    expect(one(workflow, "KSamplerSelect").sampler_name).toBe("euler");
    expect(workflow[slots.posTextId].inputs.text).toBe(LTX_SDR_TO_HDR_PROMPT);
    expect(colorSpaces(workflow).sort()).toEqual([
      "HDR ACEScct -> HDR",
      "HDR ACEScct -> linear ACEScg",
      "sRGB -> HDR ACEScct",
    ]);

    const guide = byClass(workflow, "LTXVAddGuide")[0];
    const toAces = input(workflow, guide, "image");
    expect(workflow[toAces].inputs.destination).toBe("HDR ACEScct");
    expect(workflow[input(workflow, toAces, "image")].class_type).toBe(
      "ImageScale",
    );

    const create = byClass(workflow, "CreateVideo")[0];
    expect(workflow[create].inputs).toMatchObject({
      fps: 24,
      bit_depth: 10,
      color_space: "HDR",
      codec: "none",
    });
    const hlg = input(workflow, create, "images");
    expect(workflow[hlg].inputs).toMatchObject({
      source: "HDR ACEScct",
      destination: "HDR",
    });
    expect(workflow[input(workflow, hlg, "image")].class_type).toBe(
      "VAEDecodeTiled",
    );
    expect(one(workflow, "SaveVideo")).toMatchObject({
      format: "mp4",
      "format.codec": "av1",
    });

    const exr = byClass(workflow, "SaveImageAdvanced")[0];
    expect(isMasterNode(workflow[exr])).toBe(true);
    expect(workflow[exr].inputs).toMatchObject({
      format: "exr",
      "format.bit_depth": "16-bit float",
      "format.input_color_space": "linear ACEScg",
    });
    expect(String(workflow[exr].inputs.filename_prefix)).toMatch(
      new RegExp(`^${MASTER_SUBFOLDER}/`),
    );
    expect(workflow[input(workflow, exr, "images")].inputs.destination).toBe(
      "linear ACEScg",
    );
  });

  it("follows the clip up to 121 frames at 960x544 and picks the EXR depth", () => {
    const long = build(LTX_SDR_TO_HDR_ACTION, clipRun({ params: {} }), {
      exr: "float",
      strength: 1.8,
    }).workflow;
    expect(one(long, "EmptyLTXVLatentVideo")).toMatchObject({
      width: 960,
      height: 544,
      length: 121,
    });
    expect(one(long, "LoraLoaderModelOnly").strength_model).toBe(1);
    expect(one(long, "SaveImageAdvanced")["format.bit_depth"]).toBe(
      "32-bit float",
    );
    expect(one(long, "LTXVConditioning").frame_rate).toBe(24);
  });

  it("no scene-embedding loader: core classes only", () => {
    const wf = load(LTX_SDR_TO_HDR_ACTION);
    for (const node of Object.values(wf))
      expect(node.class_type).not.toMatch(/LoadConditioning|ConditioningLoader/);
  });

  it("is not mirrored again by the opt-in master files", () => {
    const { workflow } = build(LTX_SDR_TO_HDR_ACTION, clipRun());
    expect(
      addMasterOutputs(workflow, { video: "prores4444" }, { tool: "x" }).added,
    ).toEqual([]);
    expect(getActionTool(LTX_SDR_TO_HDR_ACTION)!.ownMaster).toBe(true);
  });

  it("is not a board chain step (HLG output would feed SDR tools)", () => {
    expect(BOARD_TOOLS.map((t) => t.id)).not.toContain(LTX_SDR_TO_HDR_ACTION);
  });

  it("request sends the EXR depth, no prompt", () => {
    const spec = getActionTool(LTX_SDR_TO_HDR_ACTION)!;
    expect(spec.text).toBeUndefined();
    const req = buildActionRequest(
      spec,
      { ...defaultSettings(spec), picks: { exr: "float" }, seed: 4 },
      null,
    );
    expect(req).toMatchObject({
      action: LTX_SDR_TO_HDR_ACTION,
      params: { exr: "float", seed: 4 },
    });
    expect(
      buildActionRequest(spec, defaultSettings(spec), null).params,
    ).toEqual({ exr: "half" });
  });
});

describe("LTX VFX tools page and hub", () => {
  const settings = (
    over: Partial<ToolSettings> = {},
    id = LTX_ADD_WATER_ACTION,
  ): ToolSettings => ({
    ...defaultSettings(getActionTool(id)),
    ...over,
  });

  it("specs: LTX VFX group, clip input for IC tools, model check", () => {
    expect(CATEGORY_ORDER).toContain("LTX VFX");
    for (const action of LTX_VFX_ACTIONS) {
      const spec = getActionTool(action)!;
      expect(spec.category).toBe("LTX VFX");
      expect(spec.subtitle).toMatch(/^LTX VFX: /);
      expect(spec.modelCheck).toEqual({ pack: "ltx25", action });
      expect(!!spec.videoInput).toBe(LTX_VFX_VIDEO_ACTIONS.includes(action));
    }
  });

  it("requests carry the picked values", () => {
    const water = buildActionRequest(
      getActionTool(LTX_ADD_WATER_ACTION)!,
      settings({ text: "rain", picks: { strength: "1.45" }, seed: 3 }),
      null,
    );
    expect(water).toMatchObject({
      action: LTX_ADD_WATER_ACTION,
      params: { prompt: "rain", strength: 1.45, seed: 3 },
    });
    const slow = buildActionRequest(
      getActionTool(LTX_SLOW_MOTION_ACTION)!,
      settings({ text: "a splash" }, LTX_SLOW_MOTION_ACTION),
      null,
    );
    expect(slow.params).toMatchObject({ prompt: "a splash", speed: 0.2 });
    const cine = buildActionRequest(
      getActionTool(LTX_CINEMAGRAPH_ACTION)!,
      settings({ text: "the flag" }, LTX_CINEMAGRAPH_ACTION),
      null,
    );
    expect(cine.params).toMatchObject({ frames: 25 });
    const alpha = buildActionRequest(
      getActionTool(LTX_ALPHA_MATTE_ACTION)!,
      settings({}, LTX_ALPHA_MATTE_ACTION),
      null,
    );
    expect(alpha.params).toEqual({});
    expect(() =>
      buildActionRequest(
        getActionTool(LTX_ADD_WATER_ACTION)!,
        settings(),
        null,
      ),
    ).toThrow();
  });

  it("stays disabled until model-status lists the weights", () => {
    const spec = getActionTool(LTX_CLEAN_PLATE_ACTION)!;
    expect(actionAvailability(spec, null, null, { tools: {} }).available).toBe(
      false,
    );
    expect(
      actionAvailability(spec, null, null, {
        tools: { [spec.id]: { missing: ["loras/ltx25/x.safetensors"] } },
      }).available,
    ).toBe(false);
    expect(
      actionAvailability(spec, null, null, {
        tools: { [spec.id]: { missing: [] } },
      }).available,
    ).toBe(true);
  });

  it("hub cards land in the LTX VFX section, searchable as LTX VFX, marked new", () => {
    const tools = Object.fromEntries(
      LTX_VFX_ACTIONS.map((a) => [a, { missing: [] }]),
    );
    const cards = buildToolCards({
      catalog: [],
      packIds: null,
      editLoras: null,
      modelStatus: { tools },
    }).filter((c) => LTX_VFX_ACTIONS.includes(c.id));
    expect(cards).toHaveLength(13);
    for (const card of cards) {
      const hub = toHubCard(card, null);
      expect(hub.hubCategory).toBe("VFX");
      expect(hub.model).toMatch(/^LTX-2\.5 /);
      expect(hub.nc).toBe(false);
      expect(hub.aliases).toContain("ltx vfx");
      expect(isNewCard(hub)).toBe(true);
    }
  });
});

describe("LTX VFX routing", () => {
  afterEach(() => {
    delete process.env.COMFY_VIDEO_HTTP_URL;
  });

  it("ltx25 packs run on the video host", () => {
    expect(routeBackend({ workflowPath: "packs/ltx25/vfx_alpha.json" })).toBe(
      "default",
    );
    process.env.COMFY_VIDEO_HTTP_URL = "http://pc:8288/";
    for (const action of LTX_VFX_ACTIONS) {
      const file = reg.templates[reg.actions[action].template].file;
      expect(routeBackend({ action, workflowPath: file })).toBe("video");
    }
  });
});

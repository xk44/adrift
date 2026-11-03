/**
 * SeedVR2 upscale (image + video), frame interpolation (smooth / slow-mo) and
 * Qwen-Image-Edit-2509 Relight: graphs, builders, registry + tool wiring.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import registry from "@/lib/oj/registry.json";
import { resolveWorkflow } from "@/lib/oj/packs";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  SEEDVR2_UPSCALE_ACTION,
  SEEDVR2_VIDEO_MAX_SHORT_SIDE,
  buildSeedvr2UpscaleWorkflow,
  seedvr2ResizeInputs,
} from "@/lib/oj/seedvr2Upscale";
import {
  INTERPOLATE_ACTION,
  INTERP_MAX_OUTPUT_FRAMES,
  buildInterpolateWorkflow,
} from "@/lib/oj/frameInterpolate";
import {
  RELIGHT_ACTION,
  RELIGHT_PRESETS,
  RELIGHT_TRIGGER,
  buildRelightWorkflow,
  relightPrompt,
} from "@/lib/oj/relight";
import { routeBackend } from "@/lib/comfy/backends";
import { workflowModelRequirements } from "@/lib/tools/modelStatus";
import { missingAgainstObjectInfo } from "@/lib/comfy/backendModels";
import {
  ACTION_TOOLS,
  ToolInputError,
  buildActionRequest,
  getActionTool,
} from "@/lib/tools/toolsPage";
import type { ImagineRun, Workflow } from "@/types";

const WORKFLOWS_DIR = path.join(process.cwd(), "public/workflows");
const load = (rel: string): Workflow =>
  JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, rel), "utf-8"));

const SEEDVR2 = "packs/seedvr2/seedvr2_upscale.json";
const INTERP = "packs/interp/interpolate.json";
const RELIGHT = "packs/qwen-edit-2509/relight.json";

const run = (media: { images?: string[]; videos?: string[] }): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "a fox in snow",
    width: 832,
    height: 480,
    jobs: [
      {
        seed: 11,
        index: 0,
        status: "completed",
        progress: 100,
        images: media.images ?? [],
        ...(media.videos ? { videos: media.videos } : {}),
      },
    ],
    createdAt: new Date().toISOString(),
    status: "completed",
    params: {},
  }) as unknown as ImagineRun;

const IMG = "/api/comfy/view?filename=fox.png&subfolder=&type=output";
const VID = "/api/comfy/view?filename=fox.mp4&subfolder=video&type=output";

const classes = (wf: Workflow) => Object.values(wf).map((n) => n.class_type);
const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(([, n]) => n.class_type === cls);
const one = (wf: Workflow, cls: string) => {
  const hits = byClass(wf, cls);
  expect(hits).toHaveLength(1);
  return hits[0];
};

/** Every link in the graph points at an existing node. */
function expectLinksResolve(wf: Workflow) {
  for (const [id, node] of Object.entries(wf)) {
    for (const [k, v] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(v) && typeof v[0] === "string") {
        expect(wf[v[0]], `${id}.${k} → ${v[0]}`).toBeDefined();
      }
    }
  }
}

describe("registry wiring", () => {
  const actions = registry.actions as Record<string, Record<string, unknown>>;
  const templates = registry.templates as Record<string, { file: string }>;

  it.each([
    [SEEDVR2_UPSCALE_ACTION, SEEDVR2, false],
    [INTERPOLATE_ACTION, INTERP, false],
    [RELIGHT_ACTION, RELIGHT, true],
  ])("%s → %s (requiresImage %s)", (action, file, requiresImage) => {
    expect(actions[action]).toMatchObject({ template: action, requiresImage });
    expect(templates[action].file).toBe(file);
    expect(fs.existsSync(path.join(WORKFLOWS_DIR, file))).toBe(true);
    expect(actionBuilderFor(action)).toBeTypeOf("function");
    expect(
      resolveWorkflow({ templateOrAction: action, packId: "krea2" })
        .workflowPath,
    ).toBe(file);
  });

  it("only interpolate is a video-only action", () => {
    expect(VIDEO_INPUT_ACTIONS.has(INTERPOLATE_ACTION)).toBe(true);
    expect(VIDEO_INPUT_ACTIONS.has(SEEDVR2_UPSCALE_ACTION)).toBe(false);
    expect(VIDEO_INPUT_ACTIONS.has(RELIGHT_ACTION)).toBe(false);
  });

  it("graphs route to the video host when one is configured", () => {
    const prev = process.env.COMFY_VIDEO_HTTP_URL;
    process.env.COMFY_VIDEO_HTTP_URL = "http://video-host:8188";
    try {
      for (const [action, file] of [
        [SEEDVR2_UPSCALE_ACTION, SEEDVR2],
        [INTERPOLATE_ACTION, INTERP],
        [RELIGHT_ACTION, RELIGHT],
      ]) {
        expect(routeBackend({ action, workflowPath: file })).toBe("video");
      }
    } finally {
      if (prev === undefined) delete process.env.COMFY_VIDEO_HTTP_URL;
      else process.env.COMFY_VIDEO_HTTP_URL = prev;
    }
  });

  it("graphs carry no personal paths", () => {
    for (const f of [SEEDVR2, INTERP, RELIGHT]) {
      const raw = fs.readFileSync(path.join(WORKFLOWS_DIR, f), "utf-8");
      expect(raw).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\\\/);
    }
  });
});

describe("model requirements", () => {
  it("lists every SeedVR2 / interp / relight weight", () => {
    const files = (rel: string) =>
      workflowModelRequirements(load(rel)).map((r) => `${r.dir}/${r.file}`);
    expect(files(SEEDVR2)).toEqual([
      "vae/seedvr2_ema_vae_fp16.safetensors",
      "diffusion_models/seedvr2_3b_fp8_e4m3fn.safetensors",
    ]);
    expect(files(INTERP)).toEqual([
      "frame_interpolation/rife_v4.26.safetensors",
    ]);
    expect(files(RELIGHT)).toEqual([
      "diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors",
      "loras/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors",
      "loras/Qwen-Image-Edit-2509-Relight.safetensors",
      "text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
      "vae/qwen_image_vae.safetensors",
    ]);
  });

  it("remote check flags a missing interpolation model", () => {
    const info = {
      LoadVideo: {},
      VideoTemporalCrop: {},
      GetVideoComponents: {},
      FrameInterpolationModelLoader: {
        input: {
          required: {
            model_name: ["COMBO", { options: ["film_net_fp16.safetensors"] }],
          },
        },
      },
      FrameInterpolate: {},
      ComfyMathExpression: {},
      CreateVideo: {},
      SaveVideo: {},
    };
    expect(missingAgainstObjectInfo(load(INTERP), info)).toEqual([
      "frame_interpolation/rife_v4.26.safetensors",
    ]);
  });
});

describe("seedvr2_upscale builder", () => {
  it("image source keeps only the image branch", () => {
    const { workflow } = buildSeedvr2UpscaleWorkflow(
      load(SEEDVR2),
      run({ images: [IMG] }),
      0,
      {},
    );
    const cls = classes(workflow);
    for (const gone of [
      "LoadVideo",
      "GetVideoComponents",
      "SeedVR2TemporalChunk",
      "SeedVR2TemporalMerge",
      "CreateVideo",
      "SaveVideo",
    ]) {
      expect(cls).not.toContain(gone);
    }
    const [loadId, load_] = one(workflow, "LoadImage");
    expect(load_.inputs.image).toBe("fox.png [output]");
    const [, resize] = one(workflow, "ResizeImageMaskNode");
    expect(resize.inputs).toMatchObject({
      input: [loadId, 0],
      resize_type: "scale by multiplier",
      "resize_type.multiplier": 2,
    });
    const [encId] = one(workflow, "VAEEncodeTiled");
    const [ksId, ks] = one(workflow, "KSampler");
    expect(ks.inputs.latent_image).toEqual([encId, 0]);
    expect(ks.inputs.seed).toBe(11);
    expect(
      one(workflow, "SeedVR2Conditioning")[1].inputs.vae_conditioning,
    ).toEqual([encId, 0]);
    expect(one(workflow, "VAEDecodeTiled")[1].inputs.samples).toEqual([
      ksId,
      0,
    ]);
    expect(one(workflow, "UNETLoader")[1].inputs.unet_name).toBe(
      "seedvr2_3b_fp8_e4m3fn.safetensors",
    );
    one(workflow, "SaveImage");
    expectLinksResolve(workflow);
  });

  it("video source chunks the latent and muxes fps + audio", () => {
    const { workflow } = buildSeedvr2UpscaleWorkflow(
      load(SEEDVR2),
      run({ images: [IMG], videos: [VID] }),
      0,
      { scale: "1080p", model: "quality" },
    );
    const cls = classes(workflow);
    expect(cls).not.toContain("LoadImage");
    expect(cls).not.toContain("SaveImage");
    expect(one(workflow, "LoadVideo")[1].inputs.file).toBe(
      "video/fox.mp4 [output]",
    );
    const [gvcId] = one(workflow, "GetVideoComponents");
    const [, resize] = one(workflow, "ResizeImageMaskNode");
    expect(resize.inputs).toMatchObject({
      input: [gvcId, 0],
      resize_type: "scale shorter dimension",
      "resize_type.shorter_size": 1080,
    });
    expect(resize.inputs["resize_type.multiplier"]).toBeUndefined();
    const [encId] = one(workflow, "VAEEncodeTiled");
    const [chunkId, chunk] = one(workflow, "SeedVR2TemporalChunk");
    expect(chunk.inputs).toMatchObject({
      latent: [encId, 0],
      chunking_mode: "auto",
    });
    const [ksId, ks] = one(workflow, "KSampler");
    expect(ks.inputs.latent_image).toEqual([chunkId, 0]);
    expect(
      one(workflow, "SeedVR2Conditioning")[1].inputs.vae_conditioning,
    ).toEqual([chunkId, 0]);
    const [mergeId, merge] = one(workflow, "SeedVR2TemporalMerge");
    expect(merge.inputs).toEqual({
      latents: [ksId, 0],
      temporal_overlap: [chunkId, 1],
    });
    expect(one(workflow, "VAEDecodeTiled")[1].inputs.samples).toEqual([
      mergeId,
      0,
    ]);
    expect(one(workflow, "CreateVideo")[1].inputs).toMatchObject({
      fps: [gvcId, 2],
      audio: [gvcId, 1],
    });
    expect(one(workflow, "UNETLoader")[1].inputs.unet_name).toBe(
      "seedvr2_7b_fp8_e4m3fn.safetensors",
    );
    expectLinksResolve(workflow);
  });

  it("media=image forces the image branch even when the job has a clip", () => {
    const { workflow } = buildSeedvr2UpscaleWorkflow(
      load(SEEDVR2),
      run({ images: [IMG], videos: [VID] }),
      0,
      { media: "image" },
    );
    one(workflow, "LoadImage");
    expect(classes(workflow)).not.toContain("LoadVideo");
  });

  it("video 2x stops at a 1080p short side; image 2x stays literal", () => {
    const vid = buildSeedvr2UpscaleWorkflow(
      load(SEEDVR2),
      run({ images: [IMG], videos: [VID] }),
      0,
      { scale: "2x" },
    ).workflow;
    const [gvcId] = one(vid, "GetVideoComponents");
    const [, resize] = one(vid, "ResizeImageMaskNode");
    const mult = resize.inputs["resize_type.multiplier"] as [string, number];
    expect(vid[mult[0]].inputs).toMatchObject({
      expression: `min(2, ${SEEDVR2_VIDEO_MAX_SHORT_SIDE} / min(a, b))`,
    });
    const sizeId = (vid[mult[0]].inputs["values.a"] as [string, number])[0];
    expect(vid[sizeId].inputs.image).toEqual([gvcId, 0]);
    expectLinksResolve(vid);
    const img = buildSeedvr2UpscaleWorkflow(
      load(SEEDVR2),
      run({ images: [IMG] }),
      0,
      { scale: "2x" },
    ).workflow;
    expect(
      one(img, "ResizeImageMaskNode")[1].inputs["resize_type.multiplier"],
    ).toBe(2);
    expect(classes(img)).not.toContain("ComfyMathExpression");
  });

  it("4k = longer side 3840 for images, clamped to 1080p for video", () => {
    expect(seedvr2ResizeInputs("4k", false)).toEqual({
      resize_type: "scale longer dimension",
      "resize_type.longer_size": 3840,
    });
    expect(seedvr2ResizeInputs("4k", true)).toEqual({
      resize_type: "scale shorter dimension",
      "resize_type.shorter_size": 1080,
    });
  });

  it("throws without any source media", () => {
    expect(() =>
      buildSeedvr2UpscaleWorkflow(load(SEEDVR2), run({}), 0, {}),
    ).toThrow(/no image or video/);
  });
});

describe("interpolate builder", () => {
  it("caps source length so output frames stay within budget", () => {
    for (const multiplier of [2, 4] as const) {
      const { workflow } = buildInterpolateWorkflow(
        load(INTERP),
        run({ videos: [VID] }),
        0,
        { multiplier },
      );
      const [capId, cap] = one(workflow, "VideoTemporalCrop");
      expect(cap.inputs).toMatchObject({
        video: [one(workflow, "LoadVideo")[0], 0],
        start_frame: 0,
        length: INTERP_MAX_OUTPUT_FRAMES / multiplier,
      });
      expect(one(workflow, "GetVideoComponents")[1].inputs.video).toEqual([
        capId,
        0,
      ]);
    }
  });

  it("keeps the caller's start_frame (trimmed clips start where asked)", () => {
    const { workflow } = buildInterpolateWorkflow(
      load(INTERP),
      run({ videos: [VID] }),
      0,
      { multiplier: 2, start_frame: 48.7 },
    );
    expect(one(workflow, "VideoTemporalCrop")[1].inputs.start_frame).toBe(48);
    for (const bad of [-5, "x", undefined]) {
      const { workflow: wf } = buildInterpolateWorkflow(
        load(INTERP),
        run({ videos: [VID] }),
        0,
        { start_frame: bad },
      );
      expect(one(wf, "VideoTemporalCrop")[1].inputs.start_frame).toBe(0);
    }
  });

  it("smooth: fps × multiplier and audio kept", () => {
    const { workflow } = buildInterpolateWorkflow(
      load(INTERP),
      run({ videos: [VID] }),
      0,
      {
        multiplier: 4,
        model: "film",
      },
    );
    const [gvcId] = one(workflow, "GetVideoComponents");
    expect(one(workflow, "FrameInterpolate")[1].inputs.multiplier).toBe(4);
    expect(
      one(workflow, "FrameInterpolationModelLoader")[1].inputs.model_name,
    ).toBe("film_net_fp16.safetensors");
    const [mathId, math] = one(workflow, "ComfyMathExpression");
    expect(math.inputs).toEqual({
      expression: "a * 4",
      "values.a": [gvcId, 2],
    });
    expect(one(workflow, "CreateVideo")[1].inputs).toMatchObject({
      fps: [mathId, 0],
      audio: [gvcId, 1],
    });
    expectLinksResolve(workflow);
  });

  it("slow-mo: source fps, no audio, no math node", () => {
    const { workflow } = buildInterpolateWorkflow(
      load(INTERP),
      run({ videos: [VID] }),
      0,
      {
        mode: "slowmo",
        multiplier: "2",
      },
    );
    const [gvcId] = one(workflow, "GetVideoComponents");
    expect(classes(workflow)).not.toContain("ComfyMathExpression");
    const create = one(workflow, "CreateVideo")[1].inputs;
    expect(create.fps).toEqual([gvcId, 2]);
    expect(create.audio).toBeUndefined();
    expect(
      one(workflow, "FrameInterpolationModelLoader")[1].inputs.model_name,
    ).toBe("rife_v4.26.safetensors");
    expectLinksResolve(workflow);
  });

  it("odd multipliers fall back to 2x; needs a clip", () => {
    const { workflow } = buildInterpolateWorkflow(
      load(INTERP),
      run({ videos: [VID] }),
      0,
      { multiplier: 16 },
    );
    expect(one(workflow, "FrameInterpolate")[1].inputs.multiplier).toBe(2);
    expect(() =>
      buildInterpolateWorkflow(load(INTERP), run({ images: [IMG] }), 0, {}),
    ).toThrow(/no video/);
  });
});

describe("relight builder", () => {
  it("writes trigger + preset prompt into the positive encoder only", () => {
    const { workflow, seed } = buildRelightWorkflow(
      load(RELIGHT),
      run({ images: [IMG] }),
      0,
      {
        preset: "neon_night",
        seed: 5,
      },
    );
    expect(seed).toBe(5);
    const [, ks] = one(workflow, "KSampler");
    expect(ks.inputs.seed).toBe(5);
    // Both branches go through ReferenceLatent fed by the SAME VAEEncode the
    // sampler starts from, so the reference and sampled latents always match
    // in size (the encoder's own 1MP/8 rescale left an 8px edge strip).
    const posRef = workflow[(ks.inputs.positive as [string, number])[0]];
    const negRef = workflow[(ks.inputs.negative as [string, number])[0]];
    expect(posRef.class_type).toBe("ReferenceLatent");
    expect(negRef.class_type).toBe("ReferenceLatent");
    expect(posRef.inputs.latent).toEqual(ks.inputs.latent_image);
    expect(negRef.inputs.latent).toEqual(ks.inputs.latent_image);
    const pos = workflow[(posRef.inputs.conditioning as [string, number])[0]];
    const neg = workflow[(negRef.inputs.conditioning as [string, number])[0]];
    expect(pos.inputs.vae).toBeUndefined();
    expect(pos.inputs.prompt).toBe(
      `${RELIGHT_TRIGGER} relight the image using ${RELIGHT_PRESETS.neon_night}`,
    );
    expect(neg.inputs.prompt).toBe("");
    expect(one(workflow, "LoadImage")[1].inputs.image).toBe("fox.png [output]");
    expectLinksResolve(workflow);
  });

  it("prompt helper: default, extra text and custom", () => {
    expect(relightPrompt(undefined, "")).toContain(RELIGHT_PRESETS.golden_hour);
    expect(relightPrompt("moonlight", "light from the left")).toBe(
      `${RELIGHT_TRIGGER} relight the image using ${RELIGHT_PRESETS.moonlight}, light from the left`,
    );
    expect(relightPrompt("custom", "a red police light")).toBe(
      `${RELIGHT_TRIGGER} relight the image using a red police light`,
    );
    expect(() => relightPrompt("custom", " ")).toThrow(/needs a description/);
  });
});

describe("tool cards", () => {
  const base = { text: "", picks: {} } as unknown as Parameters<
    typeof buildActionRequest
  >[1];
  const settings = (text: string, pickers: Record<string, string>) =>
    ({ ...base, text, picks: pickers }) as Parameters<
      typeof buildActionRequest
    >[1];

  it("all four cards gate on model status", () => {
    for (const id of [
      "upscale_seedvr2",
      "upscale_video",
      "interpolate",
      "relight",
    ]) {
      const spec = getActionTool(id)!;
      expect(spec, id).toBeDefined();
      expect(spec.modelCheck).toBeDefined();
      expect(spec.requireStatusEntry).toBe(true);
    }
    expect(getActionTool("upscale_video")!.videoInput).toBeTruthy();
    expect(getActionTool("interpolate")!.videoInput).toBeTruthy();
    expect(getActionTool("upscale_seedvr2")!.videoInput).toBeUndefined();
    expect(getActionTool("upscale")).toBeDefined(); // Real-ESRGAN card stays
    expect(new Set(ACTION_TOOLS.map((t) => t.id)).size).toBe(
      ACTION_TOOLS.length,
    );
  });

  it("maps defaults to action params", () => {
    expect(
      buildActionRequest(
        getActionTool("upscale_seedvr2")!,
        settings("", {}),
        null,
      ),
    ).toEqual({
      action: "seedvr2_upscale",
      params: { media: "image", scale: "2x", model: "fast", color: "lab" },
      overrides: {},
    });
    expect(
      buildActionRequest(
        getActionTool("upscale_video")!,
        settings("", { engine: "best", scale: "1080p", model: "quality" }),
        null,
      ),
    ).toEqual({
      action: "seedvr2_upscale",
      params: {
        media: "video",
        scale: "1080p",
        model: "quality",
        color: "lab",
      },
      overrides: {},
    });
    expect(
      buildActionRequest(
        getActionTool("upscale_video")!,
        settings("", { scale: "1080p", model: "quality" }),
        null,
      ),
    ).toEqual({
      action: "video_upscale",
      params: { size: "1080p" },
      overrides: {},
    });
    expect(
      buildActionRequest(
        getActionTool("interpolate")!,
        settings("", { mode: "slowmo", multiplier: "4" }),
        null,
      ),
    ).toEqual({
      action: "interpolate",
      params: { mode: "slowmo", multiplier: 4, model: "rife" },
      overrides: {},
    });
    expect(
      buildActionRequest(getActionTool("relight")!, settings("", {}), null),
    ).toEqual({
      action: "relight",
      params: { preset: "golden_hour" },
      overrides: {},
    });
  });

  it("relight custom needs text", () => {
    const spec = getActionTool("relight")!;
    expect(() =>
      buildActionRequest(spec, settings("", { preset: "custom" }), null),
    ).toThrow(ToolInputError);
    expect(
      buildActionRequest(spec, settings("blue rim", { preset: "custom" }), null)
        .params,
    ).toEqual({
      preset: "custom",
      text: "blue rim",
    });
  });
});

/**
 * "Lipsync onto an existing video" (packs/wan-animate/video_lipsync.json,
 * src/lib/oj/videoLipsync.ts): graph shape against the backend's
 * /object_info input names, masked-latent chaining, paste-back, audio mux,
 * smart select, registration, tool request + upload legs.
 */
import { describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { ImagineRun, Workflow } from "@/types";
import {
  VIDEO_LIPSYNC_MAX_SECONDS,
  VIDEO_LIPSYNC_PASTE,
  VIDEO_LIPSYNC_PROMPT,
  VL_NODES,
  buildVideoLipsyncWorkflow,
  cleanFaceTarget,
  videoLipsyncPlan,
  videoLipsyncSeconds,
  videoLipsyncSourceCap,
} from "@/lib/oj/videoLipsync";
import { LIPSYNC_FPS, LIPSYNC_MAX_FRAMES } from "@/lib/oj/lipsync";
import { ACTION_BUILDERS, VIDEO_INPUT_ACTIONS } from "@/lib/oj/actionBuilders";
import { getPack, resolveWorkflow } from "@/lib/oj/packs";
import registry from "@/lib/oj/registry.json";
import {
  SMART_TRACK_ACTIONS,
  SMART_TRACK_WINDOW_SECONDS,
} from "@/lib/tools/smartTrack";
import {
  ToolInputError,
  buildActionRequest,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";
import { CARD_OVERRIDES } from "@/lib/tools/hub";
import { submitVideoTool } from "@/lib/tools/runTool";

const RAW: Workflow = JSON.parse(
  fs.readFileSync(
    path.join(
      process.cwd(),
      "public/workflows/packs/wan-animate/video_lipsync.json",
    ),
    "utf-8",
  ),
);
/** As loadWorkflowFromSelection hands it to builders (metadata keys stripped). */
const BASE: Workflow = Object.fromEntries(
  Object.entries(RAW).filter(([k]) => !k.startsWith("_")),
);

/**
 * Input names per class from the live backend's GET /object_info
 * (2026-10-24). Every node the builder emits must use only these.
 */
const OBJECT_INFO: Record<string, { required: string[]; optional: string[] }> =
  {
    VHS_LoadVideo: {
      required: [
        "custom_height",
        "custom_width",
        "force_rate",
        "frame_load_cap",
        "select_every_nth",
        "skip_first_frames",
        "video",
      ],
      optional: ["format", "meta_batch", "vae"],
    },
    LoadAudio: { required: ["audio"], optional: [] },
    TrimAudioDuration: {
      required: ["audio", "duration", "start_index"],
      optional: [],
    },
    AudioEncoderLoader: { required: ["audio_encoder_name"], optional: [] },
    AudioEncoderEncode: { required: ["audio", "audio_encoder"], optional: [] },
    ModelPatchLoader: { required: ["name"], optional: [] },
    UNETLoader: { required: ["unet_name", "weight_dtype"], optional: [] },
    LoraLoaderModelOnly: {
      required: ["lora_name", "model", "strength_model"],
      optional: [],
    },
    CLIPLoader: { required: ["clip_name", "type"], optional: ["device"] },
    CLIPTextEncode: { required: ["clip", "text"], optional: [] },
    ConditioningZeroOut: { required: ["conditioning"], optional: [] },
    VAELoader: { required: ["vae_name"], optional: [] },
    CLIPVisionLoader: { required: ["clip_name"], optional: [] },
    ImageScale: {
      required: ["crop", "height", "image", "upscale_method", "width"],
      optional: [],
    },
    CLIPVisionEncode: {
      required: ["clip_vision", "crop", "image"],
      optional: [],
    },
    WanInfiniteTalkToVideo: {
      required: [
        "audio_encoder_output_1",
        "audio_scale",
        "height",
        "length",
        "mode",
        "model",
        "model_patch",
        "motion_frame_count",
        "negative",
        "positive",
        "vae",
        "width",
      ],
      optional: ["clip_vision_output", "previous_frames", "start_image"],
    },
    KSamplerSelect: { required: ["sampler_name"], optional: [] },
    BasicScheduler: {
      required: ["denoise", "model", "scheduler", "steps"],
      optional: [],
    },
    RandomNoise: { required: ["noise_seed"], optional: [] },
    CFGGuider: {
      required: ["cfg", "model", "negative", "positive"],
      optional: [],
    },
    SamplerCustomAdvanced: {
      required: ["guider", "latent_image", "noise", "sampler", "sigmas"],
      optional: [],
    },
    VAEDecode: { required: ["samples", "vae"], optional: [] },
    ImageFromBatch: {
      required: ["batch_index", "image", "length"],
      optional: [],
    },
    CJImagePasteBack: {
      required: ["edited", "original"],
      optional: [
        "color_match",
        "diff_thresh",
        "feather_px",
        "fit",
        "grow_px",
        // region_match / match_band_px need the repo's node
        // (comfy_nodes/cj_h3_tools); an older deployed node ignores them.
        "match_band_px",
        "min_blob",
        "new_content",
        "protect",
        "protect_mode",
        "reach",
        "region",
        "region_match",
        "subject",
      ],
    },
    CreateVideo: {
      required: ["fps", "images"],
      optional: ["audio", "bit_depth", "codec", "color_space"],
    },
    SaveVideo: {
      required: ["filename_prefix", "format", "video"],
      optional: ["codec"],
    },
    RepeatImageBatch: { required: ["amount", "image"], optional: [] },
    ImageBatch: { required: ["image1", "image2"], optional: [] },
    VAEEncode: { required: ["pixels", "vae"], optional: [] },
    MaskToImage: { required: ["mask"], optional: [] },
    ImageToMask: { required: ["channel", "image"], optional: [] },
    SetLatentNoiseMask: { required: ["mask", "samples"], optional: [] },
    CheckpointLoaderSimple: { required: ["ckpt_name"], optional: [] },
    SAM3_VideoTrack: {
      required: [
        "detect_interval",
        "detection_threshold",
        "images",
        "max_objects",
        "model",
      ],
      optional: ["conditioning", "initial_mask"],
    },
    SAM3_TrackToMask: {
      required: ["object_indices", "track_data"],
      optional: [],
    },
    GrowMask: { required: ["expand", "mask", "tapered_corners"], optional: [] },
    CJMaskTemporal: { required: ["mask", "mode", "radius"], optional: [] },
    LoadVideo: { required: ["file"], optional: [] },
    GetVideoComponents: { required: ["video"], optional: [] },
    SAM3_Detect: {
      required: [
        "image",
        "individual_masks",
        "model",
        "refine_iterations",
        "threshold",
      ],
      optional: [
        "bboxes",
        "conditioning",
        "negative_coords",
        "positive_coords",
      ],
    },
    VHS_SelectImages: {
      required: ["err_if_empty", "err_if_missing", "image", "indexes"],
      optional: [],
    },
    VHS_SelectMasks: {
      required: ["err_if_empty", "err_if_missing", "indexes", "mask"],
      optional: [],
    },
    MaskComposite: {
      required: ["destination", "operation", "source", "x", "y"],
      optional: [],
    },
    "Video Slice": {
      required: ["duration", "start_time", "strict_duration", "video"],
      optional: [],
    },
  };

const view = (name: string) =>
  `http://127.0.0.1:8188/view?filename=${name}&subfolder=&type=input`;

function run(
  job: Partial<ImagineRun["jobs"][number]>,
  extra: Partial<ImagineRun> = {},
): ImagineRun {
  return {
    run_id: "r",
    prompt: "",
    parsedPrompt: "",
    width: 1920,
    height: 1080,
    createdAt: "",
    status: "done",
    jobs: [
      { seed: 0, index: 0, status: "done", progress: 100, images: [], ...job },
    ],
    params: {},
    ...extra,
  } as ImagineRun;
}

const SRC = run(
  { videos: [view("talk.mp4")], audios: [view("speech.wav")] },
  { params: { video_seconds: 12, audio_seconds: 6.8 } },
);

const nodesOf = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(([, n]) => n?.class_type === cls);

/** Graph nodes valid against OBJECT_INFO: known class, required set, no stray inputs, links resolve. */
function validate(wf: Workflow): void {
  for (const [id, node] of Object.entries(wf)) {
    if (id === "_meta") continue;
    const spec = OBJECT_INFO[node.class_type];
    expect(spec, `node ${id} class ${node.class_type}`).toBeDefined();
    const allowed = new Set([...spec.required, ...spec.optional]);
    for (const name of spec.required)
      expect(node.inputs, `${id} ${node.class_type}.${name}`).toHaveProperty([
        name,
      ]);
    for (const [name, v] of Object.entries(node.inputs)) {
      expect(allowed.has(name), `${id} ${node.class_type} stray ${name}`).toBe(
        true,
      );
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string")
        expect(wf[v[0]], `${id}.${name} -> ${v[0]}`).toBeDefined();
    }
  }
}

describe("video_lipsync plan helpers", () => {
  it("renders the shorter of clip and speech, capped like lipsync", () => {
    expect(videoLipsyncSeconds(12, 6.8)).toBe(6.8);
    expect(videoLipsyncSeconds(3, 6.8)).toBe(3);
    expect(videoLipsyncSeconds(undefined, 6.8)).toBe(6.8);
    expect(videoLipsyncSeconds(undefined, undefined)).toBeUndefined();
    // 6.8 s -> 170 frames, 3 passes, windows need 81 + 72*2 = 225 padded frames.
    expect(videoLipsyncPlan(12, 6.8)).toEqual({
      frames: 170,
      segments: 3,
      truncated: false,
      padded: 225,
    });
    expect(videoLipsyncPlan(60, 60)).toMatchObject({
      frames: LIPSYNC_MAX_FRAMES,
      segments: 5,
      truncated: true,
      padded: LIPSYNC_MAX_FRAMES,
    });
    expect(VIDEO_LIPSYNC_MAX_SECONDS).toBeCloseTo(14.76, 5);
  });

  it("caps the paste-back frames' long edge at 1280, keeping aspect", () => {
    expect(videoLipsyncSourceCap(1920, 1080)).toEqual({
      custom_width: 1280,
      custom_height: 0,
    });
    expect(videoLipsyncSourceCap(1080, 1920)).toEqual({
      custom_width: 0,
      custom_height: 1280,
    });
    expect(videoLipsyncSourceCap(1280, 720)).toEqual({
      custom_width: 0,
      custom_height: 0,
    });
    expect(videoLipsyncSourceCap(undefined, undefined)).toEqual({
      custom_width: 0,
      custom_height: 0,
    });
  });

  it("cleans the face prompt", () => {
    expect(cleanFaceTarget("  woman's   face, ")).toBe("woman's face");
    expect(cleanFaceTarget("")).toBe("face");
    expect(cleanFaceTarget(undefined)).toBe("face");
  });
});

describe("video_lipsync base graph", () => {
  it("uses only object_info nodes/inputs, core InfiniteTalk + CJ paste-back, no personal data", () => {
    validate(BASE);
    const text = JSON.stringify(BASE);
    expect(text).not.toMatch(/\/Users\/|\/home\//);
    expect(nodesOf(BASE, "ModelPatchLoader")[0][1].inputs.name).toBe(
      "wan2.1_infiniteTalk_single_fp16.safetensors",
    );
    expect(
      nodesOf(BASE, "AudioEncoderLoader")[0][1].inputs.audio_encoder_name,
    ).toBe("wav2vec2-chinese-base_fp16.safetensors");
    expect(nodesOf(BASE, "CheckpointLoaderSimple")[0][1].inputs.ckpt_name).toBe(
      "sam3.1_multiplex_fp16.safetensors",
    );
    // No wrapper / MediaPipe nodes (those need downloads on the backend).
    expect(text).not.toMatch(
      /MultiTalk|Wav2VecModelLoader|MediaPipe|CJPasteBackSave/,
    );
  });

  it("samples pass 1 from the masked source latent, not InfiniteTalk's empty latent", () => {
    const N = VL_NODES;
    expect(BASE[N.sample].inputs.latent_image).toEqual([N.noiseMask, 0]);
    expect(BASE[N.noiseMask].inputs).toEqual({
      samples: [N.encode, 0],
      mask: [N.maskWindowMask, 0],
    });
    expect(BASE[N.encode].inputs.pixels).toEqual([N.window, 0]);
    expect(BASE[N.window].inputs.image).toEqual([N.padded, 0]);
    expect(BASE[N.maskImage].inputs.mask).toEqual([N.temporal, 0]);
    expect(BASE[N.talk].inputs.start_image).toEqual([N.start, 0]);
    expect(BASE[N.talk].inputs.audio_encoder_output_1).toEqual(["5", 0]);
    // The audio encoder hears only the driving speech (LoadAudio), never the clip's audio.
    expect(BASE["5"].inputs.audio).toEqual([N.speech, 0]);
    expect(BASE[N.speech].inputs.audio).toEqual([N.audio, 0]);
  });

  it("pastes the face back onto the full-res source and muxes the driving speech", () => {
    const N = VL_NODES;
    expect(BASE[N.paste].inputs).toMatchObject({
      original: [N.load, 0],
      edited: [N.trim, 0],
      region: [N.temporal, 0],
      fit: "stretch",
    });
    expect(BASE[N.scale].inputs.crop).toBe("disabled");
    expect(BASE[N.mux].inputs).toMatchObject({
      images: [N.paste, 0],
      audio: [N.speech, 0],
    });
    expect(BASE[N.track].inputs).toMatchObject({
      images: [N.padded, 0],
      conditioning: [N.samText, 0],
      max_objects: 1,
    });
  });
});

describe("buildVideoLipsyncWorkflow", () => {
  it("wires refs, sizes, lengths and a 3-pass chain for 6.8 s of speech", () => {
    const { workflow: wf, seed } = buildVideoLipsyncWorkflow(BASE, SRC, 0, {
      seed: 7,
    });
    validate(wf);
    const N = VL_NODES;
    expect(seed).toBe(7);
    expect(wf[N.noise].inputs.noise_seed).toBe(7);
    expect(wf[N.load].inputs).toMatchObject({
      video: "talk.mp4 [input]",
      force_rate: 25,
      frame_load_cap: 170,
      custom_width: 1280,
      custom_height: 0,
    });
    expect(wf[N.audio].inputs.audio).toBe("speech.wav [input]");
    expect(wf[N.speech].inputs.duration).toBe(6.8);
    expect(wf[N.scale].inputs).toMatchObject({ width: 832, height: 480 });
    expect(wf[N.talk].inputs).toMatchObject({
      width: 832,
      height: 480,
      length: 81,
    });
    expect(wf[N.repeat].inputs.amount).toBe(225);
    expect(wf[N.padded].inputs.length).toBe(225);
    expect(wf[N.prompt].inputs.text).toBe(VIDEO_LIPSYNC_PROMPT);
    expect(wf[N.samText].inputs.text).toBe("face");

    const talks = nodesOf(wf, "WanInfiniteTalkToVideo");
    expect(talks).toHaveLength(3);
    expect(nodesOf(wf, "SamplerCustomAdvanced")).toHaveLength(3);
    expect(nodesOf(wf, "SetLatentNoiseMask")).toHaveLength(3);
    // Each extra pass: start frame + source window + mask window at 72k.
    for (const [k, [, t]] of talks.slice(1).entries()) {
      const offset = 72 * (k + 1);
      const start = wf[(t.inputs.start_image as [string, number])[0]];
      expect(start.inputs).toMatchObject({
        image: [N.padded, 0],
        batch_index: offset,
        length: 1,
      });
      expect(t.inputs.previous_frames).toBeDefined();
      const smp = Object.values(wf).find(
        (n) =>
          n.class_type === "SamplerCustomAdvanced" &&
          (n.inputs.sigmas as [string, number])[0] !== N.scheduler &&
          (
            wf[(n.inputs.guider as [string, number])[0]].inputs.model as [
              string,
              number,
            ]
          )[0] === talks[k + 1][0],
      )!;
      const latent = wf[(smp.inputs.latent_image as [string, number])[0]];
      expect(latent.class_type).toBe("SetLatentNoiseMask");
      const enc = wf[(latent.inputs.samples as [string, number])[0]];
      const win = wf[(enc.inputs.pixels as [string, number])[0]];
      expect(win.inputs).toMatchObject({
        image: [N.padded, 0],
        batch_index: offset,
        length: 81,
      });
      const mmask = wf[(latent.inputs.mask as [string, number])[0]];
      const mwin = wf[(mmask.inputs.image as [string, number])[0]];
      expect(mwin.inputs).toMatchObject({
        image: [N.maskImage, 0],
        batch_index: offset,
        length: 81,
      });
    }
    // Trim to the rendered length off the appended batch.
    const trimSrc = (wf[N.trim].inputs.image as [string, number])[0];
    expect(wf[trimSrc].class_type).toBe("ImageBatch");
    expect(wf[N.trim].inputs.length).toBe(170);
  });

  it("one pass for short clips; video length bounds the speech", () => {
    const short = run(
      { videos: [view("v.mp4")], audios: [view("s.wav")] },
      {
        params: { video_seconds: 2, audio_seconds: 9 },
        width: 720,
        height: 1280,
      },
    );
    const { workflow: wf } = buildVideoLipsyncWorkflow(BASE, short, 0);
    validate(wf);
    expect(nodesOf(wf, "WanInfiniteTalkToVideo")).toHaveLength(1);
    expect(wf[VL_NODES.trim].inputs).toMatchObject({
      image: [VL_NODES.decode, 0],
      length: 50,
    });
    expect(wf[VL_NODES.speech].inputs.duration).toBe(2);
    expect(wf[VL_NODES.load].inputs).toMatchObject({
      custom_width: 0,
      custom_height: 0,
    });
    expect(wf[VL_NODES.scale].inputs).toMatchObject({
      width: 480,
      height: 832,
    });
  });

  it("resamples a 24 fps source onto the 25 fps audio clock (no lip drift)", () => {
    // A 24 fps clip with sourceFps sent by the tool runner: the load is still
    // forced to 25 fps and frame count, speech trim and mux share that clock,
    // so frames / fps == speech seconds and the mouth stays on the audio.
    const src24 = run(
      { videos: [view("v24.mp4")], audios: [view("s.wav")] },
      { params: { video_seconds: 10, audio_seconds: 7.3 } },
    );
    const { workflow: wf } = buildVideoLipsyncWorkflow(BASE, src24, 0, {
      sourceFps: 24,
    });
    validate(wf);
    const N = VL_NODES;
    const frames = Math.ceil(7.3 * LIPSYNC_FPS);
    expect(wf[N.load].inputs).toMatchObject({
      force_rate: LIPSYNC_FPS,
      frame_load_cap: frames,
    });
    expect(wf[N.trim].inputs.length).toBe(frames);
    expect(wf[N.mux].inputs.fps).toBe(LIPSYNC_FPS);
    expect(wf[N.speech].inputs.duration).toBeCloseTo(frames / LIPSYNC_FPS, 2);
    // Played back, the video lasts as long as the trimmed speech (< 1 frame).
    expect(
      Math.abs(
        (wf[N.trim].inputs.length as number) / (wf[N.mux].inputs.fps as number) -
          (wf[N.speech].inputs.duration as number),
      ),
    ).toBeLessThan(1 / LIPSYNC_FPS);
  });

  it("paste-back: wider grow/feather + rim tone match (no face drift, soft seam)", () => {
    const { workflow: wf } = buildVideoLipsyncWorkflow(BASE, SRC, 0);
    validate(wf);
    expect(wf[VL_NODES.paste].inputs).toMatchObject({
      ...VIDEO_LIPSYNC_PASTE,
      region: [VL_NODES.temporal, 0],
    });
    // Seam ramp sits outside the regenerated face, tone match is on.
    expect(VIDEO_LIPSYNC_PASTE.grow_px).toBeGreaterThan(
      VIDEO_LIPSYNC_PASTE.feather_px,
    );
    expect(VIDEO_LIPSYNC_PASTE.region_match).toBeGreaterThan(0);
    // The pack itself ships the same values (direct ComfyUI loads match).
    for (const [k, v] of Object.entries(VIDEO_LIPSYNC_PASTE))
      expect(BASE[VL_NODES.paste].inputs[k]).toBe(v);
  });

  it("prefers an explicit audioRef + params and takes the face prompt", () => {
    const { workflow: wf } = buildVideoLipsyncWorkflow(
      BASE,
      run({ videos: [view("v.mp4")] }),
      0,
      {
        audioRef: "new.mp3 [input]",
        audio_seconds: 4,
        target: "man's face",
        prompt: "a man speaking softly",
      },
    );
    expect(wf[VL_NODES.audio].inputs.audio).toBe("new.mp3 [input]");
    expect(wf[VL_NODES.samText].inputs.text).toBe("man's face");
    expect(wf[VL_NODES.prompt].inputs.text).toBe("a man speaking softly");
    expect(wf[VL_NODES.trim].inputs.length).toBe(100);
  });

  it("smart select replaces the text SAM branch with a 25 fps click track", () => {
    const { workflow: wf } = buildVideoLipsyncWorkflow(BASE, SRC, 0, {
      smartTrack: [{ t: 1, positive: [{ x: 900, y: 300 }], negative: [] }],
    });
    validate(wf);
    expect(wf[VL_NODES.track]).toBeUndefined();
    expect(wf[VL_NODES.trackMask]).toBeUndefined();
    expect(wf[VL_NODES.samText]).toBeUndefined();
    const grow = wf[VL_NODES.grow].inputs.mask as [string, number];
    expect(Number(grow[0])).toBeGreaterThanOrEqual(900);
    expect(nodesOf(wf, "LoadVideo")[0][1].inputs.file).toBe("talk.mp4 [input]");
    const slice = nodesOf(wf, "Video Slice")[0][1];
    expect(slice.inputs.start_time).toBe(1);
    const fwd = nodesOf(wf, "ImageFromBatch").find(
      ([, n]) => n.inputs.batch_index === 25 && n.inputs.length === 4096,
    );
    expect(fwd?.[1].inputs.image).toEqual([VL_NODES.padded, 0]);
  });

  it("rejects a run without video or speech, a bad audioRef, or a stale graph", () => {
    expect(() =>
      buildVideoLipsyncWorkflow(BASE, run({ audios: [view("s.wav")] }), 0),
    ).toThrow(/no video/);
    expect(() =>
      buildVideoLipsyncWorkflow(BASE, run({ videos: [view("v.mp4")] }), 0),
    ).toThrow(/speech/);
    expect(() =>
      buildVideoLipsyncWorkflow(BASE, run({ videos: [view("v.mp4")] }), 0, {
        audioRef: "../etc/passwd",
      }),
    ).toThrow(/audioRef/);
    const broken = structuredClone(BASE);
    delete broken[VL_NODES.noiseMask];
    expect(() => buildVideoLipsyncWorkflow(broken, SRC, 0)).toThrow(
      /graph out of sync/,
    );
  });
});

describe("video_lipsync registration", () => {
  it("is in the pack, registry, builders, hub and smart-track sets", () => {
    expect(getPack("wan-animate")?.workflows.video_lipsync).toBe(
      "packs/wan-animate/video_lipsync.json",
    );
    expect(
      resolveWorkflow({
        templateOrAction: "video_lipsync",
        packId: "wan-animate",
      }).workflowPath,
    ).toMatch(/video_lipsync\.json$/);
    const r = registry as unknown as {
      templates: Record<string, { file: string }>;
      actions: Record<string, { template: string; requiresImage: boolean }>;
    };
    expect(r.templates.video_lipsync.file).toBe(
      "packs/wan-animate/video_lipsync.json",
    );
    expect(r.actions.video_lipsync).toMatchObject({
      template: "video_lipsync",
      requiresImage: false,
    });
    expect(ACTION_BUILDERS.video_lipsync).toBe(buildVideoLipsyncWorkflow);
    expect(VIDEO_INPUT_ACTIONS.has("video_lipsync")).toBe(true);
    expect(CARD_OVERRIDES["action:video_lipsync"]).toMatchObject({
      hub: "Audio",
    });
    expect(SMART_TRACK_ACTIONS.has("video_lipsync")).toBe(true);
    expect(SMART_TRACK_WINDOW_SECONDS.video_lipsync).toBeCloseTo(
      VIDEO_LIPSYNC_MAX_SECONDS,
      2,
    );
  });
});

describe("video_lipsync tool", () => {
  const spec = getActionTool("video_lipsync")!;

  it("takes a video and an audio, gated on the wan-animate models", () => {
    expect(spec).toMatchObject({
      videoInput: expect.any(String),
      audioInput: expect.any(String),
      modelCheck: { pack: "wan-animate", action: "video_lipsync" },
      requireStatusEntry: true,
    });
    const s = { ...defaultSettings(spec), text: "girl's face", seed: 3 };
    expect(
      buildActionRequest(spec, s, null, undefined, {
        ref: "a.wav [input]",
        seconds: 5,
      }),
    ).toEqual({
      action: "video_lipsync",
      params: {
        pack_id: "wan-animate",
        audioRef: "a.wav [input]",
        audio_seconds: 5,
        target: "girl's face",
        seed: 3,
      },
      overrides: {},
    });
    expect(() => buildActionRequest(spec, defaultSettings(spec), null)).toThrow(
      ToolInputError,
    );
  });

  it("submitVideoTool uploads clip + speech and seeds both into one run", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url, body });
      const json =
        url === "/api/comfy/upload"
          ? { ok: true, ref: `${body.filename} [input]` }
          : url === "/api/jobs/seed-run"
            ? { ok: true, run: { run_id: "R", jobs: [{ index: 0 }] } }
            : { ok: true, run: { run_id: "NEW", jobs: [] } };
      return { ok: true, status: 200, json: async () => json };
    });
    const video = {
      id: "v",
      previewUrl: "data:video/mp4;base64,AA",
      dataUrl: "data:video/mp4;base64,AA",
      label: "clip.mp4",
      duration: 8,
      width: 1280,
      height: 720,
    };
    const audio = {
      id: "a",
      previewUrl: "data:audio/wav;base64,AA",
      dataUrl: "data:audio/wav;base64,AA",
      label: "line.wav",
      duration: 4.5,
    };
    await expect(
      submitVideoTool({
        fetchImpl,
        spec,
        settings: defaultSettings(spec),
        video,
        face: null,
        clientId: "c",
      }),
    ).rejects.toThrow(/speech audio/);
    expect(fetchImpl).not.toHaveBeenCalled();

    const out = await submitVideoTool({
      fetchImpl,
      spec,
      settings: defaultSettings(spec),
      video,
      face: null,
      audio,
      clientId: "c",
    });
    expect(out.run_id).toBe("NEW");
    const [upVideo, upAudio, seed, action] = calls;
    expect(upVideo.url).toBe("/api/comfy/upload");
    expect(upAudio.body.filename).toMatch(/^cj_audio_.*\.wav$/);
    expect(seed.body).toMatchObject({
      ref: `${upVideo.body.filename} [input]`,
      audio: `${upAudio.body.filename} [input]`,
      audio_duration: 4.5,
    });
    expect(action.body).toMatchObject({
      action: "video_lipsync",
      params: {
        audioRef: `${upAudio.body.filename} [input]`,
        audio_seconds: 4.5,
      },
    });
  });
});

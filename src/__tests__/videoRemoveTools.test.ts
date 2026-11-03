/**
 * Video object / text removal (SAM 3.1 + Wan2.2 Fun VACE + CJPasteBackSave)
 * and the video background changer (BiRefNet matte + CJVideoBgComposite):
 * graph structure, builders, registry wiring and the Tools tab cards.
 *
 * Required inputs follow the pc ComfyUI /object_info schemas (core nodes,
 * h3-relay LabsH3PrepareVideo, cj_h3_tools CJ nodes); the live GPU run is not
 * part of this suite.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import { resolveWorkflow } from "@/lib/oj/packs";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  TEXT_REMOVE_PROMPTS,
  VIDEO_OBJECT_REMOVE_ACTION,
  VIDEO_REMOVE_LENGTH,
  VIDEO_REMOVE_SECONDS,
  VIDEO_REMOVE_TEXT_ACTION,
  VIDEO_TEXT_PRESETS,
  VOR_NODES,
  buildVideoObjectRemoveWorkflow,
  buildVideoRemoveTextWorkflow,
  cleanRemoveTarget,
  objectRemovePrompts,
  withTargetShadows,
  videoTextPreset,
} from "@/lib/oj/videoObjectRemove";
import { maskTemporalRadius, vaceMaskAliasRadius } from "@/lib/oj/vaceMask";
import {
  SMART_TRACK_ACTIONS,
  SMART_TRACK_WINDOW_SECONDS,
} from "@/lib/tools/smartTrack";
import {
  VBC_NODES,
  VIDEO_BG_CHANGE_ACTION,
  VIDEO_BG_CHANGE_MAX_SECONDS,
  buildVideoBgChangeWorkflow,
  VIDEO_BG_DEFAULT_SUBJECT,
  videoBgSubject,
} from "@/lib/oj/videoBgChange";
import {
  ACTION_TOOLS,
  ToolInputError,
  actionAvailability,
  buildActionRequest,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";

const loadPack = (rel: string): Workflow => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "public/workflows", rel), "utf-8"),
  ) as Record<string, unknown>;
  delete raw._meta;
  return raw as Workflow;
};
const removeGraph = () => loadPack("packs/wan22/video_object_remove.json");
const bgGraph = () => loadPack("packs/utility/video_bg_change.json");

const videoRun = (): ImagineRun =>
  ({
    run_id: "src",
    prompt: "clip",
    parsedPrompt: "clip",
    width: 832,
    height: 480,
    jobs: [
      {
        seed: 3,
        index: 0,
        status: "completed",
        progress: 100,
        images: [],
        videos: ["/api/comfy/view?filename=cj%2Fstreet.mp4&type=input"],
      },
    ],
    createdAt: new Date().toISOString(),
    status: "completed",
  }) as unknown as ImagineRun;
const noVideoRun = (): ImagineRun =>
  ({
    ...videoRun(),
    jobs: [{ ...videoRun().jobs[0], videos: [] }],
  }) as ImagineRun;

const linked = (wf: Workflow) => {
  for (const [id, node] of Object.entries(wf))
    for (const v of Object.values(node.inputs))
      if (Array.isArray(v) && typeof v[0] === "string")
        expect(wf[v[0]], `${id} -> ${v[0]}`).toBeDefined();
};

// Required inputs per the pc /object_info schemas (+ cj_h3_tools/cj_video_matte.py).
const REQUIRED: Record<string, string[]> = {
  UNETLoader: ["unet_name", "weight_dtype"],
  CLIPLoader: ["clip_name", "type"],
  VAELoader: ["vae_name"],
  LoraLoaderModelOnly: ["model", "lora_name", "strength_model"],
  ModelSamplingSD3: ["model", "shift"],
  CLIPTextEncode: ["clip", "text"],
  WanVaceToVideo: [
    "positive",
    "negative",
    "vae",
    "width",
    "height",
    "length",
    "batch_size",
    "strength",
  ],
  KSamplerAdvanced: [
    "model",
    "add_noise",
    "noise_seed",
    "steps",
    "cfg",
    "sampler_name",
    "scheduler",
    "positive",
    "negative",
    "latent_image",
    "start_at_step",
    "end_at_step",
    "return_with_leftover_noise",
  ],
  TrimVideoLatent: ["samples", "trim_amount"],
  VAEDecode: ["samples", "vae"],
  ImageFromBatch: ["image", "batch_index", "length"],
  CJPasteBackSave: [
    "frames",
    "source",
    "raw_mask",
    "expanded_mask",
    "filename_prefix",
  ],
  LoadVideo: ["file"],
  LabsH3PrepareVideo: ["video", "resolution"],
  CheckpointLoaderSimple: ["ckpt_name"],
  SAM3_VideoTrack: [
    "images",
    "model",
    "detection_threshold",
    "max_objects",
    "detect_interval",
  ],
  SAM3_TrackToMask: ["track_data", "object_indices"],
  GrowMask: ["mask", "expand"],
  EmptyImage: ["width", "height", "batch_size", "color"],
  ImageCompositeMasked: ["destination", "source", "x", "y", "resize_source"],
  CJMaskTemporal: ["mask", "mode", "radius"],
  CJMatteGate: ["matte", "subject", "grow_px", "core_px"],
  "Video Slice": ["video", "start_time", "duration"],
  GetVideoComponents: ["video"],
  LoadBackgroundRemovalModel: ["bg_removal_name"],
  RemoveBackground: ["bg_removal_model", "image"],
  CJVideoBgComposite: [
    "frames",
    "matte",
    "fit",
    "choke_px",
    "feather_px",
    "light_wrap",
    "wrap_px",
    "color_match",
    "blur_px",
  ],
  LoadImage: ["image"],
  CreateVideo: ["images", "fps"],
  SaveVideo: ["video", "filename_prefix", "format", "codec"],
  // Smart select (src/lib/tools/smartTrack.ts) click-track subgraph.
  SAM3_Detect: [
    "model",
    "image",
    "threshold",
    "refine_iterations",
    "individual_masks",
  ],
  MaskToImage: ["mask"],
  ImageToMask: ["image", "channel"],
  ImageScale: ["image", "upscale_method", "width", "height", "crop"],
  ImageBatch: ["image1", "image2"],
  MaskComposite: ["destination", "source", "x", "y", "operation"],
  VHS_SelectImages: ["image", "indexes", "err_if_missing", "err_if_empty"],
  VHS_SelectMasks: ["mask", "indexes", "err_if_missing", "err_if_empty"],
};

describe.each([
  ["video_object_remove", removeGraph],
  ["video_bg_change", bgGraph],
])("%s graph", (_name, graph) => {
  it("uses known classes with every required input, all links resolve", () => {
    const wf = graph();
    for (const [id, node] of Object.entries(wf)) {
      const need = REQUIRED[node.class_type];
      expect(
        need,
        `unknown class ${node.class_type} (node ${id})`,
      ).toBeDefined();
      for (const key of need)
        expect(node.inputs, `${id} ${node.class_type}.${key}`).toHaveProperty(
          key,
        );
    }
    linked(wf);
  });
});

describe("video_object_remove graph shape", () => {
  const wf = removeGraph();
  it("VACE repaints the masked original frames at the prepared size", () => {
    const vace = wf[VOR_NODES.vace].inputs;
    // VACE inpaint convention: the masked area of the control video is neutral grey.
    const fill = wf[(vace.control_video as [string, number])[0]];
    expect(fill.class_type).toBe("ImageCompositeMasked");
    expect(fill.inputs.destination).toEqual([VOR_NODES.prep, 0]);
    expect(fill.inputs.mask).toEqual([VOR_NODES.temporal, 0]);
    expect(wf[(fill.inputs.source as [string, number])[0]].inputs.color).toBe(
      0x7f7f7f,
    );
    // control_masks: the grey-fill mask widened by the latent alias radius.
    expect(vace.control_masks).toEqual([VOR_NODES.latentMask, 0]);
    expect(wf[VOR_NODES.latentMask]).toMatchObject({
      class_type: "CJMaskTemporal",
      inputs: {
        mask: [VOR_NODES.temporal, 0],
        mode: "max",
        radius: vaceMaskAliasRadius(VIDEO_REMOVE_LENGTH),
      },
    });
    expect(vace.width).toEqual([VOR_NODES.prep, 2]);
    expect(vace.height).toEqual([VOR_NODES.prep, 3]);
    expect(((vace.length as number) - 1) % 4).toBe(0);
  });
  it("SAM tracks the prepared frames; the mask grows then dilates in time", () => {
    expect(wf[VOR_NODES.track].inputs.images).toEqual([VOR_NODES.prep, 0]);
    expect(wf[VOR_NODES.grow].inputs.mask).toEqual(["33", 0]);
    expect(wf[VOR_NODES.temporal].inputs).toMatchObject({
      mask: [VOR_NODES.grow, 0],
      mode: "max",
    });
  });
  it("pastes back onto the ORIGINAL clip, trimmed to the real frame count", () => {
    const paste = wf[VOR_NODES.paste].inputs;
    expect(paste.source).toEqual([VOR_NODES.load, 0]);
    expect(paste.raw_mask).toEqual(["33", 0]);
    expect(paste.expanded_mask).toEqual([VOR_NODES.latentMask, 0]);
    expect(paste.protect_text).toBe(false);
    const trim = wf[(paste.frames as [string, number])[0]];
    expect(trim.class_type).toBe("ImageFromBatch");
    expect(trim.inputs.length).toEqual([VOR_NODES.prep, 5]);
    expect(Object.values(wf).some((n) => n.class_type === "SaveVideo")).toBe(
      false,
    );
  });
});

describe("VACE latent-safe mask timing (no grey smear)", () => {
  // Mirror WanVaceToVideo: per-frame grey fill, control_masks squeezed to
  // the latent timeline with torch nearest-exact (one frame per latent).
  const latentSamples = (L: number) => {
    const N = Math.floor((L - 1) / 4) + 1;
    return Array.from({ length: N }, (_, i) =>
      Math.min(L - 1, Math.floor(((i + 0.5) * L) / N)),
    );
  };
  const groupOf = (t: number) => (t === 0 ? 0 : Math.ceil(t / 4));
  const dilate = (m: boolean[], r: number) =>
    m.map((_, t) => m.slice(Math.max(0, t - r), t + r + 1).some(Boolean));

  it("alias radius is 4 frames for the 73-frame window", () => {
    expect(vaceMaskAliasRadius(VIDEO_REMOVE_LENGTH)).toBe(4);
    expect(vaceMaskAliasRadius(1)).toBe(0);
    expect(vaceMaskAliasRadius(81)).toBeGreaterThanOrEqual(3);
  });

  it("every greyed frame is masked at its latent's sampled frame", () => {
    const L = VIDEO_REMOVE_LENGTH;
    const R = vaceMaskAliasRadius(L);
    const samples = latentSamples(L);
    // A fast limb inside the mask for a single frame t, for every t.
    let smearWithoutFix = 0;
    for (let t = 0; t < L; t++) {
      const grey = dilate(
        Array.from({ length: L }, (_, u) => u === t),
        2,
      );
      const latent = dilate(grey, R);
      for (let u = 0; u < L; u++) {
        if (!grey[u]) continue;
        const s = samples[groupOf(u)];
        expect(latent[s], `frame ${u} (limb at ${t})`).toBe(true);
        if (!grey[s]) smearWithoutFix++;
      }
    }
    // The old wiring (control_masks = grey mask) left greyed frames unmasked.
    expect(smearWithoutFix).toBeGreaterThan(0);
  });

  it("temporalRadius param: number clamped to 0..12, else the default", () => {
    expect(maskTemporalRadius(undefined, 2)).toBe(2);
    expect(maskTemporalRadius("5", 2)).toBe(2);
    expect(maskTemporalRadius(6.4, 2)).toBe(6);
    expect(maskTemporalRadius(99, 2)).toBe(12);
    expect(maskTemporalRadius(-3, 2)).toBe(0);
    const { workflow: wf } = buildVideoObjectRemoveWorkflow(
      removeGraph(),
      videoRun(),
      0,
      { target: "cup", temporalRadius: 5 },
    );
    linked(wf);
    expect(wf[VOR_NODES.temporal].inputs.radius).toBe(5);
    expect(wf[VOR_NODES.latentMask].inputs.radius).toBe(4);
    expect(wf[VOR_NODES.vace].inputs.control_masks).toEqual([
      VOR_NODES.latentMask,
      0,
    ]);
  });

  it("smart select keeps the latent mask chain intact", () => {
    const { workflow: wf } = buildVideoObjectRemoveWorkflow(
      removeGraph(),
      videoRun(),
      0,
      {
        smartTrack: [{ t: 0.5, positive: [{ x: 400, y: 200 }], negative: [] }],
      },
    );
    linked(wf);
    expect(wf[VOR_NODES.latentMask].inputs.mask).toEqual([
      VOR_NODES.temporal,
      0,
    ]);
    expect(wf[VOR_NODES.paste].inputs.expanded_mask).toEqual([
      VOR_NODES.latentMask,
      0,
    ]);
  });
});

describe("video_object_remove / video_remove_text builders", () => {
  it("are wired in registry, pack resolution and video-input builders", () => {
    for (const action of [
      VIDEO_OBJECT_REMOVE_ACTION,
      VIDEO_REMOVE_TEXT_ACTION,
    ]) {
      expect(
        resolveWorkflow({ templateOrAction: action, packId: "wan22" })
          .workflowPath,
      ).toMatch(/packs\/wan22\/video_object_remove\.json$/);
      expect(VIDEO_INPUT_ACTIONS.has(action)).toBe(true);
    }
    expect(actionBuilderFor(VIDEO_OBJECT_REMOVE_ACTION)).toBe(
      buildVideoObjectRemoveWorkflow,
    );
    expect(actionBuilderFor(VIDEO_REMOVE_TEXT_ACTION)).toBe(
      buildVideoRemoveTextWorkflow,
    );
  });

  it("object: target into SAM + prompts, 3 s window, balanced speed", () => {
    const {
      workflow: wf,
      seed,
      slots,
    } = buildVideoObjectRemoveWorkflow(removeGraph(), videoRun(), 0, {
      target: "  red   umbrella, ",
      seed: 11,
    });
    linked(wf);
    expect(seed).toBe(11);
    expect(wf[VOR_NODES.load].inputs.file).toBe("cj/street.mp4 [input]");
    expect(wf[VOR_NODES.prep].inputs.duration_seconds).toBe(
      VIDEO_REMOVE_SECONDS,
    );
    expect(wf[VOR_NODES.vace].inputs.length).toBe(VIDEO_REMOVE_LENGTH);
    expect(wf[VOR_NODES.samText].inputs.text).toBe("red umbrella, red umbrella shadow");
    expect(wf[VOR_NODES.pos].inputs.text).not.toMatch(/umbrella/);
    expect(wf[VOR_NODES.neg].inputs.text).toMatch(/^red umbrella, /);
    expect(wf[VOR_NODES.track].inputs).toMatchObject({
      max_objects: 8,
      detect_interval: 4,
    });
    expect(wf[VOR_NODES.grow].inputs.expand).toBe(10);
    expect(wf[VOR_NODES.hi].inputs.noise_seed).toBe(11);
    // balanced: hi w/o LoRA, 8 steps cfg 3.5
    expect(wf[VOR_NODES.loraHi]).toBeUndefined();
    expect(wf[VOR_NODES.shiftHi].inputs.model).toEqual(["1", 0]);
    expect(wf[VOR_NODES.hi].inputs).toMatchObject({ steps: 8, cfg: 3.5 });
    expect(wf[VOR_NODES.paste].inputs.filename_prefix).toBe(
      "video/CJ_ObjectRemove",
    );
    expect(slots).toMatchObject({
      ksamplerId: VOR_NODES.hi,
      posTextId: VOR_NODES.pos,
      imageInputId: VOR_NODES.load,
    });
  });

  it("fast speed puts the high-noise LoRA in at 4 steps", () => {
    const { workflow: wf } = buildVideoObjectRemoveWorkflow(
      removeGraph(),
      videoRun(),
      0,
      { target: "cup", speed: "fast" },
    );
    linked(wf);
    expect(wf[VOR_NODES.shiftHi].inputs.model).toEqual([VOR_NODES.loraHi, 0]);
    expect(wf[VOR_NODES.hi].inputs).toMatchObject({
      steps: 4,
      cfg: 1,
      end_at_step: 2,
    });
    expect(wf[VOR_NODES.lo].inputs).toMatchObject({
      steps: 4,
      start_at_step: 2,
    });
  });

  it("object target defaults and ':N' counts stay SAM-only", () => {
    expect(cleanRemoveTarget("   ", "object")).toBe("object");
    expect(cleanRemoveTarget("a".repeat(300), "x")).toHaveLength(120);
    const p = objectRemovePrompts("cup:2, bag");
    // umT5 has no negation and fast mode runs cfg 1 (negative ignored):
    // naming the target in the positive paints it back in.
    expect(p.positive).not.toMatch(/cup|bag/);
    expect(p.negative).toMatch(/^cup, bag, shadow of the cup, bag/);
    expect(p.negative).not.toMatch(/:2/);
    const { workflow: wf } = buildVideoObjectRemoveWorkflow(
      removeGraph(),
      videoRun(),
      0,
    );
    expect(wf[VOR_NODES.samText].inputs.text).toBe("object, object shadow");
  });

  it("object SAM prompt adds each target's shadow unless told not to", () => {
    expect(withTargetShadows("cup:2, bag")).toBe("cup:2, bag, cup shadow, bag shadow");
    expect(withTargetShadows("car, its shadow")).toBe("car, its shadow");
    expect(withTargetShadows("red car", true)).toBe("red car");
    const { workflow: wf } = buildVideoObjectRemoveWorkflow(removeGraph(), videoRun(), 0, {
      target: "red car",
      keepShadow: true,
    });
    expect(wf[VOR_NODES.samText].inputs.text).toBe("red car");
    expect(wf[VOR_NODES.neg].inputs.text).toMatch(/^red car, shadow of the red car/);
  });

  it("text: preset SAM prompt, denser tracking, wider mask", () => {
    const { workflow: wf } = buildVideoRemoveTextWorkflow(
      removeGraph(),
      videoRun(),
      0,
      { textPreset: "captions" },
    );
    linked(wf);
    expect(wf[VOR_NODES.samText].inputs.text).toBe(
      VIDEO_TEXT_PRESETS.captions.sam,
    );
    expect(wf[VOR_NODES.pos].inputs.text).toBe(TEXT_REMOVE_PROMPTS.positive);
    expect(wf[VOR_NODES.neg].inputs.text).toBe(TEXT_REMOVE_PROMPTS.negative);
    expect(wf[VOR_NODES.track].inputs).toMatchObject({
      max_objects: 16,
      detect_interval: 2,
    });
    expect(wf[VOR_NODES.grow].inputs.expand).toBe(16);
    expect(wf[VOR_NODES.temporal].inputs.radius).toBe(3);
    expect(wf[VOR_NODES.paste].inputs.protect_text).toBe(false);
    expect(wf[VOR_NODES.paste].inputs.filename_prefix).toBe(
      "video/CJ_TextRemove",
    );
  });

  it("text: custom target overrides the preset; unknown preset -> all", () => {
    const { workflow: wf } = buildVideoRemoveTextWorkflow(
      removeGraph(),
      videoRun(),
      0,
      { textPreset: "watermark", target: "station logo" },
    );
    expect(wf[VOR_NODES.samText].inputs.text).toBe("station logo");
    expect(videoTextPreset("nope")).toBe("all");
    expect(videoTextPreset(" Watermark ")).toBe("watermark");
  });

  it("rejects a run without a video and a graph missing nodes", () => {
    expect(() =>
      buildVideoObjectRemoveWorkflow(removeGraph(), noVideoRun(), 0, {
        target: "x",
      }),
    ).toThrow(/no video/);
    const broken = removeGraph();
    delete broken[VOR_NODES.paste];
    expect(() => buildVideoRemoveTextWorkflow(broken, videoRun(), 0)).toThrow(
      /missing node 17/,
    );
  });
});

describe("video_bg_change builder", () => {
  it("is wired in registry, pack resolution and video-input builders", () => {
    expect(
      resolveWorkflow({
        templateOrAction: VIDEO_BG_CHANGE_ACTION,
        packId: "utility",
      }).workflowPath,
    ).toMatch(/packs\/utility\/video_bg_change\.json$/);
    expect(VIDEO_INPUT_ACTIONS.has(VIDEO_BG_CHANGE_ACTION)).toBe(true);
    expect(actionBuilderFor(VIDEO_BG_CHANGE_ACTION)).toBe(
      buildVideoBgChangeWorkflow,
    );
  });

  it("matte is smoothed in time and composited at source fps with audio", () => {
    const wf = bgGraph();
    expect(wf[VBC_NODES.composite].inputs.matte).toEqual(["6", 0]);
    expect(wf["6"].inputs).toMatchObject({ mask: ["24", 0], mode: "stable" });
  });

  it("matte is gated by a SAM 3.1 track of the subject (default person)", () => {
    const wf = bgGraph();
    expect(wf["24"]).toMatchObject({
      class_type: "CJMatteGate",
      inputs: { matte: ["5", 0], subject: ["23", 0] },
    });
    expect(wf["22"].inputs).toMatchObject({
      images: ["3", 0],
      conditioning: [VBC_NODES.subjectText, 0],
    });
    const run = (p: Record<string, unknown>) =>
      buildVideoBgChangeWorkflow(bgGraph(), videoRun(), 0, p).workflow[
        VBC_NODES.subjectText
      ].inputs.text;
    expect(run({})).toBe(VIDEO_BG_DEFAULT_SUBJECT);
    expect(run({ subject: "   " })).toBe("person");
    expect(run({ subject: " man in\n red jacket " })).toBe("man in red jacket");
    expect(videoBgSubject("x".repeat(300))).toHaveLength(120);
    expect(wf["9"].inputs).toMatchObject({
      images: [VBC_NODES.composite, 0],
      fps: ["3", 2],
      audio: ["3", 1],
    });
  });

  it("image background: LoadImage feeds the composite, video branch dropped", () => {
    const { workflow: wf } = buildVideoBgChangeWorkflow(
      bgGraph(),
      videoRun(),
      0,
      {
        secondRefImage: "beach.png [input]",
      },
    );
    linked(wf);
    expect(wf[VBC_NODES.load].inputs.file).toBe("cj/street.mp4 [input]");
    expect(wf[VBC_NODES.slice].inputs.duration).toBe(
      VIDEO_BG_CHANGE_MAX_SECONDS,
    );
    expect(wf[VBC_NODES.bgImage].inputs.image).toBe("beach.png [input]");
    expect(wf[VBC_NODES.composite].inputs.background).toEqual([
      VBC_NODES.bgImage,
      0,
    ]);
    expect(wf[VBC_NODES.bgVideo]).toBeUndefined();
    expect(wf[VBC_NODES.bgFrames]).toBeUndefined();
    expect(wf[VBC_NODES.composite].inputs).toMatchObject({
      light_wrap: 0.25,
      color_match: 0.3,
    });
  });

  it("video background: LoadVideo branch, image dropped", () => {
    const { workflow: wf } = buildVideoBgChangeWorkflow(
      bgGraph(),
      videoRun(),
      0,
      {
        backgroundVideo: "waves.mp4 [input]",
        secondRefImage: "beach.png [input]",
        blend: "strong",
      },
    );
    linked(wf);
    expect(wf[VBC_NODES.bgVideo].inputs.file).toBe("waves.mp4 [input]");
    expect(wf[VBC_NODES.composite].inputs.background).toEqual([
      VBC_NODES.bgFrames,
      0,
    ]);
    expect(wf[VBC_NODES.bgImage]).toBeUndefined();
    expect(wf[VBC_NODES.composite].inputs).toMatchObject({
      light_wrap: 0.45,
      color_match: 0.6,
    });
  });

  it("blur: no background input, no colour match", () => {
    for (const params of [
      {},
      { background: "blur", secondRefImage: "beach.png [input]" },
    ]) {
      const { workflow: wf } = buildVideoBgChangeWorkflow(
        bgGraph(),
        videoRun(),
        0,
        params,
      );
      linked(wf);
      expect(wf[VBC_NODES.composite].inputs.background).toBeUndefined();
      expect(wf[VBC_NODES.composite].inputs.color_match).toBe(0);
      for (const id of [
        VBC_NODES.bgImage,
        VBC_NODES.bgVideo,
        VBC_NODES.bgFrames,
      ])
        expect(wf[id]).toBeUndefined();
    }
  });

  it("rejects bad refs and runs without video", () => {
    expect(() =>
      buildVideoBgChangeWorkflow(bgGraph(), videoRun(), 0, {
        secondRefImage: "../x.png",
      }),
    ).toThrow(/uploaded image ref/);
    expect(() =>
      buildVideoBgChangeWorkflow(bgGraph(), videoRun(), 0, {
        backgroundVideo: "x.exe [input]",
      }),
    ).toThrow(/uploaded video ref/);
    expect(() =>
      buildVideoBgChangeWorkflow(bgGraph(), noVideoRun(), 0),
    ).toThrow(/no video/);
  });
});

describe("Tools tab cards", () => {
  const packs = new Set(["wan22", "utility"]);

  it("object removal card requires a target and gates on its models", () => {
    const spec = getActionTool("video_object_remove")!;
    expect(spec.videoInput).toBeTruthy();
    expect(spec.modelCheck).toEqual({
      pack: "wan22",
      action: "video_object_remove",
    });
    expect(spec.requireStatusEntry).toBe(true);
    expect(() => buildActionRequest(spec, defaultSettings(spec), null)).toThrow(
      ToolInputError,
    );
    expect(
      buildActionRequest(
        spec,
        { ...defaultSettings(spec), text: "red umbrella", seed: 5 },
        null,
      ),
    ).toEqual({
      action: "video_object_remove",
      params: { speed: "balanced", target: "red umbrella", seed: 5 },
      overrides: {},
    });
    expect(
      actionAvailability(spec, packs, null, {
        tools: { video_object_remove: { missing: [] } },
      }).available,
    ).toBe(true);
    expect(
      actionAvailability(spec, packs, null, {
        tools: {
          video_object_remove: { missing: ["diffusion_models/x.safetensors"] },
        },
      }).available,
    ).toBe(false);
  });

  it("text removal card sends the preset (target optional)", () => {
    const spec = getActionTool("video_remove_text")!;
    expect(buildActionRequest(spec, defaultSettings(spec), null)).toEqual({
      action: "video_remove_text",
      params: { speed: "balanced", textPreset: "all" },
      overrides: {},
    });
    const s = defaultSettings(spec);
    s.picks.textPreset = "watermark";
    s.picks.speed = "fast";
    expect(buildActionRequest(spec, s, null).params).toEqual({
      speed: "fast",
      textPreset: "watermark",
    });
  });

  it("background card needs an image unless blurring", () => {
    const spec = getActionTool("video_bg_change")!;
    expect(spec.secondImageOptional).toBe(true);
    expect(() => buildActionRequest(spec, defaultSettings(spec), null)).toThrow(
      /background image/,
    );
    expect(
      buildActionRequest(
        spec,
        defaultSettings(spec),
        null,
        "beach.png [input]",
      ),
    ).toEqual({
      action: "video_bg_change",
      params: {
        background: "image",
        blend: "natural",
        secondRefImage: "beach.png [input]",
      },
      overrides: {},
    });
    const s = defaultSettings(spec);
    s.picks.background = "blur";
    expect(
      buildActionRequest(spec, s, null, "beach.png [input]").params,
    ).toEqual({
      background: "blur",
      blend: "natural",
    });
    s.text = "  dog ";
    expect(buildActionRequest(spec, s, null).params).toMatchObject({
      subject: "dog",
    });
  });

  it("all three are listed once", () => {
    const ids = ACTION_TOOLS.map((t) => t.id);
    for (const id of [
      "video_object_remove",
      "video_remove_text",
      "video_bg_change",
    ])
      expect(ids.filter((x) => x === id)).toHaveLength(1);
  });
});

describe("video_object_remove smart select (clicks)", () => {
  const clicks = [
    {
      t: 1.5,
      positive: [
        { x: 290, y: 110 },
        { x: 250, y: 330 },
      ],
      negative: [{ x: 430, y: 420 }],
    },
    { t: 0, positive: [{ x: 10, y: 20 }], negative: [] },
  ];
  const known = (wf: Workflow) => {
    for (const [id, node] of Object.entries(wf)) {
      const need = REQUIRED[node.class_type];
      expect(
        need,
        `unknown class ${node.class_type} (node ${id})`,
      ).toBeDefined();
      for (const key of need)
        expect(node.inputs, `${id} ${node.class_type}.${key}`).toHaveProperty(
          key,
        );
    }
  };

  it("clicks replace the text-SAM track; mask consumers point at the union", () => {
    const { workflow: wf } = buildVideoObjectRemoveWorkflow(
      removeGraph(),
      videoRun(),
      0,
      { target: "umbrella", smartTrack: clicks, seed: 1 },
    );
    linked(wf);
    known(wf);
    expect(wf[VOR_NODES.track]).toBeUndefined();
    expect(wf[VOR_NODES.trackMask]).toBeUndefined();
    const union = wf[VOR_NODES.grow].inputs.mask as [string, number];
    expect(wf[union[0]].class_type).toBe("MaskComposite");
    expect(wf[VOR_NODES.paste].inputs.raw_mask).toEqual(union);
    // Both tracks run on the tool's own prepared frames.
    const tracks = Object.values(wf).filter(
      (n) => n.class_type === "SAM3_VideoTrack",
    );
    expect(tracks).toHaveLength(3); // t=0 forward + t=1.5 forward/backward
    for (const n of tracks)
      expect(n.inputs.model).toEqual([VOR_NODES.samModel, 0]);
    const detects = Object.values(wf).filter(
      (n) => n.class_type === "SAM3_Detect",
    );
    expect(detects.map((n) => n.inputs.positive_coords).sort()).toEqual([
      '[{"x":10,"y":20}]',
      '[{"x":290,"y":110},{"x":250,"y":330}]',
    ]);
    const fwd = Object.values(wf).filter(
      (n) =>
        n.class_type === "ImageFromBatch" &&
        Array.isArray(n.inputs.image) &&
        n.inputs.image[0] === VOR_NODES.prep,
    );
    expect(fwd.map((n) => n.inputs.batch_index).sort()).toEqual([0, 0, 36]);
  });

  it("no clicks keeps the text path unchanged", () => {
    const plain = buildVideoObjectRemoveWorkflow(removeGraph(), videoRun(), 0, {
      target: "umbrella",
      seed: 1,
    }).workflow;
    const junk = buildVideoObjectRemoveWorkflow(removeGraph(), videoRun(), 0, {
      target: "umbrella",
      seed: 1,
      smartTrack: [{ t: 1, positive: [] }],
    }).workflow;
    expect(junk).toEqual(plain);
    expect(plain[VOR_NODES.grow].inputs.mask).toEqual([VOR_NODES.trackMask, 0]);
  });

  it("remove text: clicks replace the preset track, text tuning kept", () => {
    const plain = buildVideoRemoveTextWorkflow(removeGraph(), videoRun(), 0, {
      textPreset: "watermark",
    }).workflow;
    const { workflow: wf } = buildVideoRemoveTextWorkflow(
      removeGraph(),
      videoRun(),
      0,
      { textPreset: "watermark", smartTrack: clicks },
    );
    linked(wf);
    known(wf);
    expect(wf[VOR_NODES.track]).toBeUndefined();
    const union = wf[VOR_NODES.grow].inputs.mask as [string, number];
    expect(wf[union[0]].class_type).toBe("MaskComposite");
    expect(wf[VOR_NODES.paste].inputs.raw_mask).toEqual(union);
    // Glyph-width grow from the text tuning, not the object one.
    expect(wf[VOR_NODES.grow].inputs.expand).toBe(16);
    expect(plain[VOR_NODES.grow].inputs.expand).toBe(16);
    expect(
      Object.values(wf).filter((n) => n.class_type === "SAM3_Detect"),
    ).toHaveLength(2);
    expect(() =>
      buildVideoRemoveTextWorkflow(removeGraph(), videoRun(), 0, {
        smartTrack: [{ t: 8, positive: [{ x: 1, y: 1 }] }],
      }),
    ).toThrow(/first 3 s/);
  });

  it("the remove-text card forwards clicks", () => {
    const spec = getActionTool("video_remove_text")!;
    const req = buildActionRequest(
      spec,
      { ...defaultSettings(spec), smartTrack: clicks },
      null,
    );
    expect(req.params.smartTrack).toHaveLength(2);
    expect(req.params.textPreset).toBe("all");
    expect(SMART_TRACK_ACTIONS.has("video_remove_text")).toBe(true);
    expect(SMART_TRACK_WINDOW_SECONDS.video_remove_text).toBe(
      VIDEO_REMOVE_SECONDS,
    );
  });

  it("clicks past the 3 s window are dropped; all past -> error", () => {
    const { workflow: wf } = buildVideoObjectRemoveWorkflow(
      removeGraph(),
      videoRun(),
      0,
      { smartTrack: [...clicks, { t: 8, positive: [{ x: 1, y: 1 }] }] },
    );
    expect(
      Object.values(wf).filter((n) => n.class_type === "SAM3_Detect"),
    ).toHaveLength(2);
    expect(() =>
      buildVideoObjectRemoveWorkflow(removeGraph(), videoRun(), 0, {
        smartTrack: [{ t: 8, positive: [{ x: 1, y: 1 }] }],
      }),
    ).toThrow(/first 3 s/);
  });

  it("the card accepts clicks without a text target", () => {
    const spec = getActionTool("video_object_remove")!;
    const req = buildActionRequest(
      spec,
      { ...defaultSettings(spec), smartTrack: clicks, seed: 5 },
      null,
    );
    expect(req.params.smartTrack).toEqual([
      { t: 0, positive: [{ x: 10, y: 20 }], negative: [] },
      clicks[0],
    ]);
    expect(() => buildActionRequest(spec, defaultSettings(spec), null)).toThrow(
      /Smart select/,
    );
  });
});

/**
 * Video object swap from a reference image (SAM 3.1 + Wan2.2 Fun VACE with
 * reference_image + CJPasteBackSave): graph structure, builder, registry
 * wiring, Tools tab card, and the image counterpart app template.
 *
 * Required inputs follow the ComfyUI /object_info schemas (core nodes,
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
  VIDEO_OBJECT_SWAP_ACTION,
  VIDEO_SWAP_LENGTH,
  VIDEO_SWAP_MARGINS,
  VIDEO_SWAP_SECONDS,
  VOS_NODES,
  buildVideoObjectSwapWorkflow,
  objectSwapPrompts,
  videoSwapMargin,
} from "@/lib/oj/videoObjectSwap";
import {
  SMART_TRACK_ACTIONS,
  SMART_TRACK_WINDOW_SECONDS,
} from "@/lib/tools/smartTrack";
import {
  ToolInputError,
  actionAvailability,
  buildActionRequest,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";
import { CARD_OVERRIDES } from "@/lib/tools/hub";
import {
  compileAppPrompt,
  getApp,
  validateAppTemplates,
} from "@/lib/tools/apps";
import rawApps from "@/lib/tools/appTemplates.json";

const swapGraph = (): Workflow => {
  const raw = JSON.parse(
    fs.readFileSync(
      path.join(
        process.cwd(),
        "public/workflows/packs/wan22/video_object_swap.json",
      ),
      "utf-8",
    ),
  ) as Record<string, unknown>;
  delete raw._meta;
  return raw as Workflow;
};

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

const REF = "mug_ref.png [input]";

const linked = (wf: Workflow) => {
  for (const [id, node] of Object.entries(wf))
    for (const v of Object.values(node.inputs))
      if (Array.isArray(v) && typeof v[0] === "string")
        expect(wf[v[0]], `${id} -> ${v[0]}`).toBeDefined();
};

// Required inputs per ComfyUI /object_info (checked against the live server).
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
  LoadImage: ["image"],
  LoadBackgroundRemovalModel: ["bg_removal_name"],
  RemoveBackground: ["bg_removal_model", "image"],
  ImageCropToMask: [
    "images",
    "masks",
    "width",
    "height",
    "pad_factor",
    "grow_mask",
    "background",
  ],
  ResizeAndPadImage: [
    "image",
    "target_width",
    "target_height",
    "padding_color",
    "interpolation",
  ],
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
  "Video Slice": ["video", "start_time", "duration"],
  GetVideoComponents: ["video"],
};

const checkGraph = (wf: Workflow) => {
  for (const [id, node] of Object.entries(wf)) {
    const need = REQUIRED[node.class_type];
    expect(need, `unknown class ${node.class_type} (node ${id})`).toBeDefined();
    for (const key of need)
      expect(node.inputs, `${id} ${node.class_type}.${key}`).toHaveProperty(
        key,
      );
  }
  linked(wf);
};

describe("video_object_swap graph", () => {
  const wf = swapGraph();

  it("uses known classes with every required input, all links resolve", () => {
    checkGraph(wf);
  });

  it("VACE repaints the grey-filled masked area with the reference as subject", () => {
    const vace = wf[VOS_NODES.vace].inputs;
    const fill = wf[(vace.control_video as [string, number])[0]];
    expect(fill.class_type).toBe("ImageCompositeMasked");
    expect(fill.inputs.destination).toEqual([VOS_NODES.prep, 0]);
    expect(fill.inputs.mask).toEqual([VOS_NODES.temporal, 0]);
    expect(wf[(fill.inputs.source as [string, number])[0]].inputs.color).toBe(
      0x7f7f7f,
    );
    // control_masks take the latent-safe (wider) dilation of the grey mask.
    expect(vace.control_masks).toEqual([VOS_NODES.latentMask, 0]);
    expect(wf[VOS_NODES.latentMask]).toMatchObject({
      class_type: "CJMaskTemporal",
      inputs: { mask: [VOS_NODES.temporal, 0], mode: "max", radius: 4 },
    });
    expect(vace.reference_image).toEqual([VOS_NODES.refFit, 0]);
    expect(((vace.length as number) - 1) % 4).toBe(0);
    // The reference latent frame is trimmed before decode.
    expect(wf["14"].inputs.trim_amount).toEqual([VOS_NODES.vace, 3]);
  });

  it("reference: BiRefNet cut-out on white, padded to the prepared video size", () => {
    expect(wf[VOS_NODES.refBgMask].inputs).toEqual({
      bg_removal_model: [VOS_NODES.refBgModel, 0],
      image: [VOS_NODES.refLoad, 0],
    });
    expect(wf[VOS_NODES.refBgModel].inputs.bg_removal_name).toBe(
      "birefnet.safetensors",
    );
    expect(wf[VOS_NODES.refCrop].inputs).toMatchObject({
      images: [VOS_NODES.refLoad, 0],
      masks: [VOS_NODES.refBgMask, 0],
      background: "#FFFFFF",
    });
    expect(wf[VOS_NODES.refFit].inputs).toMatchObject({
      image: [VOS_NODES.refCrop, 0],
      target_width: [VOS_NODES.prep, 2],
      target_height: [VOS_NODES.prep, 3],
      padding_color: "white",
    });
  });

  it("pastes back onto the ORIGINAL clip at source res, no SaveVideo", () => {
    const paste = wf[VOS_NODES.paste].inputs;
    expect(paste.source).toEqual([VOS_NODES.load, 0]);
    expect(paste.raw_mask).toEqual([VOS_NODES.trackMask, 0]);
    expect(paste.expanded_mask).toEqual([VOS_NODES.latentMask, 0]);
    expect(wf[(paste.frames as [string, number])[0]].inputs.length).toEqual([
      VOS_NODES.prep,
      5,
    ]);
    expect(Object.values(wf).some((n) => n.class_type === "SaveVideo")).toBe(
      false,
    );
  });
});

describe("video_object_swap builder", () => {
  it("is wired in registry, pack resolution, video-input builders, smart select", () => {
    expect(
      resolveWorkflow({
        templateOrAction: VIDEO_OBJECT_SWAP_ACTION,
        packId: "wan22",
      }).workflowPath,
    ).toMatch(/packs\/wan22\/video_object_swap\.json$/);
    expect(VIDEO_INPUT_ACTIONS.has(VIDEO_OBJECT_SWAP_ACTION)).toBe(true);
    expect(actionBuilderFor(VIDEO_OBJECT_SWAP_ACTION)).toBe(
      buildVideoObjectSwapWorkflow,
    );
    expect(SMART_TRACK_ACTIONS.has(VIDEO_OBJECT_SWAP_ACTION)).toBe(true);
    expect(SMART_TRACK_WINDOW_SECONDS[VIDEO_OBJECT_SWAP_ACTION]).toBe(
      VIDEO_SWAP_SECONDS,
    );
    expect(CARD_OVERRIDES[`action:${VIDEO_OBJECT_SWAP_ACTION}`]).toBeDefined();
  });

  it("target + reference + replacement words, 3 s window, balanced", () => {
    const {
      workflow: wf,
      seed,
      slots,
    } = buildVideoObjectSwapWorkflow(swapGraph(), videoRun(), 0, {
      target: " coffee   cup, ",
      replacement: "red ceramic mug",
      secondRefImage: REF,
      seed: 9,
    });
    checkGraph(wf);
    expect(seed).toBe(9);
    expect(wf[VOS_NODES.load].inputs.file).toBe("cj/street.mp4 [input]");
    expect(wf[VOS_NODES.refLoad].inputs.image).toBe(REF);
    expect(wf[VOS_NODES.prep].inputs.duration_seconds).toBe(VIDEO_SWAP_SECONDS);
    expect(wf[VOS_NODES.vace].inputs.length).toBe(VIDEO_SWAP_LENGTH);
    expect(wf[VOS_NODES.samText].inputs.text).toBe("coffee cup");
    expect(wf[VOS_NODES.pos].inputs.text).toMatch(
      /^red ceramic mug \(the object from the reference image\), filling the masked area/,
    );
    // The negative never names the target (a cup -> mug swap would fight it).
    expect(wf[VOS_NODES.neg].inputs.text).not.toMatch(/cup/);
    expect(wf[VOS_NODES.grow].inputs.expand).toBe(
      VIDEO_SWAP_MARGINS.normal.grow,
    );
    expect(wf[VOS_NODES.temporal].inputs.radius).toBe(2);
    expect(wf[VOS_NODES.loraHi]).toBeUndefined();
    expect(wf[VOS_NODES.hi].inputs).toMatchObject({
      steps: 8,
      cfg: 3.5,
      noise_seed: 9,
    });
    expect(wf[VOS_NODES.paste].inputs).toMatchObject({
      filename_prefix: "video/CJ_ObjectSwap",
      protect_text: false,
    });
    expect(slots).toMatchObject({
      ksamplerId: VOS_NODES.hi,
      posTextId: VOS_NODES.pos,
      imageInputId: VOS_NODES.load,
    });
  });

  it("wide margin, photo as is (no BiRefNet), fast speed", () => {
    const { workflow: wf } = buildVideoObjectSwapWorkflow(
      swapGraph(),
      videoRun(),
      0,
      {
        target: "vase",
        secondRefImage: REF,
        margin: "wide",
        refPrep: "asis",
        speed: "fast",
      },
    );
    checkGraph(wf);
    expect(wf[VOS_NODES.grow].inputs.expand).toBe(VIDEO_SWAP_MARGINS.wide.grow);
    expect(wf[VOS_NODES.temporal].inputs.radius).toBe(4);
    expect(wf[VOS_NODES.latentMask].inputs.radius).toBe(4);
    expect(wf[VOS_NODES.vace].inputs.control_masks).toEqual([
      VOS_NODES.latentMask,
      0,
    ]);
    expect(wf[VOS_NODES.refFit].inputs.image).toEqual([VOS_NODES.refLoad, 0]);
    for (const id of [
      VOS_NODES.refCrop,
      VOS_NODES.refBgMask,
      VOS_NODES.refBgModel,
    ])
      expect(wf[id]).toBeUndefined();
    expect(wf[VOS_NODES.shiftHi].inputs.model).toEqual([VOS_NODES.loraHi, 0]);
    expect(wf[VOS_NODES.hi].inputs).toMatchObject({ steps: 4, cfg: 1 });
    expect(wf[VOS_NODES.pos].inputs.text).toMatch(
      /^the object from the reference image, filling the masked area/,
    );
  });

  it("temporalRadius (k) overrides the margin default, clamped 0..12", () => {
    const build = (temporalRadius: unknown) =>
      buildVideoObjectSwapWorkflow(swapGraph(), videoRun(), 0, {
        secondRefImage: REF,
        margin: "wide",
        temporalRadius,
      }).workflow;
    const wf = build(6);
    checkGraph(wf);
    expect(wf[VOS_NODES.temporal].inputs.radius).toBe(6);
    expect(wf[VOS_NODES.latentMask].inputs.radius).toBe(4);
    expect(build(99)[VOS_NODES.temporal].inputs.radius).toBe(12);
    expect(build(-3)[VOS_NODES.temporal].inputs.radius).toBe(0);
    expect(build("8")[VOS_NODES.temporal].inputs.radius).toBe(4);
  });

  it("Smart select clicks replace the text SAM branch", () => {
    const { workflow: wf } = buildVideoObjectSwapWorkflow(
      swapGraph(),
      videoRun(),
      0,
      {
        secondRefImage: REF,
        smartTrack: [{ t: 0.5, positive: [{ x: 400, y: 200 }], negative: [] }],
      },
    );
    checkGraph(wf);
    expect(wf[VOS_NODES.track]).toBeUndefined();
    expect(wf[VOS_NODES.trackMask]).toBeUndefined();
    const grow = wf[VOS_NODES.grow].inputs.mask as [string, number];
    expect(Number(grow[0])).toBeGreaterThanOrEqual(900);
    expect(wf[VOS_NODES.paste].inputs.raw_mask).toEqual(grow);
    expect(wf[VOS_NODES.neg].inputs.text).not.toMatch(/^object, /);
    expect(() =>
      buildVideoObjectSwapWorkflow(swapGraph(), videoRun(), 0, {
        secondRefImage: REF,
        smartTrack: [{ t: 5, positive: [{ x: 1, y: 1 }], negative: [] }],
      }),
    ).toThrow(/after the first 3 s/);
  });

  it("rejects a missing / bad reference, no video, and a broken graph", () => {
    expect(() =>
      buildVideoObjectSwapWorkflow(swapGraph(), videoRun(), 0, { target: "x" }),
    ).toThrow(/secondRefImage/);
    expect(() =>
      buildVideoObjectSwapWorkflow(swapGraph(), videoRun(), 0, {
        target: "x",
        secondRefImage: "../etc/passwd",
      }),
    ).toThrow(/secondRefImage/);
    const noVideo = videoRun();
    noVideo.jobs[0].videos = [];
    expect(() =>
      buildVideoObjectSwapWorkflow(swapGraph(), noVideo, 0, {
        secondRefImage: REF,
      }),
    ).toThrow(/no video/);
    const broken = swapGraph();
    delete broken[VOS_NODES.refFit];
    expect(() =>
      buildVideoObjectSwapWorkflow(broken, videoRun(), 0, {
        secondRefImage: REF,
      }),
    ).toThrow(/missing node 44/);
  });

  it("helpers: margin fallback, prompt without words", () => {
    expect(videoSwapMargin("WIDE ")).toBe("wide");
    expect(videoSwapMargin("nope")).toBe("normal");
    expect(objectSwapPrompts("cup:2", "").positive).toMatch(
      /^the object from the reference image, filling the masked area/,
    );
    // Different shape: target in the negative, never in the positive.
    const wide = objectSwapPrompts("man", "a fluffy cat", "wide");
    expect(wide.positive).not.toMatch(/\bman\b/);
    expect(wide.negative).toMatch(/^man, /);
    expect(objectSwapPrompts("cup", "mug", "normal").negative).not.toMatch(
      /cup/,
    );
  });
});

describe("video_object_swap Tools card", () => {
  const spec = getActionTool("video_object_swap")!;
  const packs = new Set(["wan22"]);

  it("declares video + reference inputs and the model check", () => {
    expect(spec.videoInput).toBeTruthy();
    expect(spec.secondImage).toBeTruthy();
    expect(spec.secondImageOptional).toBeFalsy();
    expect(spec.modelCheck).toEqual({
      pack: "wan22",
      action: "video_object_swap",
    });
    expect(spec.requireStatusEntry).toBe(true);
    expect(
      actionAvailability(spec, packs, null, {
        tools: { video_object_swap: { missing: [] } },
      }).available,
    ).toBe(true);
  });

  it("needs a target (or clicks) and the reference photo", () => {
    expect(() =>
      buildActionRequest(spec, defaultSettings(spec), null, REF),
    ).toThrow(ToolInputError);
    expect(() =>
      buildActionRequest(spec, { ...defaultSettings(spec), text: "cup" }, null),
    ).toThrow(/photo of the replacement/);
    const s = defaultSettings(spec);
    s.text = "cup";
    s.secondText = " red mug ";
    s.seed = 4;
    s.picks.margin = "wide";
    s.picks.refPrep = "asis";
    expect(buildActionRequest(spec, s, null, REF)).toEqual({
      action: "video_object_swap",
      params: {
        secondRefImage: REF,
        speed: "balanced",
        margin: "wide",
        refPrep: "asis",
        target: "cup",
        replacement: "red mug",
        seed: 4,
      },
      overrides: {},
    });
    const clicked = buildActionRequest(
      spec,
      {
        ...defaultSettings(spec),
        smartTrack: [{ t: 1, positive: [{ x: 5, y: 6 }], negative: [] }],
      },
      null,
      REF,
    );
    expect(clicked.params).toMatchObject({
      margin: "normal",
      refPrep: "cutout",
      smartTrack: [{ t: 1, positive: [{ x: 5, y: 6 }], negative: [] }],
    });
    expect(clicked.params).not.toHaveProperty("target");
  });
});

describe("object_swap app (image counterpart)", () => {
  it("is a valid two-image insert app with a target field", () => {
    expect(validateAppTemplates(rawApps)).toEqual([]);
    const app = getApp("object_swap")!;
    expect(app.inputs?.second).toBeDefined();
    expect(app.editMode).toBe("insert");
    expect(compileAppPrompt(app, "coffee cup")).toMatch(
      /^Replace the coffee cup in image 1 with the object shown in image 2/,
    );
    expect(compileAppPrompt(app)).toMatch(
      /^Replace the main object in image 1/,
    );
  });
});

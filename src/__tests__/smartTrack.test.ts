/**
 * Smart select for video tools (src/lib/tools/smartTrack.ts): click parsing,
 * letterbox coordinate mapping, and the forward/backward/union SAM3 track
 * subgraph. Required inputs follow the pc ComfyUI /object_info schemas
 * (core comfy_extras.nodes_sam3 + VideoHelperSuite VHS_Select*).
 */
import { describe, expect, it } from "vitest";
import type { Workflow } from "@/types";
import {
  PREVIEW_FRAME_OUTPUT,
  PREVIEW_MASKS_OUTPUT,
  PREVIEW_TRACK_OUTPUT,
  SMART_TRACK_ID_BASE,
  SMART_TRACK_MAX_OCCURRENCES,
  SMART_TRACK_MAX_POINTS,
  SMART_TRACK_WINDOW_SECONDS,
  SmartTrackError,
  addSmartTrackNodes,
  applySmartTrack,
  buildFramePreviewWorkflow,
  buildTrackPreviewWorkflow,
  clientToNatural,
  contentRect,
  coordsJson,
  frameIndexAt,
  hasSmartTrack,
  occurrencesInWindow,
  parseSmartTrack,
} from "@/lib/tools/smartTrack";
import { VIDEO_REMOVE_SECONDS } from "@/lib/oj/videoObjectRemove";
import { PERSON_REMOVE_MAX_SECONDS } from "@/lib/oj/personRemove";

const REQUIRED: Record<string, string[]> = {
  CheckpointLoaderSimple: ["ckpt_name"],
  LoadVideo: ["file"],
  LabsH3PrepareVideo: ["video", "resolution"],
  "Video Slice": ["video", "start_time", "duration"],
  GetVideoComponents: ["video"],
  ImageFromBatch: ["image", "batch_index", "length"],
  SAM3_Detect: [
    "model",
    "image",
    "threshold",
    "refine_iterations",
    "individual_masks",
  ],
  SAM3_VideoTrack: [
    "images",
    "model",
    "detection_threshold",
    "max_objects",
    "detect_interval",
  ],
  SAM3_TrackToMask: ["track_data", "object_indices"],
  MaskToImage: ["mask"],
  ImageToMask: ["image", "channel"],
  ImageScale: ["image", "upscale_method", "width", "height", "crop"],
  ImageBatch: ["image1", "image2"],
  MaskComposite: ["destination", "source", "x", "y", "operation"],
  VHS_SelectImages: ["image", "indexes", "err_if_missing", "err_if_empty"],
  VHS_SelectMasks: ["mask", "indexes", "err_if_missing", "err_if_empty"],
  EmptyImage: ["width", "height", "batch_size", "color"],
  ImageCompositeMasked: ["destination", "source", "x", "y", "resize_source"],
  ImageBlend: ["image1", "image2", "blend_factor", "blend_mode"],
  CreateVideo: ["images", "fps"],
  SaveVideo: ["video", "filename_prefix", "format", "codec"],
  SaveImage: ["images", "filename_prefix"],
  PreviewImage: ["images"],
};

const checkGraph = (wf: Workflow) => {
  for (const [id, node] of Object.entries(wf)) {
    const need = REQUIRED[node.class_type];
    expect(need, `unknown class ${node.class_type} (node ${id})`).toBeDefined();
    for (const key of need)
      expect(node.inputs, `${id} ${node.class_type}.${key}`).toHaveProperty(
        key,
      );
    for (const v of Object.values(node.inputs))
      if (Array.isArray(v) && typeof v[0] === "string")
        expect(wf[v[0]], `${id} -> ${v[0]}`).toBeDefined();
  }
};

const P = [
  { x: 290, y: 110 },
  { x: 250, y: 330 },
  { x: 430, y: 420 },
];

/** Minimal host graph: LoadVideo -> prep -> (text SAM) -> consumer. */
const host = (): Workflow => ({
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sam" } },
  "2": { class_type: "LoadVideo", inputs: { file: "a.mp4 [input]" } },
  "3": {
    class_type: "LabsH3PrepareVideo",
    inputs: { video: ["2", 0], resolution: "480" },
  },
  "4": {
    class_type: "SAM3_VideoTrack",
    inputs: {
      images: ["3", 0],
      model: ["1", 0],
      detection_threshold: 0.4,
      max_objects: 4,
      detect_interval: 4,
    },
  },
  "5": {
    class_type: "SAM3_TrackToMask",
    inputs: { track_data: ["4", 0], object_indices: "" },
  },
  "6": { class_type: "MaskToImage", inputs: { mask: ["5", 0] } },
  "7": { class_type: "PreviewImage", inputs: { images: ["6", 0] } },
});
const graphOpts = {
  sourceVideo: ["2", 0] as [string, number],
  frames: ["3", 0] as [string, number],
  width: ["3", 2] as [string, number],
  height: ["3", 3] as [string, number],
  samModel: ["1", 0] as [string, number],
};
const B = SMART_TRACK_ID_BASE;
const id = (n: number) => String(n);

describe("parseSmartTrack", () => {
  it("rounds/clamps points, snaps t to 24 fps, merges same-frame, sorts", () => {
    const occ = parseSmartTrack([
      { t: 4.51, positive: [{ x: 290.4, y: -3 }], negative: [] },
      { t: 1, positive: [{ x: 1, y: 2 }], negative: [{ x: 5.6, y: 6 }] },
      { t: 4.5, positive: [{ x: 10, y: 20 }] },
      { t: 2, positive: [], negative: [{ x: 1, y: 1 }] }, // no include -> dropped
      { t: "x", positive: P },
      null,
    ]);
    expect(occ).toEqual([
      { t: 1, positive: [{ x: 1, y: 2 }], negative: [{ x: 6, y: 6 }] },
      {
        t: 108 / 24,
        positive: [
          { x: 290, y: 0 },
          { x: 10, y: 20 },
        ],
        negative: [],
      },
    ]);
  });

  it("accepts {occurrences}, caps counts, garbage -> []", () => {
    expect(
      parseSmartTrack({ occurrences: [{ t: 0, positive: P }] }),
    ).toHaveLength(1);
    const many = Array.from({ length: 20 }, (_, i) => ({ t: i, positive: P }));
    expect(parseSmartTrack(many)).toHaveLength(SMART_TRACK_MAX_OCCURRENCES);
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: i, y: i }));
    expect(parseSmartTrack([{ t: 0, positive: pts }])[0].positive).toHaveLength(
      SMART_TRACK_MAX_POINTS,
    );
    expect(parseSmartTrack("nope")).toEqual([]);
    expect(parseSmartTrack(undefined)).toEqual([]);
    expect(hasSmartTrack([{ t: 1, positive: [] }])).toBe(false);
    expect(hasSmartTrack([{ t: 1, positive: P }])).toBe(true);
  });

  it("coordsJson is the SAM3_Detect point format", () => {
    expect(coordsJson(P)).toBe(
      '[{"x":290,"y":110},{"x":250,"y":330},{"x":430,"y":420}]',
    );
    expect(coordsJson([])).toBe("[]");
    expect(frameIndexAt(4.5)).toBe(108);
  });

  it("window constants mirror the graph builders", () => {
    expect(SMART_TRACK_WINDOW_SECONDS.video_object_remove).toBe(
      VIDEO_REMOVE_SECONDS,
    );
    expect(SMART_TRACK_WINDOW_SECONDS.person_remove).toBe(
      PERSON_REMOVE_MAX_SECONDS,
    );
  });
});

describe("clientToNatural (object-fit: contain)", () => {
  it("maps through pillarbox bars on a portrait clip", () => {
    // 512x928 clip in an 800x400 box: scale 400/928, width ~220.7, left ~289.7
    const r = contentRect(800, 400, 512, 928);
    expect(r.top).toBe(0);
    expect(r.left).toBeCloseTo((800 - 512 * (400 / 928)) / 2, 6);
    expect(clientToNatural(400, 200, 800, 400, 512, 928)).toEqual({
      x: 256,
      y: 464,
    });
    expect(clientToNatural(r.left, 0, 800, 400, 512, 928)).toEqual({
      x: 0,
      y: 0,
    });
    expect(clientToNatural(10, 200, 800, 400, 512, 928)).toBeNull(); // in the bar
  });

  it("maps through letterbox bars on a landscape clip", () => {
    // 1920x1080 in a 400x400 box: scale 400/1920, height 225, top 87.5
    expect(clientToNatural(200, 87.5 + 112.5, 400, 400, 1920, 1080)).toEqual({
      x: 960,
      y: 540,
    });
    expect(clientToNatural(200, 20, 400, 400, 1920, 1080)).toBeNull();
  });
});

describe("addSmartTrackNodes", () => {
  it("single occurrence mid-clip: detect on the source frame, forward + reversed backward, concat", () => {
    const wf = host();
    const occ = parseSmartTrack([
      { t: 4.5, positive: P, negative: [{ x: 1, y: 2 }] },
    ]);
    const out = addSmartTrackNodes(wf, { ...graphOpts, occurrences: occ });
    checkGraph(wf);
    expect(out).toEqual([id(B + 18), 0]);

    expect(wf[id(B)].class_type).toBe("Video Slice");
    expect(wf[id(B)].inputs).toMatchObject({
      video: ["2", 0],
      start_time: 4.5,
    });
    const det = wf[id(B + 3)];
    expect(det.class_type).toBe("SAM3_Detect");
    expect(det.inputs.positive_coords).toBe(coordsJson(P));
    expect(det.inputs.negative_coords).toBe('[{"x":1,"y":2}]');
    expect(det.inputs.model).toEqual(["1", 0]);
    // Seed mask scaled (center crop) to the prepared frame size.
    expect(wf[id(B + 5)].inputs).toMatchObject({
      width: ["3", 2],
      height: ["3", 3],
      crop: "center",
    });

    // Forward: frames k.. on the prepared batch, seeded with the click mask.
    expect(wf[id(B + 7)].inputs).toMatchObject({
      image: ["3", 0],
      batch_index: 108,
      length: 4096,
    });
    expect(wf[id(B + 8)].inputs).toMatchObject({
      images: [id(B + 7), 0],
      initial_mask: [id(B + 6), 0],
      max_objects: 1,
    });
    // Backward: frames 0..k reversed, tracked, drop frame k, re-reversed.
    expect(wf[id(B + 10)].inputs).toMatchObject({
      image: ["3", 0],
      batch_index: 0,
      length: 109,
    });
    expect(wf[id(B + 11)].inputs).toMatchObject({
      image: [id(B + 10), 0],
      indexes: "::-1",
    });
    expect(wf[id(B + 12)].inputs).toMatchObject({
      images: [id(B + 11), 0],
      initial_mask: [id(B + 6), 0],
    });
    expect(wf[id(B + 14)].inputs).toMatchObject({
      mask: [id(B + 13), 0],
      indexes: "1::-1",
    });
    expect(wf[id(B + 17)].inputs).toEqual({
      image1: [id(B + 15), 0],
      image2: [id(B + 16), 0],
    });
    expect(wf[id(B + 15)].inputs.mask).toEqual([id(B + 14), 0]);
    expect(wf[id(B + 16)].inputs.mask).toEqual([id(B + 9), 0]);
  });

  it("t=0 is forward-only (no reverse nodes)", () => {
    const wf = host();
    const out = addSmartTrackNodes(wf, {
      ...graphOpts,
      occurrences: parseSmartTrack([{ t: 0, positive: P }]),
    });
    checkGraph(wf);
    expect(out).toEqual([id(B + 9), 0]);
    expect(wf[id(B + 10)]).toBeUndefined();
    expect(Object.values(wf).some((n) => n.class_type.startsWith("VHS_"))).toBe(
      false,
    );
  });

  it("several occurrences are unioned with MaskComposite add", () => {
    const wf = host();
    const out = addSmartTrackNodes(wf, {
      ...graphOpts,
      occurrences: parseSmartTrack([
        { t: 0, positive: P },
        { t: 1, positive: P },
        { t: 2.5, positive: P },
      ]),
    });
    checkGraph(wf);
    const composites = Object.entries(wf).filter(
      ([, n]) => n.class_type === "MaskComposite",
    );
    expect(composites).toHaveLength(2);
    const [[id1, c1], [id2, c2]] = composites;
    expect(c1.inputs).toMatchObject({
      destination: [id(B + 9), 0],
      source: [id(B + 20 + 18), 0],
      operation: "add",
    });
    expect(c2.inputs).toMatchObject({
      destination: [id1, 0],
      source: [id(B + 40 + 18), 0],
      operation: "add",
    });
    expect(out).toEqual([id2, 0]);
    expect(wf[id(B + 40 + 7)].inputs.batch_index).toBe(60);
  });

  it("refuses empty clicks and id collisions", () => {
    expect(() =>
      addSmartTrackNodes(host(), { ...graphOpts, occurrences: [] }),
    ).toThrow(SmartTrackError);
    const wf = host();
    wf[id(B + 3)] = {
      class_type: "PreviewImage",
      inputs: { images: ["6", 0] },
    };
    expect(() =>
      addSmartTrackNodes(wf, {
        ...graphOpts,
        occurrences: parseSmartTrack([{ t: 0, positive: P }]),
      }),
    ).toThrow(/already used/);
  });
});

describe("applySmartTrack / occurrencesInWindow", () => {
  it("rewires consumers of the text-SAM mask and drops the text branch", () => {
    const wf = host();
    const mask = applySmartTrack(wf, {
      ...graphOpts,
      occurrences: parseSmartTrack([{ t: 1, positive: P }]),
      replace: ["5", 0],
      remove: ["4", "5"],
    });
    checkGraph(wf);
    expect(wf["4"]).toBeUndefined();
    expect(wf["5"]).toBeUndefined();
    expect(wf["6"].inputs.mask).toEqual(mask);
  });

  it("drops clicks past the window; all past -> error", () => {
    const occ = parseSmartTrack([
      { t: 1, positive: P },
      { t: 4, positive: P },
    ]);
    expect(occurrencesInWindow(occ, 3, "x").map((o) => o.t)).toEqual([1]);
    expect(occurrencesInWindow([], 3, "x")).toEqual([]);
    expect(() =>
      occurrencesInWindow(parseSmartTrack([{ t: 4, positive: P }]), 3, "x"),
    ).toThrow(/after the first 3 s/);
  });
});

describe("preview graphs", () => {
  it("frame preview: one SAM3_Detect on the clicked source frame", () => {
    const wf = buildFramePreviewWorkflow("a.mp4 [input]", 4.5, P, []);
    checkGraph(wf);
    expect(wf[PREVIEW_FRAME_OUTPUT].class_type).toBe("PreviewImage");
    const det = Object.values(wf).find((n) => n.class_type === "SAM3_Detect")!;
    expect(det.inputs.positive_coords).toBe(coordsJson(P));
    expect(
      Object.values(wf).find((n) => n.class_type === "Video Slice")!.inputs
        .start_time,
    ).toBe(4.5);
  });

  it("track preview: prepared frames, tinted overlay video, optional mask frames", () => {
    const occ = parseSmartTrack([
      { t: 0.5, positive: P },
      { t: 4.5, positive: P },
    ]);
    const wf = buildTrackPreviewWorkflow("a.mp4 [input]", occ, 10, {
      saveMasks: true,
    });
    checkGraph(wf);
    expect(wf[PREVIEW_TRACK_OUTPUT].class_type).toBe("SaveVideo");
    expect(wf[PREVIEW_MASKS_OUTPUT].class_type).toBe("SaveImage");
    const prep = Object.values(wf).find(
      (n) => n.class_type === "LabsH3PrepareVideo",
    )!;
    expect(prep.inputs.duration_seconds).toBe(10);
    expect(
      Object.values(wf).filter((n) => n.class_type === "SAM3_VideoTrack"),
    ).toHaveLength(4);
    expect(
      buildTrackPreviewWorkflow("a.mp4 [input]", occ, 3)[PREVIEW_MASKS_OUTPUT],
    ).toBeUndefined();
  });
});

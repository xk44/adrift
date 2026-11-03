/**
 * Static graph lint (src/lib/tools/graphLint.ts) over every bundled pack
 * graph and every ACTION_BUILDERS graph (built from a synthetic source run),
 * against a recorded object_info slice of the reference ComfyUI box:
 * fixtures/graphLint.objectInfo.json, written by
 * scripts/record-graph-lint-fixture.mjs (read-only GET /object_info/<class>).
 *
 * Fails on errors: dangling links / output indexes, link type mismatches,
 * missing required inputs, unknown input names, unknown classes, bad
 * non-file combo values, out-of-range numbers. Model files are warnings only
 * (they differ per install).
 *
 * Re-record after adding a node class:
 *   GRAPH_LINT_DUMP=/tmp/graph-lint-dump.json vitest run src/__tests__/graphLintPacks.test.ts
 *   node scripts/record-graph-lint-fixture.mjs /tmp/graph-lint-dump.json
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import { ACTION_BUILDERS } from "@/lib/oj/actionBuilders";
import { applyControlOverrides } from "@/lib/oj/workflowControlSchema";
import { wanMotionLtxRequest } from "@/lib/oj/wanMotionLtx";
import {
  ACTION_TOOLS,
  buildActionRequest,
  defaultSettings,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import {
  formatLintIssue,
  lintErrors,
  lintGraph,
  typesCompatible,
} from "@/lib/tools/graphLint";

const ROOT = path.join(process.cwd(), "public/workflows");
const FIXTURE = path.join(__dirname, "fixtures/graphLint.objectInfo.json");

const recorded = JSON.parse(fs.readFileSync(FIXTURE, "utf-8")) as Record<
  string,
  unknown
> & {
  _meta: { missing_on_reference: string[] };
};
const { _meta: meta, ...liveInfo } = recorded;
/**
 * Classes the reference box lacks are linted against the hand-recorded specs
 * other suites already use (Chatterbox, Whisper ASR); only classes with no
 * spec anywhere are skipped.
 */
const fallbackInfo: Record<string, unknown> = {};
for (const f of [
  "chatterboxNodes",
  "dubNodes",
  "gridVideoNodes",
  "videoPaletteNodes",
]) {
  const specs = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, `fixtures/${f}.objectInfo.json`),
      "utf-8",
    ),
  ) as Record<string, unknown>;
  for (const cls of meta.missing_on_reference)
    if (specs[cls]) fallbackInfo[cls] = specs[cls];
}
/**
 * Anima Ref Adapter classes added after the last recording (AnimaRefAdapter
 * recorded live, the pilot classes hand-transcribed; see the file's _meta).
 * A re-recorded live spec supersedes these.
 */
const { _meta: _pendingMeta, ...pendingInfo } = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/animaRefNodes.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;
/** In-repo nodes not yet on the reference box (generated from their INPUT_TYPES). */
const { _meta: _repoMeta, ...repoInfo } = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/videoExtendNodes.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;
/** Follow subject: in-repo cj_h3_tools follow-cam nodes (from INPUT_TYPES). */
const { _meta: _fcMeta, ...followCamInfo } = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/followCamNodes.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;
/** Exact character swap: in-repo cj_h3_tools nodes (from INPUT_TYPES). */
const { _meta: _exMeta, ...exactInfo } = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/exactNodes.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;
/** Music video: live specs recorded after the fixture + cj_stems (in-repo). */
const { _meta: _mvMeta, ...musicVideoInfo } = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/musicVideoNodes.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;
/** H3 Long clip + Fix faces: live specs recorded after the fixture. */
const { _meta: _h3LongMeta, ...h3LongInfo } = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/h3LongClipNodes.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;
/** Refocus / Rack focus lens blur (cj_image_tools/cj_lens_blur.py, in-repo). */
const { _meta: _refocusMeta, ...refocusInfo } = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/refocusNodes.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;
/** MoGe-2 Depth & Normals: core nodes missing from the reference dump. */
const { _meta: _mogeMeta, ...mogeInfo } = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/mogeNodes.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;
/** Material Maps (Marigold V2): core nodes missing from the reference dump. */
const { _meta: _marigoldMeta, ...marigoldInfo } = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/marigoldNodes.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;
/** Layer Split: ComfyUI-See-through pack (live specs, not on the reference box). */
const { _meta: _seeThroughMeta, ...seeThroughInfo } = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/seeThroughNodes.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;
/** SDR to HDR: core ImageSDRToHDR + SaveImageAdvanced (newer than the fixture). */
const { _meta: _sdrToHdrMeta, ...sdrToHdrInfo } = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/sdrToHdrNodes.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;
/** Upscale video FlashVSR (WanVideoWrapper) + LTX x2 (LTXVContextWindows). */
const { _meta: _upscaleEnginesMeta, ...upscaleEnginesInfo } = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/videoUpscaleEnginesNodes.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;
/** Photo upscale (VOSR2): ComfyUI-VOSR2 pack (live specs, not on the reference box). */
const { _meta: _vosr2Meta, ...vosr2Info } = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/vosr2Nodes.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;
/** Upscale video NVIDIA RTX engine: Nvidia_RTX_Nodes_ComfyUI (optional pack). */
const { _meta: _rtxMeta, ...rtxInfo } = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/rtxNodes.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;
/** Video Translator's Several speakers option: same pack as VibeVoiceTTS. */
const vibeVoiceAsrInfo = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/vibevoiceAsrNodes.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;

/** Remove video background's named-subject engine: ComfyUI-MatAnyone (optional pack). */
const { _meta: _matAnyoneMeta, ...matAnyoneInfo } = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/matanyoneNodes.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;

const objectInfo: Record<string, unknown> = {
  ...fallbackInfo,
  ...pendingInfo,
  ...repoInfo,
  ...musicVideoInfo,
  ...h3LongInfo,
  ...followCamInfo,
  ...exactInfo,
  ...refocusInfo,
  ...mogeInfo,
  ...marigoldInfo,
  ...sdrToHdrInfo,
  ...seeThroughInfo,
  ...upscaleEnginesInfo,
  ...vosr2Info,
  ...rtxInfo,
  ...matAnyoneInfo,
  ...vibeVoiceAsrInfo,
  ...liveInfo,
};
const missingOnReference = new Set(
  meta.missing_on_reference.filter((c) => !(c in objectInfo)),
);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith(".json") ? [p] : [];
  });
}

type Node = { class_type: string; inputs: Record<string, unknown> };

function apiGraph(raw: unknown): Workflow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (Array.isArray((raw as { nodes?: unknown }).nodes)) return null;
  const nodes = Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      ([k, n]) =>
        !k.startsWith("_") &&
        n !== null &&
        typeof n === "object" &&
        typeof (n as Node).class_type === "string",
    ),
  );
  return Object.keys(nodes).length > 0 ? (nodes as Workflow) : null;
}

// Local-only scratch graphs that are never committed (absent in a clean checkout).
const LOCAL_ONLY_PACKS = new Set(["packs/minimax/t2v_cached.json"]);

const packGraphs = walk(path.join(ROOT, "packs"))
  .filter((f) => !LOCAL_ONLY_PACKS.has(path.relative(ROOT, f)))
  .map((f) => ({
    name: path.relative(ROOT, f),
    g: apiGraph(JSON.parse(fs.readFileSync(f, "utf-8"))),
  }))
  .filter((x): x is { name: string; g: Workflow } => x.g !== null);

// ---- synthetic source run + per-action params ---------------------------

const view = (name: string) =>
  `/api/comfy/view?filename=${encodeURIComponent(name)}&subfolder=&type=input`;

const sourceRun = {
  run_id: "lint",
  prompt: "a red fox in the snow",
  parsedPrompt: "a red fox in the snow",
  width: 1280,
  height: 720,
  createdAt: "2026-10-25T00:00:00Z",
  status: "done",
  params: { video_seconds: 6, audio_seconds: 4 },
  jobs: [
    {
      seed: 1,
      index: 0,
      status: "done",
      progress: 100,
      images: [view("lint_src.png")],
      videos: [view("lint_clip.mp4")],
      audios: [view("lint_speech.wav")],
    },
  ],
} as unknown as ImagineRun;

const BASE_PARAMS = {
  prompt: "a red fox in the snow",
  text: "the fox",
  seed: 7,
};
const REF = { secondRefImage: "lint_ref.png [input]" };

/** Extra params (and variants) a builder needs to produce a graph. */
const ACTION_PARAMS: Record<string, Record<string, unknown>[]> = {
  anima_ref: [{}, REF],
  sdr_to_hdr: [{}, { peak: 0, exr: "float" }],
  rack_focus: [
    {
      focusA: { x: 0.3, y: 0.5, t: 0 },
      focusB: { x: 0.7, y: 0.5, t: 1.5 },
      ease: "ease_out",
      depthModel: "fast",
    },
  ],
  see_through: [
    {},
    { detail: "fast", steps: 20, split: false, lowVram: true, seed: 7 },
  ],
  moge_geometry: [
    {},
    { source: "panorama", mesh: "light", depth: "colored" },
    { mesh: "off", normals: "directx", detail: "fast" },
    { model: "moge3" },
    { source: "panorama", model: "moge3" },
  ],
  material_maps: [
    {},
    { depth: "off", albedo: "off", detail: "high" },
    { normals: "off" },
  ],
  transition: [REF],
  ltx25_transition: [REF],
  // LTX VFX two-image tools: Ripple needs the edited first frame; Paint
  // Fluid takes an optional painted last frame.
  ltx_ripple: [REF],
  ltx_paint_fluid: [{}, REF],
  ltx_layout_render: [{}, REF],
  ltx_ingredients: [
    {},
    REF,
    { ...REF, extraRefImages: ["lint_ref2.png [input]"] },
    {
      ...REF,
      extraRefImages: ["lint_ref2.png [input]", "lint_ref3.png [input]"],
    },
  ],
  // Motion presets on the LTX-2.5 engine (10 s effect prompt + sound line).
  ltx25_animate: [
    {},
    wanMotionLtxRequest({ preset: "planet_zoom_out", subject: "the fox" })!
      .params,
  ],
  // Multiframe Reference: 2 keyframes (guides pruned) and all 4 as refs.
  multiframe_ref: [
    REF,
    {
      ...REF,
      extraRefImages: ["lint_ref2.png [input]", "lint_ref3.png [input]"],
      keysAsRefs: true,
      timing: "custom",
      keyPositions: [20, 50, 100],
      h3Speed: "fast8",
    },
  ],
  // 3D Splat: default .ply splat, then .spz + the optional mesh branch.
  image_to_splat: [{}, { format: "spz", mesh: "on" }],
  // Body 3D: clip (smoothed, mesh overlay, .glb), photo, and the bare
  // skeleton / .bvh / no-smooth / no-face variant.
  body_3d: [
    {},
    { media: "image" },
    { view: "skeleton", file: "bvh", smooth: "off", face: "off" },
    { media: "image", view: "solo", face: "off" },
  ],
  // H3 Character sheet: default views, and every view + 3 refs at Large.
  h3_charsheet: [
    REF,
    {
      ...REF,
      views: "head_front,head_34_right,head_profile_right,head_back,head_profile_left,head_34_left,body_front,body_side,body_back,outfit_front,outfit_back,hands,feet",
      size: "large",
      secondRefImage: "lint_ref2.png [input]",
      extraRefImages: ["lint_ref3.png [input]"],
      refRoles: ["outfit", "props"],
      h3Speed: "turbo4",
    },
  ],
  character_swap: [REF],
  // Relight "Match a reference": light reference is the 2nd image; faces
  // keep detail (paste-back) by default, "model" drops the chain.
  light_migration: [
    REF,
    { ...REF, text: "soft window light", faceDetail: "model" },
  ],
  face_swap: [REF],
  wan_animate: [REF],
  video_object_swap: [REF],
  // H3 masked edits (h3MaskedEdit.ts): typed vs Qwen-described outfit,
  // clicks, all three cast slots, text-only vs picture-only.
  character_swap_masked: [
    REF,
    {
      ...REF,
      description: "a yellow raincoat",
      smartTrack: [{ t: 0, positive: [{ x: 40, y: 50 }], negative: [] }],
    },
    // Motion guide: pose (pack default) at a custom strength, off, depth.
    { ...REF, motionGuide: "pose", motionGuideStrength: 0.6 },
    { ...REF, motionGuide: "off" },
    { ...REF, motionGuide: "depth" },
    // 2K finish (Open-H3-Regenerate): default strength, tuned + guide off.
    { ...REF, finish: "2k" },
    { ...REF, finish: "2k", finishStrength: 0.7, motionGuide: "off" },
    // Follow subject: crop / paste-back, alone and with 2K + depth.
    { ...REF, followSubject: "auto" },
    { ...REF, followSubject: "on", finish: "2k", motionGuide: "depth" },
  ],
  cast_swap: [
    REF,
    {
      ...REF,
      extraRefImages: ["lint_ref2.png [input]", "lint_ref3.png [input]"],
      roles: "1: the man on the left\n2: the woman",
    },
    {
      ...REF,
      extraRefImages: ["lint_ref2.png [input]"],
      smartTrackSubjects: [
        [{ t: 0, positive: [{ x: 10, y: 20 }], negative: [] }],
        [{ t: 0, positive: [{ x: 90, y: 20 }], negative: [] }],
      ],
    },
    {
      ...REF,
      extraRefImages: ["lint_ref2.png [input]", "lint_ref3.png [input]"],
      followSubject: "on",
    },
  ],
  video_bg_swap: [{ setting: "a snowy village" }, REF],
  video_object_add: [{ object: "a red fox figurine" }, REF],
  seedvr2_upscale: [
    {},
    { media: "image" },
    { model: "quality", color: "wavelet" },
    { media: "image", model: "sharp", color: "none" },
  ],
  voiceover: [
    { engine: "stock" },
    { engine: "clone", audioRef: "lint_voice.mp3 [input]" },
    { engine: "kokoro" },
  ],
  pipeline_script: [
    { kind: "shorts", topic: "how tides work", scenes: 4 },
    { kind: "ad", topic: "a ceramic mug", scenes: 5, preset: "luxury" },
  ],
  stitch_clips: [
    {
      clips: [
        { video: "video/clip0_00001_.mp4 [output]", seconds: 3 },
        { video: "video/clip1_00001_.mp4 [output]", seconds: 3 },
      ],
      fps: 24,
      audio: true,
    },
    {
      clips: [
        "video/clip0_00001_.mp4 [output]",
        "video/clip1_00001_.mp4 [output]",
      ],
    },
  ],
  pipeline_assemble: [
    {
      scenes: [0, 1].map((i) => ({
        video: `video/clip${i}_00001_.mp4 [output]`,
        audio: `audio/voice${i}_00001_.mp3 [output]`,
        caption: `Scene ${i}`,
        clipSeconds: 4.04,
        seconds: 4,
      })),
      music: "audio/bed_00001_.mp3 [output]",
      size: "1080x1920",
      fps: 24,
    },
  ],
  music_video: [
    {
      song: "lint_music.mp3 [input]",
      songStart: 2,
      index: 0,
      startFrame: 0,
      frames: 120,
      refs: ["lint_ref.png [input]"],
      prompt: "A music video starring <Picture 1>.",
      aspect: "16:9",
      token: "linttoken1",
      seed: 7,
    },
    {
      song: "lint_music.mp3 [input]",
      songStart: 2,
      index: 1,
      startFrame: 120,
      frames: 97,
      refs: ["lint_ref.png [input]", "lint_ref2.png [input]"],
      prompt: "A music video starring <Picture 1>, <Picture 2>.",
      aspect: "9:16",
      token: "linttoken1",
      prevFrame:
        "video/adrift_ctx/CJ_MTV_linttoken1/seg01_last_00001_.png [output]",
      vocals: "audio/adrift_mtv/CJ_MTV_vocals_00001_.flac [output]",
      seed: 8,
    },
  ],
  music_video_assemble: [
    {
      clips: [
        "video/adrift_mtv/CJ_MTV_linttoken1_seg01_00001_.mp4 [output]",
        "video/adrift_mtv/CJ_MTV_linttoken1_seg02_00001_.mp4 [output]",
      ],
      frames: [120, 97],
      song: "lint_music.mp3 [input]",
      songStart: 2,
      token: "linttoken1",
    },
  ],
  music_video_stems: [
    { song: "lint_music.mp3 [input]", songStart: 2, seconds: 12 },
  ],
  grid_video: (["poster", "infection", "mosaic"] as const).map((style) => ({
    source: "lint_clip.mp4 [input]",
    sourceKind: "video",
    sourceSeconds: 15,
    audio: "lint_music.mp3 [input]",
    audioSeconds: 12,
    beats: Array.from({ length: 24 }, (_, i) => 0.47 * (i + 1)),
    bpm: 128,
    style,
    gridMax: 4,
    intensity: "high",
  })),
  video_palette: [
    { source: "preset", palette: "#0b3c49, #e07a2f", strength: 0.8 },
    { source: "reference", ...REF, strength: 1 },
    {
      source: "hex",
      palette: "#112233:2, #445566",
      preserveLuminance: true,
      skinProtect: 0.85,
    },
  ],
  motion_script: [{ brief: "a fox runs across a snowy field" }],
  dub_translate: [{ transcript: "hello there", target: "es" }],
  dub_voice: [
    { text: "hola" },
    {
      text: "[1] hola\n[2] adios",
      speakers: [
        { speaker: 1, start: 0, seconds: 4 },
        { speaker: 2, start: 4, seconds: 5 },
      ],
    },
  ],
  dub_voice_chatterbox: [{ text: "hola", language: "es" }],
  dub_mux: [{ audioRef: "lint_dub.mp3 [input]" }],
  sa3_t2a: [{ prompt: "lo-fi beat" }, { prompt: "rain", speed: "quality", lora: "audio/lint_style.safetensors" }],
  sa3_a2a: [{ audioRef: "lint_src.mp3 [input]", prompt: "jazz trio" }],
  sa3_inpaint: [{ audioRef: "lint_src.mp3 [input]", regions: "1-2; 4-5" }],
  sa3_extend: [{ audioRef: "lint_src.mp3 [input]", seconds: 10, total: 60 }],
  voice_change: [{ sourceAudioRef: "lint_speech.mp3 [input]" }],
  overlay_composite: [
    {
      overlays: [
        {
          ref: "lint_sticker.png [input]",
          kind: "image",
          width: 512,
          height: 512,
          x: 0.5,
          y: 0.5,
          scale: 0.25,
          opacity: 1,
          blend: "normal",
          start: 0,
          end: null,
        },
      ],
    },
  ],
};

const reg = registry as unknown as {
  actions: Record<string, { template: string }>;
  templates: Record<string, { file: string }>;
};

function baseGraph(action: string): Workflow {
  const file = reg.templates[reg.actions[action].template].file;
  return apiGraph(
    JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf-8")),
  ) as Workflow;
}

const builderCases = Object.keys(ACTION_BUILDERS).flatMap((action) =>
  (ACTION_PARAMS[action] ?? [{}]).map((extra, i) => ({
    name: `${action}${i ? ` #${i}` : ""}`,
    action,
    params: { ...BASE_PARAMS, ...extra },
  })),
);

function buildCase(c: (typeof builderCases)[number]): Workflow {
  const { workflow } = ACTION_BUILDERS[c.action](
    baseGraph(c.action),
    structuredClone(sourceRun),
    0,
    structuredClone(c.params),
  );
  return workflow;
}

/**
 * Tools-page requests: every action tool, default settings plus each picker
 * option in turn, through buildActionRequest -> builder -> overrides (what
 * POST /api/jobs/action queues). Edit-LoRA tools need a server LoRA list.
 */
const toolCases = ACTION_TOOLS.filter(
  (t) => !t.special && !t.usesEditLora,
).flatMap((spec) => {
  const variants: [string, Record<string, string>][] = [["default", {}]];
  for (const p of spec.pickers ?? [])
    for (const o of p.options.slice(1))
      variants.push([`${p.key}=${o.id}`, { [p.key]: o.id }]);
  return variants.flatMap(([label, picks]) => {
    const settings: ToolSettings = {
      ...defaultSettings(spec),
      text: "the fox",
      secondText: "a calm piano melody",
      picks,
    };
    let req;
    try {
      req = buildActionRequest(
        spec,
        settings,
        null,
        spec.secondImage ? "lint_ref.png [input]" : undefined,
        spec.audioInput
          ? { ref: "lint_speech.mp3 [input]", seconds: 4 }
          : undefined,
      );
    } catch {
      return []; // needs input the sweep cannot fake (covered by builderCases)
    }
    const builder = ACTION_BUILDERS[req.action];
    if (!builder || !reg.actions[req.action]) return [];
    const c = { name: `${spec.id} ${label}`, action: req.action, req };
    try {
      buildToolCase(c);
    } catch {
      return []; // builder rejects this source (e.g. reframe to its own aspect)
    }
    return [c];
  });
});

function buildToolCase(c: (typeof toolCases)[number]): Workflow {
  const { workflow } = ACTION_BUILDERS[c.action](
    baseGraph(c.action),
    structuredClone(sourceRun),
    0,
    { ...structuredClone(c.req.params) },
  );
  return Object.keys(c.req.overrides).length > 0
    ? applyControlOverrides(workflow, c.req.overrides)
    : workflow;
}

const lint = (g: Workflow, templateSlots = false) =>
  lintErrors(
    lintGraph(g, objectInfo, {
      skipClasses: missingOnReference,
      templateSlots,
    }),
  ).map(formatLintIssue);

// Recording helper: class_types + literal values used, for the fixture script.
if (process.env.GRAPH_LINT_DUMP) {
  const graphs = [
    ...packGraphs.map((x) => x.g),
    ...builderCases.map((c) => buildCase(c)),
    ...toolCases.map((c) => buildToolCase(c)),
  ];
  const classes = new Set<string>();
  const values = new Set<string>();
  for (const g of graphs)
    for (const n of Object.values(g) as Node[]) {
      classes.add(n.class_type);
      for (const v of Object.values(n.inputs ?? {}))
        if (typeof v === "string" && v.length < 300) values.add(v);
    }
  fs.writeFileSync(
    process.env.GRAPH_LINT_DUMP,
    JSON.stringify({
      classes: [...classes].sort(),
      values: [...values].sort(),
    }),
  );
}

// ---- tests ---------------------------------------------------------------

describe("graphLint rules", () => {
  const info = {
    Src: { input: { required: {} }, output: ["IMAGE", "MASK", "*"] },
    Dst: {
      input: {
        required: {
          image: ["IMAGE"],
          mode: [["a", "b"]],
          ckpt: [["x.safetensors"]],
          n: ["INT", { min: 1, max: 4 }],
        },
        optional: { any: ["IMAGE,MASK"], dyn: ["COMFY_AUTOGROW_V3", {}] },
        hidden: { unique_id: "UNIQUE_ID" },
      },
      output: ["IMAGE"],
    },
  };
  const g = (inputs: Record<string, unknown>) => ({
    "1": { class_type: "Src", inputs: {} },
    "2": {
      class_type: "Dst",
      inputs: {
        image: ["1", 0],
        mode: "a",
        ckpt: "x.safetensors",
        n: 2,
        ...inputs,
      },
    },
  });
  const kinds = (inputs: Record<string, unknown>) =>
    lintGraph(g(inputs), info).map((i) => `${i.severity}:${i.kind}:${i.input}`);

  it("clean graph is clean (hidden + dynamic child inputs allowed)", () => {
    expect(kinds({ unique_id: "x", "dyn.a": ["1", 0], any: ["1", 1] })).toEqual(
      [],
    );
  });
  it("flags dangling links and output indexes", () => {
    expect(kinds({ image: ["9", 0] })).toEqual(["error:missing_node:image"]);
    expect(kinds({ image: ["1", 3] })).toEqual([
      "error:bad_output_index:image",
    ]);
  });
  it("flags type mismatches, honours * and unions", () => {
    expect(kinds({ image: ["1", 1] })).toEqual(["error:type_mismatch:image"]);
    expect(kinds({ image: ["1", 2] })).toEqual([]);
    expect(typesCompatible("MASK", "IMAGE,MASK")).toBe(true);
    expect(typesCompatible("LATENT", "IMAGE,MASK")).toBe(false);
    expect(typesCompatible("COMBO", "COMBO")).toBe(true);
  });
  it("flags missing required + unknown inputs", () => {
    const graph = g({ bogus: 1 });
    delete (graph["2"].inputs as Record<string, unknown>).mode;
    expect(lintGraph(graph, info).map((i) => `${i.kind}:${i.input}`)).toEqual([
      "missing_required_input:mode",
      "unknown_input:bogus",
    ]);
  });
  it("combo values: error for plain lists, warn for model files", () => {
    expect(kinds({ mode: "c" })).toEqual(["error:invalid_combo_value:mode"]);
    expect(kinds({ ckpt: "y.safetensors" })).toEqual([
      "warn:model_file_not_listed:ckpt",
    ]);
    expect(kinds({ n: 9 })).toEqual(["error:out_of_range:n"]);
  });
  it("flags unknown classes unless skipped", () => {
    const graph = { "1": { class_type: "Nope", inputs: {} } };
    expect(lintGraph(graph, info).map((i) => i.kind)).toEqual([
      "unknown_class_type",
    ]);
    expect(lintGraph(graph, info, { skipClasses: ["Nope"] })).toEqual([]);
  });
});

describe("graph lint fixture", () => {
  it("covers every class used by packs and action builders", () => {
    const used = new Set<string>();
    for (const { g } of packGraphs)
      for (const n of Object.values(g) as Node[]) used.add(n.class_type);
    for (const c of builderCases)
      for (const n of Object.values(buildCase(c)) as Node[])
        used.add(n.class_type);
    for (const c of toolCases)
      for (const n of Object.values(buildToolCase(c)) as Node[])
        used.add(n.class_type);
    const absent = [...used].filter(
      (c) => !(c in objectInfo) && !missingOnReference.has(c),
    );
    expect(absent.sort()).toEqual([]);
  });
});

describe("bundled pack graphs lint clean", () => {
  it("finds the pack graphs", () => {
    expect(packGraphs.length).toBeGreaterThan(80);
  });
  it.each(packGraphs.map((x) => [x.name, x.g] as const))("%s", (_name, g) => {
    expect(lint(g, true)).toEqual([]);
  });
  it("catches a miswired KSampler in every pack graph that has one", () => {
    let checked = 0;
    for (const { name, g } of packGraphs) {
      const ks = Object.entries(g).find(
        ([, n]) => n.class_type === "KSampler" && Array.isArray(n.inputs.model),
      );
      if (!ks || !Array.isArray(ks[1].inputs.positive)) continue;
      const bad = structuredClone(g);
      bad[ks[0]].inputs.positive = ks[1].inputs.model;
      expect(lint(bad, true), name).toContainEqual(
        expect.stringMatching(/^type_mismatch: .*KSampler\.positive/),
      );
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe("ACTION_BUILDERS graphs lint clean", () => {
  it("has a case for every builder", () => {
    const covered = new Set(builderCases.map((c) => c.action));
    expect(Object.keys(ACTION_BUILDERS).filter((a) => !covered.has(a))).toEqual(
      [],
    );
  });
  it.each(builderCases)("$name", (c) => {
    expect(lint(buildCase(c))).toEqual([]);
  });
});

describe("tools-page action requests lint clean", () => {
  it("sweeps the action tools", () => {
    expect(toolCases.length).toBeGreaterThan(40);
  });
  it.each(toolCases)("$name", (c) => {
    expect(lint(buildToolCase(c))).toEqual([]);
  });
});

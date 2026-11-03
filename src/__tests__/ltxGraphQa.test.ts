/**
 * LTX graph QA: every LTX graph Adrift can queue, checked statically against
 * the node schemas of the reference ComfyUI box (no GPU, no network).
 *
 * Graphs: every pack under packs/ltx25/ and packs/ltxv/ (raw), the generic
 * --ar / --draft injection path on those packs, and every LTX builder
 * (Animate, Transition, Motion presets on the LTX engine, the LTX VFX
 * tools, Video Expand on its default LTX engine) over landscape / portrait /
 * square sources and each picker value.
 *
 * Fixture fixtures/ltxQaNodes.objectInfo.json: read-only
 * GET /object_info/<class> for the node classes these graphs use, trimmed:
 * model-file combos keep only the LTX files installed on the box, upload
 * combos are emptied. Model files therefore fail as errors here, not
 * warnings.
 *
 * Checks, on top of graphLint (classes, required inputs, link types, combos,
 * ranges):
 *  - core ComfyUI nodes only (no KJNodes / ComfyUI-LTXVideo classes)
 *  - frame counts 8n+1 (latent length, audio frames, sampled source frames)
 *  - latent sizes and guide images /32; two-stage final size = 2 x stage
 *  - 24 fps playback, audio latent and conditioning frame rate in step
 *  - sound muxed wherever the tool copy promises it
 *  - tiled VAE decode on every LTX-2.5 graph (16 / 12 GB cards)
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import { ACTION_BUILDERS } from "@/lib/oj/actionBuilders";
import { discoverVideoSlots } from "@/lib/oj/discovery";
import { injectParams } from "@/lib/oj/engine";
import { LTX25_ANIMATE_ACTION, LTX25_TRANSITION_ACTION } from "@/lib/oj/ltx25";
import { LTX25_DURATIONS } from "@/lib/oj/ltx25Tools";
import { LTX_INGREDIENTS_ACTION } from "@/lib/oj/ltxIngredients";
import {
  LTX_CINEMAGRAPH_ACTION,
  LTX_CINEMAGRAPH_FRAMES,
  LTX_SLOWMO_SPEEDS,
  LTX_SLOW_MOTION_ACTION,
  LTX_VFX_ACTIONS,
  LTX_VFX_SPECS,
  LTX_WATER_STRENGTHS,
  LTX_ADD_WATER_ACTION,
  LTX_CLEAN_PLATE_ACTION,
  LTX_LAYOUT_RENDER_ACTION,
  LTX_PAINT_FLUID_ACTION,
  LTX_RIPPLE_ACTION,
  ltxSlowmoMotionFps,
} from "@/lib/oj/ltxVfx";
import { LTX_RESTORE_ACTIONS, isLtxRestoreAction } from "@/lib/oj/ltxRestore";
import {
  LTX_EFFECT_PRESET_IDS,
  wanMotionLtxRequest,
} from "@/lib/oj/wanMotionLtx";
import {
  VIDEO_EXPAND_ACTION,
  VIDEO_EXPAND_LTX_EDGES,
  VIDEO_EXPAND_MODES,
} from "@/lib/oj/videoExpand";
import {
  VIDEO_RETAKE_ACTION,
  VIDEO_RETAKE_AUDIO_MODES,
  VIDEO_RETAKE_EDGES,
} from "@/lib/oj/videoRetake";
import { LTX_UPSCALE_X2_ACTION } from "@/lib/oj/ltxUpscaleX2";
import { formatLintIssue, isGraphLink, lintGraph } from "@/lib/tools/graphLint";

const ROOT = path.join(process.cwd(), "public/workflows");
const { _meta: _fixtureMeta, ...INFO } = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/ltxQaNodes.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;

/**
 * LTX-Video 0.9.x checkpoints of the legacy ltxv pack: not on the reference
 * box (video resolves to LTX-2.5; packs.ts), model-status gates them.
 */
const OPTIONAL_MODEL_FILES = new Set([
  "ltx-video-2b-v0.9.5.safetensors",
  "ltxv-2b-0.9.8-distilled.safetensors",
]);

/** Classes from custom node packs (shipped graphs are core-only). */
const NON_CORE = /^(VHS_|KJ|LTXV(?:Tiled|Apply|Prompt|Base|Looping|Q8))|Kijai/;
/** KJNodes classes whose names don't say so. */
const KJ_CLASSES = new Set(["LTXVAudioVideoMask"]);

type Inputs = Record<string, unknown>;
type Case = {
  name: string;
  wf: Workflow;
  template?: boolean;
  /** Non-core classes this graph may use (opt-in modes only). */
  allowNonCore?: string[];
  /** Soundtrack CreateVideo must carry, when the case pins one. */
  audio?: "source" | "generated";
};

const nodes = (wf: Workflow) =>
  Object.entries(wf).filter(
    ([id, n]) => !id.startsWith("_") && n && typeof n === "object",
  );
const byClass = (wf: Workflow, cls: string) =>
  nodes(wf).filter(([, n]) => n.class_type === cls);
const ins = (wf: Workflow, id: string) => wf[id].inputs as Inputs;
const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const is8n1 = (n: number) => n >= 1 && (n - 1) % 8 === 0;

function apiGraph(raw: unknown): Workflow {
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      ([k]) => !k.startsWith("_"),
    ),
  ) as Workflow;
}

const loadPack = (file: string) =>
  apiGraph(JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf-8")));

const reg = registry as unknown as {
  actions: Record<string, { template: string }>;
  templates: Record<string, { file: string }>;
};
const templateFor = (action: string) =>
  loadPack(reg.templates[reg.actions[action].template].file);

// ---- sources -------------------------------------------------------------

const view = (name: string) =>
  `/api/comfy/view?filename=${encodeURIComponent(name)}&subfolder=&type=input`;

function source(width: number, height: number, seconds?: number): ImagineRun {
  return {
    run_id: "ltxqa",
    prompt: "a red fox in the snow",
    parsedPrompt: "a red fox in the snow",
    width,
    height,
    createdAt: "2026-10-28T00:00:00Z",
    status: "done",
    params: seconds === undefined ? {} : { video_seconds: seconds },
    jobs: [
      {
        seed: 1,
        index: 0,
        status: "done",
        progress: 100,
        images: [view("qa_src.png")],
        videos: [view("qa_clip.mp4")],
      },
    ],
  } as unknown as ImagineRun;
}

const SHAPES: [string, number, number][] = [
  ["16:9", 1280, 720],
  ["9:16", 720, 1280],
  ["1:1", 1024, 1024],
  ["21:9", 1680, 720],
];

function build(
  action: string,
  run: ImagineRun,
  params: Record<string, unknown>,
): Workflow {
  return ACTION_BUILDERS[action](templateFor(action), run, 0, {
    seed: 7,
    prompt: "the fox",
    ...params,
  }).workflow;
}

// ---- cases ---------------------------------------------------------------

const packFiles = ["ltx25", "ltxv"].flatMap((dir) =>
  fs
    .readdirSync(path.join(ROOT, "packs", dir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => `packs/${dir}/${f}`),
);

const cases: Case[] = [];
for (const file of packFiles)
  cases.push({
    name: file,
    wf: loadPack(file),
    template: true,
    // Retake's template carries every audio path; its builder keeps one.
    allowNonCore: /video_retake/.test(file) ? [...KJ_CLASSES] : undefined,
  });

// Generic prompt path (--ar / --draft / -bs) on the plain t2v/i2v/flf2v packs.
for (const file of packFiles.filter(
  (f) => !/vfx_|video_expand|video_retake|upscale_x2/.test(f),
)) {
  for (const params of [
    {},
    { ar: "16:9" },
    { ar: "9:16" },
    { ar: "21:9" },
    { ar: "2:3", draft: true },
  ]) {
    const wf = loadPack(file);
    injectParams(wf, discoverVideoSlots(wf), params, "a fox", "", 7);
    cases.push({
      name: `${file} inject ${JSON.stringify(params)}`,
      wf,
      template: true,
    });
  }
}

for (const [shape, w, h] of SHAPES) {
  for (const duration of LTX25_DURATIONS) {
    cases.push({
      name: `${LTX25_ANIMATE_ACTION} ${shape} ${duration}s`,
      wf: build(LTX25_ANIMATE_ACTION, source(w, h), { duration }),
    });
    cases.push({
      name: `${LTX25_TRANSITION_ACTION} ${shape} ${duration}s`,
      wf: build(LTX25_TRANSITION_ACTION, source(w, h), {
        duration,
        secondRefImage: "qa_end.png [input]",
      }),
    });
  }
}

for (const preset of LTX_EFFECT_PRESET_IDS) {
  const req = wanMotionLtxRequest({ preset, subject: "the fox" })!;
  cases.push({
    name: `wan_motion ${preset} on ltx25`,
    wf: build(req.action, source(1280, 720), req.params),
  });
}

for (const action of LTX_VFX_ACTIONS) {
  const variants: Record<string, unknown>[] =
    action === LTX_SLOW_MOTION_ACTION
      ? LTX_SLOWMO_SPEEDS.map((speed) => ({ speed: String(speed) }))
      : action === LTX_CINEMAGRAPH_ACTION
        ? LTX_CINEMAGRAPH_FRAMES.map((frames) => ({ frames: String(frames) }))
        : action === LTX_ADD_WATER_ACTION
          ? LTX_WATER_STRENGTHS.map((strength) => ({ strength }))
          : action === LTX_RIPPLE_ACTION
            ? [{ secondRefImage: "qa_edit.png [input]" }]
            : action === LTX_PAINT_FLUID_ACTION ||
                action === LTX_LAYOUT_RENDER_ACTION
              ? [{}, { secondRefImage: "qa_end.png [input]" }]
              : [{}];
  for (const [shape, w, h] of SHAPES)
    for (const seconds of [undefined, 0.5, 2, 3.3, 30])
      for (const extra of variants)
        cases.push({
          name: `${action} ${shape} ${seconds ?? "?"}s ${JSON.stringify(extra)}`,
          wf: build(action, source(w, h, seconds), extra),
        });
}

for (const action of LTX_RESTORE_ACTIONS)
  for (const [shape, w, h] of SHAPES)
    for (const seconds of [undefined, 0.5, 2, 3.3, 30])
      for (const extra of [{}, { prompt: "", strength: 0.8 }])
        cases.push({
          name: `${action} ${shape} ${seconds ?? "?"}s ${JSON.stringify(extra)}`,
          wf: build(action, source(w, h, seconds), extra),
        });

for (const [shape, w, h] of SHAPES)
  for (const extra of [0, 1, 2, 3])
    cases.push({
      name: `${LTX_INGREDIENTS_ACTION} ${shape} ${extra + 1} ingredients`,
      wf: build(LTX_INGREDIENTS_ACTION, source(w, h), {
        secondRefImage: extra ? "qa_ref1.png [input]" : undefined,
        extraRefImages: ["qa_ref2.png [input]", "qa_ref3.png [input]"].slice(
          0,
          Math.max(0, extra - 1),
        ),
      }),
      audio: "generated",
    });

for (const [shape, w, h] of SHAPES)
  for (const expand of Object.keys(VIDEO_EXPAND_MODES))
    for (const res of VIDEO_EXPAND_LTX_EDGES) {
      let wf: Workflow;
      try {
        wf = build(VIDEO_EXPAND_ACTION, source(w, h, 6), {
          expand,
          res: String(res),
        });
      } catch {
        continue; // aspect change to the clip's own aspect is refused
      }
      cases.push({
        name: `${VIDEO_EXPAND_ACTION} ${shape} ${expand} ${res}`,
        wf,
      });
    }

// Retake: keep / follow are core-only; regen masks the audio latent with
// KJNodes' LTXVAudioVideoMask.
for (const [shape, w, h] of SHAPES)
  for (const audio of Object.keys(VIDEO_RETAKE_AUDIO_MODES))
    for (const res of VIDEO_RETAKE_EDGES)
      cases.push({
        name: `${VIDEO_RETAKE_ACTION} ${shape} ${audio} ${res}`,
        wf: build(VIDEO_RETAKE_ACTION, source(w, h, 6), {
          audio,
          res: String(res),
          retake_start: 1,
          retake_end: 3,
        }),
        allowNonCore: audio === "regen" ? [...KJ_CLASSES] : [],
        audio: audio === "regen" ? "generated" : "source",
      });

for (const [shape, w, h] of SHAPES)
  for (const seconds of [undefined, 2, 30])
    cases.push({
      name: `${LTX_UPSCALE_X2_ACTION} ${shape} ${seconds ?? "?"}s`,
      wf: build(LTX_UPSCALE_X2_ACTION, source(w, h, seconds), {}),
      audio: "source",
    });

// ---- per-graph checks ----------------------------------------------------

/** Pack file -> the action that queues it (raw packs carry no action). */
const PACK_ACTIONS: Record<string, string> = {
  "packs/ltx25/i2v.json": LTX25_ANIMATE_ACTION,
  "packs/ltx25/flf2v.json": LTX25_TRANSITION_ACTION,
  "packs/ltx25/video_expand.json": VIDEO_EXPAND_ACTION,
  "packs/ltx25/video_retake.json": VIDEO_RETAKE_ACTION,
  "packs/ltx25/upscale_x2.json": LTX_UPSCALE_X2_ACTION,
  ...Object.fromEntries(
    [...LTX_VFX_ACTIONS, ...LTX_RESTORE_ACTIONS].map((a) => [
      reg.templates[reg.actions[a].template].file,
      a,
    ]),
  ),
};

function actionOf(name: string): string {
  const head = name.split(" ")[0];
  return PACK_ACTIONS[head] ?? head;
}

/** Literal number on a node input, or undefined when it is a link. */
function lit(wf: Workflow, id: string, key: string): number | undefined {
  return num(ins(wf, id)[key]);
}

/** Node feeding `id.key` (one hop), or undefined. */
function src(wf: Workflow, id: string, key: string): string | undefined {
  const v = ins(wf, id)[key];
  return isGraphLink(v) ? String(v[0]) : undefined;
}

/** Image nodes that set the pixel size an LTX guide / i2v image arrives at. */
function guideSizers(wf: Workflow): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string | undefined) => {
    if (!id || seen.has(id) || !wf[id]) return;
    seen.add(id);
    const cls = wf[id].class_type;
    if (cls === "LTXVPreprocess") return walk(src(wf, id, "image"));
    if (cls === "ImageCompositeMasked") return walk(src(wf, id, "destination"));
    if (
      cls === "ImageScale" ||
      cls === "EmptyImage" ||
      cls === "ResizeImageMaskNode"
    )
      out.push(id);
  };
  for (const cls of ["LTXVAddGuide", "LTXVImgToVideoInplace", "LTXVImgToVideo"])
    for (const [id] of byClass(wf, cls)) walk(src(wf, id, "image"));
  return out;
}

function sizeOf(wf: Workflow, id: string): [unknown, unknown] {
  const i = ins(wf, id);
  return wf[id].class_type === "ResizeImageMaskNode"
    ? [i["resize_type.width"], i["resize_type.height"]]
    : [i.width, i.height];
}

function check(c: Case): string[] {
  const { wf } = c;
  const errs: string[] = [];
  const fail = (m: string) => errs.push(m);

  for (const issue of lintGraph(wf, INFO, { templateSlots: c.template })) {
    if (
      issue.kind === "model_file_not_listed" &&
      OPTIONAL_MODEL_FILES.has(String(ins(wf, issue.nodeId)[issue.input!]))
    )
      continue;
    fail(formatLintIssue(issue));
  }
  for (const [id, n] of nodes(wf))
    if (
      (NON_CORE.test(n.class_type) || KJ_CLASSES.has(n.class_type)) &&
      !c.allowNonCore?.includes(n.class_type)
    )
      fail(`#${id} non-core ${n.class_type}`);

  const ltx25 = byClass(wf, "UNETLoader").some(([, n]) =>
    /ltx-?2[._]5/i.test(String((n.inputs as Inputs).unet_name)),
  );
  const twoStage = byClass(wf, "LTXVLatentUpsampler").length > 0;
  const action = actionOf(c.name);
  const vfx = LTX_VFX_SPECS[action];

  // Frames 8n+1, sizes /32.
  const lengths: number[] = [];
  for (const cls of ["EmptyLTXVLatentVideo", "LTXVImgToVideo"])
    for (const [id] of byClass(wf, cls)) {
      const [w, h, len] = ["width", "height", "length"].map((k) =>
        lit(wf, id, k),
      );
      if (w !== undefined && w % 32) fail(`#${id} ${cls} width ${w} not /32`);
      if (h !== undefined && h % 32) fail(`#${id} ${cls} height ${h} not /32`);
      if (len !== undefined) {
        lengths.push(len);
        if (!is8n1(len)) fail(`#${id} ${cls} length ${len} not 8n+1`);
      }
      if (twoStage && w !== undefined && h !== undefined) {
        for (const g of guideSizers(wf)) {
          const [gw, gh] = sizeOf(wf, g);
          if (wf[g].class_type === "ResizeImageMaskNode") continue; // i2v: any size
          if (gw !== 2 * w || gh !== 2 * h)
            fail(`#${g} guide ${gw}x${gh} != 2 x stage ${w}x${h}`);
        }
      }
    }
  for (const g of guideSizers(wf)) {
    const [gw, gh] = sizeOf(wf, g);
    const r = ins(wf, g).resize_type;
    if (wf[g].class_type === "ResizeImageMaskNode" && r !== "scale dimensions")
      continue;
    for (const v of [gw, gh])
      if (typeof v === "number" && v % 32)
        fail(`#${g} ${wf[g].class_type} guide size ${gw}x${gh} not /32`);
  }
  for (const [id] of byClass(wf, "VideoFrameSample")) {
    const n = lit(wf, id, "num_frames");
    if (n !== undefined && !is8n1(n)) fail(`#${id} num_frames ${n} not 8n+1`);
    if (n !== undefined && lengths.length && n !== lengths[0])
      fail(`#${id} samples ${n} frames, latent is ${lengths[0]}`);
  }

  // Frame rates and audio.
  const creates = byClass(wf, "CreateVideo");
  if (creates.length !== 1) fail(`${creates.length} CreateVideo nodes`);
  const [createId] = creates[0] ?? [];
  const fpsIn = createId ? ins(wf, createId).fps : undefined;
  const fps = num(fpsIn);
  if (
    action === VIDEO_EXPAND_ACTION ||
    action === VIDEO_RETAKE_ACTION ||
    action === LTX_UPSCALE_X2_ACTION
  ) {
    // Keeps the clip's own fps (source audio stays in sync).
    const s = createId && src(wf, createId, "fps");
    if (!s || wf[s].class_type !== "GetVideoComponents")
      fail(`${action} fps must follow the source clip`);
  } else if (action === LTX_CLEAN_PLATE_ACTION) {
    // Card samples the source at 25 fps; playback keeps that so the
    // source audio stays in sync.
    if (fps !== 25) fail(`clean plate playback ${fps} fps, want 25`);
  } else if (fps !== 24) fail(`CreateVideo fps ${String(fpsIn)}, want 24`);

  for (const [id] of byClass(wf, "LTXVConditioning")) {
    const r = ins(wf, id).frame_rate;
    if (isGraphLink(r)) continue;
    const want =
      action === LTX_SLOW_MOTION_ACTION
        ? undefined // 24 / speed, checked below
        : fps;
    if (want !== undefined && r !== want)
      fail(`#${id} conditioning frame_rate ${String(r)} != playback ${want}`);
  }
  for (const [id] of byClass(wf, "LTXVEmptyLatentAudio")) {
    const fn = ins(wf, id).frames_number;
    if (!isGraphLink(fn) && lengths.length && fn !== lengths[0])
      fail(`#${id} audio frames ${String(fn)} != video ${lengths[0]}`);
    const ar = ins(wf, id).frame_rate;
    for (const [cid] of byClass(wf, "LTXVConditioning")) {
      const cr = ins(wf, cid).frame_rate;
      if (JSON.stringify(cr) !== JSON.stringify(ar))
        fail(
          `#${id} audio frame_rate ${String(ar)} != conditioning ${String(cr)}`,
        );
    }
  }

  const audioIn = createId ? src(wf, createId, "audio") : undefined;
  const audioCls = audioIn ? wf[audioIn].class_type : undefined;
  const hasAudioDecode = byClass(wf, "LTXVAudioVAEDecode").length > 0;
  const builderPicksAudio = c.template && action === VIDEO_RETAKE_ACTION;
  if (
    hasAudioDecode &&
    audioCls !== "LTXVAudioVAEDecode" &&
    !builderPicksAudio
  )
    fail("generated audio is decoded but not muxed into CreateVideo");
  if (c.audio === "generated" && audioCls !== "LTXVAudioVAEDecode")
    fail("audio regen: CreateVideo must carry the generated audio");
  if (c.audio === "source" && audioCls !== "GetVideoComponents")
    fail("audio keep: CreateVideo must carry the source audio");
  if (c.audio === "source" && hasAudioDecode)
    fail("audio keep: generated audio decoded for nothing");
  const promisesSound =
    action === LTX25_ANIMATE_ACTION ||
    action === LTX25_TRANSITION_ACTION ||
    action === "wan_motion" ||
    /packs\/ltx25\/(t2v|i2v|flf2v)\.json/.test(c.name);
  if (promisesSound && audioCls !== "LTXVAudioVAEDecode")
    fail("tool promises sound but CreateVideo has no generated audio");
  const keepsSource =
    action === VIDEO_EXPAND_ACTION ||
    isLtxRestoreAction(action) ||
    (vfx?.source === "video" && action !== "ltx_alpha_matte");
  if (keepsSource && audioCls !== "GetVideoComponents")
    fail("source audio is promised but not muxed");

  // Low VRAM: LTX-2.5 decodes tiled.
  if (ltx25) {
    if (byClass(wf, "VAEDecode").length)
      fail("LTX-2.5 graph uses untiled VAEDecode");
    if (!byClass(wf, "VAEDecodeTiled").length)
      fail("LTX-2.5 graph has no VAEDecodeTiled");
  }
  return errs;
}

describe("LTX graph QA (static, recorded object_info)", () => {
  it("covers every LTX pack and builder", () => {
    expect(packFiles.length).toBeGreaterThanOrEqual(14);
    const actions = new Set(cases.map((c) => c.name.split(" ")[0]));
    for (const a of [
      LTX25_ANIMATE_ACTION,
      LTX25_TRANSITION_ACTION,
      "wan_motion",
      VIDEO_EXPAND_ACTION,
      VIDEO_RETAKE_ACTION,
      LTX_UPSCALE_X2_ACTION,
      ...LTX_VFX_ACTIONS,
      ...LTX_RESTORE_ACTIONS,
    ])
      expect(actions.has(a), a).toBe(true);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(check(c)).toEqual([]);
  });

  it("slow motion conditions on 24 / speed for both streams", () => {
    for (const speed of LTX_SLOWMO_SPEEDS) {
      const wf = build(LTX_SLOW_MOTION_ACTION, source(1280, 720), {
        speed: String(speed),
      });
      const [[cond]] = byClass(wf, "LTXVConditioning");
      const [[audio]] = byClass(wf, "LTXVEmptyLatentAudio");
      const [[create]] = byClass(wf, "CreateVideo");
      expect(ins(wf, cond).frame_rate).toBe(ltxSlowmoMotionFps(speed));
      expect(ins(wf, audio).frame_rate).toBe(ltxSlowmoMotionFps(speed));
      expect(ins(wf, create).fps).toBe(24);
    }
  });

  it("fixture carries no machine-specific paths", () => {
    const raw = fs.readFileSync(
      path.join(__dirname, "fixtures/ltxQaNodes.objectInfo.json"),
      "utf-8",
    );
    expect(raw).not.toMatch(/\/home\/|\/mnt\/|\/Users\/|192\.168\./);
  });
});

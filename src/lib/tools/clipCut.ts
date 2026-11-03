/**
 * ClipCut / Urban Cuts: a beat-synced look reel from one photo.
 *
 *   look:i    edit the photo into look i (AI Stylist garment + a style setting)
 *   clip:i    animate look i (LTX-Video i2v)
 *   music     ACE-Step bed at a known BPM, or the user's own track (upload)
 *   beats     client-side beat detection on the music (beats.ts, WebAudio)
 *   assemble  pipeline_assemble: one scene per beat cut, cycling the looks,
 *             the music as the whole soundtrack, no captions
 *
 * Pure planning lives here (catalog, cut math, step graph, params); the
 * executor reuses the Shorts Studio helpers in pipelineRunner.ts.
 */
import { pickFinalOutput } from "./pickOutput";
import type { ImagineRun } from "@/types";
import { WARDROBE_PRESETS } from "./lookCatalogs";
import type { TemplatePreset } from "./templates";
import type { EditEngine, EngineContext } from "./templates";
import {
  ASSEMBLE_FPS,
  ASSEMBLE_MAX_SCENES,
  ASSEMBLE_MAX_SECONDS,
  DEFAULT_CLIP_SECONDS,
  SCENE_MAX_SECONDS,
  type AssembleParams,
  type AssembleSize,
  type StepOutput,
  type StepStatus,
} from "./pipelines";
import type { BeatAnalysis } from "./beats";
import {
  ToolApiError,
  audioUploadName,
  submitAnimate,
  submitEngineEdit,
  uploadDataUrl,
  type ToolAudio,
  type ToolImage,
} from "./runTool";
import {
  action,
  measured,
  outputOf,
  plainPrompt,
  promptIdOf,
  seedText,
  waitForOutputs,
  type RunnerDeps,
} from "./pipelineRunner";

// Catalog

export interface ClipCutStyle {
  id: string;
  label: string;
  description: string;
  /** One setting per look (cycled when there are more looks). */
  settings: string[];
  /** Lighting / framing phrase for every look. */
  framing: string;
  /** Motion prompt for every clip. */
  motion: string;
  /** ACE-Step tags for the generated bed. */
  music: string;
  bpm: number;
}

/** Original copy; settings are generic places, no brands or landmarks. */
export const CLIPCUT_STYLES: readonly ClipCutStyle[] = [
  {
    id: "studio",
    label: "Studio cuts",
    description: "Outfit changes on bold seamless backdrops, cut on the beat",
    settings: [
      "front of a seamless warm-white studio backdrop",
      "front of a bold cobalt-blue paper backdrop",
      "front of a soft blush-pink backdrop",
      "front of a charcoal backdrop under a hard spotlight",
      "front of a sunny yellow backdrop",
      "front of a sage-green backdrop",
      "front of a terracotta backdrop",
      "front of a deep black backdrop with a crisp rim light",
    ],
    framing: "full-body vertical fashion photo, clean studio strobe light",
    motion:
      "a confident fashion pose that turns slightly toward the camera, fabric moving, the camera pushes in a little",
    music:
      "fashion runway house, punchy four-on-the-floor kick, glossy synths, energetic",
    bpm: 124,
  },
  {
    id: "urban",
    label: "Urban cuts",
    description: "Street-style looks across city spots, handheld energy",
    settings: [
      "a graffiti-covered alley",
      "a subway platform with a train blurring past",
      "a rooftop at dusk with a city skyline behind",
      "a neon-lit street at night",
      "the middle of a busy crosswalk",
      "a concrete skate park",
      "an underground parking garage with strip lights",
      "a brick storefront with a rolled-down metal shutter",
    ],
    framing: "full-body vertical street-style photo, natural city light",
    motion:
      "walks toward the camera with attitude, handheld camera tracking backwards, street life blurred behind",
    music: "gritty hip hop beat, hard boom bap drums, deep bass, confident",
    bpm: 94,
  },
  {
    id: "runway",
    label: "Runway",
    description: "Each look walks a different runway, flashes on the drop",
    settings: [
      "a long glossy runway with a mirrored floor",
      "a minimalist white runway in a gallery hall",
      "a runway lined with tall grass in a greenhouse",
      "a dark runway under a single moving spotlight",
      "a sandy outdoor runway at sunset",
      "a runway in an industrial warehouse with haze",
      "a runway over shallow water",
      "a red-lit runway with a smoke machine",
    ],
    framing: "full-body vertical runway photo, photographers' flashes",
    motion:
      "walks down the runway toward the camera, stops and poses, camera flashes pop",
    music: "dark techno runway, driving kick, hypnotic bass, tense",
    bpm: 128,
  },
];

export const CLIPCUT_LOOKS = { min: 2, max: 8, default: 4 } as const;
export const CLIPCUT_LENGTHS = [10, 15, 20, 30] as const;
export const CLIPCUT_BEATS_PER_CUT = [1, 2, 4] as const;
export const CLIPCUT_MIN_CUT_SECONDS = 0.5;

/** Garments the looks are dressed in (the AI Stylist full looks first). */
export const CLIPCUT_GARMENTS: TemplatePreset[] = WARDROBE_PRESETS.filter(
  (p) => p.group === "Full looks" || p.group === "Outerwear",
);

export function clipCutStyle(id: string): ClipCutStyle {
  return CLIPCUT_STYLES.find((s) => s.id === id) ?? CLIPCUT_STYLES[0];
}

/** Default garment picks: the first `n` full looks. */
export function defaultGarments(n: number = CLIPCUT_LOOKS.default): string[] {
  return CLIPCUT_GARMENTS.slice(0, n).map((g) => g.id);
}

/** Edit instruction for look `i`. */
export function lookPrompt(
  style: ClipCutStyle,
  garmentId: string,
  i: number,
  notes?: string,
): string {
  const g =
    CLIPCUT_GARMENTS.find((x) => x.id === garmentId) ?? CLIPCUT_GARMENTS[0];
  const garment = g.fragment ?? g.label.toLowerCase();
  const setting = style.settings[i % style.settings.length];
  const extra = plainPrompt(notes ?? "").slice(0, 160);
  return [
    `Dress the person in ${garment}.`,
    `Place them in ${setting}, ${style.framing}.`,
    extra ? `${extra}.` : "",
    "Keep their face, hair and body shape recognizable; same person in every look.",
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\.\./g, ".");
}

// Cut math

export interface Cut {
  /** Music time (s) where the cut starts / ends, frame-quantised. */
  start: number;
  end: number;
  seconds: number;
  /** Look index shown in this cut. */
  look: number;
  /** Offset into that look's clip (later repeats continue the motion). */
  clipStart: number;
}

export interface CutOptions {
  looks: number;
  beatsPerCut: number;
  maxSeconds: number;
  /** Music length; cuts never run past it. */
  duration?: number;
  fps?: number;
  /** Measured clip lengths per look (null = default 4 s). */
  clipSeconds?: (number | null | undefined)[];
  maxCuts?: number;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Beats per cut, doubled until a cut lasts at least the minimum. */
export function effectiveBeatsPerCut(
  beats: number[],
  requested: number,
): number {
  const diffs = beats.slice(1).map((b, i) => b - beats[i]);
  const period = median(diffs) || 0.5;
  let step = Math.max(1, Math.round(requested));
  while (step * period < CLIPCUT_MIN_CUT_SECONDS && step < 64) step *= 2;
  return step;
}

/**
 * Cut the reel on the beat grid: boundaries at every `beatsPerCut`-th beat
 * (the first cut absorbs any intro), capped by length, music and scene
 * limits; looks cycle in order. Boundaries are quantised to whole frames so
 * the assembled timeline stays on the beat with no drift.
 */
export function planCuts(beats: number[], o: CutOptions): Cut[] {
  const fps = o.fps ?? ASSEMBLE_FPS;
  const looks = Math.max(1, Math.round(o.looks));
  const maxCuts = Math.min(
    o.maxCuts ?? ASSEMBLE_MAX_SCENES,
    ASSEMBLE_MAX_SCENES,
  );
  const limit = Math.min(
    o.maxSeconds,
    ASSEMBLE_MAX_SECONDS,
    o.duration && o.duration > 0 ? o.duration : Infinity,
  );
  const sorted = beats
    .filter((b) => Number.isFinite(b) && b >= 0)
    .sort((a, b) => a - b);
  const step = effectiveBeatsPerCut(sorted, o.beatsPerCut);
  const bounds = [0];
  for (let k = step; k < sorted.length; k += step) {
    const t = sorted[k];
    if (t > limit + 1e-6) break;
    if (t - bounds[bounds.length - 1] < CLIPCUT_MIN_CUT_SECONDS) continue;
    if (t - bounds[bounds.length - 1] > SCENE_MAX_SECONDS) break;
    bounds.push(t);
    if (bounds.length - 1 >= maxCuts) break;
  }
  if (bounds.length < 2) {
    const end = Math.min(limit, SCENE_MAX_SECONDS);
    if (!(end >= CLIPCUT_MIN_CUT_SECONDS)) return [];
    bounds.push(end);
  }
  const frames = bounds.map((t) => Math.round(t * fps));
  const cursor = new Array<number>(looks).fill(0);
  const cuts: Cut[] = [];
  for (let i = 0; i < frames.length - 1; i++) {
    const look = i % looks;
    const seconds = (frames[i + 1] - frames[i]) / fps;
    const clipLen =
      o.clipSeconds?.[look] && o.clipSeconds[look]! > 0
        ? o.clipSeconds[look]!
        : DEFAULT_CLIP_SECONDS;
    if (cursor[look] + seconds > clipLen - 0.1) cursor[look] = 0;
    const clipStart = Math.round(cursor[look] * fps) / fps;
    cursor[look] += seconds;
    cuts.push({
      start: frames[i] / fps,
      end: frames[i + 1] / fps,
      seconds,
      look,
      clipStart: Math.round(clipStart * 1000) / 1000,
    });
  }
  return cuts;
}

// Step graph

export type ClipCutStepKind = "look" | "clip" | "music" | "beats" | "assemble";

export interface ClipCutStep {
  id: string;
  kind: ClipCutStepKind;
  scene?: number;
  status: StepStatus;
  error?: string;
  runId?: string;
  jobIndex?: number;
  output?: StepOutput;
}

export interface ClipCutState {
  looks: number;
  order: string[];
  steps: Record<string, ClipCutStep>;
  beats: BeatAnalysis | null;
}

export function ccStepId(kind: ClipCutStepKind, scene?: number): string {
  return scene === undefined ? kind : `${kind}:${scene}`;
}

export function parseCcStepId(id: string): {
  kind: ClipCutStepKind;
  scene?: number;
} {
  const [kind, scene] = id.split(":");
  return scene === undefined
    ? { kind: kind as ClipCutStepKind }
    : { kind: kind as ClipCutStepKind, scene: Number(scene) };
}

/** Looks first (edit model), then clips (video model), music, beats, cut. */
export function clipCutOrder(looks: number): string[] {
  const idx = Array.from({ length: looks }, (_, i) => i);
  return [
    ...idx.map((i) => ccStepId("look", i)),
    ...idx.map((i) => ccStepId("clip", i)),
    "music",
    "beats",
    "assemble",
  ];
}

export function ccDependencies(id: string, order: string[]): string[] {
  const { kind, scene } = parseCcStepId(id);
  switch (kind) {
    case "look":
    case "music":
      return [];
    case "clip":
      return [ccStepId("look", scene)];
    case "beats":
      return ["music"];
    case "assemble":
      return order.filter((s) => s.startsWith("clip:") || s === "beats");
  }
}

function freshCcStep(id: string): ClipCutStep {
  const { kind, scene } = parseCcStepId(id);
  return {
    id,
    kind,
    ...(scene === undefined ? {} : { scene }),
    status: "idle",
  };
}

export function initialClipCut(looks: number): ClipCutState {
  const n = Math.min(CLIPCUT_LOOKS.max, Math.max(1, Math.round(looks)));
  const order = clipCutOrder(n);
  const steps: Record<string, ClipCutStep> = {};
  for (const s of order) steps[s] = freshCcStep(s);
  return { looks: n, order, steps, beats: null };
}

export function ccDependents(id: string, order: string[]): string[] {
  const out = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const s of order) {
      if (!out.has(s) && s !== id && ccDependencies(s, order).includes(cur)) {
        out.add(s);
        queue.push(s);
      }
    }
  }
  return order.filter((s) => out.has(s));
}

/** Reset `id` and everything downstream (beat analysis dropped with `beats`). */
export function ccInvalidate(state: ClipCutState, id: string): ClipCutState {
  const steps = { ...state.steps };
  const hit = [id, ...ccDependents(id, state.order)];
  for (const s of hit) if (steps[s]) steps[s] = freshCcStep(s);
  return { ...state, steps, beats: hit.includes("beats") ? null : state.beats };
}

export function ccUpdateStep(
  state: ClipCutState,
  id: string,
  patch: Partial<ClipCutStep>,
): ClipCutState {
  const cur = state.steps[id] ?? freshCcStep(id);
  return { ...state, steps: { ...state.steps, [id]: { ...cur, ...patch } } };
}

export function ccNextRunnable(state: ClipCutState): string | null {
  for (const id of state.order) {
    const st = state.steps[id]?.status;
    if (st === "done" || st === "error") continue;
    if (
      ccDependencies(id, state.order).every(
        (d) => state.steps[d]?.status === "done",
      )
    )
      return id;
  }
  return null;
}

export function ccCanRerun(state: ClipCutState, id: string): boolean {
  return ccDependencies(id, state.order).every(
    (d) => state.steps[d]?.status === "done",
  );
}

export function ccProgress(state: ClipCutState): {
  done: number;
  total: number;
} {
  return {
    done: state.order.filter((s) => state.steps[s]?.status === "done").length,
    total: state.order.length,
  };
}

// Params + executor

export interface ClipCutInputs {
  style: string;
  /** Garment id per look (length = looks). */
  garments: string[];
  notes?: string;
  photo: ToolImage | null;
  engine: EditEngine | null;
  ctx?: EngineContext;
  motion: "animate_low" | "animate_high";
  musicSource: "generate" | "upload";
  /** Upload: the user's track. */
  track?: ToolAudio | null;
  /** Generate: override the style's music tags. */
  musicTags?: string;
  beatsPerCut: number;
  seconds: number;
  size: AssembleSize;
}

export interface ClipCutDeps extends RunnerDeps {
  /** Decode + detect beats on an audio URL (browser: beats.analyzeAudioUrl). */
  analyzeBeats?: (
    url: string,
    opts: { bpmHint?: number },
  ) => Promise<BeatAnalysis>;
}

/** BPM hint for detection: the generated bed's BPM, none for uploads. */
export function bpmHintFor(
  inputs: Pick<ClipCutInputs, "musicSource" | "style">,
): number | undefined {
  return inputs.musicSource === "generate"
    ? clipCutStyle(inputs.style).bpm
    : undefined;
}

/** Generated bed length: the reel plus a little tail (ACE-Step min 10 s). */
export function musicSecondsFor(reelSeconds: number): number {
  return Math.min(240, Math.max(10, Math.ceil(reelSeconds) + 2));
}

export function clipMotionPrompt(style: ClipCutStyle): string {
  return plainPrompt(`${style.motion}, same outfit and face throughout`);
}

/** pipeline_assemble params from finished steps; throws when one is missing. */
export function clipCutAssembleParams(
  state: ClipCutState,
  inputs: Pick<ClipCutInputs, "beatsPerCut" | "seconds" | "size">,
): AssembleParams & { cuts: Cut[] } {
  if (!state.beats) throw new Error("Detect the beats first.");
  const music = state.steps.music?.output;
  if (!music) throw new Error("The music is missing.");
  const clips = Array.from({ length: state.looks }, (_, i) => {
    const out = state.steps[ccStepId("clip", i)]?.output;
    if (!out) throw new Error(`Look ${i + 1} has no clip yet.`);
    return out;
  });
  const cuts = planCuts(state.beats.beats, {
    looks: state.looks,
    beatsPerCut: inputs.beatsPerCut,
    maxSeconds: inputs.seconds,
    duration: state.beats.duration,
    fps: ASSEMBLE_FPS,
    clipSeconds: clips.map((c) => c.seconds),
  });
  if (!cuts.length) throw new Error("The music is too short to cut.");
  return {
    cuts,
    scenes: cuts.map((c) => {
      const clip = clips[c.look];
      const clipSeconds =
        clip.seconds && clip.seconds > 0 ? clip.seconds : DEFAULT_CLIP_SECONDS;
      return {
        video: clip.ref,
        clipSeconds,
        seconds: c.seconds,
        ...(c.clipStart > 0 ? { startSeconds: c.clipStart } : {}),
      };
    }),
    music: music.ref,
    musicDb: 0,
    size: inputs.size,
    fps: ASSEMBLE_FPS,
    captions: false,
    prefix: "video/adrift_clipcut",
  };
}

export interface ClipCutStepResult {
  output?: StepOutput;
  runId?: string;
  jobIndex?: number;
  beats?: BeatAnalysis;
}

export async function executeClipCutStep(
  state: ClipCutState,
  id: string,
  inputs: ClipCutInputs,
  deps: ClipCutDeps,
): Promise<ClipCutStepResult> {
  const { kind, scene } = parseCcStepId(id);
  const style = clipCutStyle(inputs.style);

  if (kind === "look") {
    if (!inputs.photo || !inputs.engine || !inputs.ctx)
      throw new ToolApiError("Add the photo and pick an edit engine first.");
    deps.prepared ??= {};
    const garment = inputs.garments[scene!] ?? inputs.garments[0];
    const run: ImagineRun = await submitEngineEdit({
      fetchImpl: deps.fetchImpl,
      engine: inputs.engine,
      prompt: lookPrompt(style, garment, scene!, inputs.notes),
      image: inputs.photo,
      ctx: inputs.ctx,
      clientId: deps.clientId,
      title: `ClipCut look ${scene! + 1}`,
      prepared: deps.prepared,
    });
    deps.onRun?.(run);
    const out = await waitForOutputs(deps, promptIdOf(run));
    return {
      output: outputOf(pickFinalOutput(out.images), "image"),
      runId: run.run_id,
      jobIndex: run.jobs[0]?.index ?? 0,
    };
  }

  if (kind === "clip") {
    const look = state.steps[ccStepId("look", scene)];
    if (!look?.runId)
      throw new ToolApiError(`Look ${scene! + 1} is not ready.`);
    const run = await submitAnimate({
      fetchImpl: deps.fetchImpl,
      runId: look.runId,
      jobIndex: look.jobIndex ?? 0,
      motion: inputs.motion,
      prompt: clipMotionPrompt(style),
      clientId: deps.clientId,
    });
    deps.onRun?.(run);
    const out = await waitForOutputs(deps, promptIdOf(run));
    return {
      output: await measured(
        deps,
        outputOf(pickFinalOutput(out.videos), "clip"),
        "video",
      ),
      runId: run.run_id,
    };
  }

  if (kind === "music") {
    if (inputs.musicSource === "upload") {
      const track = inputs.track;
      if (!track?.dataUrl)
        throw new ToolApiError("Add your music track first.");
      const ref = await uploadDataUrl(
        deps.fetchImpl,
        track.dataUrl,
        audioUploadName(track.label),
      );
      return {
        output: { url: track.previewUrl, ref, seconds: track.duration },
      };
    }
    const tags = plainPrompt(inputs.musicTags?.trim() || style.music);
    const src = await seedText(deps, tags);
    const run = await action(deps, src, "music", {
      pack_id: "audio",
      prompt: `instrumental, ${tags}`,
      duration: musicSecondsFor(inputs.seconds),
      bpm: style.bpm,
    });
    const out = await waitForOutputs(deps, promptIdOf(run));
    return {
      output: await measured(
        deps,
        outputOf(pickFinalOutput(out.audios), "music"),
        "audio",
      ),
      runId: run.run_id,
    };
  }

  if (kind === "beats") {
    const music = state.steps.music?.output;
    if (!music) throw new ToolApiError("The music is missing.");
    if (!deps.analyzeBeats)
      throw new ToolApiError("Beat detection is not available here.");
    const beats = await deps.analyzeBeats(music.url, {
      bpmHint: bpmHintFor(inputs),
    });
    if (!beats.beats.length)
      throw new ToolApiError("No beats found in the music.");
    return { beats };
  }

  // assemble
  const { cuts: _cuts, ...params } = clipCutAssembleParams(state, inputs);
  void _cuts;
  const src = await seedText(deps, "ClipCut reel");
  const run = await action(
    deps,
    src,
    "pipeline_assemble",
    params as unknown as Record<string, unknown>,
  );
  const out = await waitForOutputs(deps, promptIdOf(run));
  return {
    output: await measured(
      deps,
      outputOf(pickFinalOutput(out.videos), "video"),
      "video",
    ),
    runId: run.run_id,
  };
}

/** Run pending steps in order; failures stay failed, independent steps continue. */
export async function runClipCut(
  initial: ClipCutState,
  inputs: ClipCutInputs,
  deps: ClipCutDeps,
  onState: (s: ClipCutState) => void,
): Promise<ClipCutState> {
  let state = initial;
  const commit = (s: ClipCutState) => {
    state = s;
    onState(s);
  };
  for (;;) {
    if (deps.isCancelled?.()) return state;
    const id = ccNextRunnable(state);
    if (!id) return state;
    commit(ccUpdateStep(state, id, { status: "running", error: undefined }));
    try {
      const res = await executeClipCutStep(state, id, inputs, deps);
      const next = res.beats ? { ...state, beats: res.beats } : state;
      commit(
        ccUpdateStep(next, id, {
          status: "done",
          output: res.output,
          runId: res.runId,
          ...(res.jobIndex !== undefined ? { jobIndex: res.jobIndex } : {}),
        }),
      );
    } catch (error) {
      if (deps.isCancelled?.()) {
        commit(ccUpdateStep(state, id, { status: "idle" }));
        return state;
      }
      const message = error instanceof Error ? error.message : String(error);
      commit(ccUpdateStep(state, id, { status: "error", error: message }));
    }
  }
}

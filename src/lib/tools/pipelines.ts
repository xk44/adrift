/**
 * Multi-step video pipelines (Shorts Studio, Click to Ad): pure data model
 * shared by the runner UI, the step executors (pipelineRunner.ts) and the
 * graph builders (src/lib/oj/pipelineScript.ts, pipelineAssemble.ts).
 *
 *   script     TextGenerate (Qwen3-VL) writes a scene list as JSON
 *   image:i    t2i per scene (shorts) / packshot edit of the product (ad)
 *   voice:i    Kokoro voiceover of the scene's narration (not for the ad's
 *              presenter scene: LTX-2.5 speaks that line on camera)
 *   clip:i     animate the scene image; the ad renders every clip with
 *              LTX-2.5 i2v + sound (see adLtx.ts)
 *   music      ACE-Step music bed sized to the whole short
 *   assemble   VHS_LoadVideo -> ImageScale -> hold -> TextOverlay captions ->
 *              CreateVideo per scene, ConcatenateVideo + one narration/music
 *              soundtrack -> SaveVideo
 *
 * Every step is an ordinary Adrift run (it shows up in the gallery too); the
 * pipeline only orders them, carries outputs forward and lets the user re-run
 * one step, which resets everything downstream of it.
 */

import { AD_PRODUCT_SOUND_DB, adShotPlan } from "./adLtx";

export type PipelineKind = "shorts" | "ad";

export interface ScriptScene {
  /** Spoken line (voiceover + burned-in caption). */
  narration: string;
  /** Shorts: standalone t2i prompt. Ad: edit instruction for the product photo. */
  visual: string;
  /** Camera / subject motion hint for the animate step. */
  motion: string;
  /** Ad: sound design for the LTX-2.5 clip (foley + ambience). */
  sound?: string;
}

export interface PipelineScript {
  title: string;
  /** Music style tags for the bed (ACE-Step tags). */
  music: string;
  scenes: ScriptScene[];
}

export const SCRIPT_SCENES = { min: 3, max: 8, default: 5 } as const;
export const NARRATION_MAX_CHARS = 240;
export const VISUAL_MAX_CHARS = 600;
export const MOTION_MAX_CHARS = 240;
export const SOUND_MAX_CHARS = 200;
export const TOPIC_MAX_CHARS = 600;

export interface PipelinePreset {
  id: string;
  label: string;
  /** Instruction folded into the script prompt. */
  hint: string;
  /** Default music tags when the script gives none. */
  music: string;
}

/** Shorts Studio tones (original copy). */
export const SHORTS_TONES: readonly PipelinePreset[] = [
  {
    id: "explainer",
    label: "Explainer",
    hint: "Clear and curious. Open with a question, explain one idea per scene, end with a one-line takeaway.",
    music: "light electronic, curious, soft plucks, steady beat",
  },
  {
    id: "story",
    label: "Story",
    hint: "A short narrative with a hook, rising tension and a twist or payoff in the last scene.",
    music: "cinematic, suspenseful strings, slow build",
  },
  {
    id: "facts",
    label: "Quick facts",
    hint: "Punchy countdown of surprising facts, one fact per scene, short sentences.",
    music: "upbeat, punchy drums, energetic synth",
  },
  {
    id: "calm",
    label: "Calm",
    hint: "Slow, soothing and reflective, gentle imagery, unhurried sentences.",
    music: "ambient, warm pads, gentle piano, relaxing",
  },
  {
    id: "hype",
    label: "Hype",
    hint: "High energy and motivating, bold claims, call to action at the end.",
    music: "energetic trap beat, bold brass hits, driving bass",
  },
];

/** Click to Ad styles (original copy). */
export const AD_STYLES: readonly PipelinePreset[] = [
  {
    id: "showcase",
    label: "Premium showcase",
    hint: "Elegant product hero shots, materials and details, confident short lines, end on the product name.",
    music: "sleek minimal electronic, deep bass, luxury",
  },
  {
    id: "ugc",
    label: "UGC testimonial",
    hint: "First-person, casual and honest, like a creator talking to camera about why they use it.",
    music: "lofi hip hop, relaxed, warm",
  },
  {
    id: "problem_solution",
    label: "Problem / solution",
    hint: "Scene one shows an everyday problem, then the product solves it, end with a clear call to action.",
    music: "upbeat acoustic pop, hand claps, positive",
  },
  {
    id: "launch",
    label: "Launch teaser",
    hint: "Mysterious build-up with close details, reveal the full product in the last scene.",
    music: "cinematic trailer, pulsing synth, big hit at the end",
  },
];

export function presetFor(kind: PipelineKind, id: string): PipelinePreset {
  const list = kind === "ad" ? AD_STYLES : SHORTS_TONES;
  return list.find((p) => p.id === id) ?? list[0];
}

export interface ScriptRequest {
  kind: PipelineKind;
  /** Shorts: topic. Ad: product + brief. */
  topic: string;
  scenes: number;
  preset: string;
  /** Ad: presenter scene first (UGC talking head). */
  presenter?: boolean;
}

function clean(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, max).trim()
    : "";
}

export function clampScenes(n: unknown): number {
  const v = typeof n === "string" && n.trim() ? Number(n) : n;
  if (typeof v !== "number" || !Number.isFinite(v))
    return SCRIPT_SCENES.default;
  return Math.min(
    SCRIPT_SCENES.max,
    Math.max(SCRIPT_SCENES.min, Math.round(v)),
  );
}

const SAFETY =
  "Everything must be original: no real people, celebrities, brand names, logos, " +
  "trademarks, copyrighted characters or on-screen text in the visuals.";

/** The TextGenerate prompt: asks for one JSON object, nothing else. */
export function scriptPrompt(req: ScriptRequest): string {
  const n = clampScenes(req.scenes);
  const topic = clean(req.topic, TOPIC_MAX_CHARS);
  const preset = presetFor(req.kind, req.preset);
  const shape =
    '{"title": "...", "music": "comma separated music style tags", ' +
    '"scenes": [{"narration": "...", "visual": "...", "motion": "..."}]}';
  if (req.kind === "ad") {
    const adShape =
      '{"title": "...", "music": "comma separated music style tags", ' +
      '"scenes": [{"narration": "...", "visual": "...", "motion": "...", ' +
      '"sound": "..."}]}';
    return [
      "You write scripts for short vertical (9:16) product video ads.",
      "The attached image is the product photo.",
      `Brief: ${topic || "an ad for the product in the photo"}`,
      `Style: ${preset.hint}`,
      `Write exactly ${n} scenes for a 15-40 second ad, in this shot order:`,
      ...adShotPlan(n, !!req.presenter),
      "narration: one spoken sentence of 6 to 18 words.",
      "visual: an edit instruction for the product photo that keeps the product exactly as it is " +
        "and changes the setting, e.g. 'Place the product on a sunlit marble counter with soft shadows, " +
        "vertical framing'. Never change the product's shape, colour or label.",
      req.presenter
        ? "Scene 1 is a friendly presenter talking to camera: its visual describes an original, " +
          "fictional person (age, look, outfit, setting) holding or pointing at the product; " +
          "its narration introduces the product in first person."
        : "",
      "motion: one present-tense sentence for the video model: what moves in the shot and " +
        "how the camera moves, e.g. 'Droplets slide down the bottle as the camera slowly " +
        "orbits it at eye level'. The product itself never changes.",
      "sound: the shot's sound design, only effects and ambience (no speech, no music), " +
        "e.g. 'a crisp cap twist, fizzing bubbles, soft kitchen room tone'.",
      "music: 3 to 6 style tags for an instrumental bed.",
      SAFETY,
      `Reply with JSON only, exactly this shape: ${adShape}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    "You write scripts for faceless vertical (9:16) short videos.",
    `Topic: ${topic}`,
    `Tone: ${preset.hint}`,
    `Write exactly ${n} scenes for a 20-50 second short.`,
    "narration: one or two spoken sentences, 8 to 22 words in total.",
    "visual: a detailed, self-contained image prompt for a vertical frame (subject, setting, " +
      "lighting, style). Repeat the main subject's description in every scene so the shots match.",
    "motion: a short camera or subject motion, e.g. 'slow pan right' or 'leaves drifting'.",
    "music: 3 to 6 style tags for an instrumental bed.",
    SAFETY,
    `Reply with JSON only, exactly this shape: ${shape}`,
  ].join("\n");
}

export class ScriptParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptParseError";
  }
}

const NARRATION_KEYS = [
  "narration",
  "voiceover",
  "voice_over",
  "line",
  "text",
  "script",
];
const VISUAL_KEYS = [
  "visual",
  "image",
  "image_prompt",
  "prompt",
  "shot",
  "edit",
];
const MOTION_KEYS = ["motion", "camera", "movement", "animation"];
const SOUND_KEYS = ["sound", "sfx", "sound_design", "audio", "foley"];

function pick(
  obj: Record<string, unknown>,
  keys: string[],
  max: number,
): string {
  for (const k of keys) {
    const v = clean(obj[k], max);
    if (v) return v;
  }
  return "";
}

function jsonCandidate(raw: string): unknown {
  const text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const body = text.slice(start, end + 1);
  for (const attempt of [body, body.replace(/,\s*([}\]])/g, "$1")]) {
    try {
      return JSON.parse(attempt);
    } catch {
      /* try the next repair */
    }
  }
  return null;
}

/** Plain-text fallback: "Scene 1: ..." / "1. ..." lines become scenes. */
function linesFallback(raw: string): ScriptScene[] {
  return raw
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/^\s*(?:scene\s*\d+\s*[:.)-]|\d+\s*[.):-]|[-*])\s*/i, "")
        .trim(),
    )
    .filter((l) => l.length >= 12 && !/^[{}[\]]/.test(l))
    .map((l) => {
      const line = clean(l, NARRATION_MAX_CHARS);
      return {
        narration: line,
        visual: clean(l, VISUAL_MAX_CHARS),
        motion: "",
      };
    });
}

/**
 * Parse the LLM reply into a script. Tolerates code fences, a leading
 * <think> block, trailing commas, alternative key names and a plain list.
 */
export function parseScript(
  raw: string,
  opts: {
    maxScenes?: number;
    fallbackTitle?: string;
    fallbackMusic?: string;
  } = {},
): PipelineScript {
  const max = Math.min(SCRIPT_SCENES.max, opts.maxScenes ?? SCRIPT_SCENES.max);
  const parsed = jsonCandidate(raw ?? "");
  let scenes: ScriptScene[] = [];
  let title = "";
  let music = "";
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    title = clean(obj.title, 120);
    music = clean(obj.music, 200);
    const list = Array.isArray(obj.scenes)
      ? obj.scenes
      : Array.isArray(obj.shots)
        ? obj.shots
        : [];
    scenes = list
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .map((s) => {
        const narration = pick(s, NARRATION_KEYS, NARRATION_MAX_CHARS);
        const visual =
          pick(s, VISUAL_KEYS, VISUAL_MAX_CHARS) ||
          clean(narration, VISUAL_MAX_CHARS);
        const sound = pick(s, SOUND_KEYS, SOUND_MAX_CHARS);
        return {
          narration,
          visual,
          motion: pick(s, MOTION_KEYS, MOTION_MAX_CHARS),
          ...(sound ? { sound } : {}),
        };
      })
      .filter((s) => s.narration && s.visual);
  }
  if (!scenes.length) scenes = linesFallback(raw ?? "");
  if (!scenes.length) {
    throw new ScriptParseError(
      "The script model returned no usable scenes. Re-run the script step.",
    );
  }
  return {
    title: title || clean(opts.fallbackTitle, 120) || "Untitled",
    music: music || clean(opts.fallbackMusic, 200),
    scenes: scenes.slice(0, max),
  };
}

// Steps

export type StepKind =
  "script" | "image" | "voice" | "clip" | "music" | "assemble";
export type StepStatus = "idle" | "running" | "done" | "error";

export interface StepOutput {
  /** Browser URL (/api/comfy/image?...). */
  url: string;
  /** ComfyUI file ref ("sub/name.ext [output]"). */
  ref: string;
  /** Media length when known (clips, audio). */
  seconds?: number | null;
}

export interface PipelineStep {
  id: string;
  kind: StepKind;
  scene?: number;
  status: StepStatus;
  error?: string;
  /** Adrift run that produced the output (gallery link, animate source). */
  runId?: string;
  jobIndex?: number;
  output?: StepOutput;
}

export interface PipelineOptions {
  kind: PipelineKind;
  /** Ad only: scene 0 is a generated presenter animated with talking_avatar. */
  presenter?: boolean;
  /** Add a music bed. */
  music?: boolean;
}

export function stepId(kind: StepKind, scene?: number): string {
  return scene === undefined ? kind : `${kind}:${scene}`;
}

export function parseStepId(id: string): { kind: StepKind; scene?: number } {
  const [kind, scene] = id.split(":");
  return scene === undefined
    ? { kind: kind as StepKind }
    : { kind: kind as StepKind, scene: Number(scene) };
}

/** Execution order: script, then per kind across scenes (GPU friendly). */
export function planOrder(sceneCount: number, opts: PipelineOptions): string[] {
  const order = ["script"];
  if (sceneCount <= 0) return order;
  const idx = Array.from({ length: sceneCount }, (_, i) => i);
  order.push(...idx.map((i) => stepId("image", i)));
  // The ad's presenter speaks on camera (LTX-2.5 audio): no voiceover.
  order.push(
    ...idx
      .filter((i) => !isPresenterScene(opts, i))
      .map((i) => stepId("voice", i)),
  );
  order.push(...idx.map((i) => stepId("clip", i)));
  if (opts.music !== false) order.push("music");
  order.push("assemble");
  return order;
}

/** Whether scene i is the ad's talking presenter. */
export function isPresenterScene(
  opts: PipelineOptions,
  scene: number | undefined,
): boolean {
  return opts.kind === "ad" && !!opts.presenter && scene === 0;
}

export function dependencies(
  id: string,
  order: string[],
  opts: PipelineOptions,
): string[] {
  const { kind, scene } = parseStepId(id);
  switch (kind) {
    case "script":
      return [];
    case "image":
    case "voice":
    case "music":
      return ["script"];
    case "clip":
      return [stepId("image", scene)];
    case "assemble":
      return order.filter(
        (s) => s.startsWith("clip:") || s.startsWith("voice:") || s === "music",
      );
  }
}

export function freshStep(id: string): PipelineStep {
  const { kind, scene } = parseStepId(id);
  return {
    id,
    kind,
    ...(scene === undefined ? {} : { scene }),
    status: "idle",
  };
}

export interface PipelineState {
  opts: PipelineOptions;
  order: string[];
  steps: Record<string, PipelineStep>;
  script: PipelineScript | null;
}

export function initialState(opts: PipelineOptions): PipelineState {
  const order = planOrder(0, opts);
  return { opts, order, steps: { script: freshStep("script") }, script: null };
}

/** Steps that (transitively) depend on `id`, not including it. */
export function dependents(
  id: string,
  order: string[],
  opts: PipelineOptions,
): string[] {
  const out = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const s of order) {
      if (
        !out.has(s) &&
        s !== id &&
        dependencies(s, order, opts).includes(cur)
      ) {
        out.add(s);
        queue.push(s);
      }
    }
  }
  return order.filter((s) => out.has(s));
}

/** Reset `id` and everything downstream to idle (outputs dropped). */
export function invalidate(state: PipelineState, id: string): PipelineState {
  const steps = { ...state.steps };
  for (const s of [id, ...dependents(id, state.order, state.opts)]) {
    if (steps[s]) steps[s] = freshStep(s);
  }
  return { ...state, steps };
}

/** Install a parsed script: re-plans scene steps (all idle) after `script`. */
export function withScript(
  state: PipelineState,
  script: PipelineScript,
): PipelineState {
  const order = planOrder(script.scenes.length, state.opts);
  const steps: Record<string, PipelineStep> = {};
  for (const s of order)
    steps[s] =
      s === "script" ? (state.steps.script ?? freshStep(s)) : freshStep(s);
  return { ...state, order, steps, script };
}

/**
 * Change pipeline options (music bed on/off, presenter scene) keeping the
 * finished steps that are still valid; assembly is always redone.
 */
export function withOptions(
  state: PipelineState,
  opts: PipelineOptions,
): PipelineState {
  const scenes = state.script?.scenes.length ?? 0;
  const order = planOrder(scenes, opts);
  const steps: Record<string, PipelineStep> = {};
  for (const s of order) steps[s] = state.steps[s] ?? freshStep(s);
  let out: PipelineState = { ...state, opts, order, steps };
  if (scenes > 0) {
    const presenterChanged =
      !!state.opts.presenter !== !!opts.presenter && opts.kind === "ad";
    if (presenterChanged) out = invalidate(out, stepId("image", 0));
    out = invalidate(out, "assemble");
  }
  return out;
}

/** Edit one scene; resets the steps that consumed the changed field. */
export function editScene(
  state: PipelineState,
  scene: number,
  patch: Partial<ScriptScene>,
): PipelineState {
  if (!state.script || !state.script.scenes[scene]) return state;
  const prev = state.script.scenes[scene];
  const next: ScriptScene = {
    narration:
      patch.narration !== undefined
        ? clean(patch.narration, NARRATION_MAX_CHARS)
        : prev.narration,
    visual:
      patch.visual !== undefined
        ? clean(patch.visual, VISUAL_MAX_CHARS)
        : prev.visual,
    motion:
      patch.motion !== undefined
        ? clean(patch.motion, MOTION_MAX_CHARS)
        : prev.motion,
  };
  const sound =
    patch.sound !== undefined
      ? clean(patch.sound, SOUND_MAX_CHARS)
      : (prev.sound ?? "");
  if (sound) next.sound = sound;
  const scenes = state.script.scenes.slice();
  scenes[scene] = next;
  let out: PipelineState = { ...state, script: { ...state.script, scenes } };
  if (next.visual !== prev.visual)
    out = invalidate(out, stepId("image", scene));
  if (next.narration !== prev.narration) {
    out = invalidate(out, stepId("voice", scene));
    // Captions are burned in at assembly.
    out = invalidate(out, "assemble");
  }
  // The presenter says the narration on camera, so its clip redoes too.
  if (
    next.motion !== prev.motion ||
    (next.sound ?? "") !== (prev.sound ?? "") ||
    (next.narration !== prev.narration && isPresenterScene(state.opts, scene))
  )
    out = invalidate(out, stepId("clip", scene));
  return out;
}

export function updateStep(
  state: PipelineState,
  id: string,
  patch: Partial<PipelineStep>,
): PipelineState {
  const cur = state.steps[id] ?? freshStep(id);
  return { ...state, steps: { ...state.steps, [id]: { ...cur, ...patch } } };
}

/**
 * Next step to execute: the first non-done step whose dependencies are done.
 * null when finished or when a failed step blocks everything left.
 */
export function nextRunnable(state: PipelineState): string | null {
  for (const id of state.order) {
    const step = state.steps[id];
    if (step?.status === "done") continue;
    if (step?.status === "error") continue;
    const deps = dependencies(id, state.order, state.opts);
    if (deps.every((d) => state.steps[d]?.status === "done")) return id;
  }
  return null;
}

export function progressOf(state: PipelineState): {
  done: number;
  total: number;
} {
  const total = state.order.length;
  const done = state.order.filter(
    (s) => state.steps[s]?.status === "done",
  ).length;
  return { done, total };
}

// Timing + assembly params

export const ASSEMBLE_FPS = 24;
export const ASSEMBLE_MAX_SCENES = 12;
export const ASSEMBLE_MAX_SECONDS = 90;
export const SCENE_MIN_SECONDS = 1.5;
export const SCENE_MAX_SECONDS = 15;
/** Breath after a scene's narration before the cut. */
export const NARRATION_TAIL_SECONDS = 0.35;
/** Default clip length when the browser can't read it (LTXV 97 frames @ 24 fps). */
export const DEFAULT_CLIP_SECONDS = 4;
/** Speaking rate used when an audio length can't be read. */
export const WORDS_PER_SECOND = 2.6;

export const ASSEMBLE_SIZES = {
  "720x1280": { width: 720, height: 1280 },
  "1080x1920": { width: 1080, height: 1920 },
} as const;
export type AssembleSize = keyof typeof ASSEMBLE_SIZES;

export function estimateSpeechSeconds(narration: string): number {
  const words = narration.trim().split(/\s+/).filter(Boolean).length;
  return Math.round((words / WORDS_PER_SECOND) * 100) / 100;
}

/** Scene length: the clip, stretched (last frame held) to fit the narration. */
export function sceneSeconds(
  clip: number | null | undefined,
  narration: number | null | undefined,
): number {
  const c = typeof clip === "number" && clip > 0 ? clip : DEFAULT_CLIP_SECONDS;
  const n =
    typeof narration === "number" && narration > 0
      ? narration + NARRATION_TAIL_SECONDS
      : 0;
  const s = Math.max(c, n, SCENE_MIN_SECONDS);
  return Math.round(Math.min(SCENE_MAX_SECONDS, s) * 100) / 100;
}

/** Wrap a caption into at most `maxLines` lines of ~`width` characters. */
export function wrapCaption(text: string, width = 26, maxLines = 4): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > width) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].replace(/[.,;:!?]*$/, "")}...`;
    return kept.join("\n");
  }
  return lines.join("\n");
}

export interface AssembleScene {
  video: string;
  audio?: string;
  caption?: string;
  clipSeconds: number;
  seconds: number;
  /** Offset into the clip (ClipCut re-uses a look's clip across cuts). */
  startSeconds?: number;
  /**
   * Mix the clip's own audio (LTX-2.5 sound) in at this level, dB (-40..0).
   * Absent: the clip's audio is dropped.
   */
  clipAudioDb?: number;
}

export interface AssembleParams {
  scenes: AssembleScene[];
  music?: string;
  musicDb?: number;
  size: AssembleSize;
  fps: number;
  captions: boolean;
  prefix: string;
}

/** Collect assemble params from finished steps; throws when a step is missing. */
export function assembleParamsFor(
  state: PipelineState,
  choice: { size: AssembleSize; captions: boolean; musicDb?: number },
): AssembleParams {
  if (!state.script) throw new Error("Write the script first.");
  const scenes = state.script.scenes.map((sc, i): AssembleScene => {
    const clip = state.steps[stepId("clip", i)]?.output;
    if (!clip) throw new Error(`Scene ${i + 1} has no clip yet.`);
    const voice = state.steps[stepId("voice", i)]?.output;
    const narr = voice
      ? (voice.seconds ?? estimateSpeechSeconds(sc.narration))
      : null;
    const clipSeconds =
      clip.seconds && clip.seconds > 0 ? clip.seconds : DEFAULT_CLIP_SECONDS;
    // Ad clips are LTX-2.5 renders with sound: product foley under the
    // narration, the presenter's own voice at full level.
    const clipAudioDb =
      state.opts.kind !== "ad"
        ? undefined
        : isPresenterScene(state.opts, i)
          ? 0
          : AD_PRODUCT_SOUND_DB;
    return {
      video: clip.ref,
      ...(voice ? { audio: voice.ref } : {}),
      caption: sc.narration,
      clipSeconds,
      seconds: sceneSeconds(clipSeconds, narr),
      ...(clipAudioDb !== undefined ? { clipAudioDb } : {}),
    };
  });
  const music = state.steps.music?.output?.ref;
  return {
    scenes,
    ...(music ? { music } : {}),
    ...(typeof choice.musicDb === "number" ? { musicDb: choice.musicDb } : {}),
    size: choice.size,
    fps: ASSEMBLE_FPS,
    captions: choice.captions,
    prefix: state.opts.kind === "ad" ? "video/adrift_ad" : "video/adrift_short",
  };
}

export function totalSeconds(scenes: Pick<AssembleScene, "seconds">[]): number {
  return Math.round(scenes.reduce((a, s) => a + s.seconds, 0) * 100) / 100;
}

// Refs

const MEDIA_EXT =
  /\.(mp4|webm|mov|mkv|m4v|mp3|wav|flac|m4a|ogg|opus|png|jpe?g|webp)$/i;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9 _.()+-]*$/;
const REF_TYPES = new Set(["output", "input", "temp"]);

export interface MediaFileRef {
  filename: string;
  subfolder?: string;
  type?: string;
}

/** History file entry -> "sub/name.ext [output]"; null when unsafe. */
export function fileRef(file: MediaFileRef): string | null {
  const type = file.type || "output";
  if (!REF_TYPES.has(type)) return null;
  const parts = [
    ...(file.subfolder ? file.subfolder.split("/") : []),
    file.filename,
  ];
  if (!parts.every((p) => SEGMENT.test(p) && !p.includes(".."))) return null;
  if (!MEDIA_EXT.test(file.filename)) return null;
  return `${parts.join("/")} [${type}]`;
}

/** Validate a ComfyUI file ref (any of output/input/temp) for the builders. */
export function isSafeFileRef(ref: unknown, ext?: RegExp): ref is string {
  if (typeof ref !== "string") return false;
  const m = /^(.+) \[(output|input|temp)\]$/.exec(ref);
  if (!m) return false;
  const parts = m[1].split("/");
  if (!parts.every((p) => SEGMENT.test(p) && !p.includes(".."))) return false;
  const name = parts[parts.length - 1];
  return (ext ?? MEDIA_EXT).test(name);
}

export const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v)$/i;
export const AUDIO_EXT = /\.(mp3|wav|flac|m4a|ogg|opus)$/i;

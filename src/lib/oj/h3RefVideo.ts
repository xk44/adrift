/**
 * Reference to Video (MiniMax H3 Ref2VA, packs/minimax/r2v.json): 1-3
 * reference photos (characters, optionally the last one a setting) become a
 * new shot with generated sound. Native ComfyUI nodes only, local weights.
 *
 *   params.secondRefImage / params.extraRefImages  references 2..3
 *   params.scene        REF_VIDEO_SCENES id (structured preset prompt)
 *   params.prompt       optional "what happens" text (replaces the preset
 *                       action; the only action for the "custom" scene)
 *   params.lastIsSetting  the last reference (of >= 2) is a place, not a cast
 *                       member
 *   params.aspect       "16:9" | "9:16" | "1:1"
 *   params.duration     seconds ("2" | "3" | "5")
 *   params.resolution   "480" (default, fast) | "768" (native max canvas,
 *                       1344x768 at 16:9)
 *   params.h3Speed      turbo8 (client default) / turbo4 / fast8 / off
 *   params.longClip / longSeconds / longMethod / fixFaces  see h3LongClip.ts
 *
 * Reference 1 is the source run's image. The prompt uses the structured
 * Ref2VA layout (subject_definitions / summary / retention_analysis /
 * detailed_description / sound), with each reference bound as
 * <Subject i> = <Picture i>.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { applyH3ExtraLoras } from "./h3Video";
import { applyH3Speed } from "./h3Speed";
import {
  applyH3FixFaces,
  applyH3LongClip,
  h3LongClipFrames,
} from "./h3LongClip";

export const REF_VIDEO_ACTION = "ref_video";
export const REF_VIDEO_MAX_REFS = 3;
export const REF_VIDEO_FPS = 24;

export type RefVideoAspect = "16:9" | "9:16" | "1:1";
/** 480p-class sizes on the /32 grid (the Turbo LoRAs' fast tier). */
export const REF_VIDEO_SIZES: Record<
  RefVideoAspect,
  { width: number; height: number }
> = {
  "16:9": { width: 864, height: 480 },
  "9:16": { width: 480, height: 864 },
  "1:1": { width: 640, height: 640 },
};
/** H3's native max canvas (768 short edge, 768*1344 px): the quality tier. */
export const REF_VIDEO_SIZES_768: Record<
  RefVideoAspect,
  { width: number; height: number }
> = {
  "16:9": { width: 1344, height: 768 },
  "9:16": { width: 768, height: 1344 },
  "1:1": { width: 768, height: 768 },
};
export const REF_VIDEO_DEFAULT_ASPECT: RefVideoAspect = "16:9";

/** Seconds -> frames on the H3 17k+5 grid (2 s = 39, 3 s = 73, 5 s = 124). */
export const REF_VIDEO_LENGTHS: Record<string, number> = {
  "2": 39,
  "3": 73,
  "5": 124,
};
export const REF_VIDEO_DEFAULT_DURATION = "3";

export interface RefVideoScene {
  id: string;
  label: string;
  /**
   * What happens (summary); `{cast}` becomes the cast's subject tokens. The
   * user's text replaces it. Worded so a cast member may be a person, an
   * animal or an object (no "side by side" pairs that invent a 2nd person).
   */
  action: string;
  /** Look, camera and motion (detailed_description). */
  detail: string;
  /** Generated sound (sound section). */
  sound: string;
}

export const REF_VIDEO_CUSTOM_SCENE = "custom";

export const REF_VIDEO_SCENES: readonly RefVideoScene[] = [
  {
    id: "market",
    label: "Market stroll",
    action:
      "{cast} make their way through a busy open-air market under glowing paper lanterns, pausing at a stall and sharing a quick laugh",
    detail:
      "Paper lanterns, food stalls and passers-by, shallow depth of field. The camera tracks alongside at walking pace, slightly ahead, keeping every main character in view.",
    sound:
      "Lively market ambience: crowd murmur, vendors calling, footsteps on stone, a distant street musician. Light, natural laughter.",
  },
  {
    id: "rooftop",
    label: "Rooftop at dusk",
    action:
      "{cast} wait at the edge of a wet rooftop at dusk, then turn toward the camera as the city lights come on behind them",
    detail:
      "Blue-hour sky, neon reflections on wet concrete, gentle wind in hair and fabric. Slow push-in from a medium-wide shot to a medium shot.",
    sound:
      "City hum far below, light wind, a distant siren, soft rain dripping from railings.",
  },
  {
    id: "conversation",
    label: "Two-shot conversation",
    action:
      "{cast} share a table in a cosy cafe; <Subject 1> says a short line and the reply comes with a smile",
    detail:
      "Soft window light, warm interior, natural skin tones. Static two-shot at eye level, subtle handheld breathing, lips in sync with the speech.",
    sound:
      "Clear close-mic dialogue with natural pauses, quiet cafe room tone, a cup set down on a saucer.",
  },
  {
    id: "adventure",
    label: "Action beat",
    action:
      "{cast} dash across a narrow bridge as the camera whips around, then skid to a stop and look back",
    detail:
      "Dynamic cinematic lighting, motion blur on fast moves, consistent identities in every frame. Low-angle tracking shot that swings around the subjects.",
    sound:
      "Fast footsteps, cloth rustle, heavy breathing, a whoosh as the camera swings, wind over the bridge.",
  },
  {
    id: "showcase",
    label: "Hero showcase",
    action:
      "The camera slowly orbits {cast} as they hold a confident pose and turn toward the lens",
    detail:
      "Studio-quality key light with a soft rim, clean background, crisp detail on faces, materials and fabric. Smooth 90-degree orbit at chest height.",
    sound: "A soft cinematic swell and gentle ambient room tone.",
  },
  {
    id: REF_VIDEO_CUSTOM_SCENE,
    label: "Custom (your text)",
    action: "",
    detail:
      "Natural motion, physically plausible interaction and consistent lighting.",
    sound: "Natural, synchronized sound effects and ambience for the action.",
  },
];

export function refVideoScene(id: unknown): RefVideoScene {
  return REF_VIDEO_SCENES.find((s) => s.id === id) ?? REF_VIDEO_SCENES[0];
}

export function refVideoAspect(value: unknown): RefVideoAspect {
  return value === "9:16" || value === "1:1" ? value : REF_VIDEO_DEFAULT_ASPECT;
}

/** Canvas for an aspect + resolution ("768" = native max, else 480p). */
export function refVideoSize(
  aspect: unknown,
  resolution: unknown,
): { width: number; height: number } {
  const sizes =
    String(resolution ?? "") === "768" ? REF_VIDEO_SIZES_768 : REF_VIDEO_SIZES;
  return sizes[refVideoAspect(aspect)];
}

/** Frames for a duration pick (unknown -> 3 s = 73). */
export function refVideoLength(value: unknown): number {
  const key = String(value ?? "").trim();
  return (
    REF_VIDEO_LENGTHS[key] ?? REF_VIDEO_LENGTHS[REF_VIDEO_DEFAULT_DURATION]
  );
}

const clean = (v: unknown, max = 400) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

const sentence = (s: string) => {
  const t = s.charAt(0).toUpperCase() + s.slice(1);
  return t && !/[.!?]$/.test(t) ? `${t}.` : t;
};

/**
 * Structured Ref2VA prompt for `refs` references. With `lastIsSetting` (and
 * at least two references) the last one is the place, not a cast member.
 */
export function refVideoPrompt(opts: {
  refs: number;
  scene?: unknown;
  text?: unknown;
  lastIsSetting?: boolean;
  seconds?: number;
}): string {
  const refs = Math.max(1, Math.min(REF_VIDEO_MAX_REFS, Math.round(opts.refs)));
  const setting = opts.lastIsSetting && refs >= 2 ? refs : 0;
  const cast = setting ? refs - 1 : refs;
  const scene = refVideoScene(opts.scene);
  const text = clean(opts.text);
  const secs = (opts.seconds ?? 3).toFixed(1);
  const subj = (i: number) => `<Subject ${i}>`;
  const castList =
    cast === 1
      ? subj(1)
      : `${Array.from({ length: cast - 1 }, (_, i) => subj(i + 1)).join(", ")} and ${subj(cast)}`;

  const action = (
    text ||
    scene.action ||
    "{cast} move naturally through the scene"
  ).replace(/\{cast\}/g, () => castList);
  const lines = ["subject_definitions:"];
  for (let i = 1; i <= cast; i++)
    lines.push(`${subj(i)} is the character from <Picture ${i}>.`);
  if (setting)
    lines.push(`${subj(setting)} is the setting from <Picture ${setting}>.`);
  lines.push(
    "",
    "summary:",
    `[reference generation + audio generation] A new ${secs}-second shot at 24 fps starring ${castList}` +
      `${setting ? `, set in ${subj(setting)}` : ""}. ${sentence(action)}`,
    "",
    "retention_analysis:",
  );
  for (let i = 1; i <= cast; i++)
    lines.push(
      `${subj(i)} (all shots): fully_preserved - face or features, hair, body proportions, colours, materials and complete outfit stay consistent with <Picture ${i}> in every frame.`,
    );
  if (setting)
    lines.push(
      `${subj(setting)} (setting): partially_preserved - the location, materials and lighting come from <Picture ${setting}>; the camera sees it from the shot's own angle.`,
    );
  lines.push(
    "",
    "detailed_description:",
    `${sentence(scene.detail)} ${
      setting ? "" : "The backgrounds of the pictures do not enter the scene. "
    }Exactly ${cast} main character${cast > 1 ? "s" : ""} (${castList}), each appearing exactly once: no twins, look-alikes or extra copies. Every character keeps the form, size, material and outfit from its picture. No text, captions, logos or watermarks.`,
    "",
    "sound:",
    sentence(scene.sound),
  );
  return lines.join("\n").slice(0, 4000);
}

const ANNOTATED_REF_RE = /^[^\s].* \[(input|output|temp)\]$/;

function validRef(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const ref = v.trim();
  return ref.length <= 300 &&
    ANNOTATED_REF_RE.test(ref) &&
    !ref.split(" [")[0].split("/").includes("..")
    ? ref
    : null;
}

/** References 2..3 from params (secondRefImage, then extraRefImages). */
export function refVideoExtraRefs(params: Record<string, unknown>): string[] {
  const raw = [
    params.secondRefImage,
    ...(Array.isArray(params.extraRefImages) ? params.extraRefImages : []),
  ];
  return raw
    .map(validRef)
    .filter((r): r is string => Boolean(r))
    .slice(0, REF_VIDEO_MAX_REFS - 1);
}

function nodeIdOf(workflow: Workflow, classType: string): string | undefined {
  return Object.keys(workflow).find(
    (id) => workflow[id].class_type === classType,
  );
}

function nextId(workflow: Workflow): string {
  const nums = Object.keys(workflow)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  return String((nums.length ? Math.max(...nums) : 0) + 1);
}

export function buildRefVideoWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const A = REF_VIDEO_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const firstRef = comfyImageRefFromViewUrl(
    sourceRun.jobs[sourceJobIndex]?.images?.[0],
  );
  if (!firstRef) throw new Error(`${A}: source run has no image`);
  const r2vId = nodeIdOf(workflow, "MiniMaxH3ReferenceToVideo");
  if (!r2vId) throw new Error(`${A}: workflow needs MiniMaxH3ReferenceToVideo`);
  const r2v = workflow[r2vId].inputs as Record<string, unknown>;
  const ref0 = r2v["ref_images.ref_image_0"];
  const ref0Id = Array.isArray(ref0) ? String(ref0[0]) : undefined;
  if (!ref0Id || workflow[ref0Id]?.class_type !== "LoadImage")
    throw new Error(`${A}: ref_image_0 must come from a LoadImage node`);

  setNodeInput(workflow, ref0Id, "image", firstRef);
  const extras = refVideoExtraRefs(params);
  extras.forEach((ref, i) => {
    const id = nextId(workflow);
    workflow[id] = {
      class_type: "LoadImage",
      inputs: { image: ref },
      _meta: { title: `Reference ${i + 2}` },
    } as Workflow[string];
    r2v[`ref_images.ref_image_${i + 1}`] = [id, 0];
  });

  const length = h3LongClipFrames(params) ?? refVideoLength(params.duration);
  const { width, height } = refVideoSize(params.aspect, params.resolution);
  const prompt = refVideoPrompt({
    refs: 1 + extras.length,
    scene: params.scene,
    text: params.prompt,
    lastIsSetting: params.lastIsSetting === true,
    seconds: length / REF_VIDEO_FPS,
  });
  setNodeInput(workflow, r2vId, "prompt", prompt);
  setNodeInput(workflow, r2vId, "width", width);
  setNodeInput(workflow, r2vId, "height", height);
  setNodeInput(workflow, r2vId, "length", length);

  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? params.seed
      : Math.floor(Math.random() * 2 ** 32);
  const noiseId = nodeIdOf(workflow, "RandomNoise");
  if (noiseId) setNodeInput(workflow, noiseId, "noise_seed", seed);

  applyH3ExtraLoras(workflow, params);
  applyH3Speed(workflow, params);
  applyH3LongClip(workflow, params);
  applyH3FixFaces(workflow, params);

  const saveId = nodeIdOf(workflow, "SaveVideo");
  if (saveId)
    setNodeInput(workflow, saveId, "filename_prefix", "video/CJ_H3_RefVideo");

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: r2vId,
      posTextInputName: "prompt",
      negTextId: "",
      latentDimsId: r2vId,
      imageInputId: ref0Id,
    },
    seed,
  };
}

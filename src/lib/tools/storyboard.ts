/**
 * Storyboard sequencer (Higgsfield "Popcorn" parity): a premise (+ optional
 * character reference or opening frame) becomes 4-8 consistent frames.
 *
 * No new graph: frame 1 is a text-to-image Imagine run (or an edit of the
 * character reference), and every later frame is an edit of the previous
 * frame's output — by default the Qwen-Image 2.1 next-scene LoRA, which is
 * trained exactly for "the following shot of the same world". The runner
 * chains these client-side, one queued job at a time, and "Animate all"
 * hands each finished frame to the existing animate (i2v) action.
 *
 * Pure data + planners + the chain state machine live here so they are
 * unit-tested without React, ComfyUI or a GPU. All text is our own wording.
 */

import {
  EDIT_ENGINES,
  SINGLE_ENGINES,
  DUAL_ENGINES,
  cleanNotes,
  type EditEngine,
  type EditEngineId,
  type EngineContext,
} from "./templates";
import { submitEngineEdit, type FetchLike, type ToolImage } from "./runTool";
import type { ImagineRun } from "@/types";

export const STORYBOARD_MIN_FRAMES = 4;
export const STORYBOARD_MAX_FRAMES = 8;
export const STORYBOARD_FRAME_COUNTS = [4, 5, 6, 7, 8] as const;

// Story structures (preset catalog)

export interface StoryBeat {
  /** Camera direction, phrased the way the next-scene LoRA expects. */
  camera: string;
  /** What happens in the shot. `{premise}` may appear once. */
  beat: string;
  /** Short motion prompt for "Animate all". */
  motion: string;
}

export interface StoryStructure {
  id: string;
  label: string;
  description: string;
  /** Exactly STORYBOARD_MAX_FRAMES beats; fewer frames sample them evenly. */
  beats: StoryBeat[];
}

export const STORY_STRUCTURES: StoryStructure[] = [
  {
    id: "three_act",
    label: "Story",
    description: "Setup, rising tension, turn and resolution",
    beats: [
      {
        camera: "Wide establishing shot",
        beat: "the world of the story is introduced: {premise}",
        motion: "slow push in across the setting",
      },
      {
        camera: "The camera moves to a medium shot",
        beat: "the main character goes about their routine",
        motion: "subtle handheld drift, character moves naturally",
      },
      {
        camera: "Close-up on the character's face",
        beat: "they notice something unexpected",
        motion: "slow push in on the face, eyes shift",
      },
      {
        camera: "Over-the-shoulder shot",
        beat: "the source of the disturbance comes into view",
        motion: "gentle rack focus from shoulder to the distance",
      },
      {
        camera: "The camera tracks alongside the character",
        beat: "they set off to deal with it, the stakes rising",
        motion: "steady tracking shot following the character",
      },
      {
        camera: "Low-angle dramatic shot",
        beat: "the moment of greatest tension, the turning point",
        motion: "slow tilt up, light flickers",
      },
      {
        camera: "Medium two-shot",
        beat: "the conflict breaks and the outcome becomes clear",
        motion: "slow orbit around the subjects",
      },
      {
        camera: "The camera pulls back to a wide closing shot",
        beat: "a quiet resolution as the scene settles",
        motion: "slow pull back and rise",
      },
    ],
  },
  {
    id: "action",
    label: "Action",
    description: "A fast chase or fight, cut like a trailer",
    beats: [
      {
        camera: "Wide aerial shot",
        beat: "the location before the action starts: {premise}",
        motion: "fast aerial glide over the location",
      },
      {
        camera: "Tight close-up",
        beat: "the hero's eyes narrow as they spot the threat",
        motion: "quick snap zoom on the eyes",
      },
      {
        camera: "The camera whips to a wide shot",
        beat: "the chase or fight erupts, debris flying",
        motion: "whip pan, debris flies past the lens",
      },
      {
        camera: "Low tracking shot at ground level",
        beat: "feet and wheels pound forward at full speed",
        motion: "fast low tracking shot, motion blur",
      },
      {
        camera: "Dutch angle medium shot",
        beat: "a near miss as the hero dodges at the last second",
        motion: "tilted camera shake, quick dodge",
      },
      {
        camera: "Overhead top-down shot",
        beat: "the hero cornered with nowhere left to run",
        motion: "slow overhead spin",
      },
      {
        camera: "Extreme close-up",
        beat: "a split-second decision, a hand reaching for the way out",
        motion: "slow motion, sparks drift",
      },
      {
        camera: "The camera pulls back to a wide hero shot",
        beat: "the hero stands victorious as dust settles",
        motion: "slow pull back, dust swirls in the light",
      },
    ],
  },
  {
    id: "product",
    label: "Product reveal",
    description: "Tease, reveal and hero shot for an ad",
    beats: [
      {
        camera: "Extreme macro shot",
        beat: "a hint of texture and material from the product: {premise}",
        motion: "slow macro slide across the surface",
      },
      {
        camera: "The camera glides along a silhouette",
        beat: "the product's outline in dramatic rim light",
        motion: "slow lateral glide, rim light sweeps",
      },
      {
        camera: "Medium shot",
        beat: "the product fully revealed on a clean pedestal",
        motion: "slow turntable rotation",
      },
      {
        camera: "Close-up detail",
        beat: "a key feature or control in crisp focus",
        motion: "rack focus onto the detail",
      },
      {
        camera: "Lifestyle medium shot",
        beat: "a person using the product in a real setting",
        motion: "natural handheld, person interacts with the product",
      },
      {
        camera: "Top-down flat lay",
        beat: "the product with its accessories neatly arranged",
        motion: "slow overhead push in",
      },
      {
        camera: "Low-angle hero shot",
        beat: "the product towering against a bold backdrop",
        motion: "slow crane up, light flare",
      },
      {
        camera: "The camera pulls back to a wide end card",
        beat: "the product centered with clean negative space for a tagline",
        motion: "slow pull back, background softly glows",
      },
    ],
  },
  {
    id: "day_in_life",
    label: "Day in the life",
    description: "Morning to night with the same character",
    beats: [
      {
        camera: "Wide shot at dawn",
        beat: "the character wakes up; {premise}",
        motion: "soft morning light spreads across the room",
      },
      {
        camera: "Medium shot",
        beat: "a morning ritual over coffee or breakfast",
        motion: "steam rises, gentle handheld",
      },
      {
        camera: "The camera tracks alongside the character",
        beat: "the commute through busy streets",
        motion: "tracking shot, passers-by blur",
      },
      {
        camera: "Over-the-shoulder shot",
        beat: "focused at work in the middle of the day",
        motion: "slow push in over the shoulder",
      },
      {
        camera: "Wide shot in warm afternoon light",
        beat: "a break outdoors with friends",
        motion: "light breeze, slow orbit",
      },
      {
        camera: "Close-up",
        beat: "a small personal moment, a smile",
        motion: "slow push in, a soft smile",
      },
      {
        camera: "Wide shot at golden hour",
        beat: "heading home as the sun sets",
        motion: "slow pan following the sunset",
      },
      {
        camera: "The camera pulls back to a wide night shot",
        beat: "city lights on, the day winding down",
        motion: "slow pull back, lights twinkle",
      },
    ],
  },
  {
    id: "mood",
    label: "Mood piece",
    description: "Slow, atmospheric shots with little plot",
    beats: [
      {
        camera: "Wide atmospheric shot",
        beat: "{premise}, drifting fog and soft light",
        motion: "fog drifts slowly through the frame",
      },
      {
        camera: "The camera drifts to a detail",
        beat: "a small object catching the light",
        motion: "slow drift, light glints",
      },
      {
        camera: "Silhouette medium shot",
        beat: "the character framed against the light",
        motion: "silhouette breathes, slow parallax",
      },
      {
        camera: "Close-up through foreground elements",
        beat: "a quiet expression, partly hidden",
        motion: "foreground slides past the lens",
      },
      {
        camera: "Reflection shot",
        beat: "the scene mirrored in water or glass",
        motion: "ripples distort the reflection",
      },
      {
        camera: "Slow overhead shot",
        beat: "the character small in a vast space",
        motion: "slow overhead rotation",
      },
      {
        camera: "Extreme close-up",
        beat: "hands, fabric or rain in fine detail",
        motion: "slow motion, droplets fall",
      },
      {
        camera: "The camera pulls back into darkness",
        beat: "the light fades as the moment ends",
        motion: "slow fade as the camera recedes",
      },
    ],
  },
];

/** Returns a list of problems; empty = valid. */
export function validateStoryStructures(data: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(data)) return ["structures must be an array"];
  const ids = new Set<string>();
  data.forEach((s: Partial<StoryStructure>, i) => {
    const at = `structures[${i}]${s?.id ? ` (${s.id})` : ""}`;
    if (!s || typeof s !== "object") {
      errors.push(`${at}: not an object`);
      return;
    }
    if (typeof s.id !== "string" || !/^[a-z0-9_]+$/.test(s.id))
      errors.push(`${at}: id must be snake_case`);
    else if (ids.has(s.id)) errors.push(`${at}: duplicate id`);
    else ids.add(s.id);
    if (typeof s.label !== "string" || !s.label.trim())
      errors.push(`${at}: label required`);
    if (typeof s.description !== "string" || !s.description.trim())
      errors.push(`${at}: description required`);
    if (!Array.isArray(s.beats) || s.beats.length !== STORYBOARD_MAX_FRAMES) {
      errors.push(`${at}: needs exactly ${STORYBOARD_MAX_FRAMES} beats`);
      return;
    }
    s.beats.forEach((b, j) => {
      const bt = `${at}.beats[${j}]`;
      for (const k of ["camera", "beat", "motion"] as const)
        if (typeof b?.[k] !== "string" || !b[k].trim())
          errors.push(`${bt}: ${k} required`);
      const holes = (b?.beat ?? "").match(/\{(\w+)\}/g) ?? [];
      if (holes.some((h) => h !== "{premise}"))
        errors.push(`${bt}: unknown placeholder`);
      if (holes.length > 1) errors.push(`${bt}: {premise} at most once`);
      if ((b?.motion ?? "").length > 160) errors.push(`${bt}: motion too long`);
    });
    if (!s.beats[0]?.beat?.includes("{premise}"))
      errors.push(`${at}: first beat must carry {premise}`);
  });
  return errors;
}

export function getStoryStructure(id: string): StoryStructure | undefined {
  return STORY_STRUCTURES.find((s) => s.id === id);
}

export function clampFrameCount(n: number): number {
  if (!Number.isFinite(n)) return STORYBOARD_MIN_FRAMES;
  return Math.min(
    STORYBOARD_MAX_FRAMES,
    Math.max(STORYBOARD_MIN_FRAMES, Math.round(n)),
  );
}

/**
 * `n` beat indices out of `total`, evenly spaced, always keeping the first
 * (establishing) and last (resolution) beat.
 */
export function pickBeatIndices(
  n: number,
  total = STORYBOARD_MAX_FRAMES,
): number[] {
  const count = Math.min(total, Math.max(1, Math.round(n)));
  if (count === 1) return [0];
  const out: number[] = [];
  for (let i = 0; i < count; i++)
    out.push(Math.round((i * (total - 1)) / (count - 1)));
  return out;
}

export interface StoryShot {
  /** Editable shot text ("camera, what happens"). */
  text: string;
  motion: string;
}

/** Auto shot list: the structure's beats sampled to `count`, premise filled. */
export function planShots(
  structureId: string,
  premise: string,
  count: number,
): StoryShot[] {
  const s = getStoryStructure(structureId) ?? STORY_STRUCTURES[0];
  const p =
    cleanNotes(premise, 400).replace(/[.!?]+$/, "") || "an original story";
  return pickBeatIndices(clampFrameCount(count), s.beats.length).map((i) => {
    const b = s.beats[i];
    return {
      text: `${b.camera}: ${b.beat.replace("{premise}", p)}.`,
      motion: b.motion,
    };
  });
}

// Prompts

/** What the optional uploaded image is. */
export type RefRole = "character" | "opening";

export const FRAME_STYLE =
  "Cinematic film still, consistent lighting and color grade";

/** Frame 1 with no reference: one text-to-image prompt. */
export function firstFrameT2IPrompt(shot: StoryShot, premise: string): string {
  const p = cleanNotes(premise, 400).replace(/[.!?]+$/, "");
  const lead = p ? `${p}. ` : "";
  return `${lead}${cleanNotes(shot.text, 400)} ${FRAME_STYLE}.`
    .replace(/\.\./g, ".")
    .trim();
}

/** Frame 1 from a character reference: an edit of the reference photo. */
export function firstFrameRefPrompt(shot: StoryShot, premise: string): string {
  const p = cleanNotes(premise, 400).replace(/[.!?]+$/, "");
  return (
    `Show this same character in the opening shot of a story${p ? ` about ${p}` : ""}. ` +
    `${cleanNotes(shot.text, 400)} ` +
    `Keep their face, hairstyle, body and outfit exactly the same. ${FRAME_STYLE}.`
  )
    .replace(/\.\./g, ".")
    .trim();
}

/**
 * Frames 2..N: an edit of the previous frame. The next-scene LoRA takes the
 * bare shot ("fragment"; its tool adds "Next Scene:"); instruction engines
 * get a full instruction; two-image engines also lock the character to the
 * reference image.
 */
export function nextFramePrompt(shot: StoryShot, engine: EditEngine): string {
  const text = cleanNotes(shot.text, 400);
  if (engine.promptStyle === "fragment") return text;
  const lock =
    engine.refs === 2
      ? "Keep the character identical to the reference image"
      : "Keep the same character, wardrobe, setting and lighting as this frame";
  return `Show the next shot of the same story. ${text} ${lock}.`
    .replace(/\.\./g, ".")
    .trim();
}

// Engines

/** Engines for frames 2..N, in preference order (next-scene LoRA first). */
export function nextFrameEngineIds(hasCharacterRef: boolean): EditEngineId[] {
  return [
    "qwen21-next-scene",
    ...(hasCharacterRef ? DUAL_ENGINES : []),
    ...SINGLE_ENGINES,
  ];
}

/** Engines for an edit of the character reference into frame 1. */
export const FIRST_FRAME_ENGINES: EditEngineId[] = SINGLE_ENGINES;

/** Card-level engine set (any one available means the card can run). */
export const STORYBOARD_ENGINES: EditEngineId[] = nextFrameEngineIds(false);

export function engineById(id: EditEngineId): EditEngine {
  return EDIT_ENGINES[id];
}

// Chain state machine

export type FrameStatus = "pending" | "queued" | "done" | "error";

export interface FrameState {
  status: FrameStatus;
  runId?: string;
  jobIndex?: number;
  /** Finished image URL (preview). */
  imageUrl?: string;
  /** Frame 1 taken as-is from the uploaded opening frame. */
  image?: ToolImage;
  error?: string;
}

export function initialFrames(count: number): FrameState[] {
  return Array.from({ length: clampFrameCount(count) }, () => ({
    status: "pending" as const,
  }));
}

/**
 * The next frame to queue, or null. Strictly sequential: frame i needs
 * frame i-1 done (its output is frame i's input), and nothing may be in
 * flight. Frame 0 is only returned when `chainStarted` (the user pressed
 * Generate) so loading the page never queues work.
 */
export function nextFrameToSubmit(
  frames: FrameState[],
  chainStarted: boolean,
): number | null {
  if (!chainStarted) return null;
  if (frames.some((f) => f.status === "queued" || f.status === "error"))
    return null;
  const i = frames.findIndex((f) => f.status === "pending");
  if (i < 0) return null;
  if (i === 0) return 0;
  return frames[i - 1].status === "done" ? i : null;
}

/**
 * Re-roll frame `k`: reset it (and, with `cascade`, every later frame,
 * whose inputs derive from it) to pending.
 */
export function resetFrom(
  frames: FrameState[],
  k: number,
  cascade: boolean,
): FrameState[] {
  return frames.map((f, i) =>
    i === k || (cascade && i > k) ? { status: "pending" } : f,
  );
}

/** Frames ready for "Animate all" (finished, with a server-side run). */
export function animatableFrames(frames: FrameState[]): number[] {
  return frames
    .map((f, i) => (f.status === "done" && (f.runId || f.image) ? i : -1))
    .filter((i) => i >= 0);
}

/** A finished frame as an input image for the next edit. */
export function frameAsImage(
  f: FrameState,
  index: number,
  size: { width: number; height: number },
): ToolImage | null {
  if (f.status !== "done") return null;
  if (f.image) return f.image;
  if (!f.runId) return null;
  return {
    id: `storyboard-${index}-${f.runId}`,
    source: "gallery",
    previewUrl: f.imageUrl ?? "",
    label: `Frame ${index + 1}`,
    width: size.width,
    height: size.height,
    runId: f.runId,
    jobIndex: f.jobIndex ?? 0,
  };
}

/** Queue one edit-based frame (frame 1 from a character ref, or frames 2..N). */
export async function submitStoryFrame(args: {
  fetchImpl: FetchLike;
  index: number;
  frames: FrameState[];
  shots: StoryShot[];
  premise: string;
  /** Uploaded image and what it is (optional). */
  reference: ToolImage | null;
  refRole: RefRole;
  /** Engine for frames 2..N. */
  engine: EditEngine;
  /** Engine for frame 1 from a character reference. */
  firstEngine: EditEngine | null;
  ctx: EngineContext;
  clientId: string;
  size?: { width: number; height: number };
  onWarnings?: (w: string[]) => void;
}): Promise<ImagineRun> {
  const { index, frames, shots, reference, engine } = args;
  const shot = shots[index];
  if (!shot) throw new Error(`No shot for frame ${index + 1}`);
  const title = `Storyboard ${index + 1}/${shots.length}`;
  const size = args.size ?? {
    width: reference?.width || 1024,
    height: reference?.height || 1024,
  };
  if (index === 0) {
    if (!reference || args.refRole !== "character")
      throw new Error("Frame 1 needs a character reference for an edit.");
    if (!args.firstEngine) throw new Error("No edit model is installed.");
    return submitEngineEdit({
      fetchImpl: args.fetchImpl,
      engine: args.firstEngine,
      prompt: firstFrameRefPrompt(shot, args.premise),
      image: reference,
      ctx: args.ctx,
      clientId: args.clientId,
      title,
      onWarnings: args.onWarnings,
    });
  }
  const prev = frameAsImage(frames[index - 1], index - 1, size);
  if (!prev) throw new Error(`Frame ${index} is not finished yet.`);
  const dual = engine.refs === 2;
  if (dual && (!reference || args.refRole !== "character"))
    throw new Error("This model needs the character reference.");
  return submitEngineEdit({
    fetchImpl: args.fetchImpl,
    engine,
    prompt: nextFramePrompt(shot, engine),
    image: prev,
    secondImage: dual ? reference : null,
    ctx: args.ctx,
    clientId: args.clientId,
    title,
    onWarnings: args.onWarnings,
  });
}

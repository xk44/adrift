/**
 * Stitch clips: join 2-8 finished video outputs into one clip, with a hard
 * cut or a crossfade at each seam. Pure, client-safe helpers (limits, file
 * refs from gallery / history output URLs, action params, hub card); the
 * graph builder is src/lib/oj/stitchClips.ts and the executor
 * stitchRunner.ts.
 *
 * Reusable step: anything holding ComfyUI output refs ("video/x_00001_.mp4
 * [output]", e.g. pipeline StepOutput.ref) can call runStitch / stitchParams
 * to concatenate them (Cinema multi-shot scenes, Board lanes).
 */
import type { GalleryImage } from "@/types";
import type { HubCard } from "./hub";
import { VIDEO_EXT, isSafeFileRef } from "./pipelines";

export const STITCH_CLIPS_ACTION = "stitch_clips";
export const STITCH_CLIPS_KEY = "special:stitch_clips";
export const STITCH_MIN_CLIPS = 2;
export const STITCH_MAX_CLIPS = 8;
/** Every frame of every clip sits in RAM, so the joined clip is capped. */
export const STITCH_MAX_TOTAL_SECONDS = 60;
export const STITCH_DEFAULT_FPS = 24;
export const STITCH_MIN_FPS = 12;
export const STITCH_MAX_FPS = 30;
/** Crossfade frames are blended one by one (one ImageBlend each). */
export const STITCH_MIN_FADE_FRAMES = 2;
export const STITCH_MAX_FADE_FRAMES = 24;
export const STITCH_DEFAULT_FADE_SECONDS = 0.5;

export const STITCH_TRANSITIONS = [
  { id: "cut", label: "Hard cut" },
  { id: "fade", label: "Crossfade" },
] as const;
export type StitchTransition = (typeof STITCH_TRANSITIONS)[number]["id"];

export const STITCH_FADE_LENGTHS = [
  { id: "0.25", label: "Quick" },
  { id: "0.5", label: "Medium" },
  { id: "1", label: "Slow" },
] as const;

export const STITCH_FPS_OPTIONS = [
  { id: "24", label: "24 fps" },
  { id: "30", label: "30 fps" },
  { id: "source", label: "Match clip 1" },
] as const;

/** Frame-rate choice that copies the first clip's own fps. */
export const STITCH_SOURCE_FPS = "source";

/** crop = fill the frame and trim edges; letterbox = fit inside, black bars. */
export type StitchFit = "crop" | "letterbox";

export const STITCH_FIT_OPTIONS: { id: StitchFit; label: string }[] = [
  { id: "crop", label: "Fill (trims edges)" },
  { id: "letterbox", label: "Fit (black bars)" },
];

/**
 * Stitch fps: keeps fractional rates (23.976, 29.97), halves rates above the
 * max (60 -> 30, 59.94 -> 29.97) so motion timing stays exact, then clamps.
 */
export function stitchFps(value: unknown): number {
  let fps =
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : STITCH_DEFAULT_FPS;
  while (fps > STITCH_MAX_FPS && fps / 2 >= STITCH_MIN_FPS) fps /= 2;
  fps = Math.min(STITCH_MAX_FPS, Math.max(STITCH_MIN_FPS, fps));
  return Math.round(fps * 1000) / 1000;
}

/** One clip to stitch: a ComfyUI output ref plus what the client knows. */
export interface StitchClip {
  /** Annotated ComfyUI ref: "sub/name.mp4 [output|input|temp]". */
  ref: string;
  /** Playable URL (preview / measuring); optional for server callers. */
  url?: string;
  /** Length in seconds, null/undefined = unknown. */
  seconds?: number | null;
  /** false = the clip has no sound track (silence is used for it). */
  audio?: boolean;
  /** The clip's own frame rate when known (MP4 / MOV probe). */
  fps?: number | null;
  label?: string;
  /** Gallery tile id (picker bookkeeping). */
  id?: string;
}

export interface StitchOptions {
  transition?: StitchTransition;
  /** Crossfade length (cut ignores it). */
  fadeSeconds?: number;
  /** Output fps, or "source" = the first clip's own fps (24 when unknown). */
  fps?: number | typeof STITCH_SOURCE_FPS;
  /** How clips of another shape fit the frame (default crop). */
  fit?: StitchFit;
  /** Keep the clips' sound (needs every clip's length). */
  audio?: boolean;
  /** Output frame size; omitted = match the first clip. */
  width?: number;
  height?: number;
  /** SaveVideo prefix ("video/<name>"). */
  prefix?: string;
}

/**
 * Annotated ref for a ComfyUI view URL (/api/comfy/image?filename=..., the
 * raw /view?... form, or a bare ref already). null when it is not a video.
 */
export function clipRefFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  if (isSafeFileRef(url, VIDEO_EXT)) return url;
  let u: URL;
  try {
    u = new URL(url, "http://local");
  } catch {
    return null;
  }
  const filename = u.searchParams.get("filename");
  if (!filename) return null;
  const subfolder = u.searchParams.get("subfolder") ?? "";
  const type = u.searchParams.get("type") || "output";
  const ref = `${subfolder ? `${subfolder}/` : ""}${filename} [${type}]`;
  return isSafeFileRef(ref, VIDEO_EXT) ? ref : null;
}

/** Newest-first video outputs from the gallery that can be stitched. */
export function recentVideoClips(
  gallery: GalleryImage[],
  limit = 48,
): StitchClip[] {
  const out: StitchClip[] = [];
  const seen = new Set<string>();
  for (const g of gallery) {
    if (out.length >= limit) break;
    if (!g.videoUrl || g.hidden || g.external) continue;
    const ref = clipRefFromUrl(g.videoUrl);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    out.push({
      id: g.id,
      ref,
      url: g.videoUrl,
      label: g.prompt?.slice(0, 60) || "Video",
    });
  }
  return out;
}

/** Why the clip list cannot run yet, or null. */
export function stitchValidation(
  clips: StitchClip[],
  opts: StitchOptions = {},
): string | null {
  if (clips.length < STITCH_MIN_CLIPS)
    return `Pick at least ${STITCH_MIN_CLIPS} clips.`;
  if (clips.length > STITCH_MAX_CLIPS)
    return `Pick at most ${STITCH_MAX_CLIPS} clips.`;
  const known = clips.map((c) => c.seconds);
  if (known.every((s): s is number => typeof s === "number" && s > 0)) {
    const total = known.reduce((a, s) => a + s, 0);
    if (total > STITCH_MAX_TOTAL_SECONDS)
      return `That is ${Math.round(total)} s of video; the limit is ${STITCH_MAX_TOTAL_SECONDS} s.`;
  }
  if (opts.audio && known.some((s) => !(typeof s === "number" && s > 0)))
    return "Keeping sound needs every clip's length; one could not be read.";
  return null;
}

/**
 * stitch_clips action params from a list of output refs (order = timeline
 * order). Throws on an invalid list so callers fail before queueing.
 */
export function stitchParams(
  clips: StitchClip[],
  opts: StitchOptions = {},
): Record<string, unknown> {
  const problem = stitchValidation(clips, opts);
  if (problem) throw new Error(problem);
  clips.forEach((c, i) => {
    if (!isSafeFileRef(c.ref, VIDEO_EXT))
      throw new Error(`Clip ${i + 1} is not a video output.`);
  });
  const params: Record<string, unknown> = {
    clips: clips.map((c) => {
      const clip: Record<string, unknown> = { video: c.ref };
      if (typeof c.seconds === "number" && c.seconds > 0)
        clip.seconds = Math.round(c.seconds * 1000) / 1000;
      if (c.audio === false) clip.audio = false;
      return clip;
    }),
    transition: opts.transition ?? "cut",
    fps: stitchFps(
      opts.fps === STITCH_SOURCE_FPS ? clips[0]?.fps : opts.fps,
    ),
    audio: !!opts.audio,
  };
  if (params.transition === "fade")
    params.fadeSeconds = opts.fadeSeconds ?? STITCH_DEFAULT_FADE_SECONDS;
  if (opts.width && opts.height) {
    params.width = opts.width;
    params.height = opts.height;
  }
  if (opts.prefix) params.prefix = opts.prefix;
  if (opts.fit === "letterbox") params.fit = "letterbox";
  return params;
}

/** Tools hub card: no model, stock ComfyUI + VideoHelperSuite nodes. */
export function stitchClipsCard(): HubCard {
  return {
    key: STITCH_CLIPS_KEY,
    kind: "special",
    id: "stitch_clips",
    title: "Stitch Clips",
    subtitle:
      "Join 2 to 8 of your recent clips into one, with hard cuts or crossfades",
    icon: "Clapperboard",
    hubCategory: "Video",
    available: true,
    unavailableReason: null,
    licenseNote: null,
    checking: false,
    model: "No model (stock video nodes)",
    nc: false,
    aliases: [
      "stitch",
      "join clips",
      "merge videos",
      "concat",
      "concatenate",
      "crossfade",
      "multi-shot",
      "scene",
      "edit together",
    ],
  };
}

/**
 * "Upscale after": a tool run whose result is an image or a clip can queue
 * Adrift's own Upscale (image) or Upscale video (Fast engine) on that result
 * once it finishes. Neither request names a model, so the server swaps in
 * the user's default upscaler for the content type (resolveUpscalers.ts:
 * Upscale actions always follow the preference).
 *
 * Never twice: tools that upscale themselves are not offered the toggle
 * (UPSCALE_AFTER_SKIP), and the job routes stamp UPSCALE_GRAPH_PARAM on
 * every run from its final graph, so a run that did upscale (an engine pick
 * that switched to a two-stage graph, say) is skipped at chain time too.
 *
 * Pure: the store (store/upscaleAfterStore.ts) holds the chains and
 * hooks/useUpscaleAfter.ts runs them.
 */
import type { ImagineJob, ImagineRun } from "@/types";
import type { UpscalerPref } from "./upscalerPref";

/** Run param (true/false) the job routes write from the queued graph. */
export const UPSCALE_GRAPH_PARAM = "action_graph_upscales";

/** Node classes that raise output resolution. */
const UPSCALE_NODE_RE =
  /^(UpscaleModelLoader|ImageUpscaleWithModel\w*|UltimateSDUpscale\w*|SeedVR2\w*|LatentUpscale\w*|LTXVLatentUpsampler|\w*SUPIR\w*)$/;

export function graphUpscales(prompt: unknown): boolean {
  if (!prompt || typeof prompt !== "object") return false;
  return Object.values(prompt as Record<string, unknown>).some((n) => {
    const cls = (n as { class_type?: unknown } | null)?.class_type;
    return typeof cls === "string" && UPSCALE_NODE_RE.test(cls);
  });
}

export type UpscaleAfterMedia = "image" | "video";
export type UpscaleAfterFactor = 2 | 4;

/** Tools that already upscale, or whose output a model upscale would break. */
export const UPSCALE_AFTER_SKIP: Readonly<Record<string, string>> = {
  "action:upscale": "upscales",
  "action:upscale_seedvr2": "upscales",
  "action:upscale_vosr2": "upscales",
  "action:upscale_video": "upscales",
  "catalog:qwen2511-unblur-upscale": "upscales",
  "catalog:qwen21-restore": "upscales",
  // LTX-2.5 two-stage graphs: half-size pass + latent 2× upsampler.
  "action:ltx25_animate": "upscales",
  "action:ltx_reshoot": "upscales",
  "action:ltx_slow_motion": "upscales",
  // Transparency or a special master the upscale graph would flatten.
  "action:bg_remove": "alpha",
  "action:video_bg_remove": "alpha",
  "action:subject_matte": "alpha",
  "action:ltx_alpha_matte": "alpha",
  "catalog:qwen21-remove-bg": "alpha",
  "action:sdr_to_hdr": "hdr",
};

/** Action tools with one still image as their result. */
export const IMAGE_TOOLS: ReadonlySet<string> = new Set([
  "edit_photo",
  "edit_qwen21",
  "edit_flux3",
  "edit_fibo",
  "remove_object",
  "restyle_locked",
  "replace_person",
  "pose_character",
  "enhance_faces",
  "relight",
  "light_migration",
  "refocus",
  "h3_charsheet",
]);

/** Action tools with one clip as their result. */
export const VIDEO_TOOLS: ReadonlySet<string> = new Set([
  "animate",
  "orbit_360",
  "camera_move",
  "face_swap",
  "person_remove",
  "video_object_remove",
  "video_remove_text",
  "video_object_swap",
  "video_object_add",
  "video_bg_swap",
  "video_bg_change",
  "video_palette",
  "cast_swap",
  "character_swap",
  "character_swap_full",
  "wan_animate",
  "lipsync",
  "video_lipsync",
  "talking_avatar",
  "transition",
  "ref_video",
  "multiframe_ref",
  "ltx25_transition",
  "interpolate",
  "wan_motion",
  "wan_camera",
  "wan_move",
  "vace_restyle",
  "vace_reframe",
  "video_expand",
  "video_retake",
  "vace_extend",
  "rack_focus",
  "video_edit",
  "add_sound",
  "ltx_clean_plate",
  "ltx_day_to_night",
  "ltx_add_water",
  "ltx_cinemagraph",
  "ltx_ripple",
  "ltx_edge_control",
  "ltx_blockout_render",
  "ltx_exploded_view",
  "ltx_paint_fluid",
]);

/**
 * What an "Upscale after" pass would upscale for a runner card
 * (`action:<id>` / `catalog:<id>`), or null when the tool gets no toggle.
 * Catalog tools are all image edits.
 */
export function upscaleAfterMedia(cardKey: string): UpscaleAfterMedia | null {
  if (UPSCALE_AFTER_SKIP[cardKey]) return null;
  const cut = cardKey.indexOf(":");
  const kind = cardKey.slice(0, cut);
  const id = cut < 0 ? "" : cardKey.slice(cut + 1);
  if (kind === "catalog" && id) return "image";
  if (kind !== "action" || !id) return null;
  if (IMAGE_TOOLS.has(id)) return "image";
  if (VIDEO_TOOLS.has(id)) return "video";
  return null;
}

/** Sizes offered: 2× / 4× for stills; clips stay at 2× (4× of 720p is 2880p). */
export function upscaleAfterFactors(
  media: UpscaleAfterMedia,
): UpscaleAfterFactor[] {
  return media === "video" ? [2] : [2, 4];
}

export interface UpscaleAfterChoice {
  on: boolean;
  factor: UpscaleAfterFactor;
}

/**
 * Settings default: off unless saved on; the size follows the Faithful
 * upscale size (4× only when that is 4×) and is clamped to the media.
 */
export function defaultUpscaleAfter(
  pref: UpscalerPref | null | undefined,
  media: UpscaleAfterMedia,
): UpscaleAfterChoice {
  return {
    on: pref?.after === true,
    factor: clampFactor(pref?.scale === 4 ? 4 : 2, media),
  };
}

export function clampFactor(
  factor: number,
  media: UpscaleAfterMedia,
): UpscaleAfterFactor {
  const allowed = upscaleAfterFactors(media);
  return (allowed as number[]).includes(factor)
    ? (factor as UpscaleAfterFactor)
    : 2;
}

/** Per-run override over the Settings default (null = follow it). */
export function effectiveUpscaleAfter(
  override: Partial<UpscaleAfterChoice> | null,
  pref: UpscalerPref | null | undefined,
  media: UpscaleAfterMedia,
): UpscaleAfterChoice {
  const base = defaultUpscaleAfter(pref, media);
  return {
    on: override?.on ?? base.on,
    factor: clampFactor(override?.factor ?? base.factor, media),
  };
}

// Chains

export type UpscaleChainStatus = "waiting" | "queued" | "skipped" | "failed";

export interface UpscaleChain {
  parentRunId: string;
  /** Tool title of the parent ("Relight"). */
  parentLabel: string;
  /** Runner card the parent came from (its result strip gets the child). */
  cardKey: string;
  factor: UpscaleAfterFactor;
  createdAt: number;
  status: UpscaleChainStatus;
  /** Upscale runs queued for the parent's jobs. */
  children: string[];
  /** Why the chain was skipped / failed. */
  note?: string;
}

export interface UpscaleStep {
  jobIndex: number;
  /** Action tool to queue on the parent job: "upscale" | "upscale_video". */
  toolId: "upscale" | "upscale_video";
  /** Picker values (ToolSettings.picks); no model, so the default applies. */
  picks: Record<string, string>;
}

export type UpscalePlan =
  | { kind: "wait" }
  | { kind: "skip"; note: string }
  | { kind: "fail"; note: string }
  | { kind: "queue"; steps: UpscaleStep[] };

/** A parent nobody heard from in this long is dropped. */
export const CHAIN_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** Grace for a finished job's files to arrive (WS "done" can lead them). */
export const OUTPUT_GRACE_MS = 2 * 60 * 1000;

const TERMINAL = new Set(["done", "error", "cancelled"]);

function hasVideo(job: ImagineJob): boolean {
  return (job.videos?.length ?? 0) > 0;
}

export function upscaleStepFor(
  job: ImagineJob,
  factor: UpscaleAfterFactor,
): UpscaleStep | null {
  if (hasVideo(job))
    return {
      jobIndex: job.index,
      toolId: "upscale_video",
      picks: { engine: "fast", scale: "2x" },
    };
  if (job.images.length > 0)
    return {
      jobIndex: job.index,
      toolId: "upscale",
      picks: { mode: "upscale_subtle", size: `${factor}x` },
    };
  return null;
}

/** Next move for a waiting chain given its parent run (undefined = not seen yet). */
export function planUpscaleChain(
  chain: UpscaleChain,
  run: ImagineRun | undefined,
  now = Date.now(),
): UpscalePlan {
  if (chain.status !== "waiting") return { kind: "wait" };
  if (!run) {
    return now - chain.createdAt > CHAIN_MAX_AGE_MS
      ? { kind: "fail", note: "The tool run is gone." }
      : { kind: "wait" };
  }
  if (run.params?.[UPSCALE_GRAPH_PARAM] === true)
    return { kind: "skip", note: `${chain.parentLabel} already upscales.` };
  if (run.jobs.length === 0 || run.jobs.some((j) => !TERMINAL.has(j.status)))
    return { kind: "wait" };
  const done = run.jobs.filter((j) => j.status === "done");
  if (done.length === 0)
    return {
      kind: "skip",
      note: run.jobs.some((j) => j.status === "error")
        ? `${chain.parentLabel} failed.`
        : `${chain.parentLabel} was cancelled.`,
    };
  const steps: UpscaleStep[] = [];
  for (const job of done) {
    const step = upscaleStepFor(job, chain.factor);
    if (step) {
      steps.push(step);
      continue;
    }
    // Finished without files yet: give them a moment to land.
    if (now - (job.completedAt ?? now) < OUTPUT_GRACE_MS)
      return { kind: "wait" };
  }
  if (steps.length === 0)
    return {
      kind: "fail",
      note: `${chain.parentLabel} made nothing to upscale.`,
    };
  return { kind: "queue", steps };
}

/** "Upscale 2×" / "Upscale video 2×". */
export function chainLabel(
  factor: UpscaleAfterFactor,
  media?: UpscaleAfterMedia,
): string {
  return `${media === "video" ? "Upscale video" : "Upscale"} ${factor}×`;
}

/** Chains worth keeping: waiting ones, and the newest `keep` finished ones. */
export function pruneChains(
  chains: Readonly<Record<string, UpscaleChain>>,
  now = Date.now(),
  keep = 40,
): Record<string, UpscaleChain> {
  const live = Object.values(chains).filter(
    (c) => now - c.createdAt <= CHAIN_MAX_AGE_MS * 4,
  );
  const waiting = live.filter((c) => c.status === "waiting");
  const rest = live
    .filter((c) => c.status !== "waiting")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, keep);
  return Object.fromEntries(
    [...waiting, ...rest].map((c) => [c.parentRunId, c]),
  );
}

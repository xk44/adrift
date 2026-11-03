/**
 * LTX-2.5 (22B distilled, open weights) video packs in packs/ltx25/.
 *
 * t2v / i2v follow the official two-stage recipe: an 8-step pass at half
 * resolution, the x2 latent upscaler, then a 3-step refine (euler_ancestral,
 * ManualSigmas, LTXVDualCFGGuider at cfg 1). flf2v is one 8-step pass at full
 * resolution guided by a first and a last frame. Every graph renders sound
 * (LTXVEmptyLatentAudio + audio VAE) muxed into the clip.
 *
 * Pure helpers only (no engine import) so engine.ts can call
 * applyLtx25Params without an import cycle; the tool builders live in
 * ltx25Tools.ts.
 */
import type { Workflow } from "@/types";

export const LTX25_PACK_ID = "ltx25";
export const LTX25_ANIMATE_ACTION = "ltx25_animate";
export const LTX25_TRANSITION_ACTION = "ltx25_transition";

/** Matches the LTX-2.5 DiT file names ("ltx-2.5-22b-distilled-…"). */
export const LTX25_UNET_RE = /ltx-?2[._]5/i;
export const LTX25_FPS = 24;
/** 5 s at 24 fps (+1): the official templates' default. */
export const LTX25_DEFAULT_LENGTH = 121;
export const LTX25_MIN_LENGTH = 9;
/** 10 s at 24 fps (+1). */
export const LTX25_MAX_LENGTH = 241;
/** ~0.9 MP output, the templates' ResolutionSelector default. */
export const LTX25_TARGET_PIXELS = 0.9 * 1024 * 1024;

type Inputs = Record<string, unknown>;

function inputsOf(workflow: Workflow, id: string): Inputs {
  return (workflow[id]?.inputs ?? {}) as Inputs;
}

function idsOf(workflow: Workflow, classType: string): string[] {
  return Object.entries(workflow)
    .filter(([, n]) => n.class_type === classType)
    .map(([id]) => id);
}

export function isLtx25Workflow(workflow: Workflow): boolean {
  return Object.values(workflow).some(
    (n) =>
      n.class_type === "UNETLoader" &&
      LTX25_UNET_RE.test(String((n.inputs as Inputs)?.unet_name ?? "")),
  );
}

/** Two-stage graphs (t2v / i2v) carry the x2 latent upsampler. */
export function isLtx25TwoStage(workflow: Workflow): boolean {
  return idsOf(workflow, "LTXVLatentUpsampler").length > 0;
}

/** Frame count snapped to the model's 8n+1 grid, clamped to [9, 241]. */
export function ltx25Length(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return LTX25_DEFAULT_LENGTH;
  const snapped = Math.round((n - 1) / 8) * 8 + 1;
  return Math.min(LTX25_MAX_LENGTH, Math.max(LTX25_MIN_LENGTH, snapped));
}

/** Seconds → frame count at `fps` (8n+1). */
export function ltx25LengthForSeconds(seconds: unknown, fps = LTX25_FPS) {
  const s = typeof seconds === "number" ? seconds : Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return LTX25_DEFAULT_LENGTH;
  return ltx25Length(Math.round(s * fps) + 1);
}

/** "16:9" / "1.78" / "9x16" → width/height ratio (undefined when unusable). */
export function parseAspect(ar: unknown): number | undefined {
  if (typeof ar === "number") return ar > 0 ? ar : undefined;
  if (typeof ar !== "string") return undefined;
  const m = ar.trim().match(/^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/i);
  const ratio = m ? Number(m[1]) / Number(m[2]) : Number(ar);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : undefined;
}

const snap32 = (v: number) => Math.max(64, Math.round(v / 32) * 32);

/**
 * Output size for an aspect ratio at ~0.9 MP. Two-stage graphs sample the
 * first pass at exactly half size (/32), so the final clip is 2x that.
 * Ratios are clamped to 1:3 … 3:1.
 */
export function ltx25Dims(
  ratio: number,
  twoStage: boolean,
): { width: number; height: number; stageWidth: number; stageHeight: number } {
  const r = Math.min(3, Math.max(1 / 3, ratio));
  const w = Math.sqrt(LTX25_TARGET_PIXELS * r);
  const h = w / r;
  if (twoStage) {
    const sw = snap32(w / 2);
    const sh = snap32(h / 2);
    return { width: sw * 2, height: sh * 2, stageWidth: sw, stageHeight: sh };
  }
  const fw = snap32(w);
  const fh = snap32(h);
  return { width: fw, height: fh, stageWidth: fw, stageHeight: fh };
}

/** Largest clip a source-sized handoff may pick, as a multiple of the target. */
export const LTX25_HANDOFF_MAX_SCALE = 1.3;
/** Aspect errors this close to the best count as a tie (smaller clip wins). */
const HANDOFF_ASPECT_TIE = 0.01;

/**
 * Clip size for a source image (an image -> LTX handoff): on the model's
 * grid (/32 per stage, so /64 final for two-stage graphs), the closest
 * aspect to the source, never smaller than ltx25Dims would render for that
 * ratio and at most LTX25_HANDOFF_MAX_SCALE x the ~0.9 MP target (aspect
 * errors within 1% of the best count as equal; the smaller clip wins). A
 * source that already sits on the grid in that range (FLUX.3 16:9 key art,
 * 1344x768) comes back unchanged, so the first frame is neither resampled
 * nor cropped.
 */
export function ltx25SourceDims(
  sourceWidth: number,
  sourceHeight: number,
  twoStage: boolean,
): { width: number; height: number; stageWidth: number; stageHeight: number } {
  const ratioIn =
    sourceWidth > 0 && sourceHeight > 0 ? sourceWidth / sourceHeight : 1;
  const ratio = Math.min(3, Math.max(1 / 3, ratioIn));
  const fallback = ltx25Dims(ratio, twoStage);
  const floor = fallback.width * fallback.height;
  const cap = LTX25_TARGET_PIXELS * LTX25_HANDOFF_MAX_SCALE;
  const grid = twoStage ? 64 : 32;
  const sizeOk = (w: number, h: number) =>
    w % grid === 0 && h % grid === 0 && w * h >= floor && w * h <= cap;
  // Already a valid clip size: keep it, so the frame is not resampled.
  if (ratio === ratioIn && sizeOk(sourceWidth, sourceHeight))
    return dimsOf(sourceWidth, sourceHeight, twoStage);
  const err = (w: number, h: number) => Math.abs(Math.log(w / h / ratio));
  const options: { w: number; h: number; e: number }[] = [];
  for (let w = grid; w * grid <= cap; w += grid) {
    const ideal = w / ratio;
    for (const h of [
      Math.floor(ideal / grid) * grid,
      Math.ceil(ideal / grid) * grid,
    ]) {
      if (h < grid || !sizeOk(w, h)) continue;
      options.push({ w, h, e: err(w, h) });
    }
  }
  if (!options.length) return fallback;
  const best = Math.min(...options.map((o) => o.e));
  const pick = options
    .filter((o) => o.e <= best + HANDOFF_ASPECT_TIE)
    .reduce((a, b) =>
      b.w * b.h < a.w * a.h || (b.w * b.h === a.w * a.h && b.e < a.e) ? b : a,
    );
  return dimsOf(pick.w, pick.h, twoStage);
}

function dimsOf(width: number, height: number, twoStage: boolean) {
  return twoStage
    ? { width, height, stageWidth: width / 2, stageHeight: height / 2 }
    : { width, height, stageWidth: width, stageHeight: height };
}

/**
 * Set the clip size: the EmptyLTXVLatentVideo gets the stage size, and every
 * "scale dimensions" resize (flf2v guide frames) the final size.
 */
export function setLtx25Size(
  workflow: Workflow,
  dims: {
    width: number;
    height: number;
    stageWidth: number;
    stageHeight: number;
  },
): void {
  for (const id of idsOf(workflow, "EmptyLTXVLatentVideo")) {
    const inputs = inputsOf(workflow, id);
    inputs.width = dims.stageWidth;
    inputs.height = dims.stageHeight;
  }
  for (const id of idsOf(workflow, "ResizeImageMaskNode")) {
    const inputs = inputsOf(workflow, id);
    if (inputs.resize_type !== "scale dimensions") continue;
    inputs["resize_type.width"] = dims.width;
    inputs["resize_type.height"] = dims.height;
  }
}

/** Set the clip length on the video latent (and, via sync, the audio). */
export function setLtx25Length(workflow: Workflow, frames: number): void {
  for (const id of idsOf(workflow, "EmptyLTXVLatentVideo")) {
    inputsOf(workflow, id).length = ltx25Length(frames);
  }
  syncLtx25AudioVideo(workflow);
}

/**
 * Keep the audio latent and frame-rate conditioning in step with the video:
 * LTXVEmptyLatentAudio.frames_number = video length (8n+1) and every
 * frame_rate = the CreateVideo fps.
 */
export function syncLtx25AudioVideo(workflow: Workflow): void {
  const latentId = idsOf(workflow, "EmptyLTXVLatentVideo")[0];
  const length = latentId
    ? ltx25Length(inputsOf(workflow, latentId).length)
    : LTX25_DEFAULT_LENGTH;
  if (latentId) inputsOf(workflow, latentId).length = length;

  const muxId = idsOf(workflow, "CreateVideo")[0];
  const fpsRaw = muxId ? Number(inputsOf(workflow, muxId).fps) : NaN;
  const fps =
    Number.isFinite(fpsRaw) && fpsRaw > 0 ? Math.round(fpsRaw) : LTX25_FPS;

  for (const id of idsOf(workflow, "LTXVEmptyLatentAudio")) {
    const inputs = inputsOf(workflow, id);
    inputs.frames_number = length;
    inputs.frame_rate = fps;
  }
  for (const id of idsOf(workflow, "LTXVConditioning")) {
    inputsOf(workflow, id).frame_rate = fps;
  }
}

/**
 * Post-injection fixes for LTX-2.5 graphs (runs at the end of injectParams):
 *  - --ar → ~0.9 MP size; two-stage graphs get the half-size first pass.
 *    Without --ar the latent is only snapped to /32 (e.g. after --draft).
 *  - length snapped to 8n+1; audio frames / frame rates synced.
 *  - Distilled recipe is fixed: generic injection writes `steps` onto the
 *    ManualSigmas nodes and `cfg` onto the guider, neither of which those
 *    nodes declare; drop them so the graph matches /object_info.
 */
export function applyLtx25Params(
  workflow: Workflow,
  params: Record<string, unknown>,
): void {
  if (!isLtx25Workflow(workflow)) return;
  const twoStage = isLtx25TwoStage(workflow);
  const ratio = parseAspect(params.ar);
  if (ratio !== undefined) {
    setLtx25Size(workflow, ltx25Dims(ratio, twoStage));
  } else {
    for (const id of idsOf(workflow, "EmptyLTXVLatentVideo")) {
      const inputs = inputsOf(workflow, id);
      const w = Number(inputs.width);
      const h = Number(inputs.height);
      if (Number.isFinite(w) && w > 0) inputs.width = snap32(w);
      if (Number.isFinite(h) && h > 0) inputs.height = snap32(h);
      if (!twoStage) {
        for (const rid of idsOf(workflow, "ResizeImageMaskNode")) {
          const r = inputsOf(workflow, rid);
          if (r.resize_type !== "scale dimensions") continue;
          r["resize_type.width"] = inputs.width;
          r["resize_type.height"] = inputs.height;
        }
      }
    }
  }
  syncLtx25AudioVideo(workflow);
  for (const id of idsOf(workflow, "ManualSigmas")) {
    delete inputsOf(workflow, id).steps;
  }
  for (const id of idsOf(workflow, "LTXVDualCFGGuider")) {
    delete inputsOf(workflow, id).cfg;
  }
}

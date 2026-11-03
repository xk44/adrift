/**
 * Krea 2 ControlNet (packs/krea2/controlnet.json) auto-depth.
 *
 * The graph estimates depth in-graph with core ComfyUI Depth Anything 3
 * (LoadImage -> LoadDA3Model/DA3Inference -> DA3Render "depth", near = white)
 * before Krea2ControlImageEncode, so a normal photo works as the control
 * image. When the control image is already a depth map (grayscale, or the
 * user passed --cn-depthmap) the estimator is cut out and the LoadImage feeds
 * the encoder directly.
 */
import type { ImageAttachment, Workflow } from "@/types";
import { isFetchableImageUrl } from "@/lib/sref/styleRefImage";

export const KREA2_CONTROL_ENCODE_CLASS = "Krea2ControlImageEncode";
const DEPTH_ESTIMATOR_CLASSES: ReadonlySet<string> = new Set([
  "LoadDA3Model",
  "DA3Inference",
  "DA3Render",
]);

type NodeRef = [string, number];

function isRef(v: unknown): v is NodeRef {
  return Array.isArray(v) && v.length === 2 && typeof v[1] === "number";
}

function findClass(workflow: Workflow, cls: string): string | undefined {
  return Object.keys(workflow).find((id) => workflow[id]?.class_type === cls);
}

/** True for the Krea 2 control-LoRA graph (Krea2ControlImageEncode present). */
export function isKrea2ControlGraph(workflow: Workflow): boolean {
  return findClass(workflow, KREA2_CONTROL_ENCODE_CLASS) !== undefined;
}

/**
 * The LoadImage that feeds the control encoder: either directly or as the
 * image input of the DA3 depth estimator in front of it.
 */
export function krea2ControlImageLoaderId(
  workflow: Workflow,
): string | undefined {
  const encId = findClass(workflow, KREA2_CONTROL_ENCODE_CLASS);
  if (!encId) return undefined;
  let ref = workflow[encId].inputs.control_image;
  // Walk back through DA3Render -> DA3Inference to the image source.
  for (let hops = 0; hops < 4 && isRef(ref); hops++) {
    const node = workflow[String(ref[0])];
    if (!node) return undefined;
    if (node.class_type === "LoadImage") return String(ref[0]);
    if (node.class_type === "DA3Render") ref = node.inputs.da3_geometry;
    else if (node.class_type === "DA3Inference") ref = node.inputs.image;
    else return undefined;
  }
  return undefined;
}

/** True when the encoder's control image runs through the DA3 estimator. */
export function hasKrea2DepthEstimator(workflow: Workflow): boolean {
  const encId = findClass(workflow, KREA2_CONTROL_ENCODE_CLASS);
  if (!encId) return false;
  const ref = workflow[encId].inputs.control_image;
  return isRef(ref) && workflow[String(ref[0])]?.class_type === "DA3Render";
}

/**
 * Cut the DA3 estimator out: the encoder reads the LoadImage directly, and
 * estimator nodes nothing else consumes are deleted. Mutates `workflow`;
 * returns true when the graph changed.
 */
export function bypassKrea2DepthEstimator(workflow: Workflow): boolean {
  const encId = findClass(workflow, KREA2_CONTROL_ENCODE_CLASS);
  if (!encId || !hasKrea2DepthEstimator(workflow)) return false;
  const loaderId = krea2ControlImageLoaderId(workflow);
  if (!loaderId) return false;
  workflow[encId].inputs.control_image = [loaderId, 0];

  // Drop orphaned estimator nodes (repeat: removing DA3Render frees DA3Inference).
  for (let changed = true; changed;) {
    changed = false;
    for (const id of Object.keys(workflow)) {
      if (!DEPTH_ESTIMATOR_CLASSES.has(workflow[id].class_type)) continue;
      const used = Object.entries(workflow).some(
        ([otherId, n]) =>
          otherId !== id &&
          Object.values(n.inputs ?? {}).some(
            (v) => isRef(v) && String(v[0]) === id,
          ),
      );
      if (!used) {
        delete workflow[id];
        changed = true;
      }
    }
  }
  return true;
}

/**
 * Pixel test on raw interleaved samples: every channel equal within
 * `tolerance` on at least `fraction` of the pixels. 1-2 channel buffers
 * (gray / gray+alpha) are grayscale by definition.
 */
export function isGrayscalePixels(
  data: Uint8Array,
  channels: number,
  tolerance = 6,
  fraction = 0.995,
): boolean {
  if (channels <= 2) return true;
  const pixels = Math.floor(data.length / channels);
  if (pixels === 0) return false;
  let gray = 0;
  for (let i = 0; i < pixels; i++) {
    const o = i * channels;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    if (
      Math.abs(r - g) <= tolerance &&
      Math.abs(g - b) <= tolerance &&
      Math.abs(r - b) <= tolerance
    ) {
      gray++;
    }
  }
  return gray / pixels >= fraction;
}

type SharpFn = typeof import("sharp");
async function loadSharp(): Promise<SharpFn> {
  const mod = (await import("sharp")) as unknown as { default?: SharpFn };
  return (mod.default ?? mod) as SharpFn;
}

/**
 * Does this image already look like a depth map? Single-channel (or
 * gray+alpha) files, or RGB whose channels match everywhere. Decode errors
 * count as "no" so the estimator stays in (the safe default).
 */
export async function looksLikeDepthMap(buffer: Buffer): Promise<boolean> {
  try {
    const sharp = await loadSharp();
    const meta = await sharp(buffer).metadata();
    if (meta.channels === 1 || meta.space === "b-w") return true;
    if (meta.channels === 2 && meta.hasAlpha) return true;
    const { data, info } = await sharp(buffer)
      .removeAlpha()
      .resize(64, 64, { fit: "inside" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return isGrayscalePixels(data, info.channels);
  } catch {
    return false;
  }
}

function truthyFlag(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  const s = String(v).trim().toLowerCase();
  return !["false", "0", "no", "off"].includes(s);
}

/**
 * Point the Krea 2 control graph at an uploaded control image and decide
 * whether depth is estimated: skipped when `markedDepth` (--cn-depthmap) or
 * the image already looks like a depth map. Mutates `workflow`.
 */
export function wireKrea2ControlImage(
  workflow: Workflow,
  imageName: string,
  opts: { markedDepth?: unknown; looksDepth?: boolean },
): { estimateDepth: boolean } {
  const loaderId = krea2ControlImageLoaderId(workflow);
  if (!loaderId)
    throw new Error("Krea 2 control graph has no control LoadImage");
  workflow[loaderId].inputs.image = imageName;
  const skip = truthyFlag(opts.markedDepth) || opts.looksDepth === true;
  if (skip) bypassKrea2DepthEstimator(workflow);
  return { estimateDepth: hasKrea2DepthEstimator(workflow) };
}

/** --cn-strength drives the control LoRA strength (default 1.0 in the pack). */
export function applyKrea2ControlStrength(
  workflow: Workflow,
  strength: unknown,
): void {
  const n = typeof strength === "number" ? strength : Number(strength);
  if (strength === undefined || strength === null || !Number.isFinite(n))
    return;
  const id = findClass(workflow, "Krea2ControlLoRALoader");
  if (id) workflow[id].inputs.strength = Math.max(0, Math.min(2, n));
}

/**
 * Control image source for the Krea 2 control graph: a "control" attachment
 * first, then a fetchable --cn-image URL.
 */
export function pickKrea2ControlImageUrl(
  params: Record<string, unknown>,
  attachments: ImageAttachment[] | undefined,
): string | undefined {
  const att = attachments?.find(
    (a) => a?.mode === "control" && isFetchableImageUrl(a.url),
  );
  if (att) return att.url;
  const cn = params["cn-image"];
  return isFetchableImageUrl(cn) ? cn : undefined;
}

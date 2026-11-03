/**
 * Full-resolution paste-back for image edits (CJImagePasteBack, our
 * comfy_nodes/cj_h3_tools/cj_image_pasteback.py).
 *
 * Instruction-edit models re-render every pixel at ~1 MP: faces drift and
 * untouched areas soften. Paste-back warps the edit onto the ORIGINAL photo at
 * its own resolution and keeps original pixels outside the edit. Masks:
 *
 *   region      = SAM3 "<area>" on the original (what the user asked to change)
 *   protect     = SAM3 "face" on the original (faces stay unless the area covers them)
 *   pose change (edits that move a body, e.g. "lower his arm"):
 *   subject     = SAM3 "person" on the original (whole body taken from the edit)
 *   new_content = SAM3 "person" on the edited image
 *
 * Request (action params):
 *   pasteBack      on/off (FIBO edit defaults on; generic edits only when asked)
 *   pasteBackArea  SAM3 text; "" = diff-only: the region SAM node is pruned and
 *                  the node keeps changed blobs >= min_blob of the frame
 *   pasteBackPose  on = wire subject + new_content (default off)
 *   pasteBackMasks up to 2 uploaded user masks ("name.png [input]", white =
 *                  subject; Smart select or brush). They replace the SAM3
 *                  region (and pose) and turn paste-back on. Each mask gets
 *                  its OWN paste-back pass, hard-clamped to that mask
 *                  (ImageCompositeMasked over GrowMask; the margin covers
 *                  the pass's grow + feather, pasteBackClampGrow) and
 *                  chained after the
 *                  previous one: the refine never leaves its mask, and two
 *                  replaced subjects never share a pass, so faces never mix.
 *   off           the chain is removed; SaveImage gets the raw edit
 * Face protect stays in every mode.
 *
 * Two entry points share one configure step:
 *   - configurePasteBack: graphs that ship the full chain (packs/fibo2/edit*.json)
 *   - addImagePasteBack:  appends the chain to any edit graph (FLUX.3, Qwen 2.1,
 *                         Krea 2 edit / remove object), then configures it.
 */
import type { Workflow } from "@/types";
import { isSafeInputRef } from "@/lib/tools/smartMask";

export const PASTEBACK_CLASS = "CJImagePasteBack";
export const SAM3_CHECKPOINT = "sam3.1_multiplex_fp16.safetensors";
export const PROTECT_TEXT = "face";
export const POSE_SUBJECT_TEXT = "person";

export type PasteBackFit = "crop" | "stretch";

/** Max user masks (MaskPainter has two subjects). */
export const PASTEBACK_MAX_MASKS = 2;
/**
 * Long side the clamp copy of each user mask is normalized to on the server
 * (ImageScaleToMaxDimension), whatever size the browser exported it at; the
 * clamp margin math below is in these normalized pixels.
 */
export const PASTEBACK_MASK_MAX_SIDE = 1024;
/** CJImagePasteBack tunes grow_px / feather_px at an 880 px short side. */
export const PASTEBACK_KNOB_SHORT_SIDE = 880;
const DEFAULT_GROW_PX = 12;
const DEFAULT_FEATHER_PX = 6;

/**
 * Clamp margin (GrowMask expand, in normalized mask pixels) that reaches past
 * everything a paste-back pass can blend.
 *
 * A pass's alpha = GaussianBlur(dilate(region, grow * px), sigma = feather * px)
 * with px = imageShort / 880, so it is ~0 (< 0.2 %) beyond grow + 3 * feather
 * knob units. The clamp mask has long side PASTEBACK_MASK_MAX_SIDE, so one
 * image pixel is 1024 / imageLong mask pixels and that reach, in mask pixels,
 * is (grow + 3 * feather) * imageShort / 880 * 1024 / imageLong
 *   = (grow + 3 * feather) * maskShort / 880  <=  (grow + 3 * feather) * 1024 / 880,
 * with equality for a square image (the worst case). +1 covers the bilinear
 * resample of the mask to the source size. A clamp tighter than this cuts the
 * pass's feather where its alpha is still high and leaves a hard seam.
 */
export function pasteBackClampGrow(
  growPx: number = DEFAULT_GROW_PX,
  featherPx: number = DEFAULT_FEATHER_PX,
): number {
  const g = Number.isFinite(growPx) && growPx > 0 ? growPx : 0;
  const f = Number.isFinite(featherPx) && featherPx > 0 ? featherPx : 0;
  return (
    Math.ceil(
      ((g + 3 * f) * PASTEBACK_MASK_MAX_SIDE) / PASTEBACK_KNOB_SHORT_SIDE,
    ) + 1
  );
}

/** Clamp margin for the default pass knobs (grow 12, feather 6) = 36. */
export const PASTEBACK_MASK_CLAMP_GROW = pasteBackClampGrow();

export interface PasteBackRequest {
  enabled: boolean;
  /** SAM3 text for the edit region; "" = diff-only. */
  area: string;
  /** Pose change: take the whole person from the edit (face still protected). */
  pose: boolean;
  /** User masks (annotated input refs), one paste-back pass each. */
  masks?: string[];
}

/**
 * Validate params.pasteBackMasks: safe annotated input refs only (a data URL
 * or path never reaches the graph), de-duplicated, at most
 * PASTEBACK_MAX_MASKS. Anything else is dropped.
 */
export function pasteBackMasks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (!isSafeInputRef(v) || out.includes(v)) continue;
    out.push(v);
    if (out.length === PASTEBACK_MAX_MASKS) break;
  }
  return out;
}

type Link = [string, number];

function isLink(v: unknown): v is Link {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === "string" &&
    typeof v[1] === "number"
  );
}

function truthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string")
    return ["on", "true", "1", "yes"].includes(v.trim().toLowerCase());
  return v === 1;
}

/**
 * Read the paste-back request from action params. `defaultOn` applies when
 * params.pasteBack is absent (FIBO 2.0 edit defaults on; the generic edit
 * actions only paste back when the client asks).
 */
export function pasteBackRequest(
  params: Record<string, unknown>,
  defaultOn: boolean,
): PasteBackRequest {
  const raw = params.pasteBack;
  const masks = pasteBackMasks(params.pasteBackMasks);
  // A user mask means "limit the edit to this": always paste back.
  const enabled =
    masks.length > 0 ||
    (raw === undefined || raw === null ? defaultOn : truthy(raw));
  const area =
    typeof params.pasteBackArea === "string"
      ? params.pasteBackArea.trim().slice(0, 200)
      : "";
  const req: PasteBackRequest = {
    enabled,
    area,
    pose: truthy(params.pasteBackPose),
  };
  if (masks.length) req.masks = masks;
  return req;
}

function nodeIdsOf(workflow: Workflow, classType: string): string[] {
  return Object.keys(workflow).filter(
    (id) => workflow[id].class_type === classType,
  );
}

function referenced(workflow: Workflow, id: string): boolean {
  for (const node of Object.values(workflow)) {
    for (const v of Object.values(node.inputs ?? {})) {
      if (isLink(v) && v[0] === id) return true;
    }
  }
  return false;
}

const OUTPUT_CLASSES = new Set(["SaveImage", "PreviewImage"]);

/**
 * Delete candidate nodes (and, transitively, their now-orphaned upstream
 * nodes) that nothing references any more. Output nodes are never pruned.
 */
function pruneOrphans(workflow: Workflow, candidates: string[]): void {
  const queue = [...candidates];
  while (queue.length) {
    const id = queue.shift()!;
    const node = workflow[id];
    if (!node || OUTPUT_CLASSES.has(node.class_type)) continue;
    if (referenced(workflow, id)) continue;
    const upstream = Object.values(node.inputs ?? {})
      .filter(isLink)
      .map((l) => l[0]);
    delete workflow[id];
    queue.push(...upstream);
  }
}

function dropInput(workflow: Workflow, nodeId: string, input: string): void {
  const v = workflow[nodeId]?.inputs?.[input];
  if (v === undefined) return;
  delete workflow[nodeId].inputs[input];
  if (isLink(v)) pruneOrphans(workflow, [v[0]]);
}

/** CLIPTextEncode feeding a SAM3_Detect's conditioning (its text prompt). */
function samTextNode(workflow: Workflow, samId: string): string | undefined {
  const cond = workflow[samId]?.inputs?.conditioning;
  return isLink(cond) && workflow[cond[0]]?.class_type === "CLIPTextEncode"
    ? cond[0]
    : undefined;
}

/**
 * Apply a paste-back request to a graph that already contains the chain.
 * Returns the CJImagePasteBack node id, or null when it was removed / absent.
 */
export function configurePasteBack(
  workflow: Workflow,
  req: PasteBackRequest,
): string | null {
  const pbId = nodeIdsOf(workflow, PASTEBACK_CLASS)[0];
  if (!pbId) return null;
  const pb = workflow[pbId];

  if (!req.enabled) {
    const edited = pb.inputs.edited;
    if (!isLink(edited))
      throw new Error(`${PASTEBACK_CLASS} ${pbId} has no edited input`);
    for (const node of Object.values(workflow)) {
      for (const [k, v] of Object.entries(node.inputs ?? {})) {
        if (isLink(v) && v[0] === pbId) node.inputs[k] = [...edited];
      }
    }
    pruneOrphans(workflow, [pbId]);
    return null;
  }

  if (req.masks?.length) {
    applyMaskedPasses(workflow, pbId, req.masks);
    return pbId;
  }

  if (!req.pose) {
    dropInput(workflow, pbId, "subject");
    dropInput(workflow, pbId, "new_content");
  }

  if (!req.area) {
    // Diff-only: no region; protect (faces) stays.
    dropInput(workflow, pbId, "region");
  } else {
    const link = pb.inputs.region;
    const textId = isLink(link) ? samTextNode(workflow, link[0]) : undefined;
    if (textId) workflow[textId].inputs.text = req.area;
  }
  return pbId;
}

/**
 * User-mask paste-back: the SAM3 region / pose inputs are replaced by one pass
 * per mask. Pass k pastes the edit onto the previous pass's result with
 * region = mask k, then ImageCompositeMasked(destination = previous, source =
 * pass k, mask = GrowMask(mask k at a 1024 long side)) clamps it, so nothing
 * outside that mask's neighbourhood changes whatever the diff blobs say. The
 * margin (pasteBackClampGrow) covers the pass's grow + feather, so the clamp
 * edge falls where the pass alpha is already ~0 (no seam; reach is 0 so
 * changed blobs outside the mask are clipped to it, not cut by the clamp). Face protect still applies inside each
 * pass (faces the mask does not cover stay original). Every consumer of the
 * paste-back image is rewired to the last clamp.
 */
function applyMaskedPasses(
  workflow: Workflow,
  pbId: string,
  masks: string[],
): void {
  const pb = workflow[pbId];
  const original = pb.inputs.original;
  if (!isLink(original))
    throw new Error(`${PASTEBACK_CLASS} ${pbId} has no original input`);
  const consumers: [string, string][] = [];
  for (const [id, node] of Object.entries(workflow)) {
    for (const [k, v] of Object.entries(node.inputs ?? {})) {
      if (isLink(v) && v[0] === pbId && v[1] === 0) consumers.push([id, k]);
    }
  }
  dropInput(workflow, pbId, "region");
  dropInput(workflow, pbId, "subject");
  dropInput(workflow, pbId, "new_content");
  // reach 0 + strict: a changed blob that spills out of the mask (the edit
  // model recoloured a passer-by too) is clipped to it before grow + feather,
  // so the pass alpha is ~0 where the hard clamp edge falls. With the default
  // reach it was kept up to the clamp and cut there (a half-recoloured coat).
  pb.inputs.reach = 0;
  pb.inputs.strict = true;

  const knob = (v: unknown, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : d;
  const margin = pasteBackClampGrow(
    knob(pb.inputs.grow_px, DEFAULT_GROW_PX),
    knob(pb.inputs.feather_px, DEFAULT_FEATHER_PX),
  );
  const id = nextIdFrom(workflow, 950);
  let base: Link = [original[0], original[1]];
  masks.forEach((ref, k) => {
    const load = id();
    const asImage = id();
    const scaled = id();
    const norm = id();
    const grow = id();
    const clamp = id();
    const pass = k === 0 ? pbId : id();
    if (k > 0) {
      workflow[pass] = {
        class_type: PASTEBACK_CLASS,
        inputs: { ...structuredClone(pb.inputs), original: base },
        _meta: { title: `Paste edit back: subject ${k + 1}` },
      } as Workflow[string];
    }
    workflow[pass].inputs.region = [load, 0];
    Object.assign(workflow, {
      [load]: {
        class_type: "LoadImageMask",
        inputs: { image: ref, channel: "red" },
        _meta: { title: `Subject ${k + 1} mask` },
      },
      // Normalize the clamp copy to a 1024 long side so the margin math holds
      // for any uploaded mask size (the pass itself reads the raw mask).
      [asImage]: {
        class_type: "MaskToImage",
        inputs: { mask: [load, 0] },
        _meta: { title: `Subject ${k + 1} mask (image)` },
      },
      [scaled]: {
        class_type: "ImageScaleToMaxDimension",
        inputs: {
          image: [asImage, 0],
          upscale_method: "bilinear",
          largest_size: PASTEBACK_MASK_MAX_SIDE,
        },
        _meta: { title: `Subject ${k + 1} mask at clamp size` },
      },
      [norm]: {
        class_type: "ImageToMask",
        inputs: { image: [scaled, 0], channel: "red" },
        _meta: { title: `Subject ${k + 1} clamp mask` },
      },
      [grow]: {
        class_type: "GrowMask",
        inputs: {
          mask: [norm, 0],
          expand: margin,
          tapered_corners: true,
        },
        _meta: { title: `Subject ${k + 1} clamp margin` },
      },
      [clamp]: {
        class_type: "ImageCompositeMasked",
        inputs: {
          destination: base,
          source: [pass, 0],
          x: 0,
          y: 0,
          resize_source: false,
          mask: [grow, 0],
        },
        _meta: { title: `Keep subject ${k + 1} edit inside its mask` },
      },
    } as unknown as Workflow);
    base = [clamp, 0];
  });
  for (const [nodeId, input] of consumers)
    workflow[nodeId].inputs[input] = [base[0], base[1]];
}

function nextIdFrom(workflow: Workflow, floor: number): () => string {
  let n = Math.max(
    floor,
    ...Object.keys(workflow)
      .map((k) => Number(k))
      .filter((k) => Number.isInteger(k))
      .map((k) => k + 1),
  );
  return () => String(n++);
}

/**
 * Append SAM3 masks + CJImagePasteBack between the edit graph's decoded
 * image and its SaveImage, pasting onto `originalId` (the source LoadImage),
 * then apply `req`. Returns the paste-back node id, or null when disabled.
 */
export function addImagePasteBack(
  workflow: Workflow,
  opts: { originalId: string; fit: PasteBackFit } & PasteBackRequest,
): string | null {
  if (!opts.enabled) return null;
  if (nodeIdsOf(workflow, PASTEBACK_CLASS).length)
    return configurePasteBack(workflow, opts);
  if (workflow[opts.originalId]?.class_type !== "LoadImage")
    throw new Error(`paste-back: ${opts.originalId} is not a LoadImage`);
  const saveId = nodeIdsOf(workflow, "SaveImage").find((id) =>
    isLink(workflow[id].inputs.images),
  );
  if (!saveId) throw new Error("paste-back: graph has no SaveImage");
  const edited = workflow[saveId].inputs.images as Link;
  const original: Link = [opts.originalId, 0];

  const id = nextIdFrom(workflow, 900);
  const sam = id();
  const areaText = id();
  const region = id();
  const faceText = id();
  const protect = id();
  const personText = id();
  const subject = id();
  const newContent = id();
  const pb = id();
  const detect = (image: Link, text: string, title: string) => ({
    class_type: "SAM3_Detect",
    inputs: {
      model: [sam, 0],
      image,
      conditioning: [text, 0],
      threshold: 0.3,
      refine_iterations: 2,
      individual_masks: false,
    },
    _meta: { title },
  });
  const encode = (text: string, title: string) => ({
    class_type: "CLIPTextEncode",
    inputs: { clip: [sam, 1], text },
    _meta: { title },
  });
  Object.assign(workflow, {
    [sam]: {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: SAM3_CHECKPOINT },
      _meta: { title: "SAM3 (paste-back masks)" },
    },
    [areaText]: encode(opts.area || "object", "Area to change"),
    [region]: detect(original, areaText, "Region (original)"),
    [faceText]: encode(PROTECT_TEXT, "Protect text"),
    [protect]: detect(original, faceText, "Protect faces"),
    [personText]: encode(POSE_SUBJECT_TEXT, "Pose subject text"),
    [subject]: detect(original, personText, "Pose: person on the original"),
    [newContent]: detect(edited, personText, "Pose: person on the edit"),
    [pb]: {
      class_type: PASTEBACK_CLASS,
      inputs: {
        original,
        edited,
        region: [region, 0],
        new_content: [newContent, 0],
        protect: [protect, 0],
        subject: [subject, 0],
        fit: opts.fit,
        diff_thresh: 22.0,
        reach: 0.18,
        grow_px: 12,
        feather_px: 6,
        min_blob: 0.001,
        color_match: true,
      },
      _meta: { title: "Paste edit back (full res)" },
    },
  } as unknown as Workflow);
  workflow[saveId].inputs.images = [pb, 0];
  return configurePasteBack(workflow, opts);
}

/**
 * Masked catalog tools (Inpaint, AnyPaint same-canvas, Remove box, Doodle):
 * their graphs re-render the WHOLE frame at ~1 MP from a prepped copy of the
 * photo (region blacked out / boxed / scribbled). Paste the result back onto
 * the untouched original at its own resolution, limited to the user's mask:
 *
 *   clamp on  (inpaint / remove box / anypaint): one masked pass, hard-clamped
 *             to the mask + the blend margin (nothing outside ever changes)
 *   clamp off (doodle): the strokes are the region; a sketched object may
 *             reach past them, so changed blobs near the strokes are kept
 *             (CJImagePasteBack reach) without the hard clamp.
 *
 * `originalRef` is the source's annotated ref (before any prep), `maskRef`
 * an uploaded input ref; the mask is white = edited, any size (resampled to
 * the original).
 * Returns the paste-back node id.
 */
export function addMaskPasteBack(
  workflow: Workflow,
  opts: {
    originalRef: string;
    maskRef: string;
    fit: PasteBackFit;
    clamp: boolean;
  },
): string {
  // originalRef was validated by the caller (parseComfyRef: input / output /
  // temp); the mask is always one we uploaded (an input ref).
  if (!opts.originalRef.trim() || !isSafeInputRef(opts.maskRef))
    throw new Error("paste-back: needs the original and an input mask ref");
  const id = nextIdFrom(workflow, 880);
  const orig = id();
  workflow[orig] = {
    class_type: "LoadImage",
    inputs: { image: opts.originalRef, upload: "image" },
    _meta: { title: "Original photo (paste-back)" },
  } as Workflow[string];
  const pbId = addImagePasteBack(workflow, {
    enabled: true,
    area: opts.clamp ? "" : "object",
    pose: false,
    ...(opts.clamp ? { masks: [opts.maskRef] } : {}),
    originalId: orig,
    fit: opts.fit,
  });
  if (!pbId) throw new Error("paste-back: chain was not added");
  if (!opts.clamp) {
    // Region = the strokes (not a SAM text): swap the SAM region for the mask.
    const mask = nextIdFrom(workflow, 980)();
    workflow[mask] = {
      class_type: "LoadImageMask",
      inputs: { image: opts.maskRef, channel: "red" },
      _meta: { title: "Edit region (your mask)" },
    } as Workflow[string];
    const old = workflow[pbId].inputs.region;
    workflow[pbId].inputs.region = [mask, 0];
    if (isLink(old)) pruneOrphans(workflow, [old[0]]);
  }
  return pbId;
}

/**
 * How each generic edit action's output maps onto its source: Krea 2 edit
 * encoders centre-crop the source to the latent's aspect then resize (crop);
 * FLUX.3 / Qwen-Image resize the whole source (stretch).
 */
export function pasteBackFitFor(action: string): PasteBackFit {
  return /^edit_(instruct|structural|ostris|inpaint|depth)/.test(action)
    ? "crop"
    : "stretch";
}

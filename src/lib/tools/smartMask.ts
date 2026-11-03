/**
 * Smart select (click-to-mask) for image tools: a pure ComfyUI prompt-graph
 * builder around core SAM3 (comfy_extras.nodes_sam3). Clicks arrive in
 * natural image pixels; SAM3_Detect wants them as a JSON *string* of integer
 * {x,y} objects. The mask is previewed (temp dir) instead of saved, so
 * repeated clicks never pile files into ComfyUI's output folder.
 *
 * Used by POST /api/tools/smart-mask. No I/O here — unit-tested directly.
 */
import type { Workflow } from "@/types";

export interface SmartPoint {
  x: number;
  y: number;
}

export interface SmartMaskInput {
  /** LoadImage ref: "name.png", "sub/name.png" or annotated "name.png [input]". */
  image: string;
  include: SmartPoint[];
  exclude?: SmartPoint[];
  /** Natural image size; when given, points are clamped inside it. */
  width?: number;
  height?: number;
  threshold?: number;
}

export const SMART_MASK_CHECKPOINT = "sam3.1_multiplex_fp16.safetensors";
export const SMART_MASK_MAX_POINTS = 32;
export const SMART_MASK_DEFAULT_THRESHOLD = 0.5;
/** Node id of the PreviewImage carrying the mask (read back from history). */
export const SMART_MASK_OUTPUT_NODE = "5";

export class SmartMaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmartMaskError";
  }
}

/** Plain basename/subfolder, safe chars, image extension, optional " [input]". */
const INPUT_REF =
  /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}\/)?[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\.(?:png|jpe?g|webp)(?: \[input\])?$/i;

export function isSafeInputRef(ref: unknown): ref is string {
  return typeof ref === "string" && INPUT_REF.test(ref) && !ref.includes("..");
}

function finiteDim(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 1
    ? Math.floor(v)
    : undefined;
}

/**
 * Validate, round to ints and clamp a point list. Non-finite / non-object
 * entries throw (a client bug, not something to silently drop).
 */
export function normalizePoints(
  raw: unknown,
  label: string,
  width?: number,
  height?: number,
): SmartPoint[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw))
    throw new SmartMaskError(`${label} must be an array`);
  if (raw.length > SMART_MASK_MAX_POINTS) {
    throw new SmartMaskError(
      `too many ${label} points (max ${SMART_MASK_MAX_POINTS})`,
    );
  }
  const w = finiteDim(width);
  const h = finiteDim(height);
  return raw.map((p, i) => {
    const pt = p as Partial<SmartPoint> | null;
    if (
      !pt ||
      typeof pt.x !== "number" ||
      typeof pt.y !== "number" ||
      !Number.isFinite(pt.x) ||
      !Number.isFinite(pt.y)
    ) {
      throw new SmartMaskError(`${label}[${i}] must be {x, y} numbers`);
    }
    let x = Math.max(0, Math.round(pt.x));
    let y = Math.max(0, Math.round(pt.y));
    if (w !== undefined) x = Math.min(w - 1, x);
    if (h !== undefined) y = Math.min(h - 1, y);
    return { x, y };
  });
}

export function buildSmartMaskWorkflow(input: SmartMaskInput): Workflow {
  if (!isSafeInputRef(input.image)) {
    throw new SmartMaskError("invalid image reference");
  }
  const include = normalizePoints(
    input.include,
    "include",
    input.width,
    input.height,
  );
  if (include.length === 0) {
    throw new SmartMaskError("at least one include point is required");
  }
  const exclude = normalizePoints(
    input.exclude,
    "exclude",
    input.width,
    input.height,
  );
  const t = input.threshold;
  const threshold =
    typeof t === "number" && Number.isFinite(t)
      ? Math.min(0.99, Math.max(0.01, t))
      : SMART_MASK_DEFAULT_THRESHOLD;

  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: SMART_MASK_CHECKPOINT },
    },
    "2": { class_type: "LoadImage", inputs: { image: input.image } },
    "3": {
      class_type: "SAM3_Detect",
      inputs: {
        model: ["1", 0],
        image: ["2", 0],
        threshold,
        refine_iterations: 2,
        individual_masks: false,
        positive_coords: JSON.stringify(include),
        negative_coords: JSON.stringify(exclude),
      },
    },
    "4": { class_type: "MaskToImage", inputs: { mask: ["3", 0] } },
    [SMART_MASK_OUTPUT_NODE]: {
      class_type: "PreviewImage",
      inputs: { images: ["4", 0] },
    },
  } as unknown as Workflow;
}

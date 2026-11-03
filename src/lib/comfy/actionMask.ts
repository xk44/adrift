/**
 * Mask plumbing for /api/jobs/action graphs (e.g. krea2-edit `edit_inpaint`).
 *
 * A graph "needs a mask" when it has a mask loader slot: a `LoadImageMask`
 * node, or a `LoadImage` whose title names it a mask. The caller sends the
 * mask in the same formats the edit-tool route and the editor/MaskPainter
 * already produce:
 *   - `data:image/png|jpeg|webp;base64,...` — normalized here to a binary
 *     white-on-black PNG (white = regenerate) and uploaded to ComfyUI;
 *   - an annotated ComfyUI ref ("sub/name.png [input]") from /api/comfy/upload,
 *     used as-is.
 *
 * Normalization accepts both painter conventions: opaque white-on-black
 * (MaskPainter) and colored strokes on a transparent canvas (editor paint
 * tool, red on alpha). A pixel is "on" when it is opaque enough AND bright in
 * any channel, so LoadImageMask's `channel: "red"` reads it correctly either
 * way. Size is left alone: CropAndStitch rescales a mismatched mask itself.
 */
import type { Workflow } from "@/types";
import { parseComfyRef, formatComfyRef } from "@/lib/tools/editTools";

/** Decoded mask bytes cap (matches /api/jobs/tool). */
export const MAX_ACTION_MASK_BYTES = 16 * 1024 * 1024;

/** Upper bound for the grow/feather pixel params. */
export const MAX_MASK_GROW_PX = 256;

export class ActionMaskError extends Error {
  constructor(
    message: string,
    readonly code: "mask_required" | "mask_unsupported" | "invalid_mask",
  ) {
    super(message);
    this.name = "ActionMaskError";
  }
}

const MASK_TITLE = /\bmask\b/i;

/** Node ids that load a user mask (LoadImageMask, or LoadImage titled "...mask..."). */
export function findMaskSlotIds(workflow: Workflow): string[] {
  const ids: string[] = [];
  for (const [id, node] of Object.entries(workflow)) {
    if (!node || typeof node !== "object") continue;
    if (node.class_type === "LoadImageMask") {
      ids.push(id);
    } else if (
      node.class_type === "LoadImage" &&
      MASK_TITLE.test(node._meta?.title ?? "")
    ) {
      ids.push(id);
    }
  }
  return ids;
}

export type ParsedActionMask =
  { kind: "data"; bytes: Buffer } | { kind: "ref"; ref: string };

/** Validate a mask body field (data URL or annotated ComfyUI ref). */
export function parseActionMask(mask: unknown): ParsedActionMask {
  if (typeof mask !== "string" || !mask.trim()) {
    throw new ActionMaskError(
      "mask must be a data: URL or an annotated ComfyUI ref",
      "invalid_mask",
    );
  }
  const raw = mask.trim();
  if (raw.startsWith("data:")) {
    const m = /^data:image\/(?:png|jpeg|jpg|webp);base64,([\s\S]+)$/.exec(raw);
    if (!m) {
      throw new ActionMaskError(
        "mask data URL must be data:image/png|jpeg|webp;base64,...",
        "invalid_mask",
      );
    }
    const bytes = Buffer.from(m[1], "base64");
    if (bytes.length === 0 || bytes.length > MAX_ACTION_MASK_BYTES) {
      throw new ActionMaskError("mask is empty or too large", "invalid_mask");
    }
    return { kind: "data", bytes };
  }
  const ref = parseComfyRef(raw);
  if (!ref) {
    throw new ActionMaskError(
      'mask must be a data: URL or an annotated ComfyUI ref ("mask.png [input]")',
      "invalid_mask",
    );
  }
  return { kind: "ref", ref: formatComfyRef(ref) };
}

/** Pure: RGBA -> binary RGB (255 = masked). on = alpha >= 128 && max(r,g,b) >= 128. */
export function rgbaToBinaryMask(rgba: Uint8Array): {
  rgb: Buffer;
  painted: number;
} {
  const px = Math.floor(rgba.length / 4);
  const rgb = Buffer.alloc(px * 3);
  let painted = 0;
  for (let i = 0; i < px; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    const on = a >= 128 && Math.max(r, g, b) >= 128;
    if (on) {
      painted++;
      rgb[i * 3] = 255;
      rgb[i * 3 + 1] = 255;
      rgb[i * 3 + 2] = 255;
    }
  }
  return { rgb, painted };
}

type SharpFn = typeof import("sharp");

async function loadSharp(): Promise<SharpFn> {
  const mod = (await import("sharp")) as unknown as { default?: SharpFn };
  return (mod.default ?? (mod as unknown as SharpFn)) as SharpFn;
}

/** Decode any painter mask to a binary white-on-black PNG; empty -> error. */
export async function normalizeActionMask(
  bytes: Uint8Array,
): Promise<{ png: Buffer; width: number; height: number }> {
  const sharp = await loadSharp();
  let decoded: { data: Buffer; info: { width: number; height: number } };
  try {
    decoded = await sharp(Buffer.from(bytes))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new ActionMaskError(
      "mask image could not be decoded",
      "invalid_mask",
    );
  }
  const { width, height } = decoded.info;
  const { rgb, painted } = rgbaToBinaryMask(decoded.data);
  if (painted === 0) {
    throw new ActionMaskError(
      "Mask is empty: paint the area to regenerate",
      "invalid_mask",
    );
  }
  const png = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  return { png, width, height };
}

/**
 * Check mask presence against the graph before anything is uploaded.
 * Returns the mask slot ids (empty when the graph takes no mask).
 */
export function checkActionMask(workflow: Workflow, mask: unknown): string[] {
  const slots = findMaskSlotIds(workflow);
  const supplied = mask !== undefined && mask !== null && mask !== "";
  if (slots.length > 0 && !supplied) {
    throw new ActionMaskError(
      "This edit needs a mask: paint the area to regenerate and try again",
      "mask_required",
    );
  }
  if (slots.length === 0 && supplied) {
    throw new ActionMaskError(
      "This workflow has no mask input; remove the mask or pick a mask-based edit",
      "mask_unsupported",
    );
  }
  return slots;
}

/**
 * Resolve the mask to an annotated ComfyUI ref: data URLs are normalized and
 * uploaded via `upload`, refs pass through.
 */
export async function resolveActionMaskRef(
  mask: unknown,
  upload: (png: Buffer, filename: string) => Promise<string>,
  filename: string,
): Promise<string> {
  const parsed = parseActionMask(mask);
  if (parsed.kind === "ref") return parsed.ref;
  const { png } = await normalizeActionMask(parsed.bytes);
  return upload(png, filename);
}

function intParam(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(MAX_MASK_GROW_PX, Math.round(n)));
}

/**
 * Point every mask slot at `maskRef` and apply the optional grow/feather
 * params (`maskExpand` / `maskBlend`, pixels) to mask-processing nodes:
 * CropAndStitch `InpaintCropImproved.mask_expand_pixels|mask_blend_pixels`
 * and core `GrowMask.expand`.
 */
export function applyActionMask(
  workflow: Workflow,
  slotIds: string[],
  maskRef: string,
  params: Record<string, unknown> = {},
): void {
  for (const id of slotIds) {
    const node = workflow[id];
    if (!node) continue;
    node.inputs = { ...(node.inputs ?? {}), image: maskRef };
  }
  const expand = intParam(params.maskExpand);
  const blend = intParam(params.maskBlend);
  for (const node of Object.values(workflow)) {
    if (!node?.inputs) continue;
    if (node.class_type === "InpaintCropImproved") {
      if (expand !== undefined) node.inputs.mask_expand_pixels = expand;
      if (blend !== undefined) node.inputs.mask_blend_pixels = blend;
    } else if (node.class_type === "GrowMask" && expand !== undefined) {
      node.inputs.expand = expand;
    }
  }
}

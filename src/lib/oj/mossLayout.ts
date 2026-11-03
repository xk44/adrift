/**
 * MOSS-Image layout prompts: positioned objects / characters / text boxes.
 *
 * MOSS-Image reads layout natively from the prompt string (no LoRA, no extra
 * node at sampling time): ComfyUI's MOSSImageLayoutPrompt node only turns
 * Create Bounding Boxes elements into a JSON caption. This is a byte-exact
 * port of that node (comfy_extras/nodes_moss_image.py +
 * nodes_bounding_boxes.py `_norm_bbox` / color_util `normalize_palette`), so
 * Adrift can build the caption server-side from plain request data:
 *
 *   {"summary":{"caption":<prompt>},"items":[{"label":"object|character|text",
 *    "caption":..., "text"?:..., "palette"?:[...], "bbox":[y0,x0,y1,x1]}],
 *    "bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}
 *
 * bbox = pixel edges enclosing the box, origin at the canvas centre.
 * Client boxes are fractions of the canvas: {x, y, w, h} in 0..1.
 */
import type { Workflow, WorkflowSlots } from "@/types";
import { isMossImageWorkflow } from "./mossImage";

export type MossLayoutKind = "object" | "character" | "text";

export interface MossLayoutBox {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: MossLayoutKind;
  caption: string;
  /** Text to render (kind "text" only). */
  text?: string;
  /** Up to 5 colours, "#RRGGBB". */
  palette?: string[];
}

export const MOSS_LAYOUT_MAX_BOXES = 16;
const MAX_CAPTION = 400;
const HEX = /^#?[0-9a-f]{6}$/i;

/** Python's round() (banker's rounding) for the 0-1000 grid snap. */
function pyRound(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (Math.abs(d - 0.5) < 1e-12) return f % 2 === 0 ? f : f + 1;
  return Math.round(v);
}

/** round(v, 9) as Python does it, close enough for grid * size / 1000. */
const round9 = (v: number) => Math.round(v * 1e9) / 1e9;

/** {x, y, w, h} fractions -> [ymin, xmin, ymax, xmax] on the 0-1000 grid. */
export function gridBox(
  box: Pick<MossLayoutBox, "x" | "y" | "w" | "h">,
): [number, number, number, number] {
  const grid = (v: number) => Math.max(0, Math.min(1000, pyRound(v * 1000)));
  let ymin = grid(box.y);
  let xmin = grid(box.x);
  let ymax = grid(box.y + box.h);
  let xmax = grid(box.x + box.w);
  if (ymin > ymax) [ymin, ymax] = [ymax, ymin];
  if (xmin > xmax) [xmin, xmax] = [xmax, xmin];
  return [ymin, xmin, ymax, xmax];
}

/** Validate request data. Returns the boxes or an error string. */
export function sanitizeMossLayout(
  raw: unknown,
): { boxes: MossLayoutBox[] } | { error: string } {
  if (raw === undefined || raw === null) return { boxes: [] };
  if (!Array.isArray(raw)) return { error: "layout_boxes must be an array" };
  if (raw.length > MOSS_LAYOUT_MAX_BOXES)
    return { error: `layout_boxes: at most ${MOSS_LAYOUT_MAX_BOXES} boxes` };
  const boxes: MossLayoutBox[] = [];
  for (const [i, b] of raw.entries()) {
    if (!b || typeof b !== "object")
      return { error: `layout_boxes[${i}] must be an object` };
    const o = b as Record<string, unknown>;
    const nums = ["x", "y", "w", "h"].map((k) => o[k]);
    if (!nums.every((n) => typeof n === "number" && Number.isFinite(n)))
      return { error: `layout_boxes[${i}]: x, y, w, h must be numbers (0-1)` };
    const [x, y, w, h] = nums as number[];
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001)
      return {
        error: `layout_boxes[${i}]: box must lie inside the 0-1 canvas`,
      };
    const kind = o.kind ?? "object";
    if (kind !== "object" && kind !== "character" && kind !== "text")
      return {
        error: `layout_boxes[${i}].kind must be object, character or text`,
      };
    const caption =
      typeof o.caption === "string"
        ? o.caption.trim().slice(0, MAX_CAPTION)
        : "";
    const text = typeof o.text === "string" ? o.text.slice(0, MAX_CAPTION) : "";
    if (kind === "text" && !text.trim())
      return { error: `layout_boxes[${i}]: text boxes need "text"` };
    if (kind !== "text" && !caption)
      return { error: `layout_boxes[${i}]: caption is required` };
    let palette: string[] | undefined;
    if (o.palette !== undefined) {
      if (
        !Array.isArray(o.palette) ||
        !o.palette.every((c) => typeof c === "string" && HEX.test(c))
      )
        return {
          error: `layout_boxes[${i}].palette must be "#RRGGBB" strings`,
        };
      palette = (o.palette as string[])
        .slice(0, 5)
        .map((c) => (c.startsWith("#") ? c : `#${c}`).toUpperCase());
      if (!palette.length) palette = undefined;
    }
    boxes.push({
      x,
      y,
      w,
      h,
      kind,
      caption,
      ...(kind === "text" ? { text } : {}),
      ...(palette ? { palette } : {}),
    });
  }
  return { boxes };
}

/** The MOSSImageLayoutPrompt output for `prompt` + boxes at width x height. */
export function buildMossLayoutPrompt(
  prompt: string,
  boxes: MossLayoutBox[],
  width: number,
  height: number,
): string {
  if (!boxes.length) return prompt;
  const hh = Math.floor(height / 2);
  const hw = Math.floor(width / 2);
  const items = boxes.map((b) => {
    const [y0, x0, y1, x1] = gridBox(b);
    const item: Record<string, unknown> = { label: b.kind, caption: b.caption };
    if (b.kind === "text") item.text = b.text ?? "";
    if (b.palette?.length) item.palette = b.palette;
    item.bbox = [
      Math.floor(round9((y0 * height) / 1000)) - hh,
      Math.floor(round9((x0 * width) / 1000)) - hw,
      Math.ceil(round9((y1 * height) / 1000)) - hh,
      Math.ceil(round9((x1 * width) / 1000)) - hw,
    ];
    return item;
  });
  return JSON.stringify({
    summary: { caption: prompt.trim() },
    items,
    bbox_coord_space: "abs_centralized",
    bbox_format: "yxyx",
  });
}

/** Output canvas of a MOSS t2i graph (EmptyFlux2LatentImage), else null. */
export function mossLayoutCanvas(
  workflow: Workflow,
): { width: number; height: number } | null {
  if (!isMossImageWorkflow(workflow)) return null;
  const latent = Object.values(workflow).find(
    (n) => n.class_type === "EmptyFlux2LatentImage",
  );
  const w = Number(latent?.inputs?.width);
  const h = Number(latent?.inputs?.height);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
    ? { width: w, height: h }
    : null;
}

/**
 * Replace the positive prompt with the layout JSON when `params.mossLayout`
 * holds boxes and the graph is MOSS t2i. Call after dims are injected.
 */
export function applyMossLayout(
  workflow: Workflow,
  slots: WorkflowSlots,
  params: Record<string, unknown>,
  prompt: string,
): boolean {
  const raw = params.mossLayout;
  if (!Array.isArray(raw) || !raw.length) return false;
  const canvas = mossLayoutCanvas(workflow);
  if (!canvas) return false;
  const parsed = sanitizeMossLayout(raw);
  if ("error" in parsed || !parsed.boxes.length) return false;
  const node = workflow[slots.posTextId];
  if (!node) return false;
  (node.inputs as Record<string, unknown>)[slots.posTextInputName ?? "text"] =
    buildMossLayoutPrompt(prompt, parsed.boxes, canvas.width, canvas.height);
  return true;
}

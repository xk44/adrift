/**
 * Lightbox "Quick edit": the pure half.
 *
 * The overlay (components/QuickEditOverlay.tsx) paints a mask on a canvas whose
 * backing store is the SOURCE resolution while its CSS box is the displayed
 * (object-contain) size. Everything here is DOM-free so it can be unit-tested:
 *
 *   - geometry: contain-fit, display -> source point / brush scaling
 *   - brush: size clamps and the [ / ] steps
 *   - mask history: stroke / invert ops with undo + clear (re-rasterized by the
 *     overlay, so undo never keeps full-resolution bitmaps around)
 *   - stroke rasterization params (composite op, line width, caps)
 *   - Expand presets -> tool settings and the padding they add
 *   - which existing tool a mode runs through (planQuickEdit)
 *
 * Submission reuses the Tools page / Edit page paths (lib/tools/runTool.ts,
 * hooks/useInpaint.ts); nothing here talks to the network.
 *
 * Design rule: refinement stays inside the mask. Remove (mode "erase") goes
 * through the remove_object region-mask path (one paste-back pass clamped to
 * the mask) when it can, and Inpaint only picks graphs that keep unpainted pixels.
 */

import {
  catalogUnavailableReason,
  defaultSettings,
  getActionTool,
  overlayToMaskPixels,
  pickEditLora,
  resolveOutpaintTool,
  zoomPresetSettings,
  type ActionToolSpec,
  type CatalogTool,
  type EditLoraListResponse,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import { EXPAND_KEY, toolTitle } from "@/lib/tools/toolNames";

// Modes

export type QuickEditMode = "inpaint" | "erase" | "expand" | "upscale";

export interface QuickEditModeInfo {
  id: QuickEditMode;
  /** Chip label: the tool's canonical name (lib/tools/toolNames.ts). */
  label: string;
  /** Painting a mask is required to submit. */
  needsMask: boolean;
  /** The mask canvas is shown (and painting enabled). */
  paints: boolean;
  /** A prompt field is shown; "required" blocks submit while empty. */
  prompt: "required" | "optional" | "none";
  /** Short hint under the chips. */
  hint: string;
  /** Submit button label. */
  action: string;
}

export const QUICK_EDIT_MODES: readonly QuickEditModeInfo[] = [
  {
    id: "inpaint",
    label: toolTitle("catalog:krea2-inpaint"),
    needsMask: true,
    paints: true,
    prompt: "required",
    hint: "Paint the area to change, then say what goes there.",
    action: "Repaint",
  },
  {
    id: "erase",
    label: toolTitle("action:remove_object"),
    needsMask: true,
    paints: true,
    prompt: "none",
    hint: "Paint over what should disappear. The gap is filled from its surroundings.",
    // Verb matches the chip ("Object Remover"), not the internal mode id.
    action: "Remove",
  },
  {
    id: "expand",
    label: toolTitle(EXPAND_KEY),
    needsMask: false,
    paints: false,
    prompt: "optional",
    hint: "Grow the canvas and let the scene continue past the edges.",
    action: "Expand",
  },
  {
    id: "upscale",
    label: toolTitle("action:upscale"),
    needsMask: false,
    paints: false,
    prompt: "none",
    hint: "A larger, sharper copy of this image.",
    action: "Upscale",
  },
];

export function quickEditMode(id: QuickEditMode): QuickEditModeInfo {
  return QUICK_EDIT_MODES.find((m) => m.id === id) ?? QUICK_EDIT_MODES[0];
}

// Geometry

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Largest box with the source's aspect that fits inside `container`. */
export function fitContain(container: Size, source: Size): Size {
  if (
    !(container.width > 0 && container.height > 0) ||
    !(source.width > 0 && source.height > 0)
  ) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(
    container.width / source.width,
    container.height / source.height,
  );
  return {
    width: Math.max(1, Math.floor(source.width * scale)),
    height: Math.max(1, Math.floor(source.height * scale)),
  };
}

/** Source pixels per displayed pixel (per axis; equal for an exact fit). */
export function displayScale(display: Size, source: Size): Point {
  return {
    x: display.width > 0 ? source.width / display.width : 1,
    y: display.height > 0 ? source.height / display.height : 1,
  };
}

/**
 * A pointer position relative to the displayed image's top-left -> source
 * pixel coordinates, clamped to the image.
 */
export function displayToSource(pt: Point, display: Size, source: Size): Point {
  const s = displayScale(display, source);
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  return {
    x: clamp(pt.x * s.x, source.width),
    y: clamp(pt.y * s.y, source.height),
  };
}

/** Brush diameter in displayed px -> radius in source px (min 0.5). */
export function brushRadiusSource(
  diameterDisplay: number,
  display: Size,
  source: Size,
): number {
  const s = displayScale(display, source);
  return Math.max(0.5, (diameterDisplay * (s.x + s.y)) / 4);
}

// Brush size

export const BRUSH_MIN = 4;
export const BRUSH_MAX = 200;
export const BRUSH_DEFAULT = 40;
/** Multiplicative [ / ] step: small brushes move by a few px, big ones faster. */
export const BRUSH_STEP_FACTOR = 1.25;

export function clampBrush(size: number): number {
  if (!Number.isFinite(size)) return BRUSH_DEFAULT;
  return Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, Math.round(size)));
}

/** `]` grows (dir 1), `[` shrinks (dir -1); always moves at least 1 px. */
export function stepBrush(size: number, dir: 1 | -1): number {
  const cur = clampBrush(size);
  const next = dir > 0 ? cur * BRUSH_STEP_FACTOR : cur / BRUSH_STEP_FACTOR;
  const rounded = Math.round(next);
  const moved = rounded === cur ? cur + dir : rounded;
  return clampBrush(moved);
}

// Mask history (re-rasterized on change)

export interface MaskStroke {
  kind: "stroke";
  /** true = eraser (removes paint). */
  erase: boolean;
  /** Brush radius in source px. */
  radius: number;
  /** Source-px points; one point = a dot. */
  points: Point[];
}

export interface MaskInvert {
  kind: "invert";
}

export type MaskOp = MaskStroke | MaskInvert;

export function pushMaskOp(ops: readonly MaskOp[], op: MaskOp): MaskOp[] {
  if (op.kind === "stroke" && op.points.length === 0) return [...ops];
  return [...ops, op];
}

export function undoMaskOp(ops: readonly MaskOp[]): MaskOp[] {
  return ops.slice(0, -1);
}

/**
 * Cheap "could anything be painted?" check for enabling Submit: any paint
 * stroke or invert. Erasers can cancel paint, so the exported pixel count is
 * the final word (see maskFromAlpha).
 */
export function maskMaybePainted(ops: readonly MaskOp[]): boolean {
  return ops.some((op) => op.kind === "invert" || !op.erase);
}

export interface StrokeRaster {
  /** CanvasRenderingContext2D.globalCompositeOperation */
  composite: "source-over" | "destination-out";
  lineWidth: number;
  lineCap: "round";
  lineJoin: "round";
}

/** How the overlay draws one stroke on the source-resolution mask canvas. */
export function strokeRaster(op: MaskStroke): StrokeRaster {
  return {
    composite: op.erase ? "destination-out" : "source-over",
    lineWidth: op.radius * 2,
    lineCap: "round",
    lineJoin: "round",
  };
}

/**
 * Invert = fill the whole canvas with "xor": painted pixels clear, empty ones
 * fill. Exact for the opaque strokes the overlay draws.
 */
export const INVERT_COMPOSITE = "xor" as const;

/**
 * Mask canvas RGBA -> white-on-black opaque RGBA (white = edit) + painted
 * pixel count. The Tools page MaskPainter's exporter, reused as-is.
 */
export const maskFromAlpha = overlayToMaskPixels;

// Expand presets

export type ExpandPresetId = "zoom_1_5" | "zoom_2" | "to_16_9" | "to_9_16";

export type ExpandPreset =
  | { id: ExpandPresetId; label: string; kind: "zoom"; perSide: number }
  | {
      id: ExpandPresetId;
      label: string;
      kind: "aspect";
      aspect: string;
      ratio: number;
    };

/** 1.5x canvas = +25% per side; 2x = +50% per side (OUTPAINT_ZOOM_PRESETS). */
export const EXPAND_PRESETS: readonly ExpandPreset[] = [
  { id: "zoom_1_5", label: "1.5x", kind: "zoom", perSide: 0.25 },
  { id: "zoom_2", label: "2x", kind: "zoom", perSide: 0.5 },
  {
    id: "to_16_9",
    label: "16:9",
    kind: "aspect",
    aspect: "16:9",
    ratio: 16 / 9,
  },
  {
    id: "to_9_16",
    label: "9:16",
    kind: "aspect",
    aspect: "9:16",
    ratio: 9 / 16,
  },
];

export const EXPAND_DEFAULT: ExpandPresetId = "zoom_1_5";

export function expandPreset(id: ExpandPresetId): ExpandPreset {
  return EXPAND_PRESETS.find((p) => p.id === id) ?? EXPAND_PRESETS[0];
}

export interface ExpandPads {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Canvas size after padding (before the server's /16 rounding). */
  width: number;
  height: number;
}

/**
 * Padding a preset adds to a w x h image, centered. Mirrors the geometry of
 * the server planner (lib/tools/outpaint.ts planOutpaint) without its /16
 * rounding or pixel cap. Null when the preset adds nothing (already 16:9).
 */
export function expandPads(
  id: ExpandPresetId,
  width: number,
  height: number,
): ExpandPads | null {
  if (!(width > 0 && height > 0)) return null;
  const p = expandPreset(id);
  let left = 0;
  let right = 0;
  let top = 0;
  let bottom = 0;
  if (p.kind === "zoom") {
    left = right = Math.round(p.perSide * width);
    top = bottom = Math.round(p.perSide * height);
  } else {
    const current = width / height;
    if (p.ratio > current) {
      const extra = Math.max(0, Math.round(height * p.ratio) - width);
      left = Math.floor(extra / 2);
      right = extra - left;
    } else if (p.ratio < current) {
      const extra = Math.max(0, Math.round(width / p.ratio) - height);
      top = Math.floor(extra / 2);
      bottom = extra - top;
    }
  }
  if (left + right + top + bottom === 0) return null;
  return {
    left,
    right,
    top,
    bottom,
    width: width + left + right,
    height: height + top + bottom,
  };
}

/** Outpaint tool settings for a preset (catalog `outpaint` option). */
export function expandSettings(id: ExpandPresetId): Partial<ToolSettings> {
  const p = expandPreset(id);
  if (p.kind === "zoom") return zoomPresetSettings(p.perSide);
  return {
    outpaintMode: "aspect",
    outpaintAspect: p.aspect,
    outpaintAnchor: "center",
  };
}

// Which existing tool runs a mode

export type UpscaleChoice = "upscale_subtle" | "upscale_creative";

export const UPSCALE_CHOICES: { id: UpscaleChoice; label: string }[] = [
  { id: "upscale_subtle", label: "Faithful" },
  { id: "upscale_creative", label: "Creative" },
];

/**
 * Catalog inpaint tools Quick edit may use, best first. Both keep the
 * unpainted pixels (maskfill regenerates only the blacked-out region;
 * AnyPaint composites the painted area back over the original).
 */
export const INPAINT_TOOL_PREFERENCE = ["krea2-inpaint", "krea2-anypaint"];

/** Catalog fallback for Erase when no grounded edit LoRA is installed. */
export const ERASE_CATALOG_TOOL = "qwen21-remove-box";

export interface QuickEditInput {
  mode: QuickEditMode;
  prompt: string;
  /** The exported mask has painted pixels. */
  hasMask: boolean;
  expand: ExpandPresetId;
  upscale: UpscaleChoice;
  /** UpscaleModelLoader file; "" / undefined = the graph's standard model. */
  upscaleModel?: string;
}

export interface QuickEditContext {
  /** GET /api/tools (null while loading / failed). */
  catalog: CatalogTool[] | null;
  /** GET /api/krea2-edit-loras (null while loading / failed). */
  editLoras: EditLoraListResponse | null;
}

export type QuickEditPlan =
  /** submitCatalogTool (POST /api/jobs/tool); `mask` only when needsMask. */
  | { kind: "catalog"; tool: CatalogTool; settings: ToolSettings }
  /** submitActionTool (POST /api/jobs/action); region = send the mask as a paste-back subject. */
  | {
      kind: "action";
      spec: ActionToolSpec;
      settings: ToolSettings;
      region: boolean;
    }
  /** The Edit page's own inpaint path (useInpaint -> POST /api/jobs/inpaint). */
  | { kind: "inpaint"; prompt: string };

export type QuickEditPlanResult = QuickEditPlan | { error: string };

function pickInpaintTool(catalog: CatalogTool[] | null): CatalogTool | null {
  const tools = catalog ?? [];
  for (const id of INPAINT_TOOL_PREFERENCE) {
    const t = tools.find((x) => x.id === id);
    if (t?.available && t.needsMask) return t;
  }
  return null;
}

function catalogSettings(tool: CatalogTool, patch: Partial<ToolSettings>) {
  const s = defaultSettings(tool);
  // Quick edit always runs the fast path when the speed LoRA is installed.
  if (tool.speed.supported && tool.speed.available) s.fast = true;
  return { ...s, ...patch };
}

/**
 * Validate a Quick edit request and pick the existing tool that runs it.
 * Pure: the overlay turns the plan into the matching runTool / useInpaint call.
 */
export function planQuickEdit(
  input: QuickEditInput,
  ctx: QuickEditContext,
): QuickEditPlanResult {
  const prompt = input.prompt.trim();
  switch (input.mode) {
    case "inpaint": {
      if (!input.hasMask) return { error: "Paint the area to change first." };
      if (!prompt)
        return { error: "Say what should appear in the painted area." };
      const tool = pickInpaintTool(ctx.catalog);
      if (tool) {
        const s = catalogSettings(tool, { text: prompt });
        // AnyPaint: same canvas (its `expand` option would grow it).
        if (tool.options.some((o) => o.id === "expand"))
          s.picks = { ...s.picks, expand: "none" };
        return { kind: "catalog", tool, settings: s };
      }
      return { kind: "inpaint", prompt };
    }
    case "erase": {
      if (!input.hasMask) return { error: "Paint over what to erase first." };
      const spec = getActionTool("remove_object");
      if (spec && pickEditLora(spec, defaultSettings(spec), ctx.editLoras)) {
        // Empty "what to remove": the painted mask is the region.
        return {
          kind: "action",
          spec,
          settings: { ...defaultSettings(spec), text: "" },
          region: true,
        };
      }
      const box = (ctx.catalog ?? []).find((t) => t.id === ERASE_CATALOG_TOOL);
      if (box?.available)
        return {
          kind: "catalog",
          tool: box,
          settings: catalogSettings(box, {}),
        };
      if (ctx.catalog === null && ctx.editLoras === null)
        return {
          error: "Still loading the erase tools. Try again in a moment.",
        };
      return {
        error:
          "No object-remove model is installed. Add one from Tools, or use Open editor.",
      };
    }
    case "expand": {
      if (ctx.catalog === null)
        return {
          error: "Still loading the expand tools. Try again in a moment.",
        };
      const tool = resolveOutpaintTool(ctx.catalog);
      if (!tool) return { error: "No expand model is set up on this server." };
      if (!tool.available)
        return {
          error:
            catalogUnavailableReason(tool) ??
            "The expand model is not installed.",
        };
      return {
        kind: "catalog",
        tool,
        settings: catalogSettings(tool, {
          ...expandSettings(input.expand),
          text: tool.promptMode === "none" ? "" : prompt,
        }),
      };
    }
    case "upscale": {
      const spec = getActionTool("upscale");
      if (!spec) return { error: "Upscale is not available." };
      const settings = defaultSettings(spec);
      settings.picks = { ...settings.picks, mode: input.upscale };
      if (input.upscaleModel) settings.picks.upscale_model = input.upscaleModel;
      return { kind: "action", spec, settings, region: false };
    }
  }
}

/**
 * Overlay Composite: stickers, cut-outs and animated RGBA layers over a clip.
 * Pure planning (limits, frame size, placement geometry, time windows,
 * illustrated looks); the graph builder is src/lib/oj/overlayComposite.ts and
 * the executor overlayRunner.ts.
 *
 * Geometry is resolved here, not in the graph, so the builder only wires stock
 * nodes (ImageScale / ImageCrop / ImageCompositeMasked / ImageBlend) with
 * fixed integers. Coordinates: x / y are the overlay centre as a fraction of
 * the frame (0..1), scale is the overlay width as a fraction of the frame
 * width (height follows the overlay's own aspect).
 */
import { isVideoFilename, parseInputRef } from "@/lib/seedRun";

export const OVERLAY_COMPOSITE_ACTION = "overlay_composite";
/** Source and animated overlays are both decoded at this rate. */
export const OVERLAY_FPS = 24;
/**
 * Highest rate kept from the source. Every frame is composited in RAM, so a
 * 60 fps source runs at half rate (30) — timing stays exact, frame count stays
 * within the 10 s × 30 budget.
 */
export const OVERLAY_MAX_FPS = 30;
/** All frames sit in RAM at frame size, so the clip is capped. */
export const OVERLAY_MAX_SECONDS = 10;
export const OVERLAY_MAX_LONG_EDGE = 1280;
export const OVERLAY_MAX_LAYERS = 4;
export const OVERLAY_MIN_SCALE = 0.05;
export const OVERLAY_MAX_SCALE = 2;

export const OVERLAY_BLENDS = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "soft_light",
  "difference",
] as const;
export type OverlayBlend = (typeof OVERLAY_BLENDS)[number];

export const OVERLAY_BLEND_LABELS: Record<OverlayBlend, string> = {
  normal: "Normal",
  multiply: "Multiply",
  screen: "Screen",
  overlay: "Overlay",
  soft_light: "Soft light",
  difference: "Difference",
};

export type OverlayKind = "image" | "video";

/** One layer as sent in params.overlays (refs are uploaded inputs). */
export interface OverlayLayer {
  /** "name.png [input]" (image) or "name.webm [input]" (video). */
  ref: string;
  kind: OverlayKind;
  /** Native pixel size of the overlay. */
  width: number;
  height: number;
  /** Centre, fraction of the frame. */
  x: number;
  y: number;
  /** Overlay width as a fraction of the frame width. */
  scale: number;
  opacity: number;
  blend: OverlayBlend;
  /** Seconds into the clip; end null = until the end. */
  start: number;
  end: number | null;
}

export interface OverlayPlacement {
  /** Scaled overlay size. */
  sw: number;
  sh: number;
  /** Top-left of the scaled overlay in the frame (may be negative). */
  x: number;
  y: number;
  /** Visible rectangle inside the frame. */
  vx: number;
  vy: number;
  vw: number;
  vh: number;
  /** Offset of the visible part inside the scaled overlay. */
  cropX: number;
  cropY: number;
  clipped: boolean;
}

export interface OverlayWindow {
  /** First frame the overlay is on (inclusive). */
  startFrame: number;
  /** Frame the overlay goes off (exclusive). */
  endFrame: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function finite(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

const round8 = (n: number) => Math.max(8, Math.round(n / 8) * 8);

/**
 * Output frame size: the source fitted to OVERLAY_MAX_LONG_EDGE, both sides a
 * multiple of 8 (VHS_LoadVideo rounds to 8 anyway; fixing both keeps the
 * placement maths exact).
 */
export function overlayFrameSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const w = width > 0 ? width : 1280;
  const h = height > 0 ? height : 720;
  const k = Math.min(1, OVERLAY_MAX_LONG_EDGE / Math.max(w, h));
  return { width: round8(w * k), height: round8(h * k) };
}

/** Composited span in seconds (unknown length = the cap). */
export function overlaySeconds(duration: number | null | undefined): number {
  const d = finite(duration);
  if (d === undefined || d <= 0) return OVERLAY_MAX_SECONDS;
  return Math.round(Math.min(OVERLAY_MAX_SECONDS, d) * 100) / 100;
}

/** Frames decoded from the source (floor: never promise a frame that is not there). */
export function overlayFrameCount(seconds: number, fps: number = OVERLAY_FPS): number {
  return Math.max(1, Math.floor(seconds * fps));
}

/**
 * Composite frame rate: the source clip's own fps when known (halved until it
 * fits OVERLAY_MAX_FPS, so 60 → 30 and 50 → 25), else OVERLAY_FPS.
 */
export function overlayFps(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 240) return OVERLAY_FPS;
  let fps = n;
  while (fps > OVERLAY_MAX_FPS) fps /= 2;
  return Math.round(fps * 1000) / 1000;
}

/** Where the scaled overlay lands; null when nothing of it is on screen. */
export function overlayPlacement(
  layer: Pick<OverlayLayer, "width" | "height" | "x" | "y" | "scale">,
  frame: { width: number; height: number },
): OverlayPlacement | null {
  const ow = layer.width > 0 ? layer.width : 1;
  const oh = layer.height > 0 ? layer.height : 1;
  const sw = Math.max(1, Math.round(frame.width * layer.scale));
  const sh = Math.max(1, Math.round((sw * oh) / ow));
  const x = Math.round(layer.x * frame.width - sw / 2);
  const y = Math.round(layer.y * frame.height - sh / 2);
  const vx = Math.max(0, x);
  const vy = Math.max(0, y);
  const vw = Math.min(frame.width, x + sw) - vx;
  const vh = Math.min(frame.height, y + sh) - vy;
  if (vw <= 0 || vh <= 0) return null;
  return {
    sw,
    sh,
    x,
    y,
    vx,
    vy,
    vw,
    vh,
    cropX: vx - x,
    cropY: vy - y,
    clipped: vw !== sw || vh !== sh,
  };
}

/** Frame range of a layer inside a clip of `frames` frames. */
export function overlayWindow(
  layer: Pick<OverlayLayer, "start" | "end">,
  frames: number,
  fps: number = OVERLAY_FPS,
): OverlayWindow {
  const n = Math.max(1, Math.floor(frames));
  const startFrame = clamp(Math.round(layer.start * fps), 0, n - 1);
  const endFrame =
    layer.end === null
      ? n
      : clamp(Math.round(layer.end * fps), startFrame + 1, n);
  return { startFrame, endFrame };
}

const STILL_EXT = /\.(png|webp)$/i;

function overlayRef(ref: string, kind: OverlayKind): boolean {
  const parsed = parseInputRef(ref, { allowVideo: kind === "video" });
  if (!parsed) return false;
  return kind === "video"
    ? isVideoFilename(parsed.filename)
    : STILL_EXT.test(parsed.filename);
}

/** Validate + clamp one raw params.overlays entry. Returns an error string on bad input. */
export function parseOverlayLayer(
  raw: unknown,
  index: number,
): OverlayLayer | string {
  const at = `overlay ${index + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return `${at} must be an object`;
  const o = raw as Record<string, unknown>;
  const ref = typeof o.ref === "string" ? o.ref.trim() : "";
  const kind: OverlayKind = o.kind === "video" ? "video" : "image";
  if (!overlayRef(ref, kind))
    return kind === "video"
      ? `${at}: ref must be an uploaded clip ("name.webm [input]")`
      : `${at}: ref must be an uploaded PNG or WebP ("name.png [input]")`;
  const width = Math.round(finite(o.width) ?? 0);
  const height = Math.round(finite(o.height) ?? 0);
  if (width < 1 || height < 1 || width > 8192 || height > 8192)
    return `${at}: width and height must be the overlay's pixel size`;
  const blend = OVERLAY_BLENDS.includes(o.blend as OverlayBlend)
    ? (o.blend as OverlayBlend)
    : "normal";
  const start = clamp(finite(o.start) ?? 0, 0, OVERLAY_MAX_SECONDS);
  const rawEnd = finite(o.end);
  const end =
    rawEnd === undefined || rawEnd <= start
      ? null
      : clamp(rawEnd, start, OVERLAY_MAX_SECONDS);
  return {
    ref,
    kind,
    width,
    height,
    x: clamp(finite(o.x) ?? 0.5, 0, 1),
    y: clamp(finite(o.y) ?? 0.5, 0, 1),
    scale: clamp(finite(o.scale) ?? 0.3, OVERLAY_MIN_SCALE, OVERLAY_MAX_SCALE),
    opacity: clamp(finite(o.opacity) ?? 1, 0, 1),
    blend,
    start,
    end,
  };
}

export interface OverlayLook {
  id: string;
  label: string;
  /** What the sticker shows (the image prompt adds the cut-out framing). */
  subject: string;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  blend: OverlayBlend;
}

/**
 * Illustrated looks: each one is generated as a sticker on a plain white
 * background (text-to-image), cut out to RGBA (qwen21-remove-bg) and then
 * composited with these defaults. All original prompts.
 */
export const OVERLAY_LOOKS: readonly OverlayLook[] = [
  {
    id: "sparkle-doodles",
    label: "Sparkle doodles",
    subject:
      "a cluster of hand-drawn white and gold sparkle doodles, four-point stars and tiny twinkles, marker strokes",
    x: 0.8,
    y: 0.2,
    scale: 0.32,
    opacity: 1,
    blend: "screen",
  },
  {
    id: "comic-burst",
    label: "Comic burst",
    subject:
      "a comic book explosion burst with halftone dots, bold black ink outline, yellow and red, empty centre",
    x: 0.22,
    y: 0.22,
    scale: 0.34,
    opacity: 1,
    blend: "normal",
  },
  {
    id: "marker-hearts",
    label: "Marker hearts",
    subject:
      "a scattered cluster of hand-drawn pink and red marker hearts of different sizes, loose doodle style",
    x: 0.78,
    y: 0.76,
    scale: 0.3,
    opacity: 0.95,
    blend: "normal",
  },
  {
    id: "neon-scribble",
    label: "Neon scribble frame",
    subject:
      "a glowing neon pink and cyan hand-scribbled oval frame, loose looping line, empty middle",
    x: 0.5,
    y: 0.5,
    scale: 0.8,
    opacity: 0.9,
    blend: "screen",
  },
  {
    id: "paper-flowers",
    label: "Paper-cut flowers",
    subject:
      "layered paper-cut flowers and leaves in coral, mustard and teal, visible craft paper texture and soft drop shadows",
    x: 0.2,
    y: 0.8,
    scale: 0.36,
    opacity: 1,
    blend: "normal",
  },
  {
    id: "chalk-arrows",
    label: "Chalk arrows",
    subject:
      "white chalk hand-drawn arrows, circles and underline swooshes, dusty chalkboard strokes",
    x: 0.72,
    y: 0.5,
    scale: 0.3,
    opacity: 0.9,
    blend: "screen",
  },
  {
    id: "retro-badge",
    label: "Retro sticker badge",
    subject:
      "a retro 1970s sticker badge, scalloped round shape with sunburst rays in orange, cream and brown, no lettering",
    x: 0.84,
    y: 0.18,
    scale: 0.22,
    opacity: 1,
    blend: "normal",
  },
  {
    id: "watercolor-clouds",
    label: "Watercolor clouds",
    subject:
      "soft watercolor clouds in pastel blue and peach, wet edges and paper grain",
    x: 0.5,
    y: 0.16,
    scale: 0.62,
    opacity: 0.85,
    blend: "multiply",
  },
];

export function overlayLook(id: string): OverlayLook | undefined {
  return OVERLAY_LOOKS.find((l) => l.id === id);
}

/** Square sticker prompt for the look's text-to-image step. */
export function overlayLookPrompt(look: OverlayLook, extra?: string): string {
  const more = extra?.trim().replace(/-{2,}/g, " ").replace(/::/g, ":");
  return [
    look.subject,
    more,
    "die-cut sticker illustration, isolated on a plain flat white background, centered with margin, clean edges, no text, no watermark --ar 1:1",
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * Export the editor's paint layer (EditorCanvas mask canvas: colored strokes
 * on a transparent canvas) as a PNG data URL for mask-based edits, or null
 * when nothing is painted. The server binarizes it (opaque + bright = masked),
 * so the stroke color/alpha convention does not leak into the graph.
 */
export function editorMaskDataUrl(
  canvas: HTMLCanvasElement | null | undefined,
): string | null {
  if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let painted = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) {
      painted = true;
      break;
    }
  }
  return painted ? canvas.toDataURL("image/png") : null;
}

/**
 * Paint-layer RGBA -> black/white mask pixels (white = painted), the format
 * the Tools page MaskPainter emits. Returns how many pixels are painted.
 */
export function editorMaskToBinaryPixels(rgba: Uint8ClampedArray): {
  pixels: Uint8ClampedArray;
  painted: number;
} {
  const pixels = new Uint8ClampedArray(rgba.length);
  let painted = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const on = rgba[i + 3] > 0;
    if (on) painted++;
    const v = on ? 255 : 0;
    pixels[i] = v;
    pixels[i + 1] = v;
    pixels[i + 2] = v;
    pixels[i + 3] = 255;
  }
  return { pixels, painted };
}

/**
 * The editor selection as a black/white PNG data URL (white = selected) for
 * handing to a Tools page mask painter, or null when nothing is painted.
 */
export function editorMaskBinaryDataUrl(
  canvas: HTMLCanvasElement | null | undefined,
): string | null {
  if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const { width: w, height: h } = canvas;
  const { pixels, painted } = editorMaskToBinaryPixels(
    ctx.getImageData(0, 0, w, h).data,
  );
  if (painted === 0) return null;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  if (!octx) return null;
  octx.putImageData(
    new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, w, h),
    0,
    0,
  );
  return out.toDataURL("image/png");
}

/** Paint-layer stroke color (EditorCanvas draws the selection in opaque red). */
export const EDITOR_MASK_RGB = [255, 0, 0] as const;

function setPixel(out: Uint8ClampedArray, i: number, on: boolean): void {
  out[i] = EDITOR_MASK_RGB[0];
  out[i + 1] = EDITOR_MASK_RGB[1];
  out[i + 2] = EDITOR_MASK_RGB[2];
  out[i + 3] = on ? 255 : 0;
}

/** Whole image selected. Mutates and returns `rgba`. */
export function fillMaskPixels(rgba: Uint8ClampedArray): Uint8ClampedArray {
  for (let i = 0; i < rgba.length; i += 4) setPixel(rgba, i, true);
  return rgba;
}

/** Selected <-> unselected. Mutates and returns `rgba`. */
export function invertMaskPixels(rgba: Uint8ClampedArray): Uint8ClampedArray {
  for (let i = 0; i < rgba.length; i += 4) setPixel(rgba, i, rgba[i + 3] === 0);
  return rgba;
}

/**
 * Paint-layer pixels for a smart-select result: everything selected in
 * `base` (the mask before this smart-select session; null = empty) plus every
 * bright pixel of the SAM mask (white = subject). Both arrays must be the
 * same size.
 */
export function mergeSmartMaskPixels(
  base: Uint8ClampedArray | null,
  sam: Uint8ClampedArray,
): Uint8ClampedArray {
  if (base && base.length !== sam.length) {
    throw new Error("mask size mismatch");
  }
  const out = new Uint8ClampedArray(sam.length);
  for (let i = 0; i < sam.length; i += 4) {
    const on = (base ? base[i + 3] > 0 : false) || sam[i] > 127;
    setPixel(out, i, on);
  }
  return out;
}

export type EditorMaskOp = "clear" | "fill" | "invert";

/** Apply a whole-mask operation to the paint-layer canvas in place. */
export function applyEditorMaskOp(
  canvas: HTMLCanvasElement | null | undefined,
  op: EditorMaskOp,
): boolean {
  if (!canvas || canvas.width === 0 || canvas.height === 0) return false;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  ctx.globalCompositeOperation = "source-over";
  if (op === "clear") {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return true;
  }
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  if (op === "fill") fillMaskPixels(img.data);
  else invertMaskPixels(img.data);
  ctx.putImageData(img, 0, 0);
  return true;
}

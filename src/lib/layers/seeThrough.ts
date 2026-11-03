/**
 * Layer Split (see-through) results: manifest parsing and compositing.
 *
 * The ComfyUI-See-through pack writes one RGBA PNG per part (cropped to its
 * bbox in the padded square canvas), a matching 8-bit depth PNG, and a
 * `<prefix>_<ts>_<uid>_layers.json` manifest whose absolute server path is
 * the job's only text output. Depth PNGs share one global scale: larger =
 * farther. Parts interleave (a coat lining covers shorts, a handle sits
 * behind a hand), so a single draw order per part is wrong; zComposite
 * picks the order per pixel from each part's own depth.
 *
 * Pure: no DOM, no fetch. Typed arrays in, typed arrays out.
 */

/** Same plain-name rule as validateOutputRef (src/lib/mesh/usdz.ts). */
const SAFE_NAME_RE = /^[A-Za-z0-9 ._()+-]+$/;
const MAX_NAME = 255;
const MANIFEST_RE = /_layers\.json$/i;

export const SEE_THROUGH_CREDIT =
  "Layers by see-through (shitagaki-lab, MIT node pack; weights RAIL++-M)";

/** Pixels with alpha at or below this (0..1) do not take part in a pixel's depth order. */
export const ALPHA_THRESHOLD = 0.02;

export interface LayerEntry {
  name: string;
  filename: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  depthMedian: number;
  depthFilename: string | null;
}

export interface LayerManifest {
  prefix: string;
  timestamp: string;
  /** Back to front (largest depthMedian first). */
  layers: LayerEntry[];
}

export class LayerManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayerManifestError";
  }
}

/** A plain ComfyUI output PNG name: no separators, no "..", ends in .png. */
export function isSafePngName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length <= MAX_NAME &&
    SAFE_NAME_RE.test(name) &&
    !name.includes("..") &&
    /\.png$/i.test(name)
  );
}

/** The job text that is the manifest path, or null. */
export function manifestPathFromTexts(
  texts: readonly unknown[] | undefined | null,
): string | null {
  for (const t of texts ?? []) {
    if (typeof t !== "string") continue;
    for (const line of t.split(/\r?\n/)) {
      const s = line.trim().replace(/^["']|["']$/g, "");
      if (MANIFEST_RE.test(s) && manifestBasename(s)) return s;
    }
  }
  return null;
}

/** Last path segment ("/" or "\\" separated) when it is a safe manifest name. */
export function manifestBasename(path: string): string | null {
  const base = path.split(/[\\/]/).pop() ?? "";
  if (
    !base ||
    base.length > MAX_NAME ||
    !SAFE_NAME_RE.test(base) ||
    base.includes("..") ||
    !MANIFEST_RE.test(base)
  )
    return null;
  return base;
}

/** Proxy URL for a file in the ComfyUI output root. */
export function outputFileUrl(filename: string): string {
  return `/api/comfy/image?filename=${encodeURIComponent(filename)}&subfolder=&type=output`;
}

export function layerImageUrl(filename: string): string {
  if (!isSafePngName(filename))
    throw new LayerManifestError(`Unsafe layer file name: ${filename}`);
  return outputFileUrl(filename);
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Validate a layers.json. Entries with an unsafe file name or a bad box are
 * dropped; an unsafe depth file name only drops the depth. Throws when no
 * usable layer is left.
 */
export function parseLayerManifest(json: unknown): LayerManifest {
  if (!json || typeof json !== "object")
    throw new LayerManifestError("Layer manifest is not an object");
  const obj = json as Record<string, unknown>;
  if (!Array.isArray(obj.layers))
    throw new LayerManifestError("Layer manifest has no layers list");
  const layers: LayerEntry[] = [];
  for (const raw of obj.layers) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (!isSafePngName(r.filename)) continue;
    const left = num(r.left);
    const top = num(r.top);
    const right = num(r.right);
    const bottom = num(r.bottom);
    if (left === null || top === null || right === null || bottom === null)
      continue;
    if (left < 0 || top < 0 || right <= left || bottom <= top) continue;
    if (right > 16384 || bottom > 16384) continue;
    const name =
      typeof r.name === "string" && r.name.trim()
        ? r.name.trim().slice(0, 120)
        : r.filename.replace(/\.png$/i, "");
    layers.push({
      name,
      filename: r.filename,
      left: Math.round(left),
      top: Math.round(top),
      right: Math.round(right),
      bottom: Math.round(bottom),
      depthMedian: num(r.depth_median) ?? 0,
      depthFilename: isSafePngName(r.depth_filename) ? r.depth_filename : null,
    });
  }
  if (!layers.length)
    throw new LayerManifestError("Layer manifest has no usable layers");
  // Stable: equal depths keep the manifest's order.
  const order = layers.map((l, i) => ({ l, i }));
  order.sort((a, b) => b.l.depthMedian - a.l.depthMedian || a.i - b.i);
  return {
    prefix: typeof obj.prefix === "string" ? obj.prefix : "",
    timestamp:
      typeof obj.timestamp === "string" || typeof obj.timestamp === "number"
        ? String(obj.timestamp)
        : "",
    layers: order.map((o) => o.l),
  };
}

/** The pack's default generation resolution ("detail: max"). */
export const DEFAULT_LAYER_RESOLUTION = 1280;
/** Generation resolution per `detail` pick; the builder (src/lib/oj/seeThrough.ts) reuses it. */
export const LAYER_DETAIL_RESOLUTION: Readonly<Record<string, number>> = {
  max: DEFAULT_LAYER_RESOLUTION,
  fast: 1024,
};

/**
 * Generation resolution from a Layer Split run's params: an explicit
 * `resolution`, else the `detail` pick (max 1280, fast 1024), else null.
 */
export function layerRunResolution(
  params: Record<string, unknown> | null | undefined,
): number | null {
  const r = Number(params?.resolution);
  if (Number.isFinite(r) && r > 0) return Math.round(r);
  const detail =
    typeof params?.detail === "string" ? params.detail.trim().toLowerCase() : "";
  return LAYER_DETAIL_RESOLUTION[detail] ?? null;
}

/**
 * Size of the padded square canvas the boxes live in: the generation
 * resolution (default 1280), grown to the boxes' extent if they overflow it.
 */
export function canvasSize(
  manifest: LayerManifest,
  resolution?: number | null,
): { width: number; height: number } {
  let extent = 0;
  for (const l of manifest.layers) extent = Math.max(extent, l.right, l.bottom);
  const res =
    typeof resolution === "number" &&
    Number.isFinite(resolution) &&
    resolution > 0
      ? Math.round(resolution)
      : DEFAULT_LAYER_RESOLUTION;
  const side = Math.max(res, Math.ceil(extent / 64) * 64);
  return { width: side, height: side };
}

/** One decoded part, positioned on the canvas. */
export interface CompositePart {
  /** Straight-alpha RGBA, width*height*4. */
  rgba: Uint8ClampedArray;
  /** Per-pixel depth (0..255, larger = farther), width*height, or null. */
  depth: Uint8Array | null;
  left: number;
  top: number;
  width: number;
  height: number;
  visible: boolean;
  /** 0..1, same scale as depth/255. */
  depthMedian: number;
}

export interface CompositeOptions {
  /** 0..1; default ALPHA_THRESHOLD. */
  alphaThreshold?: number;
}

interface Span {
  part: CompositePart;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** depthMedian on the 0..255 scale. */
  median: number;
}

function spans(
  parts: readonly CompositePart[],
  width: number,
  height: number,
): Span[] {
  const out: Span[] = [];
  for (const p of parts) {
    if (!p.visible || p.width <= 0 || p.height <= 0) continue;
    if (p.rgba.length < p.width * p.height * 4) continue;
    const x0 = Math.max(0, p.left);
    const y0 = Math.max(0, p.top);
    const x1 = Math.min(width, p.left + p.width);
    const y1 = Math.min(height, p.top + p.height);
    if (x1 <= x0 || y1 <= y0) continue;
    out.push({ part: p, x0, x1, y0, y1, median: p.depthMedian * 255 });
  }
  return out;
}

function depthOk(p: CompositePart): boolean {
  return !!p.depth && p.depth.length >= p.width * p.height;
}

/**
 * Per-pixel z-buffer composite: at each pixel the parts with alpha above the
 * threshold are sorted by that part's depth there (fallback: its median),
 * then blended back to front with straight-alpha "over". O(W*H*k), no
 * per-pixel allocation.
 */
export function zComposite(
  parts: readonly CompositePart[],
  width: number,
  height: number,
  opts: CompositeOptions = {},
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * height * 4);
  const all = spans(parts, width, height);
  if (!all.length) return out;
  const thr = Math.round((opts.alphaThreshold ?? ALPHA_THRESHOLD) * 255);
  const k = all.length;
  const zs = new Float32Array(k);
  const offs = new Int32Array(k);
  const which = new Int32Array(k);
  const rgbas: Uint8ClampedArray[] = all.map((s) => s.part.rgba);
  const depths: (Uint8Array | null)[] = all.map((s) =>
    depthOk(s.part) ? s.part.depth : null,
  );
  const rowSpans = new Int32Array(k);
  for (let y = 0; y < height; y++) {
    let rn = 0;
    for (let i = 0; i < k; i++) {
      if (y >= all[i].y0 && y < all[i].y1) rowSpans[rn++] = i;
    }
    if (!rn) continue;
    let o = y * width * 4;
    for (let x = 0; x < width; x++, o += 4) {
      let n = 0;
      for (let r = 0; r < rn; r++) {
        const i = rowSpans[r];
        const s = all[i];
        if (x < s.x0 || x >= s.x1) continue;
        const p = s.part;
        const pi = (y - p.top) * p.width + (x - p.left);
        if (rgbas[i][pi * 4 + 3] <= thr) continue;
        const d = depths[i];
        const z = d ? d[pi] : s.median;
        // Insertion sort, farthest first; ties keep back-to-front input order.
        let j = n++;
        while (j > 0 && zs[j - 1] < z) {
          zs[j] = zs[j - 1];
          offs[j] = offs[j - 1];
          which[j] = which[j - 1];
          j--;
        }
        zs[j] = z;
        offs[j] = pi * 4;
        which[j] = i;
      }
      if (!n) continue;
      let cr = 0;
      let cg = 0;
      let cb = 0;
      let ca = 0;
      for (let j = 0; j < n; j++) {
        const src = rgbas[which[j]];
        const q = offs[j];
        const a = src[q + 3] / 255;
        const keep = ca * (1 - a);
        const na = a + keep;
        if (na <= 0) continue;
        cr = (src[q] * a + cr * keep) / na;
        cg = (src[q + 1] * a + cg * keep) / na;
        cb = (src[q + 2] * a + cb * keep) / na;
        ca = na;
      }
      out[o] = cr;
      out[o + 1] = cg;
      out[o + 2] = cb;
      out[o + 3] = ca * 255;
    }
  }
  return out;
}

/** Whole-part draw order by depthMedian (farthest first): the PSD's stacking. */
export function painterComposite(
  parts: readonly CompositePart[],
  width: number,
  height: number,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * height * 4);
  const all = spans(parts, width, height)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.median - a.s.median || a.i - b.i)
    .map((e) => e.s);
  // Float accumulators so repeated "over" does not round per layer.
  const acc = new Float32Array(width * height * 4);
  for (const s of all) {
    const p = s.part;
    for (let y = s.y0; y < s.y1; y++) {
      let pi = ((y - p.top) * p.width + (s.x0 - p.left)) * 4;
      let o = (y * width + s.x0) * 4;
      for (let x = s.x0; x < s.x1; x++, pi += 4, o += 4) {
        const a = p.rgba[pi + 3] / 255;
        if (a <= 0) continue;
        const keep = acc[o + 3] * (1 - a);
        const na = a + keep;
        acc[o] = (p.rgba[pi] * a + acc[o] * keep) / na;
        acc[o + 1] = (p.rgba[pi + 1] * a + acc[o + 1] * keep) / na;
        acc[o + 2] = (p.rgba[pi + 2] * a + acc[o + 2] * keep) / na;
        acc[o + 3] = na;
      }
    }
  }
  for (let i = 0; i < acc.length; i += 4) {
    out[i] = acc[i];
    out[i + 1] = acc[i + 1];
    out[i + 2] = acc[i + 2];
    out[i + 3] = acc[i + 3] * 255;
  }
  return out;
}

/**
 * Grayscale map of the nearest visible depth per pixel (near = bright),
 * opaque where any part covers, transparent elsewhere.
 */
export function depthPreview(
  parts: readonly CompositePart[],
  width: number,
  height: number,
  opts: CompositeOptions = {},
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * height * 4);
  const near = new Float32Array(width * height).fill(Infinity);
  const thr = Math.round((opts.alphaThreshold ?? ALPHA_THRESHOLD) * 255);
  for (const s of spans(parts, width, height)) {
    const p = s.part;
    const d = depthOk(p) ? p.depth : null;
    for (let y = s.y0; y < s.y1; y++) {
      let pi = (y - p.top) * p.width + (s.x0 - p.left);
      let o = y * width + s.x0;
      for (let x = s.x0; x < s.x1; x++, pi++, o++) {
        if (p.rgba[pi * 4 + 3] <= thr) continue;
        const z = d ? d[pi] : s.median;
        if (z < near[o]) near[o] = z;
      }
    }
  }
  for (let o = 0; o < near.length; o++) {
    const z = near[o];
    if (z === Infinity) continue;
    const v = 255 - z;
    out[o * 4] = v;
    out[o * 4 + 1] = v;
    out[o * 4 + 2] = v;
    out[o * 4 + 3] = 255;
  }
  return out;
}

/** The part's coverage as a flat tint (for hover highlight), part-sized RGBA. */
export function partTint(
  part: Pick<CompositePart, "rgba" | "width" | "height">,
  rgb: [number, number, number],
  alpha = 110,
  opts: CompositeOptions = {},
): Uint8ClampedArray<ArrayBuffer> {
  const thr = Math.round((opts.alphaThreshold ?? ALPHA_THRESHOLD) * 255);
  const n = part.width * part.height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    if (part.rgba[i * 4 + 3] <= thr) continue;
    out[i * 4] = rgb[0];
    out[i * 4 + 1] = rgb[1];
    out[i * 4 + 2] = rgb[2];
    out[i * 4 + 3] = alpha;
  }
  return out;
}

/**
 * Single-channel depth from a decoded RGBA depth image. With `crop`, the
 * source is canvas-sized and the part's box is cut out at (left, top);
 * otherwise it is resampled (nearest) to the part's size when sizes differ.
 */
export function depthFromRgba(
  rgba: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  crop?: { left: number; top: number },
): Uint8Array {
  const out = new Uint8Array(dstW * dstH);
  if (srcW <= 0 || srcH <= 0) return out;
  if (crop) {
    for (let y = 0; y < dstH; y++) {
      const sy = Math.min(srcH - 1, Math.max(0, crop.top + y));
      for (let x = 0; x < dstW; x++) {
        const sx = Math.min(srcW - 1, Math.max(0, crop.left + x));
        out[y * dstW + x] = rgba[(sy * srcW + sx) * 4];
      }
    }
    return out;
  }
  for (let y = 0; y < dstH; y++) {
    const sy =
      srcH === dstH ? y : Math.min(srcH - 1, Math.floor((y * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const sx =
        srcW === dstW ? x : Math.min(srcW - 1, Math.floor((x * srcW) / dstW));
      out[y * dstW + x] = rgba[(sy * srcW + sx) * 4];
    }
  }
  return out;
}

/** File-safe, unique stems for part names ("back hair" stays readable). */
export function partStems(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const base =
      name
        .normalize("NFKD")
        .replace(/[^A-Za-z0-9 _-]+/g, "_")
        .replace(/\s+/g, " ")
        .replace(/^[ _]+|[ _]+$/g, "")
        .slice(0, 80) || "part";
    let stem = base;
    for (let i = 2; used.has(stem.toLowerCase()); i++) stem = `${base}_${i}`;
    used.add(stem.toLowerCase());
    return stem;
  });
}

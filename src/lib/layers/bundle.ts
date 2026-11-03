/**
 * Zip contents for Layer Split downloads. Pure: callers pass the original
 * PNG bytes plus the encoded composite and PSD; writeZipBytes packs them.
 */

import {
  canvasDepthUv,
  layerBlenderScript,
  sourceFrame,
} from "./layerBlender";
import { layerPlanesGlb } from "./layerGlb";
import {
  partStems,
  SEE_THROUGH_CREDIT,
  type LayerManifest,
} from "./seeThrough";
import type { ZipBytesFile } from "./zip";

export type LayerBundleKind = "all" | "parts" | "blender";

export interface BundlePart {
  name: string;
  left: number;
  top: number;
  width: number;
  height: number;
  depthMedian: number;
  png: Uint8Array;
  depthPng: Uint8Array | null;
}

export interface LayerBundleInput {
  manifest: LayerManifest;
  canvas: { width: number; height: number };
  /** Back to front. */
  parts: readonly BundlePart[];
  compositePng?: Uint8Array | null;
  psd?: Uint8Array | null;
  /** Source image width / height; the Blender camera frames it. */
  aspect?: number | null;
}

/** Source aspect (width / height) of a Layer Split run, or null. */
export function runAspect(
  run: { width?: unknown; height?: unknown } | null | undefined,
): number | null {
  const w = Number(run?.width);
  const h = Number(run?.height);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
    ? w / h
    : null;
}

/** Width and height from a PNG's IHDR, or null when it is not a PNG. */
export function pngSize(
  bytes: Uint8Array | null | undefined,
): { width: number; height: number } | null {
  if (!bytes || bytes.byteLength < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (sig.some((b, i) => bytes[i] !== b)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(12) !== 0x49484452) return null; // "IHDR"
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

/**
 * Where a part sits in its depth PNG: the pack writes either a crop matching
 * the part or a canvas-sized map (same rule as the Layer Split viewer).
 */
export function partDepthUv(
  part: Pick<BundlePart, "left" | "top" | "width" | "height" | "depthPng">,
  canvas: { width: number; height: number },
): [number, number, number, number] {
  const d = pngSize(part.depthPng);
  const full =
    !!d &&
    d.width === canvas.width &&
    d.height === canvas.height &&
    (d.width !== part.width || d.height !== part.height);
  return full ? canvasDepthUv(part, canvas.width, canvas.height) : [0, 0, 1, 1];
}

export const PSD_ORDER_NOTE =
  "PSD stacking is approximate where parts interleave: a PSD has one order per layer and cannot do per-pixel depth. Layers run back to front by median depth; the merged image (composite.png) uses per-pixel depth and is exact.";

function readme(kind: LayerBundleKind, input: LayerBundleInput): string {
  const lines = [
    "Adrift Layer Split",
    SEE_THROUGH_CREDIT,
    "",
    `Canvas: ${input.canvas.width} x ${input.canvas.height} px (the input centred on a square). ${input.parts.length} parts, back to front.`,
    "",
    "Files:",
    "  parts/<name>.png        each part, RGBA, cropped to its box (see layers.json for left/top)",
  ];
  lines.push(
    "  depth/<name>_depth.png  per-part depth, 8-bit; one shared scale, brighter = farther",
  );
  lines.push(
    "  layers.json             boxes, median depth and file names, back to front",
  );
  if (kind === "all") {
    lines.push(
      "  layers.psd              one layer per part (RGB 8-bit, hidden ones kept but off) over the exact merged image",
      "  composite.png           the visible parts merged with per-pixel depth (z-buffer)",
    );
  }
  if (kind !== "parts")
    lines.push(
      "  import_layers.py        Blender 4.2+ / 5.x: Scripting -> Open -> Run Script (or blender --python import_layers.py);",
      "                          builds one alpha image plane per part, farther parts further down -Z, plus an ortho",
      "                          camera framing the source image. RELIEF = True bends each part by its depth map.",
      "  layers.glb              the same planes and camera as one glTF scene, for other 3D tools",
    );
  if (kind === "all") lines.push("", PSD_ORDER_NOTE);
  return lines.join("\n") + "\n";
}

export function layerBundleFiles(
  kind: LayerBundleKind,
  input: LayerBundleInput,
): ZipBytesFile[] {
  const stems = partStems(input.parts.map((p) => p.name));
  const files: ZipBytesFile[] = [];
  const entries = input.parts.map((p, i) => {
    const part = `parts/${stems[i]}.png`;
    const depth = p.depthPng ? `depth/${stems[i]}_depth.png` : null;
    files.push({ name: part, data: p.png });
    if (depth) files.push({ name: depth, data: p.depthPng! });
    return {
      name: p.name,
      file: part,
      depth_file: depth,
      left: p.left,
      top: p.top,
      right: p.left + p.width,
      bottom: p.top + p.height,
      depth_median: p.depthMedian,
    };
  });
  files.push({
    name: "layers.json",
    data: JSON.stringify(
      {
        prefix: input.manifest.prefix,
        timestamp: input.manifest.timestamp,
        canvas: input.canvas,
        credit: SEE_THROUGH_CREDIT,
        layers: entries,
      },
      null,
      2,
    ),
  });
  if (kind === "all") {
    if (input.psd) files.push({ name: "layers.psd", data: input.psd });
    if (input.compositePng)
      files.push({ name: "composite.png", data: input.compositePng });
  }
  if (kind !== "parts") {
    const frame = sourceFrame(
      input.canvas.width,
      input.canvas.height,
      input.aspect,
    );
    files.push({
      name: "import_layers.py",
      data: layerBlenderScript({
        title: "Adrift layers",
        canvasWidth: input.canvas.width,
        canvasHeight: input.canvas.height,
        frame,
        layers: input.parts.map((p, i) => ({
          name: p.name,
          path: `parts/${stems[i]}.png`,
          left: p.left,
          top: p.top,
          width: p.width,
          height: p.height,
          depthMedian: p.depthMedian,
          depthPath: entries[i].depth_file,
          depthUv: p.depthPng ? partDepthUv(p, input.canvas) : null,
        })),
      }),
    });
    files.push({
      name: "layers.glb",
      data: layerPlanesGlb({
        canvasWidth: input.canvas.width,
        canvasHeight: input.canvas.height,
        frame,
        layers: input.parts,
      }),
    });
  }
  files.push({ name: "README.txt", data: readme(kind, input) });
  return files;
}

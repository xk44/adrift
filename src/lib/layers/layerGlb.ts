/**
 * `layers.glb` for the Layer Split Blender export: the same depth-ordered
 * image planes as import_layers.py, as one glTF scene any 3D tool opens.
 * Each part is an unlit, alpha-blended quad with its PNG embedded; an
 * orthographic camera frames the source image. glTF axes: +Y up, the camera
 * looks down -Z, farther parts sit further down -Z. Browser-safe.
 */

import { pad4, packGlb } from "@/lib/mesh/glb";
import { layerPlacement, type LayerFrame } from "./layerBlender";

export interface GlbLayer {
  name: string;
  png: Uint8Array;
  left: number;
  top: number;
  width: number;
  height: number;
  /** 0..1, larger = farther. */
  depthMedian: number;
}

export interface LayerGlbOptions {
  canvasWidth: number;
  canvasHeight: number;
  /** Back to front. */
  layers: readonly GlbLayer[];
  frame?: LayerFrame | null;
  /** Canvas height in metres; default 2 (matches import_layers.py). */
  canvasMeters?: number;
  depthScale?: number;
}

const FLOAT = 5126;
const USHORT = 5123;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const LINEAR = 9729;
const CLAMP = 33071;

export function layerPlanesGlb(opts: LayerGlbOptions): Uint8Array {
  const W = Math.max(1, opts.canvasWidth);
  const H = Math.max(1, opts.canvasHeight);
  const mpp = (opts.canvasMeters ?? 2) / H;
  const depthScale = opts.depthScale ?? 1;
  const zStep = Math.max(1e-4, (H * mpp) / 4000);
  const frame = opts.frame ?? { width: W, height: H };

  const chunks: Array<{ data: Uint8Array; byteOffset: number }> = [];
  const bufferViews: Record<string, unknown>[] = [];
  let offset = 0;
  const view = (data: Uint8Array, target?: number): number => {
    chunks.push({ data, byteOffset: offset });
    bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: data.byteLength,
      ...(target ? { target } : {}),
    });
    offset = pad4(offset + data.byteLength);
    return bufferViews.length - 1;
  };
  const bytes = (a: Float32Array | Uint16Array) =>
    new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

  // Shared UVs and indices: glTF UV (0,0) is the image's top-left.
  const uvView = view(
    bytes(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0])),
    ARRAY_BUFFER,
  );
  const idxView = view(
    bytes(new Uint16Array([0, 1, 2, 0, 2, 3])),
    ELEMENT_ARRAY_BUFFER,
  );
  const accessors: Record<string, unknown>[] = [
    { bufferView: uvView, componentType: FLOAT, count: 4, type: "VEC2" },
    { bufferView: idxView, componentType: USHORT, count: 6, type: "SCALAR" },
  ];

  const images: Record<string, unknown>[] = [];
  const textures: Record<string, unknown>[] = [];
  const materials: Record<string, unknown>[] = [];
  const meshes: Record<string, unknown>[] = [];
  const nodes: Record<string, unknown>[] = [];
  let maxDepth = 0;

  opts.layers.forEach((l, i) => {
    const p = layerPlacement(l, W, H, mpp, depthScale);
    maxDepth = Math.max(maxDepth, -p.z);
    const hw = p.w / 2;
    const hh = p.h / 2;
    const pos = view(
      bytes(new Float32Array([-hw, -hh, 0, hw, -hh, 0, hw, hh, 0, -hw, hh, 0])),
      ARRAY_BUFFER,
    );
    accessors.push({
      bufferView: pos,
      componentType: FLOAT,
      count: 4,
      type: "VEC3",
      min: [-hw, -hh, 0],
      max: [hw, hh, 0],
    });
    images.push({
      bufferView: view(l.png),
      mimeType: "image/png",
      name: l.name,
    });
    textures.push({ source: images.length - 1, sampler: 0 });
    materials.push({
      name: l.name,
      pbrMetallicRoughness: {
        baseColorTexture: { index: textures.length - 1 },
        metallicFactor: 0,
        roughnessFactor: 1,
      },
      alphaMode: "BLEND",
      extensions: { KHR_materials_unlit: {} },
    });
    meshes.push({
      name: l.name,
      primitives: [
        {
          attributes: { POSITION: accessors.length - 1, TEXCOORD_0: 0 },
          indices: 1,
          material: materials.length - 1,
          mode: 4,
        },
      ],
    });
    nodes.push({
      name: `${String(i).padStart(2, "0")} ${l.name}`,
      mesh: meshes.length - 1,
      translation: [p.x, p.y, p.z + i * zStep],
    });
  });

  const fw = Math.max(1, Math.min(W, frame.width)) * mpp;
  const fh = Math.max(1, Math.min(H, frame.height)) * mpp;
  nodes.push({
    name: "Adrift layers camera",
    camera: 0,
    translation: [0, 0, 10],
  });
  const children = nodes.map((_, i) => i);
  nodes.push({ name: "Adrift layers", children });

  const gltf = {
    asset: { version: "2.0", generator: "Adrift" },
    extensionsUsed: ["KHR_materials_unlit"],
    scene: 0,
    scenes: [{ name: "Adrift layers", nodes: [nodes.length - 1] }],
    nodes,
    meshes,
    materials,
    textures,
    images,
    samplers: [
      { magFilter: LINEAR, minFilter: LINEAR, wrapS: CLAMP, wrapT: CLAMP },
    ],
    cameras: [
      {
        type: "orthographic",
        name: "Adrift layers camera",
        orthographic: {
          xmag: fw / 2,
          ymag: fh / 2,
          znear: 0.01,
          zfar: 10 + maxDepth + 100,
        },
      },
    ],
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };
  return packGlb(gltf, chunks, offset);
}

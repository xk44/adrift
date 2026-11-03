/**
 * Small, dependency-free 3D file conversions for the Blender export bundle.
 *
 * - OBJ / mesh PLY → GLB (positions, normals, UVs, vertex colours; no
 *   materials or textures).
 * - Gaussian splats (3DGS .ply, antimatter15 .splat, Niantic .spz) → a
 *   coloured point-cloud PLY that Blender imports natively. Splats are not
 *   surfaces, so this is a preview of where the splats sit, not a mesh.
 *
 * Every parser throws MeshConvertError on input it does not understand; the
 * bundle builder then ships the original file instead.
 */

import { gunzipSync } from "zlib";
import { pad4, packGlb } from "./glb";

export class MeshConvertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeshConvertError";
  }
}

/** Geometry ready for writeGlb. Indices are triangles. */
export interface TriMesh {
  positions: Float32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  /** Linear RGB, 3 floats per vertex. */
  colors?: Float32Array;
  indices: Uint32Array;
}

/** Points with sRGB 8-bit colours. */
export interface PointCloud {
  positions: Float32Array;
  colors: Uint8Array;
}

const SH_C0 = 0.28209479177387814;
/** Splats whose opacity is below this are dropped from the point preview. */
const MIN_SPLAT_ALPHA = 0.05;
const MAX_VERTICES = 50_000_000;

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function clampByte(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}

// ---------------------------------------------------------------- GLB writer

/** Encode a triangle mesh as a binary glTF 2.0 file. */
export function writeGlb(mesh: TriMesh, name = "mesh"): Uint8Array {
  const vertexCount = mesh.positions.length / 3;
  if (!Number.isInteger(vertexCount) || vertexCount === 0)
    throw new MeshConvertError("Mesh has no vertices");
  if (mesh.indices.length === 0 || mesh.indices.length % 3 !== 0)
    throw new MeshConvertError("Mesh has no triangles");

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.positions[i + k];
      if (!Number.isFinite(v)) throw new MeshConvertError("Non-finite vertex");
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }

  const views: Array<{ data: Uint8Array; target: number }> = [];
  const accessors: Record<string, unknown>[] = [];
  const attributes: Record<string, number> = {};
  const add = (
    arr: Float32Array | Uint32Array,
    type: string,
    componentType: number,
    target: number,
    extra: Record<string, unknown> = {},
  ): number => {
    views.push({
      data: new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength),
      target,
    });
    const comps = type === "SCALAR" ? 1 : type === "VEC2" ? 2 : 3;
    accessors.push({
      bufferView: views.length - 1,
      componentType,
      count: arr.length / comps,
      type,
      ...extra,
    });
    return accessors.length - 1;
  };
  const FLOAT = 5126;
  const UINT = 5125;
  const ARRAY_BUFFER = 34962;
  const ELEMENT_ARRAY_BUFFER = 34963;

  attributes.POSITION = add(mesh.positions, "VEC3", FLOAT, ARRAY_BUFFER, {
    min,
    max,
  });
  if (mesh.normals && mesh.normals.length === mesh.positions.length)
    attributes.NORMAL = add(mesh.normals, "VEC3", FLOAT, ARRAY_BUFFER);
  if (mesh.uvs && mesh.uvs.length === vertexCount * 2)
    attributes.TEXCOORD_0 = add(mesh.uvs, "VEC2", FLOAT, ARRAY_BUFFER);
  if (mesh.colors && mesh.colors.length === mesh.positions.length)
    attributes.COLOR_0 = add(mesh.colors, "VEC3", FLOAT, ARRAY_BUFFER);
  const indices = add(mesh.indices, "SCALAR", UINT, ELEMENT_ARRAY_BUFFER);

  let offset = 0;
  const bufferViews = views.map((v) => {
    const view = {
      buffer: 0,
      byteOffset: offset,
      byteLength: v.data.byteLength,
      target: v.target,
    };
    offset = pad4(offset + v.data.byteLength);
    return view;
  });
  const binLength = offset;

  const gltf = {
    asset: { version: "2.0", generator: "Adrift" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: [{ attributes, indices, mode: 4 }] }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLength }],
  };
  return packGlb(
    gltf,
    views.map((v, i) => ({ data: v.data, byteOffset: bufferViews[i].byteOffset })),
    binLength,
  );
}

// ---------------------------------------------------------------- OBJ

/** Parse a Wavefront OBJ (v/vt/vn/f, polygons fan-triangulated). */
export function parseObj(text: string): TriMesh {
  const v: number[] = [];
  const vc: number[] = [];
  let hasColor = false;
  const vt: number[] = [];
  const vn: number[] = [];
  const outPos: number[] = [];
  const outNrm: number[] = [];
  const outUv: number[] = [];
  const outCol: number[] = [];
  const indices: number[] = [];
  const remap = new Map<string, number>();
  let anyUv = false;
  let anyNormal = false;

  const resolve = (raw: string, count: number): number => {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n === 0) return -1;
    const idx = n < 0 ? count + n : n - 1;
    return idx >= 0 && idx < count ? idx : -1;
  };

  const vertexFor = (token: string): number => {
    const cached = remap.get(token);
    if (cached !== undefined) return cached;
    const [a, b, c] = token.split("/");
    const pi = resolve(a, v.length / 3);
    if (pi < 0) throw new MeshConvertError(`Bad face index "${token}"`);
    const ti = b ? resolve(b, vt.length / 2) : -1;
    const ni = c ? resolve(c, vn.length / 3) : -1;
    const id = outPos.length / 3;
    if (id >= MAX_VERTICES) throw new MeshConvertError("Mesh is too large");
    outPos.push(v[pi * 3], v[pi * 3 + 1], v[pi * 3 + 2]);
    outCol.push(vc[pi * 3], vc[pi * 3 + 1], vc[pi * 3 + 2]);
    if (ti >= 0) {
      anyUv = true;
      outUv.push(vt[ti * 2], 1 - vt[ti * 2 + 1]);
    } else outUv.push(0, 0);
    if (ni >= 0) {
      anyNormal = true;
      outNrm.push(vn[ni * 3], vn[ni * 3 + 1], vn[ni * 3 + 2]);
    } else outNrm.push(0, 0, 0);
    remap.set(token, id);
    return id;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    if (tag === "v") {
      const nums = parts.slice(1).map(Number);
      if (nums.length < 3 || nums.slice(0, 3).some((x) => !Number.isFinite(x)))
        throw new MeshConvertError("Bad vertex line");
      v.push(nums[0], nums[1], nums[2]);
      if (nums.length >= 6 && nums.slice(3, 6).every(Number.isFinite)) {
        hasColor = true;
        // Colours may be 0..1 or 0..255; either way they are sRGB.
        const scale = nums.slice(3, 6).some((x) => x > 1) ? 1 / 255 : 1;
        vc.push(
          srgbToLinear(nums[3] * scale),
          srgbToLinear(nums[4] * scale),
          srgbToLinear(nums[5] * scale),
        );
      } else vc.push(1, 1, 1);
    } else if (tag === "vt") {
      vt.push(Number(parts[1]) || 0, Number(parts[2]) || 0);
    } else if (tag === "vn") {
      vn.push(
        Number(parts[1]) || 0,
        Number(parts[2]) || 0,
        Number(parts[3]) || 0,
      );
    } else if (tag === "f") {
      const ids = parts.slice(1).map(vertexFor);
      for (let i = 1; i + 1 < ids.length; i++)
        indices.push(ids[0], ids[i], ids[i + 1]);
    }
  }
  if (indices.length === 0) throw new MeshConvertError("OBJ has no faces");
  return {
    positions: Float32Array.from(outPos),
    normals: anyNormal ? Float32Array.from(outNrm) : undefined,
    uvs: anyUv ? Float32Array.from(outUv) : undefined,
    colors: hasColor ? Float32Array.from(outCol) : undefined,
    indices: Uint32Array.from(indices),
  };
}

// ---------------------------------------------------------------- PLY

type PlyScalar =
  | "int8"
  | "uint8"
  | "int16"
  | "uint16"
  | "int32"
  | "uint32"
  | "float32"
  | "float64";

const PLY_TYPES: Record<string, PlyScalar> = {
  char: "int8",
  int8: "int8",
  uchar: "uint8",
  uint8: "uint8",
  short: "int16",
  int16: "int16",
  ushort: "uint16",
  uint16: "uint16",
  int: "int32",
  int32: "int32",
  uint: "uint32",
  uint32: "uint32",
  float: "float32",
  float32: "float32",
  double: "float64",
  float64: "float64",
};

const PLY_SIZE: Record<PlyScalar, number> = {
  int8: 1,
  uint8: 1,
  int16: 2,
  uint16: 2,
  int32: 4,
  uint32: 4,
  float32: 4,
  float64: 8,
};

interface PlyProperty {
  name: string;
  type: PlyScalar;
  /** Set for list properties: the type of the leading count. */
  countType?: PlyScalar;
}

interface PlyElement {
  name: string;
  count: number;
  props: PlyProperty[];
}

export interface PlyHeader {
  format: "ascii" | "binary_little_endian" | "binary_big_endian";
  elements: PlyElement[];
  /** Byte offset of the body. */
  bodyOffset: number;
}

export type PlyKind = "mesh" | "points" | "splat";

/** Parse a PLY header. Throws when the bytes are not a PLY file. */
export function parsePlyHeader(bytes: Uint8Array): PlyHeader {
  const limit = Math.min(bytes.length, 64 * 1024);
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, limit));
  if (!/^ply\r?\n/.test(head)) throw new MeshConvertError("Not a PLY file");
  const end = head.search(/end_header\r?\n/);
  if (end < 0) throw new MeshConvertError("PLY header is incomplete");
  const endLine = /end_header\r?\n/.exec(head.slice(end))![0];
  const lines = head.slice(0, end).split(/\r?\n/);
  let format: PlyHeader["format"] | null = null;
  const elements: PlyElement[] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === "format") {
      if (
        parts[1] === "ascii" ||
        parts[1] === "binary_little_endian" ||
        parts[1] === "binary_big_endian"
      )
        format = parts[1];
      else throw new MeshConvertError(`Unknown PLY format ${parts[1]}`);
    } else if (parts[0] === "element") {
      const count = Number.parseInt(parts[2], 10);
      if (!Number.isFinite(count) || count < 0)
        throw new MeshConvertError("Bad PLY element count");
      elements.push({ name: parts[1], count, props: [] });
    } else if (parts[0] === "property") {
      const el = elements.at(-1);
      if (!el) throw new MeshConvertError("PLY property before element");
      if (parts[1] === "list") {
        const countType = PLY_TYPES[parts[2]];
        const type = PLY_TYPES[parts[3]];
        if (!countType || !type)
          throw new MeshConvertError("Unknown PLY list type");
        el.props.push({ name: parts[4], type, countType });
      } else {
        const type = PLY_TYPES[parts[1]];
        if (!type) throw new MeshConvertError(`Unknown PLY type ${parts[1]}`);
        el.props.push({ name: parts[2], type });
      }
    }
  }
  if (!format) throw new MeshConvertError("PLY header has no format");
  return { format, elements, bodyOffset: end + endLine.length };
}

/** Mesh (has faces), splat (3DGS attributes) or plain point cloud. */
export function plyKind(header: PlyHeader): PlyKind {
  const vertex = header.elements.find((e) => e.name === "vertex");
  const names = new Set(vertex?.props.map((p) => p.name));
  if (names.has("f_dc_0") || (names.has("opacity") && names.has("scale_0")))
    return "splat";
  const face = header.elements.find((e) => e.name === "face");
  return face && face.count > 0 ? "mesh" : "points";
}

/** Sniff a PLY file's kind; null when it is not a readable PLY. */
export function sniffPly(bytes: Uint8Array): PlyKind | null {
  try {
    return plyKind(parsePlyHeader(bytes));
  } catch {
    return null;
  }
}

/** Sequential reader over a PLY body (binary or ascii). */
class PlyReader {
  private p: number;
  private tokens: string[] | null = null;
  private t = 0;
  private dv: DataView;
  private little: boolean;

  constructor(
    private bytes: Uint8Array,
    private header: PlyHeader,
  ) {
    this.p = header.bodyOffset;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.little = header.format !== "binary_big_endian";
    if (header.format === "ascii") {
      this.tokens = new TextDecoder("latin1")
        .decode(bytes.subarray(header.bodyOffset))
        .split(/\s+/)
        .filter(Boolean);
    }
  }

  read(type: PlyScalar): number {
    if (this.tokens) {
      if (this.t >= this.tokens.length)
        throw new MeshConvertError("PLY body is truncated");
      return Number(this.tokens[this.t++]);
    }
    const size = PLY_SIZE[type];
    if (this.p + size > this.bytes.length)
      throw new MeshConvertError("PLY body is truncated");
    const dv = this.dv;
    const p = this.p;
    this.p += size;
    switch (type) {
      case "int8":
        return dv.getInt8(p);
      case "uint8":
        return dv.getUint8(p);
      case "int16":
        return dv.getInt16(p, this.little);
      case "uint16":
        return dv.getUint16(p, this.little);
      case "int32":
        return dv.getInt32(p, this.little);
      case "uint32":
        return dv.getUint32(p, this.little);
      case "float32":
        return dv.getFloat32(p, this.little);
      case "float64":
        return dv.getFloat64(p, this.little);
    }
  }
}

/**
 * Read every element of a PLY, keeping only the requested vertex properties
 * and the face index lists. `wanted` names map to output columns.
 */
function readPly(
  bytes: Uint8Array,
  header: PlyHeader,
  wanted: readonly string[],
): {
  columns: Map<string, Float32Array>;
  vertexCount: number;
  faces: number[];
} {
  const r = new PlyReader(bytes, header);
  const columns = new Map<string, Float32Array>();
  const faces: number[] = [];
  let vertexCount = 0;
  for (const el of header.elements) {
    if (el.name === "vertex") {
      if (el.count > MAX_VERTICES)
        throw new MeshConvertError("PLY is too large");
      vertexCount = el.count;
      const slots = el.props.map((p) =>
        wanted.includes(p.name) && !p.countType
          ? (columns.get(p.name) ??
            columns.set(p.name, new Float32Array(el.count)).get(p.name)!)
          : null,
      );
      for (let i = 0; i < el.count; i++) {
        for (let k = 0; k < el.props.length; k++) {
          const prop = el.props[k];
          if (prop.countType) {
            const n = r.read(prop.countType);
            for (let j = 0; j < n; j++) r.read(prop.type);
            continue;
          }
          const value = r.read(prop.type);
          const col = slots[k];
          if (col) col[i] = value;
        }
      }
    } else if (el.name === "face") {
      for (let i = 0; i < el.count; i++) {
        for (const prop of el.props) {
          if (!prop.countType) {
            r.read(prop.type);
            continue;
          }
          const n = r.read(prop.countType);
          const ids: number[] = [];
          for (let j = 0; j < n; j++) ids.push(r.read(prop.type));
          if (prop.name !== "vertex_indices" && prop.name !== "vertex_index")
            continue;
          for (let j = 1; j + 1 < ids.length; j++)
            faces.push(ids[0], ids[j], ids[j + 1]);
        }
      }
    } else {
      // Once vertex and face are read the rest is not needed; unknown
      // elements before them must still be skipped over.
      const at = header.elements.indexOf(el);
      if (
        !header.elements
          .slice(at + 1)
          .some((e) => e.name === "vertex" || e.name === "face")
      )
        break;
      for (let i = 0; i < el.count; i++)
        for (const prop of el.props) {
          if (prop.countType) {
            const n = r.read(prop.countType);
            for (let j = 0; j < n; j++) r.read(prop.type);
          } else r.read(prop.type);
        }
    }
  }
  return { columns, vertexCount, faces };
}

const MESH_PROPS = [
  "x",
  "y",
  "z",
  "nx",
  "ny",
  "nz",
  "red",
  "green",
  "blue",
  "s",
  "t",
  "u",
  "v",
  "texture_u",
  "texture_v",
] as const;

/** Mesh PLY (with faces) → triangle mesh. */
export function parsePlyMesh(bytes: Uint8Array): TriMesh {
  const header = parsePlyHeader(bytes);
  if (plyKind(header) !== "mesh")
    throw new MeshConvertError("PLY has no faces");
  const vertexEl = header.elements.find((e) => e.name === "vertex");
  const { columns, vertexCount, faces } = readPly(bytes, header, MESH_PROPS);
  const x = columns.get("x");
  const y = columns.get("y");
  const z = columns.get("z");
  if (!x || !y || !z || vertexCount === 0)
    throw new MeshConvertError("PLY vertices lack x/y/z");
  for (const id of faces)
    if (id < 0 || id >= vertexCount)
      throw new MeshConvertError("PLY face index out of range");

  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3] = x[i];
    positions[i * 3 + 1] = y[i];
    positions[i * 3 + 2] = z[i];
  }
  let normals: Float32Array | undefined;
  const nx = columns.get("nx");
  const ny = columns.get("ny");
  const nz = columns.get("nz");
  if (nx && ny && nz) {
    normals = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      normals[i * 3] = nx[i];
      normals[i * 3 + 1] = ny[i];
      normals[i * 3 + 2] = nz[i];
    }
  }
  let colors: Float32Array | undefined;
  const red = columns.get("red");
  const green = columns.get("green");
  const blue = columns.get("blue");
  if (red && green && blue) {
    const redType = vertexEl?.props.find((p) => p.name === "red")?.type;
    const scale = redType === "float32" || redType === "float64" ? 1 : 1 / 255;
    colors = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      colors[i * 3] = srgbToLinear(red[i] * scale);
      colors[i * 3 + 1] = srgbToLinear(green[i] * scale);
      colors[i * 3 + 2] = srgbToLinear(blue[i] * scale);
    }
  }
  let uvs: Float32Array | undefined;
  const u = columns.get("s") ?? columns.get("u") ?? columns.get("texture_u");
  const v = columns.get("t") ?? columns.get("v") ?? columns.get("texture_v");
  if (u && v) {
    uvs = new Float32Array(vertexCount * 2);
    for (let i = 0; i < vertexCount; i++) {
      uvs[i * 2] = u[i];
      uvs[i * 2 + 1] = 1 - v[i];
    }
  }
  return {
    positions,
    normals,
    colors,
    uvs,
    indices: Uint32Array.from(faces),
  };
}

const SPLAT_PROPS = [
  "x",
  "y",
  "z",
  "f_dc_0",
  "f_dc_1",
  "f_dc_2",
  "opacity",
  "red",
  "green",
  "blue",
];

/** 3DGS splat PLY → coloured points (SH band 0 colour, sigmoid opacity). */
export function splatPlyToPoints(bytes: Uint8Array): PointCloud {
  const header = parsePlyHeader(bytes);
  const { columns, vertexCount } = readPly(bytes, header, SPLAT_PROPS);
  const x = columns.get("x");
  const y = columns.get("y");
  const z = columns.get("z");
  if (!x || !y || !z) throw new MeshConvertError("PLY vertices lack x/y/z");
  const dc = [
    columns.get("f_dc_0"),
    columns.get("f_dc_1"),
    columns.get("f_dc_2"),
  ];
  const rgb = [columns.get("red"), columns.get("green"), columns.get("blue")];
  const opacity = columns.get("opacity");
  const pos: number[] = [];
  const col: number[] = [];
  for (let i = 0; i < vertexCount; i++) {
    if (opacity && 1 / (1 + Math.exp(-opacity[i])) < MIN_SPLAT_ALPHA) continue;
    pos.push(x[i], y[i], z[i]);
    for (let k = 0; k < 3; k++) {
      const d = dc[k];
      const c = rgb[k];
      col.push(
        d ? clampByte((0.5 + SH_C0 * d[i]) * 255) : c ? clampByte(c[i]) : 200,
      );
    }
  }
  return { positions: Float32Array.from(pos), colors: Uint8Array.from(col) };
}

/** antimatter15 .splat (32 bytes per splat) → coloured points. */
export function splatFileToPoints(bytes: Uint8Array): PointCloud {
  const ROW = 32;
  if (bytes.length === 0 || bytes.length % ROW !== 0)
    throw new MeshConvertError("Not a .splat file");
  const n = bytes.length / ROW;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pos: number[] = [];
  const col: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * ROW;
    if (bytes[o + 27] / 255 < MIN_SPLAT_ALPHA) continue;
    pos.push(
      dv.getFloat32(o, true),
      dv.getFloat32(o + 4, true),
      dv.getFloat32(o + 8, true),
    );
    col.push(bytes[o + 24], bytes[o + 25], bytes[o + 26]);
  }
  return { positions: Float32Array.from(pos), colors: Uint8Array.from(col) };
}

/** Niantic .spz (gzipped, versions 2-3) → coloured points. */
export function spzToPoints(bytes: Uint8Array): PointCloud {
  let raw: Buffer;
  try {
    raw = gunzipSync(bytes, { maxOutputLength: 2 * 1024 * 1024 * 1024 - 1 });
  } catch {
    throw new MeshConvertError("Not a gzipped .spz file");
  }
  if (raw.length < 16 || raw.readUInt32LE(0) !== 0x5053474e)
    throw new MeshConvertError("Not an .spz file");
  const version = raw.readUInt32LE(4);
  if (version < 2 || version > 3)
    throw new MeshConvertError(`Unsupported .spz version ${version}`);
  const n = raw.readUInt32LE(8);
  const fractionalBits = raw[13];
  const posStart = 16;
  const alphaStart = posStart + n * 9;
  const colorStart = alphaStart + n;
  if (colorStart + n * 3 > raw.length)
    throw new MeshConvertError(".spz file is truncated");
  const scale = 1 / (1 << fractionalBits);
  const int24 = (o: number) => {
    let v = raw[o] | (raw[o + 1] << 8) | (raw[o + 2] << 16);
    if (v & 0x800000) v |= ~0xffffff;
    return v * scale;
  };
  const pos: number[] = [];
  const col: number[] = [];
  for (let i = 0; i < n; i++) {
    if (raw[alphaStart + i] / 255 < MIN_SPLAT_ALPHA) continue;
    const o = posStart + i * 9;
    pos.push(int24(o), int24(o + 3), int24(o + 6));
    for (let k = 0; k < 3; k++) {
      const dc = (raw[colorStart + i * 3 + k] / 255 - 0.5) / 0.15;
      col.push(clampByte((0.5 + SH_C0 * dc) * 255));
    }
  }
  return { positions: Float32Array.from(pos), colors: Uint8Array.from(col) };
}

/** Binary little-endian PLY with x/y/z floats and 8-bit red/green/blue. */
export function writePointsPly(points: PointCloud): Uint8Array {
  const n = points.positions.length / 3;
  if (points.colors.length !== n * 3)
    throw new MeshConvertError("Point colours do not match positions");
  const head = new TextEncoder().encode(
    [
      "ply",
      "format binary_little_endian 1.0",
      "comment Adrift point preview of a Gaussian splat",
      `element vertex ${n}`,
      "property float x",
      "property float y",
      "property float z",
      "property uchar red",
      "property uchar green",
      "property uchar blue",
      "end_header",
      "",
    ].join("\n"),
  );
  const ROW = 15;
  const out = new Uint8Array(head.length + n * ROW);
  out.set(head, 0);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    const o = head.length + i * ROW;
    dv.setFloat32(o, points.positions[i * 3], true);
    dv.setFloat32(o + 4, points.positions[i * 3 + 1], true);
    dv.setFloat32(o + 8, points.positions[i * 3 + 2], true);
    out[o + 12] = points.colors[i * 3];
    out[o + 13] = points.colors[i * 3 + 1];
    out[o + 14] = points.colors[i * 3 + 2];
  }
  return out;
}

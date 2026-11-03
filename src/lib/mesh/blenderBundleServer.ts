/**
 * Server side of "Export for Blender": validate output refs from a request,
 * fetch the files through ComfyUI's /view (works for local and remote
 * ComfyUI), and build the bundle. Shared by the download and open routes.
 */

import { fetchImageResponse } from "@/lib/comfy/http";
import { layerBundleFiles, type BundlePart } from "@/lib/layers/bundle";
import {
  canvasSize,
  LayerManifestError,
  parseLayerManifest,
} from "@/lib/layers/seeThrough";
import {
  MAX_BUNDLE_FILES,
  validAspect,
  validFov,
  validLayerManifest,
  type BlenderSource,
  type MeshOutputRef,
} from "./blenderLinks";
import {
  buildBlenderBundle,
  safeStem,
  type BlenderBundle,
  type BlenderBundleOptions,
  type BundleInput,
} from "./blenderBundle";
import { buildThreejsBundle, type ThreejsBundle } from "./threejsBundle";
import { validateOutputRef } from "./usdz";

/** Total bytes a bundle may pull in (splats can be a few hundred MB). */
export const MAX_BUNDLE_BYTES = 768 * 1024 * 1024;

const TYPES = new Set(["output", "input", "temp"]);
const EXT_RE = /\.(glb|gltf|obj|ply|stl|fbx|usdz|bvh|splat|spz|ksplat)$/i;

/** Validate a list of refs; null when any is bad or the list is empty/too long. */
export function validateMeshRefs(
  raw: ReadonlyArray<{ filename: unknown; subfolder: unknown; type: unknown }>,
): MeshOutputRef[] | null {
  if (raw.length === 0 || raw.length > MAX_BUNDLE_FILES) return null;
  const out: MeshOutputRef[] = [];
  for (const r of raw) {
    const ref = validateOutputRef(r.filename, r.subfolder);
    if (!ref || !EXT_RE.test(ref.filename)) return null;
    const type =
      r.type === undefined || r.type === null || r.type === ""
        ? "output"
        : r.type;
    if (typeof type !== "string" || !TYPES.has(type)) return null;
    out.push({ ...ref, type: type as MeshOutputRef["type"] });
  }
  return out;
}

/** Refs from repeated filename/subfolder/type query params (same order). */
export function meshRefsFromQuery(
  params: URLSearchParams,
): MeshOutputRef[] | null {
  const names = params.getAll("filename");
  const subs = params.getAll("subfolder");
  const types = params.getAll("type");
  return validateMeshRefs(
    names.map((filename, i) => ({
      filename,
      subfolder: subs[i] ?? "",
      type: types[i] ?? "output",
    })),
  );
}

export class BundleFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BundleFetchError";
  }
}

async function readCapped(res: Response, budget: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > budget)
    throw new BundleFetchError("The 3D files are too large to bundle", 413);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > budget) {
      await reader.cancel().catch(() => {});
      throw new BundleFetchError("The 3D files are too large to bundle", 413);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.byteLength;
  }
  return out;
}

type Fetcher = typeof fetchImageResponse;

async function fetchOne(
  fetcher: Fetcher,
  filename: string,
  subfolder: string,
  type: string,
): Promise<Response> {
  try {
    return await fetcher(filename, subfolder, type);
  } catch (err) {
    const status =
      err &&
      typeof err === "object" &&
      "statusCode" in err &&
      err.statusCode === 404
        ? 404
        : 502;
    throw new BundleFetchError(`Could not read ${filename}`, status);
  }
}

async function loadInputs(
  refs: readonly MeshOutputRef[],
  fetcher: Fetcher,
): Promise<BundleInput[]> {
  let budget = MAX_BUNDLE_BYTES;
  const inputs = [];
  for (const ref of refs) {
    const res = await fetchOne(fetcher, ref.filename, ref.subfolder, ref.type);
    const data = await readCapped(res, budget);
    budget -= data.byteLength;
    inputs.push({ name: ref.filename, data });
  }
  return inputs;
}

/** Fetch every file and build the bundle. */
export async function loadBlenderBundle(
  refs: readonly MeshOutputRef[],
  fetcher: Fetcher = fetchImageResponse,
  options: BlenderBundleOptions = {},
): Promise<BlenderBundle> {
  return buildBlenderBundle(await loadInputs(refs, fetcher), options);
}

/** Fetch every file and build the Three.js bundle. */
export async function loadThreejsBundle(
  refs: readonly MeshOutputRef[],
  fetcher: Fetcher = fetchImageResponse,
): Promise<ThreejsBundle> {
  return buildThreejsBundle(await loadInputs(refs, fetcher));
}

/** One GLB's bytes through ComfyUI's /view, for conversions (local or remote). */
export async function loadGlbBytes(
  ref: MeshOutputRef,
  fetcher: Fetcher = fetchImageResponse,
): Promise<Uint8Array> {
  return readCapped(
    await fetchOne(fetcher, ref.filename, ref.subfolder, ref.type),
    MAX_BUNDLE_BYTES,
  );
}

/** A Layer Split manifest is small; anything bigger is not one. */
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
/** Most parts one Layer Split export takes. */
export const MAX_LAYER_PARTS = 128;

/**
 * Layer Split → Blender: read `<prefix>_layers.json` and every part (and
 * depth) PNG it names from the output root, and lay them out as the
 * client-side Layer Split export does (layerBundleFiles "blender").
 */
export async function loadLayerBlenderBundle(
  src: { manifest: string; resolution?: number | null; aspect?: number | null },
  fetcher: Fetcher = fetchImageResponse,
): Promise<BlenderBundle> {
  const manifestName = validLayerManifest(src.manifest);
  if (!manifestName) throw new BundleFetchError("Bad layer manifest name", 400);
  const raw = await readCapped(
    await fetchOne(fetcher, manifestName, "", "output"),
    MAX_MANIFEST_BYTES,
  ).catch((err) => {
    if (err instanceof BundleFetchError && err.status === 413)
      throw new BundleFetchError("Layer manifest is too large", 413);
    throw err;
  });
  let manifest;
  try {
    manifest = parseLayerManifest(JSON.parse(new TextDecoder().decode(raw)));
  } catch (err) {
    const message =
      err instanceof LayerManifestError ? err.message : "Unreadable layer manifest";
    throw new BundleFetchError(message, 422);
  }
  if (manifest.layers.length > MAX_LAYER_PARTS)
    throw new BundleFetchError("Too many layers to bundle", 413);
  const canvas = canvasSize(manifest, src.resolution);

  let budget = MAX_BUNDLE_BYTES;
  const read = async (filename: string): Promise<Uint8Array> => {
    const data = await readCapped(
      await fetchOne(fetcher, filename, "", "output"),
      budget,
    );
    budget -= data.byteLength;
    return data;
  };
  const parts: BundlePart[] = [];
  for (const l of manifest.layers) {
    const png = await read(l.filename);
    let depthPng: Uint8Array | null = null;
    if (l.depthFilename) {
      try {
        depthPng = await read(l.depthFilename);
      } catch (err) {
        if (err instanceof BundleFetchError && err.status === 413) throw err;
        depthPng = null;
      }
    }
    parts.push({
      name: l.name,
      left: l.left,
      top: l.top,
      width: l.right - l.left,
      height: l.bottom - l.top,
      depthMedian: l.depthMedian,
      png,
      depthPng,
    });
  }

  const files = layerBundleFiles("blender", {
    manifest,
    canvas,
    parts,
    aspect: src.aspect,
  });
  const name = safeStem(manifestName.replace(/_layers\.json$/i, "") + "_layers");
  return {
    name,
    scriptName: "import_layers.py",
    files: files.map((f) => ({ path: f.name, data: f.data })),
    assets: [],
    notes: [],
  };
}

function validResolution(value: unknown): number | null {
  const res = Number(value);
  return Number.isInteger(res) && res >= 256 && res <= 8192 ? res : null;
}

/** One request's export source from query params, or null when invalid. */
export function blenderSourceFromQuery(
  params: URLSearchParams,
): BlenderSource | null {
  const aspect = validAspect(params.get("aspect"));
  if (params.has("layers")) {
    const manifest = validLayerManifest(params.get("layers"));
    if (!manifest) return null;
    return {
      kind: "layers",
      manifest,
      resolution: validResolution(params.get("res")),
      aspect,
    };
  }
  const refs = meshRefsFromQuery(params);
  if (!refs) return null;
  return {
    kind: "mesh",
    refs,
    camera: validFov(params.get("fovx"), params.get("fovy")),
    aspect,
  };
}

/** One request's export source from a JSON body, or null when invalid. */
export function blenderSourceFromBody(body: unknown): BlenderSource | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.layers && typeof b.layers === "object") {
    const l = b.layers as Record<string, unknown>;
    const manifest = validLayerManifest(l.manifest);
    if (!manifest) return null;
    return {
      kind: "layers",
      manifest,
      resolution: validResolution(l.resolution),
      aspect: validAspect(l.aspect),
    };
  }
  if (!Array.isArray(b.files)) return null;
  const refs = validateMeshRefs(
    b.files.map((f) =>
      f && typeof f === "object"
        ? (f as { filename: unknown; subfolder: unknown; type: unknown })
        : { filename: null, subfolder: null, type: null },
    ),
  );
  if (!refs) return null;
  const cam =
    b.camera && typeof b.camera === "object"
      ? (b.camera as Record<string, unknown>)
      : null;
  return {
    kind: "mesh",
    refs,
    camera: cam ? validFov(cam.fovX, cam.fovY) : null,
    aspect: validAspect(b.aspect),
  };
}

/** Fetch and build the bundle for any export source. */
export function loadBlenderSource(
  src: BlenderSource,
  fetcher: Fetcher = fetchImageResponse,
): Promise<BlenderBundle> {
  return src.kind === "layers"
    ? loadLayerBlenderBundle(src, fetcher)
    : loadBlenderBundle(src.refs, fetcher, {
        sourceCamera: src.camera,
        aspect: src.aspect,
      });
}

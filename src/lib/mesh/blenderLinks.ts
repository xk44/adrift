/**
 * Client-safe helpers for the "Export for Blender" actions: turn a job's 3D
 * view URLs (/api/comfy/image?filename=…&subfolder=…&type=…) into output
 * refs and the bundle download URL. No Node imports.
 */

import {
  layerRunResolution,
  manifestBasename,
  manifestPathFromTexts,
} from "@/lib/layers/seeThrough";

export interface MeshOutputRef {
  filename: string;
  subfolder: string;
  type: "output" | "input" | "temp";
}

export const BLENDER_BUNDLE_PATH = "/api/comfy/blender-bundle";
export const BLENDER_OPEN_PATH = "/api/comfy/blender-bundle/open";
export const FBX_PATH = "/api/comfy/fbx";
export const THREEJS_BUNDLE_PATH = "/api/comfy/threejs-bundle";
/** Most files one bundle takes (a job has a handful of 3D outputs). */
export const MAX_BUNDLE_FILES = 8;

const BLENDER_EXT_RE =
  /\.(glb|gltf|obj|ply|stl|fbx|usdz|bvh|splat|spz|ksplat)$/i;
const TYPES = new Set(["output", "input", "temp"]);

/** Output ref of one proxied 3D view URL, or null for anything else. */
export function meshRefFromUrl(url: string | undefined): MeshOutputRef | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url, "http://local");
  } catch {
    return null;
  }
  if (u.pathname !== "/api/comfy/image") return null;
  const filename = u.searchParams.get("filename");
  if (!filename || !BLENDER_EXT_RE.test(filename)) return null;
  const type = u.searchParams.get("type") || "output";
  if (!TYPES.has(type)) return null;
  return {
    filename,
    subfolder: u.searchParams.get("subfolder") ?? "",
    type: type as MeshOutputRef["type"],
  };
}

/** Distinct refs for a job's 3D URLs, capped at MAX_BUNDLE_FILES. */
export function meshRefsFromUrls(
  urls: readonly (string | undefined)[] | undefined,
): MeshOutputRef[] {
  const seen = new Set<string>();
  const out: MeshOutputRef[] = [];
  for (const url of urls ?? []) {
    const ref = meshRefFromUrl(url);
    if (!ref) continue;
    const key = `${ref.type}\0${ref.subfolder}\0${ref.filename}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
    if (out.length >= MAX_BUNDLE_FILES) break;
  }
  return out;
}

/** Download URL of the Blender bundle for these files, or null if none. */
export function blenderBundleHref(
  urls: readonly (string | undefined)[] | undefined,
): string | null {
  const refs = meshRefsFromUrls(urls);
  if (refs.length === 0) return null;
  const q = new URLSearchParams();
  for (const r of refs) {
    q.append("filename", r.filename);
    q.append("subfolder", r.subfolder);
    q.append("type", r.type);
  }
  return `${BLENDER_BUNDLE_PATH}?${q}`;
}

/** The GLB an FBX export converts: the first one, or null if there is none. */
export function fbxRefFor(refs: readonly MeshOutputRef[]): MeshOutputRef | null {
  return refs.find((r) => /\.glb$/i.test(r.filename)) ?? null;
}

/** Download URL of the FBX for one GLB. */
export function fbxHref(ref: MeshOutputRef): string {
  const q = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder,
    type: ref.type,
  });
  return `${FBX_PATH}?${q}`;
}

/** Download URL of the Three.js zip for these files, or null if none. */
export function threejsBundleHref(refs: readonly MeshOutputRef[]): string | null {
  if (refs.length === 0 || refs.every((r) => /\.(bvh|usdz)$/i.test(r.filename)))
    return null;
  const q = new URLSearchParams();
  for (const r of refs) {
    q.append("filename", r.filename);
    q.append("subfolder", r.subfolder);
    q.append("type", r.type);
  }
  return `${THREEJS_BUNDLE_PATH}?${q}`;
}

// ------------------------------------------------ unified export source

/** Camera FOV (degrees) a model was reconstructed from. */
export interface SourceCameraFov {
  fovX: number;
  fovY: number;
}

/** What one "Export for Blender" covers: 3D files, or a Layer Split result. */
export type BlenderSource =
  | {
      kind: "mesh";
      refs: MeshOutputRef[];
      camera?: SourceCameraFov | null;
      aspect?: number | null;
    }
  | {
      kind: "layers";
      /** Basename of the `<prefix>_layers.json` manifest in the output root. */
      manifest: string;
      resolution?: number | null;
      aspect?: number | null;
    };

const FOV_RE =
  /Estimated FOV:\s*([0-9]+(?:\.[0-9]+)?)\s*°?\s*horizontal,\s*([0-9]+(?:\.[0-9]+)?)\s*°?\s*vertical/i;
const LAYER_MANIFEST_RE = /^[A-Za-z0-9 ._()+-]{1,255}_layers\.json$/i;
export const LAYER_SPLIT_ACTION = "see_through";

/** Valid FOV pair in degrees, or null. */
export function validFov(
  fovX: unknown,
  fovY: unknown,
): SourceCameraFov | null {
  const x = Number(fovX);
  const y = Number(fovY);
  const ok = (v: number) => Number.isFinite(v) && v >= 1 && v <= 179;
  return ok(x) && ok(y) ? { fovX: x, fovY: y } : null;
}

/** Aspect (width / height) clamped to 1:16..16:1, or null. */
export function validAspect(value: unknown): number | null {
  const a = Number(value);
  return Number.isFinite(a) && a >= 1 / 16 && a <= 16 ? a : null;
}

/** A plain Layer Split manifest basename, or null. */
export function validLayerManifest(value: unknown): string | null {
  return typeof value === "string" &&
    LAYER_MANIFEST_RE.test(value) &&
    !value.includes("..")
    ? value
    : null;
}

/** The FOV a MoGe "Depth & normals" run printed ("Estimated FOV: …"), or null. */
export function mogeFovFromTexts(
  texts: readonly unknown[] | undefined | null,
): SourceCameraFov | null {
  for (const t of texts ?? []) {
    if (typeof t !== "string") continue;
    const m = FOV_RE.exec(t);
    if (m) return validFov(m[1], m[2]);
  }
  return null;
}

export interface BlenderSourceInput {
  /** The job's 3D view URLs. */
  meshUrls?: readonly (string | undefined)[];
  /** The job's text outputs (MoGe FOV line, Layer Split manifest path). */
  texts?: readonly unknown[];
  /** The run's action id. */
  action?: string;
  /** The run's params (Layer Split detail / resolution). */
  params?: Record<string, unknown> | null;
  /** Source image size, for the camera aspect. */
  width?: number;
  height?: number;
}

/** The Blender export for a job, or null when it has nothing 3D. */
export function blenderSourceFor(input: BlenderSourceInput): BlenderSource | null {
  const aspect =
    input.width && input.height
      ? validAspect(input.width / input.height)
      : null;
  const refs = meshRefsFromUrls(input.meshUrls);
  if (refs.length > 0)
    return {
      kind: "mesh",
      refs,
      camera: mogeFovFromTexts(input.texts),
      aspect,
    };
  const path =
    input.action === LAYER_SPLIT_ACTION || input.action === undefined
      ? manifestPathFromTexts(input.texts)
      : null;
  const manifest = path ? validLayerManifest(manifestBasename(path)) : null;
  if (manifest)
    return {
      kind: "layers",
      manifest,
      resolution: layerRunResolution(input.params),
      aspect,
    };
  return null;
}

/** Download URL of the Blender bundle for a source. */
export function blenderSourceHref(src: BlenderSource): string {
  const q = new URLSearchParams();
  if (src.kind === "layers") {
    q.set("layers", src.manifest);
    if (src.resolution) q.set("res", String(src.resolution));
  } else {
    for (const r of src.refs) {
      q.append("filename", r.filename);
      q.append("subfolder", r.subfolder);
      q.append("type", r.type);
    }
    if (src.camera) {
      q.set("fovx", String(src.camera.fovX));
      q.set("fovy", String(src.camera.fovY));
    }
  }
  if (src.aspect) q.set("aspect", String(Number(src.aspect.toFixed(6))));
  return `${BLENDER_BUNDLE_PATH}?${q}`;
}

/** JSON body for POST /api/comfy/blender-bundle/open. */
export function blenderOpenBody(src: BlenderSource): Record<string, unknown> {
  return src.kind === "layers"
    ? {
        layers: {
          manifest: src.manifest,
          resolution: src.resolution ?? null,
          aspect: src.aspect ?? null,
        },
      }
    : {
        files: src.refs,
        camera: src.camera ?? null,
        aspect: src.aspect ?? null,
      };
}

/** GET /api/comfy/blender-bundle/open, as the client reads it. */
export interface BlenderOpenInfo {
  available?: boolean;
  reason?: string;
  path?: string | null;
  version?: string;
}

export const BLENDER_NOT_FOUND =
  "Blender not found. Install it, or set its path in Settings or BLENDER_PATH.";

/**
 * How the "Open in Blender" button looks: hidden when Adrift isn't on this
 * computer (or the check failed), disabled with the reason when Blender is
 * missing, otherwise naming the Blender it will start.
 */
export function blenderOpenButton(
  info: BlenderOpenInfo | null,
): { show: false } | { show: true; disabled: boolean; title: string } {
  if (!info) return { show: false };
  if (info.available) {
    const name = info.version ? `Blender ${info.version}` : "Blender";
    const where = info.path ? ` (${info.path})` : "";
    return {
      show: true,
      disabled: false,
      title: `Save the bundle to the output folder and open it in ${name}${where}`,
    };
  }
  if (info.reason === "no-blender")
    return { show: true, disabled: true, title: BLENDER_NOT_FOUND };
  return { show: false };
}

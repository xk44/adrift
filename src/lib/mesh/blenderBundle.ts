/**
 * "Export for Blender": turn one job's 3D outputs into a folder Blender can
 * open in one step — the model (GLB where possible), a generated
 * import_<name>.py, and a README — packed as a zip.
 *
 * Format routing (blenderRoute):
 *   .glb / .gltf          → as is
 *   .obj, mesh .ply       → converted to .glb (original kept in source/);
 *                           falls back to Blender's own importer on failure
 *   splat .ply/.splat/.spz → point-preview .ply + original in splat/
 *   point-cloud .ply      → as is, shown as points
 *   .ksplat               → original only (no Blender importer)
 *   .stl / .fbx / .usdz / .bvh → as is, Blender's own importer
 *   .usdz next to a .glb  → skipped (it is converted from that .glb)
 */

import { writeZip } from "@/lib/userTools/zip";
import type {
  BlenderImportKind,
  BlenderScriptAsset,
  SourceCamera,
} from "./blenderScript";
import { blenderImportScript } from "./blenderScript";
import {
  parseObj,
  parsePlyMesh,
  sniffPly,
  splatFileToPoints,
  splatPlyToPoints,
  spzToPoints,
  writeGlb,
  writePointsPly,
} from "./meshConvert";

export type BlenderRoute =
  | { action: "copy"; kind: BlenderImportKind }
  | { action: "toGlb"; from: "obj" | "ply"; fallback: BlenderImportKind }
  | { action: "splat"; from: "ply" | "splat" | "spz" }
  | { action: "splatOnly" }
  | { action: "skip"; reason: string };

export interface BundleInput {
  /** Original output file name. */
  name: string;
  data: Uint8Array;
}

export interface BundleFile {
  /** Path inside the bundle folder ("/"-separated). */
  path: string;
  data: Uint8Array | string;
}

export interface BlenderBundle {
  /** Folder / zip base name (safe: [A-Za-z0-9_-]). */
  name: string;
  scriptName: string;
  files: BundleFile[];
  assets: BlenderScriptAsset[];
  notes: string[];
}

function ext(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

/** Decide how one file goes into the bundle. `head` = first bytes, for .ply. */
export function blenderRoute(name: string, head?: Uint8Array): BlenderRoute {
  switch (ext(name)) {
    case "glb":
    case "gltf":
      return { action: "copy", kind: "gltf" };
    case "obj":
      return { action: "toGlb", from: "obj", fallback: "obj" };
    case "ply": {
      const kind = head ? sniffPly(head) : null;
      if (kind === "splat") return { action: "splat", from: "ply" };
      if (kind === "mesh")
        return { action: "toGlb", from: "ply", fallback: "ply" };
      if (kind === "points") return { action: "copy", kind: "points" };
      return { action: "copy", kind: "ply" };
    }
    case "splat":
      return { action: "splat", from: "splat" };
    case "spz":
      return { action: "splat", from: "spz" };
    case "ksplat":
      return { action: "splatOnly" };
    case "stl":
      return { action: "copy", kind: "stl" };
    case "fbx":
      return { action: "copy", kind: "fbx" };
    case "usdz":
      return { action: "copy", kind: "usd" };
    case "bvh":
      return { action: "copy", kind: "bvh" };
    default:
      return { action: "skip", reason: "not a 3D file" };
  }
}

/** File-system-safe stem: letters, digits, "_" and "-", at most 60 chars. */
export function safeStem(name: string): string {
  const stem = name.replace(/\.[^.]*$/, "");
  const clean = stem
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 60);
  return clean || "model";
}

const SPLAT_NOTE =
  "Gaussian splats are not meshes. The *_points.ply file is a coloured point preview " +
  "(one point per splat) that Blender opens on its own. To see the real splat, open the " +
  "file in splat/ with a Gaussian splat add-on for Blender (for example 3DGS Render by " +
  "KIRI Engine) or a splat viewer. Blender 5.3 is due to add its own splat import. " +
  "FBX cannot hold splats: for an FBX, run 3D splat with Mesh on and export that mesh.";

const TEXTURE_NOTE =
  "OBJ and PLY files are converted to GLB with their geometry, UVs and vertex colours. " +
  "Materials and texture images referenced by the original are not included; the " +
  "original file is in source/.";

/**
 * Build the bundle for one job's 3D files. Never throws on bad model data:
 * a file that cannot be converted is shipped as is and noted in the README.
 */
export interface BlenderBundleOptions {
  sourceCamera?: SourceCamera | null;
  aspect?: number | null;
}

export function buildBlenderBundle(
  inputs: readonly BundleInput[],
  options: BlenderBundleOptions = {},
): BlenderBundle {
  const name = safeStem(inputs[0]?.name ?? "model");
  const scriptName = `import_${name}.py`;
  const files: BundleFile[] = [];
  const assets: BlenderScriptAsset[] = [];
  const notes = new Set<string>();
  const used = new Set<string>([scriptName, "README.txt"]);
  const unique = (path: string): string => {
    if (!used.has(path)) {
      used.add(path);
      return path;
    }
    const dot = path.lastIndexOf(".");
    for (let i = 2; ; i++) {
      const next = `${path.slice(0, dot)}_${i}${path.slice(dot)}`;
      if (!used.has(next)) {
        used.add(next);
        return next;
      }
    }
  };
  const hasGlb = inputs.some((f) => ext(f.name) === "glb");

  for (const input of inputs) {
    const stem = safeStem(input.name);
    const e = ext(input.name);
    const route = blenderRoute(input.name, input.data.subarray(0, 64 * 1024));
    if (route.action === "skip") continue;
    if (e === "usdz" && hasGlb) continue;

    if (route.action === "copy") {
      const path = unique(`${stem}.${e}`);
      files.push({ path, data: input.data });
      assets.push({ path, kind: route.kind });
      if (route.kind === "gltf" && e === "gltf")
        notes.add(
          "A .gltf file can reference separate .bin and texture files. Only the .gltf itself is included.",
        );
      continue;
    }

    if (route.action === "toGlb") {
      try {
        const mesh =
          route.from === "obj"
            ? parseObj(new TextDecoder().decode(input.data))
            : parsePlyMesh(input.data);
        const path = unique(`${stem}.glb`);
        files.push({ path, data: writeGlb(mesh, stem) });
        assets.push({ path, kind: "gltf" });
        files.push({ path: unique(`source/${stem}.${e}`), data: input.data });
        notes.add(TEXTURE_NOTE);
      } catch {
        const path = unique(`${stem}.${e}`);
        files.push({ path, data: input.data });
        assets.push({ path, kind: route.fallback });
        notes.add(
          `${input.name} could not be converted to GLB, so it is included as is and imported with Blender's own ${e.toUpperCase()} importer.`,
        );
      }
      continue;
    }

    // Splats: the original always ships; add a point preview when readable.
    files.push({ path: unique(`splat/${stem}.${e}`), data: input.data });
    notes.add(SPLAT_NOTE);
    if (route.action === "splatOnly") {
      notes.add(
        `${input.name} is a .ksplat file, which Blender cannot read and Adrift cannot preview as points. Open it with a splat viewer.`,
      );
      continue;
    }
    try {
      const points =
        route.from === "ply"
          ? splatPlyToPoints(input.data)
          : route.from === "splat"
            ? splatFileToPoints(input.data)
            : spzToPoints(input.data);
      if (points.positions.length === 0) throw new Error("empty");
      const path = unique(`${stem}_points.ply`);
      files.push({ path, data: writePointsPly(points) });
      assets.push({ path, kind: "points" });
    } catch {
      notes.add(
        `${input.name} could not be read as a splat, so there is no point preview for it.`,
      );
    }
  }

  files.unshift({
    path: scriptName,
    data: blenderImportScript({
      scriptName,
      title: name,
      assets,
      sourceCamera: options.sourceCamera,
      aspect: options.aspect,
    }),
  });
  files.push({
    path: "README.txt",
    data: bundleReadme({
      name,
      scriptName,
      files,
      assets,
      notes: [...notes],
      sourceCamera: options.sourceCamera,
    }),
  });
  return { name, scriptName, files, assets, notes: [...notes] };
}

function bundleReadme(
  b: Omit<BlenderBundle, "files"> & {
    files: BundleFile[];
    sourceCamera?: SourceCamera | null;
  },
): string {
  const lines = [
    `${b.name} - exported from Adrift for Blender`,
    "",
    "Open in Blender (4.2 or later):",
    `  1. Unzip this folder and keep the files together.`,
    `  2. In Blender, open the Scripting tab, click Open, choose ${b.scriptName}, then Run Script.`,
    `     Or from a terminal: blender --python "${b.scriptName}"`,
    "",
    "The script imports the model into a new collection, centres it at the origin,",
    "rescales it if it is very small or very large, adds a camera and three lights,",
    "and switches the viewport to Material Preview so colours and textures show.",
    ...(b.files.some((f) => /\.bvh$/i.test(f.path))
      ? ["A BVH skeleton imports in metres where it stands: it isn't centred or rescaled."]
      : []),
    "",
    "Files:",
    ...b.files.map((f) => `  ${f.path}`),
    "  README.txt",
  ];
  if (b.sourceCamera)
    lines.push(
      "",
      `"Adrift source camera" sits where the photo was taken (${b.sourceCamera.fovX.toFixed(1)} x ${b.sourceCamera.fovY.toFixed(1)} degrees),`,
      "so rendering through it lines the geometry up with the source image.",
    );
  if (b.assets.length === 0)
    lines.push(
      "",
      "Nothing in this bundle can be imported by Blender directly.",
    );
  if (b.notes.length)
    lines.push("", "Notes:", ...b.notes.map((n) => `  - ${n}`));
  return lines.join("\n") + "\n";
}

/** Store large binaries uncompressed: deflating hundreds of MB blocks the server. */
const DEFLATE_LIMIT = 16 * 1024 * 1024;

/** Zip the bundle as one top-level folder named after it. */
export function blenderBundleZip(
  bundle: Pick<BlenderBundle, "name" | "files">,
): Buffer {
  return writeZip(
    bundle.files.map((f) => ({
      name: `${bundle.name}/${f.path}`,
      data: f.data,
      method:
        typeof f.data !== "string" && f.data.byteLength > DEFLATE_LIMIT
          ? (0 as const)
          : undefined,
    })),
  );
}

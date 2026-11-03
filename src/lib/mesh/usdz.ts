/**
 * GLB → USDZ export for 3D runs (i23d / t23d), so iOS can open meshes in
 * QuickLook AR / RealityKit without a third-party glTF loader.
 *
 * The converter is Blender headless (scripts/glb_to_usdz.py): it runs on
 * win/mac/linux, ships its own USD libs, and needs no pip install. Each
 * platform gets its own candidate paths (lib/blender/detect.ts: BLENDER_PATH,
 * then the Settings path, then standard installs).
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { findBlender } from "@/lib/blender/detect";
import { withLock } from "@/lib/locks";

export const MESH_FILE_RE =
  /\.(glb|gltf|usdz|obj|ply|stl|fbx|spz|ksplat|splat|bvh)$/i;
export const AUDIO_FILE_RE = /\.(wav|mp3|flac|ogg|m4a|opus|aac)$/i;
const SEGMENT_RE = /^[A-Za-z0-9 ._()+-]+$/;
const MAX_PARAM = 255;
const CONVERT_TIMEOUT_MS = 180_000;

export function isMeshFile(filename: string): boolean {
  return MESH_FILE_RE.test(filename);
}

export function isAudioFile(filename: string): boolean {
  return AUDIO_FILE_RE.test(filename);
}

/** "model_00001_.glb" → "model_00001_.usdz"; null for anything that isn't a GLB. */
export function usdzNameFor(filename: string): string | null {
  return /\.glb$/i.test(filename) ? filename.replace(/\.glb$/i, ".usdz") : null;
}

/**
 * Validate a ComfyUI output reference (filename + subfolder) from a client.
 * Plain names only: no separators in the filename, no traversal or empty
 * segments in the subfolder, no control characters.
 */
export function validateOutputRef(
  filename: unknown,
  subfolder: unknown,
): { filename: string; subfolder: string } | null {
  if (typeof filename !== "string" || filename.length > MAX_PARAM) return null;
  if (!SEGMENT_RE.test(filename) || filename === "." || filename === "..")
    return null;
  if (filename.includes("..")) return null;
  const sub = subfolder === undefined || subfolder === null ? "" : subfolder;
  if (typeof sub !== "string" || sub.length > MAX_PARAM) return null;
  if (sub) {
    const segments = sub.split("/");
    if (
      segments.some((s) => !SEGMENT_RE.test(s) || s === "." || s.includes(".."))
    )
      return null;
  }
  return { filename, subfolder: sub };
}

/**
 * Absolute path of an output file, or null if it would escape `root`.
 * Defence in depth on top of validateOutputRef: the text check, then the
 * nearest existing ancestor of the target is realpath'd and must still sit
 * inside realpath(root) (a symlinked subfolder can't point elsewhere), and
 * an existing target must be a regular file, not a symlink. The returned
 * path keeps `root`'s spelling.
 */
export function resolveOutputPath(
  root: string,
  filename: string,
  subfolder: string,
): string | null {
  const base = path.resolve(root);
  const abs = path.resolve(base, subfolder || ".", filename);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  let realBase: string;
  try {
    realBase = fs.realpathSync(base);
  } catch {
    // No output root on disk yet: nothing to escape through.
    return abs;
  }
  const inside = (p: string) => p === realBase || p.startsWith(realBase + path.sep);
  let dir = path.dirname(abs);
  for (;;) {
    let real: string | null = null;
    try {
      real = fs.realpathSync(dir);
    } catch {
      real = null;
    }
    if (real !== null) {
      if (!inside(real)) return null;
      break;
    }
    if (dir === base) break;
    dir = path.dirname(dir);
  }
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return null;
  } catch {
    // Missing target is fine (it's about to be written).
  }
  return abs;
}

export {
  blenderCandidates,
  findBlender,
  resetBlenderCache,
} from "@/lib/blender/detect";

export type ConvertResult = { ok: true } | { ok: false; error: string };

/**
 * Run Blender headless on one GLB. No shell (argv array), bounded runtime,
 * and only the last stderr/stdout lines are kept for the error message.
 * `tool` is the script's name: scripts/<tool>.py, whose errors start "<tool>:".
 */
export function runGlbConvert(
  tool: string,
  glbAbs: string,
  outAbs: string,
  opts: { blender?: string | null; script?: string; timeoutMs?: number } = {},
): Promise<ConvertResult> {
  const blender = opts.blender === undefined ? findBlender() : opts.blender;
  if (!blender) {
    return Promise.resolve({
      ok: false,
      error: "Blender not found. Install it, or set its path in Settings or BLENDER_PATH.",
    });
  }
  const script =
    opts.script ?? path.join(process.cwd(), "scripts", `${tool}.py`);
  return new Promise((resolve) => {
    let tail = "";
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-2000);
    };
    const child = spawn(
      blender,
      ["-b", "--factory-startup", "-P", script, "--", glbAbs, outAbs],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? CONVERT_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `spawn failed: ${err.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outAbs)) {
        resolve({ ok: true });
        return;
      }
      const reason = signal ? `killed (${signal})` : `exit ${code}`;
      const lastLine =
        tail
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith(`${tool}:`))
          .at(-1) ?? "";
      resolve({ ok: false, error: `${reason} ${lastLine}`.trim() });
    });
  });
}

export function convertGlbToUsdz(
  glbAbs: string,
  usdzAbs: string,
  opts: { blender?: string | null; script?: string; timeoutMs?: number } = {},
): Promise<ConvertResult> {
  return runGlbConvert("glb_to_usdz", glbAbs, usdzAbs, opts);
}

export type UsdzRef = { filename: string; subfolder: string };

/**
 * Make sure `<name>.usdz` exists next to an output GLB, converting if
 * needed. Conversions are serialized (Blender is CPU-heavy) and the
 * existence check runs inside the lock, so concurrent callers convert once.
 */
export async function ensureUsdz(
  outputRoot: string,
  glb: UsdzRef,
  convert: typeof convertGlbToUsdz = convertGlbToUsdz,
): Promise<{ ok: true; usdz: UsdzRef } | { ok: false; error: string }> {
  const usdzName = usdzNameFor(glb.filename);
  if (!usdzName) return { ok: false, error: "not a .glb" };
  const glbAbs = resolveOutputPath(outputRoot, glb.filename, glb.subfolder);
  const usdzAbs = resolveOutputPath(outputRoot, usdzName, glb.subfolder);
  if (!glbAbs || !usdzAbs) return { ok: false, error: "invalid path" };
  return withLock("usdz-convert", async () => {
    const usdz = { filename: usdzName, subfolder: glb.subfolder };
    if (fs.existsSync(usdzAbs)) return { ok: true as const, usdz };
    if (!fs.existsSync(glbAbs))
      return { ok: false as const, error: "GLB not found" };
    // scripts/glb_to_usdz.py exports into a private temp dir and
    // os.replace()s into place (replaces, never follows, a link at the
    // target); resolveOutputPath already refused symlinked targets/parents.
    const result = await convert(glbAbs, usdzAbs);
    return result.ok
      ? { ok: true as const, usdz }
      : { ok: false as const, error: result.error };
  });
}

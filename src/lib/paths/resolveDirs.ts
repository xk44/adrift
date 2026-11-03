/**
 * The one place Adrift decides which folders it uses on disk.
 *
 * Folders (key -> env var -> built-in default):
 *
 *   comfyRoot  COMFY_ROOT          <Adrift folder>/../ComfyUI
 *   models     COMFY_MODELS_DIR    <ComfyUI folder>/models
 *   input      COMFY_INPUT_DIR     <ComfyUI folder>/input
 *   output     COMFYUI_OUTPUT_DIR  <ComfyUI folder>/output
 *   data       ADRIFT_DATA_DIR     <Adrift folder>/data
 *
 * Precedence, per folder: an explicit env var always wins (the Folders
 * settings show it as locked), then the folder saved from the setup wizard /
 * Settings (`dirs` in data/runtime_settings.json), then the default. models,
 * input and output default to the RESOLVED ComfyUI folder, so moving the
 * ComfyUI folder moves them too unless they were set on their own.
 *
 * `~` / `~/…` expand to the home directory of the user running Adrift.
 *
 * Model / pack downloads go into the models folder (by model type); there is
 * no separate download folder. ComfyUI's own extra_model_paths.yaml is not
 * parsed here: ComfyUI reports those folders through its /models API, which
 * the model listings already use.
 *
 * The data folder holds Adrift's library (adrift.db, wildcards, style codes,
 * moodboards, video-editor work files, user tools). runtime_settings.json and
 * sessions.json stay in <Adrift folder>/data (or ADRIFT_RUNTIME_SETTINGS_FILE)
 * because they record where everything else is. Adrift never moves files when
 * a folder changes; a new data folder takes effect after a restart.
 *
 * Server-side only. Does not import "@/lib/env" (env's COMFY_ROOT getter
 * calls into this module).
 */
import os from "node:os";
import path from "node:path";
import {
  readRuntimeSettings,
  runtimeComfyHttpUrl,
  type DirKey,
} from "@/lib/runtimeSettings";
import { isLoopbackHost } from "@/lib/onboarding/comfyUrl";

export type { DirKey };

export const DIR_KEYS: readonly DirKey[] = [
  "comfyRoot",
  "models",
  "input",
  "output",
  "data",
];

export const DIR_ENV: Record<DirKey, string> = {
  comfyRoot: "COMFY_ROOT",
  models: "COMFY_MODELS_DIR",
  input: "COMFY_INPUT_DIR",
  output: "COMFYUI_OUTPUT_DIR",
  data: "ADRIFT_DATA_DIR",
};

/** Folders that live on the ComfyUI machine (unchecked when it is remote). */
export const COMFY_SIDE: ReadonlySet<DirKey> = new Set([
  "comfyRoot",
  "models",
  "input",
  "output",
]);

export type DirSource = "env" | "saved" | "default";

export interface ResolvedDir {
  key: DirKey;
  /** Absolute path in use. */
  path: string;
  source: DirSource;
  /** What it would be with no env var and nothing saved. */
  defaultPath: string;
  /** The saved value as typed (may start with ~), or null. */
  saved: string | null;
}

/** `~` / `~/x` -> home; anything else unchanged. */
export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\"))
    return path.join(home, p.slice(2));
  return p;
}

/**
 * Show a path under the home directory as `~/…`. Only the CURRENT user's
 * home is shortened, so the string expands back to the same path.
 */
export function tildePath(p: string, home: string = os.homedir()): string {
  if (!home) return p;
  const h = home.replace(/[\\/]+$/, "");
  if (p === h) return "~";
  if (p.startsWith(h + path.sep)) return `~${path.sep}${p.slice(h.length + 1)}`;
  return p;
}

function envValue(key: DirKey): string | undefined {
  const v = process.env[DIR_ENV[key]]?.trim();
  return v ? path.resolve(expandHome(v)) : undefined;
}

function savedValue(key: DirKey): string | undefined {
  const v = readRuntimeSettings().dirs?.[key];
  return v ? path.resolve(expandHome(v)) : undefined;
}

function defaultComfyRoot(): string {
  return path.join(process.cwd(), "../ComfyUI");
}

/** The ComfyUI install folder in use (env > saved > ../ComfyUI). */
export function resolvedComfyRoot(): string {
  // COMFY_ROOT keeps its historic form (not path.resolve'd) so commands shown
  // to the user read the way they set it.
  const raw = process.env.COMFY_ROOT?.trim();
  if (raw) return expandHome(raw);
  return savedValue("comfyRoot") ?? defaultComfyRoot();
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/**
 * A ComfyUI-side folder. `root` is the ComfyUI folder the caller works with
 * (normally env.COMFY_ROOT, which is resolvedComfyRoot()). When it is the one
 * in use, an env / saved override for this folder applies; for any other root
 * (tests, a different install) the folder is simply <root>/<name>.
 */
function comfySub(
  key: "models" | "input" | "output",
  root: string | undefined,
): string {
  const active = resolvedComfyRoot();
  const base = root ?? active;
  if (samePath(base, active)) {
    const o = envValue(key) ?? savedValue(key);
    if (o) return o;
  }
  return path.join(base, key);
}

export const comfyModelsDir = (root?: string): string =>
  comfySub("models", root);
export const comfyInputDir = (root?: string): string => comfySub("input", root);
export const comfyOutputDir = (root?: string): string =>
  comfySub("output", root);

/** <models>/<sub…> for the given ComfyUI root (see comfyModelsDir). */
export function comfyModelsPath(root: string | undefined, ...sub: string[]) {
  return path.join(comfyModelsDir(root), ...sub);
}

/** Adrift's own data / library folder (env > saved > <cwd>/data). */
export function adriftDataDir(): string {
  return (
    envValue("data") ?? savedValue("data") ?? path.join(process.cwd(), "data")
  );
}

/** A path inside the data folder. */
export function adriftDataPath(...segs: string[]): string {
  return path.join(adriftDataDir(), ...segs);
}

/** Every folder with where its value came from. */
export function resolveDirs(): Record<DirKey, ResolvedDir> {
  const saved = readRuntimeSettings().dirs ?? {};
  const root = resolvedComfyRoot();
  const def: Record<DirKey, string> = {
    comfyRoot: defaultComfyRoot(),
    models: path.join(root, "models"),
    input: path.join(root, "input"),
    output: path.join(root, "output"),
    data: path.join(process.cwd(), "data"),
  };
  const value: Record<DirKey, string> = {
    comfyRoot: root,
    models: comfyModelsDir(root),
    input: comfyInputDir(root),
    output: comfyOutputDir(root),
    data: adriftDataDir(),
  };
  const out = {} as Record<DirKey, ResolvedDir>;
  for (const key of DIR_KEYS) {
    const source: DirSource = process.env[DIR_ENV[key]]?.trim()
      ? "env"
      : saved[key]
        ? "saved"
        : "default";
    out[key] = {
      key,
      path: value[key],
      source,
      defaultPath: def[key],
      saved: saved[key] ?? null,
    };
  }
  return out;
}

/**
 * Whether the ComfyUI Adrift talks to runs on this machine, i.e. its folders
 * are on this disk. A LAN / internet ComfyUI keeps them on its own machine.
 */
export function comfyIsLocalMachine(): boolean {
  const url =
    process.env.COMFY_HTTP_URL?.trim() ||
    runtimeComfyHttpUrl() ||
    "http://127.0.0.1:8188";
  try {
    return isLoopbackHost(new URL(url).hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

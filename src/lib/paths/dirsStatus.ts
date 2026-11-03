/**
 * The Folders settings payload (GET /api/settings/dirs) and the save rules
 * (PUT). Shared by the route and its tests. Server-side only.
 *
 * Only display paths leave the server: the home folder shows as ~, and the
 * value saved is that same ~ form, so it expands back to the same folder.
 */
import path from "node:path";
import { writeDirs } from "@/lib/runtimeSettings";
import {
  COMFY_SIDE,
  DIR_ENV,
  DIR_KEYS,
  comfyIsLocalMachine,
  resolveDirs,
  tildePath,
  type DirKey,
  type DirSource,
} from "./resolveDirs";
import { checkDir, parseDirInput, type DirCheck } from "./validateDir";

export interface DirRow {
  key: DirKey;
  /** Folder in use (~ form). */
  display: string;
  source: DirSource;
  /** Env var that sets it; envLocked when that var is set. */
  envVar: string;
  envLocked: boolean;
  /** Default with nothing set (~ form); models/input/output follow ComfyUI. */
  defaultDisplay: string;
  /** "comfy": lives on the ComfyUI machine; "adrift": on Adrift's machine. */
  side: "comfy" | "adrift";
  check: DirCheck;
}

export interface DirsStatus {
  ok: true;
  /** ComfyUI runs on this machine (its folders are on this disk). */
  comfyLocal: boolean;
  dirs: DirRow[];
}

export function dirsStatus(): DirsStatus {
  const comfyLocal = comfyIsLocalMachine();
  const resolved = resolveDirs();
  return {
    ok: true,
    comfyLocal,
    dirs: DIR_KEYS.map((key) => {
      const r = resolved[key];
      return {
        key,
        display: tildePath(r.path),
        source: r.source,
        envVar: DIR_ENV[key],
        envLocked: r.source === "env",
        defaultDisplay: tildePath(r.defaultPath),
        side: COMFY_SIDE.has(key) ? "comfy" : "adrift",
        check: checkDir(key, tildePath(r.path), { comfyLocal }),
      };
    }),
  };
}

export type SaveDirsResult =
  | { ok: true }
  | { ok: false; status: number; error: string; key?: DirKey };

/**
 * Validate and save `{ key: path | null }` (null = back to the default).
 * Env-pinned folders refuse (409); bad or system paths refuse (400). Missing
 * folders are allowed (a warning in the UI), never created here.
 */
export function saveDirs(input: unknown): SaveDirsResult {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ok: false, status: 400, error: "Expected { dirs: { … } }" };
  const raw = input as Record<string, unknown>;
  const keys = Object.keys(raw);
  const unknownKey = keys.find((k) => !(DIR_KEYS as string[]).includes(k));
  if (unknownKey)
    return { ok: false, status: 400, error: `Unknown folder: ${unknownKey}` };
  const comfyLocal = comfyIsLocalMachine();
  const resolved = resolveDirs();
  const next: Partial<Record<DirKey, string | null>> = {};
  // The install folder first: models / input / output defaults follow it.
  const ordered = DIR_KEYS.filter((k) => keys.includes(k));
  let rootAbs = resolved.comfyRoot.path;
  for (const key of ordered) {
    const v = raw[key];
    if (process.env[DIR_ENV[key]]?.trim())
      return {
        ok: false,
        status: 409,
        key,
        error: `${DIR_ENV[key]} is set in the environment (.env.local), which always wins. Remove it there to choose here.`,
      };
    if (v === null || v === "") {
      next[key] = null;
      if (key === "comfyRoot") rootAbs = resolved.comfyRoot.defaultPath;
      continue;
    }
    const parsed = parseDirInput(
      v,
      undefined,
      COMFY_SIDE.has(key) && !comfyLocal,
    );
    if (!parsed.ok)
      return { ok: false, status: 400, key, error: parsed.error };
    // Picking the default is "use default": nothing to pin.
    const def =
      key === "comfyRoot" || key === "data"
        ? resolved[key].defaultPath
        : path.join(rootAbs, key);
    if (key === "comfyRoot") rootAbs = parsed.abs;
    next[key] = parsed.abs === path.resolve(def) ? null : parsed.display;
  }
  writeDirs(next);
  return { ok: true };
}

/**
 * Checks for a folder typed into the Folders step / Settings.
 *
 * Only answers questions about the folder itself: does it exist, is it a
 * folder, can Adrift read / write it, and (for the ComfyUI folder) are
 * main.py and models/ there. It never lists what is inside.
 *
 * Folders on a ComfyUI that runs on another machine are not checked (they
 * are not on this disk); only their spelling is.
 *
 * Server-side only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isValidDirSetting } from "@/lib/runtimeSettings";
import { COMFY_SIDE, expandHome, tildePath, type DirKey } from "./resolveDirs";

export type DirCheckStatus = "ok" | "warn" | "error" | "remote";

export interface DirCheck {
  key: DirKey;
  status: DirCheckStatus;
  /** Path as shown to the user (~ for the home folder). */
  display: string;
  exists: boolean;
  /** One-line reason for a warn / error / remote status ("" when ok). */
  reason: string;
  /** Extra facts worth showing (e.g. extra_model_paths.yaml found). */
  notes: string[];
  /** The folder is missing and may be created (Create folder button). */
  canCreate: boolean;
  /** Set when this request created the folder. */
  created?: boolean;
}

/** What Adrift needs from each folder. */
const NEEDS: Record<DirKey, { read: boolean; write: boolean }> = {
  comfyRoot: { read: true, write: false },
  models: { read: true, write: true }, // listings + downloads
  input: { read: true, write: true }, // uploads, poses
  output: { read: true, write: true }, // gallery + Adrift-made outputs
  data: { read: true, write: true },
};

const POSIX_SYSTEM = [
  "/System",
  "/etc",
  "/private/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/boot",
  "/dev",
  "/proc",
  "/sys",
  "/private/var/db",
  "/Library/Apple",
];
/** Under /usr only /usr/local is a place people keep their own things. */
const POSIX_ALLOWED_UNDER_SYSTEM = ["/usr/local"];

function under(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

/**
 * True for an operating-system folder Adrift must never write to: the
 * filesystem root, a drive root, /System, /etc, /usr, C:\Windows, …
 */
export function isSystemPath(p: string): boolean {
  const win = /^[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith("\\\\");
  if (win) {
    const n = p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    if (/^[a-z]:$/.test(n)) return true; // drive root
    return [
      "\\windows",
      "\\program files",
      "\\program files (x86)",
      "\\programdata",
    ].some((d) => {
      const rest = n.slice(2);
      return rest === d || rest.startsWith(`${d}\\`);
    });
  }
  const n = p.replace(/\/+$/, "") || "/";
  if (n === "/") return true;
  if (POSIX_ALLOWED_UNDER_SYSTEM.some((d) => under(n, d))) return false;
  return POSIX_SYSTEM.some((d) => under(n, d));
}

/** Real path of the folder, or of its nearest existing parent (+ the rest). */
function realish(p: string): string {
  let cur = p;
  const rest: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
  return p;
}

function canAccess(p: string, mode: number): boolean {
  try {
    fs.accessSync(p, mode);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export type ParsedDir =
  { ok: true; abs: string; display: string } | { ok: false; error: string };

/**
 * Spelling + safety: absolute or ~-relative, no control characters, and not
 * an operating-system folder (also after following symlinks).
 */
export function parseDirInput(
  raw: unknown,
  home: string = os.homedir(),
  /** Accept another OS's path style (a folder on a remote ComfyUI machine). */
  allowForeign = false,
): ParsedDir {
  if (typeof raw !== "string" || !raw.trim())
    return { ok: false, error: "Enter a folder path." };
  const typed = raw.trim();
  if (!isValidDirSetting(typed))
    return {
      ok: false,
      error: "Use a full path (starting with / or ~/, or C:\\ on Windows).",
    };
  const expanded = expandHome(typed, home);
  const isWin = /^[A-Za-z]:[\\/]/.test(expanded) || expanded.startsWith("\\\\");
  const foreign = isWin && path.sep === "/";
  if (foreign && !allowForeign)
    return {
      ok: false,
      error: "That's a Windows path; Adrift runs on macOS / Linux here.",
    };
  const abs = foreign ? expanded : path.resolve(expanded);
  if (isSystemPath(abs) || (!isWin && isSystemPath(realish(abs))))
    return {
      ok: false,
      error: "That's a system folder. Pick a folder of your own.",
    };
  return { ok: true, abs, display: tildePath(abs, home) };
}

/**
 * Check one folder. `comfyLocal` false marks the ComfyUI-side folders as
 * "on the ComfyUI machine (not checked)". `create` makes a missing folder
 * (only when the user asked, never implicitly).
 */
export function checkDir(
  key: DirKey,
  raw: unknown,
  opts: { comfyLocal: boolean; create?: boolean; home?: string },
): DirCheck {
  const home = opts.home ?? os.homedir();
  const remote = COMFY_SIDE.has(key) && !opts.comfyLocal;
  const parsed = parseDirInput(raw, home, remote);
  const base = {
    key,
    exists: false,
    notes: [] as string[],
    canCreate: false,
  };
  if (!parsed.ok)
    return {
      ...base,
      status: "error",
      display: typeof raw === "string" ? raw.trim() : "",
      reason: parsed.error,
    };
  const { abs, display } = parsed;
  if (remote)
    return {
      ...base,
      status: "remote",
      display,
      reason: "On the ComfyUI machine (not checked).",
    };

  let created = false;
  if (opts.create && !fs.existsSync(abs)) {
    try {
      fs.mkdirSync(abs, { recursive: true });
      created = true;
    } catch (e) {
      return {
        ...base,
        status: "error",
        display,
        reason: `Couldn't create it (${(e as NodeJS.ErrnoException).code ?? "error"}).`,
        canCreate: true,
      };
    }
  }

  if (!fs.existsSync(abs))
    return {
      ...base,
      status: key === "comfyRoot" ? "error" : "warn",
      display,
      reason:
        key === "comfyRoot"
          ? "Folder not found. Check the spelling (you can also fix this later in Settings)."
          : "Folder doesn't exist yet.",
      canCreate: key !== "comfyRoot",
    };
  if (!isDir(abs))
    return {
      ...base,
      status: "error",
      display,
      exists: true,
      reason: "That's a file, not a folder.",
    };

  const need = NEEDS[key];
  const out: DirCheck = {
    ...base,
    status: "ok",
    display,
    exists: true,
    reason: "",
    ...(created ? { created: true } : {}),
  };
  if (need.read && !canAccess(abs, fs.constants.R_OK | fs.constants.X_OK)) {
    out.status = "error";
    out.reason = "Adrift can't read this folder (permissions).";
    return out;
  }
  if (need.write && !canAccess(abs, fs.constants.W_OK)) {
    out.status = "warn";
    out.reason = "Adrift can't write here (permissions).";
  }
  if (key === "comfyRoot") {
    const hasMain = isFile(path.join(abs, "main.py"));
    const hasModels = isDir(path.join(abs, "models"));
    if (!hasMain || !hasModels) {
      out.status = "warn";
      out.reason = !hasMain
        ? "Doesn't look like ComfyUI (no main.py). Pick the folder that has main.py in it."
        : "Doesn't look like ComfyUI (no models folder). Pick the folder that has main.py and models in it.";
    }
    if (isFile(path.join(abs, "extra_model_paths.yaml")))
      out.notes.push(
        "extra_model_paths.yaml found: ComfyUI also loads models from the folders listed there.",
      );
  }
  return out;
}

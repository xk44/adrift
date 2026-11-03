/**
 * "Add Adrift to ComfyUI": installs the overlay pack (comfy_nodes/adrift_overlay)
 * into a ComfyUI on this machine and reports its state.
 *
 * Install = symlink <comfyRoot>/custom_nodes/adrift_overlay -> our pack (a
 * copy on Windows, or when the symlink fails), then write the Adrift URL the
 * browser used into web/adrift_config.json so the bridge needs no typing.
 * Never overwrites: an existing directory or foreign link is reported, not
 * touched (only our own pack's adrift_config.json is refreshed). fs only, no
 * shell. Server-side only.
 */
import fs from "node:fs";
import path from "node:path";

export const OVERLAY_PACK = "adrift_overlay";
export const OVERLAY_CONFIG_FILE = "adrift_config.json";
export const OVERLAY_SCRIPT = "adrift_overlay.js";

/**
 * missing: nothing there. linked: a symlink to our pack. copy: a directory
 * holding the bridge (an earlier copy). other: something else under that
 * name (a foreign link, a dangling link, an unrelated folder or file).
 */
export type OverlayPackState = "missing" | "linked" | "copy" | "other";

export function overlaySourceDir(cwd: string = process.cwd()): string {
  return path.join(cwd, "comfy_nodes", OVERLAY_PACK);
}

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

export function inspectOverlayPack(
  customNodesDir: string,
  sourceDir: string,
): OverlayPackState {
  const dest = path.join(customNodesDir, OVERLAY_PACK);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dest);
  } catch {
    return "missing";
  }
  if (st.isSymbolicLink()) {
    const target = realOrNull(dest);
    return target && target === realOrNull(sourceDir) ? "linked" : "other";
  }
  if (st.isDirectory()) {
    if (realOrNull(dest) === realOrNull(sourceDir)) return "linked"; // junction
    return fs.existsSync(path.join(dest, "web", OVERLAY_SCRIPT))
      ? "copy"
      : "other";
  }
  return "other";
}

/** The http(s) origin Adrift should be framed from, or null. */
export function normalizeAdriftUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function readOverlayConfigUrl(packDir: string): string | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(packDir, "web", OVERLAY_CONFIG_FILE), "utf8"),
    ) as { adriftUrl?: unknown };
    return normalizeAdriftUrl(raw?.adriftUrl);
  } catch {
    return null;
  }
}

function writeOverlayConfig(packDir: string, adriftUrl: string): void {
  const file = path.join(packDir, "web", OVERLAY_CONFIG_FILE);
  // Refuse to follow a link planted where the config goes.
  try {
    if (fs.lstatSync(file).isSymbolicLink())
      throw new Error(`${file} is a symlink; not writing through it`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  fs.writeFileSync(file, JSON.stringify({ adriftUrl }, null, 2) + "\n");
}

export interface InstallResult {
  ok: boolean;
  /** linked/copied = installed now; updated = it was already ours */
  action?: "linked" | "copied" | "updated";
  state: OverlayPackState;
  error?: string;
}

export function installOverlayPack(opts: {
  customNodesDir: string;
  sourceDir: string;
  adriftUrl: string | null;
  platform?: NodeJS.Platform;
  /** test seam */
  symlink?: (target: string, dest: string) => void;
}): InstallResult {
  const { customNodesDir, sourceDir, adriftUrl } = opts;
  const platform = opts.platform ?? process.platform;
  if (!fs.existsSync(path.join(sourceDir, "web", OVERLAY_SCRIPT)))
    return {
      ok: false,
      state: "missing",
      error: "The overlay pack is missing from this Adrift folder.",
    };
  let isDir = false;
  try {
    isDir = fs.statSync(customNodesDir).isDirectory();
  } catch {
    /* missing */
  }
  if (!isDir)
    return {
      ok: false,
      state: "missing",
      error: `No custom_nodes folder at ${customNodesDir}.`,
    };

  const dest = path.join(customNodesDir, OVERLAY_PACK);
  const state = inspectOverlayPack(customNodesDir, sourceDir);
  if (state === "other")
    return {
      ok: false,
      state,
      error: `${dest} already exists and isn't Adrift's overlay. Move it aside and try again.`,
    };

  let action: InstallResult["action"] = "updated";
  if (state === "missing") {
    const link =
      opts.symlink ??
      ((target: string, d: string) => fs.symlinkSync(target, d, "dir"));
    let linked = false;
    if (platform !== "win32") {
      try {
        link(sourceDir, dest);
        linked = true;
      } catch {
        linked = false;
      }
    }
    if (linked) action = "linked";
    else {
      fs.cpSync(sourceDir, dest, {
        recursive: true,
        errorOnExist: true,
        force: false,
        // A config written for an earlier install is rewritten below.
        filter: (src) =>
          path.basename(src) !== OVERLAY_CONFIG_FILE &&
          path.basename(src) !== "__pycache__",
      });
      action = "copied";
    }
  }
  if (adriftUrl) writeOverlayConfig(dest, adriftUrl);
  return {
    ok: true,
    action,
    state: inspectOverlayPack(customNodesDir, sourceDir),
  };
}

/**
 * Which extension scripts in ComfyUI's GET /extensions list are the bridge.
 * Returns the matching URLs (empty when the overlay is not loaded).
 */
export function overlayScriptsLoaded(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (u): u is string =>
      typeof u === "string" && u.split("/").pop() === OVERLAY_SCRIPT,
  );
}

/** Steps for a ComfyUI on another machine (shown with a copy button). */
export function remoteInstallSteps(adriftUrl: string | null): string {
  const url = adriftUrl ?? "http://<adrift-host>:3000";
  return [
    `# On the ComfyUI machine: copy the comfy_nodes/${OVERLAY_PACK} folder from Adrift into ComfyUI/custom_nodes/`,
    `# then tell the overlay where Adrift runs:`,
    `echo '{ "adriftUrl": "${url}" }' > ComfyUI/custom_nodes/${OVERLAY_PACK}/web/${OVERLAY_CONFIG_FILE}`,
    `# Restart ComfyUI, then press Ctrl+Shift+J (or the corner button).`,
  ].join("\n");
}

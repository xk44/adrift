/**
 * First-run checklist: shared types plus the copyable fix commands.
 *
 * Pure and client-safe (no fs / env). The server half that inspects ComfyUI
 * lives in firstRunCheck.ts; GET /api/setup/first-run returns FirstRunStatus.
 */

export type CheckState = "ok" | "fail" | "unknown";

/** A pinned starter model the checklist can offer a one-line download for. */
export interface StarterModel {
  /** Shown to the user ("SDXL base 1.0"). */
  label: string;
  /** File name written into models/<folder>/. */
  file: string;
  /** models/ subfolder ("checkpoints"). */
  folder: string;
  /** Pinned download URL (Hugging Face resolve/<revision>). */
  url: string;
  sizeBytes: number;
}

export interface CreateModelCheck {
  state: CheckState;
  /** Engine Create uses when no model is picked (CJ_DEFAULT_PACK). */
  packId: string;
  packName: string;
  /** File Create will load (when known). */
  using?: string;
  /**
   * What is missing: "<models folder>/<file>", "<folder>/*" (any file in that
   * folder would do) or "node:<Class>".
   */
  missing: string[];
  /** Offered when the missing piece is the starter checkpoint. */
  starter?: StarterModel;
  /**
   * Offered instead of `starter` when the default engine is not SDXL: the
   * starter pack (setup wizard) that installs it, with its fetch command.
   */
  starterPack?: StarterPackHint;
}

/** A starter pack (starterPacks.json) that installs Create's default engine. */
export interface StarterPackHint {
  id: string;
  /** Wizard title ("Images: best quality"). */
  title: string;
  /** Download size of its default files. */
  sizeBytes: number;
  /** `node scripts/fetch-models.mjs --pack <id> ...`, run from the Adrift folder. */
  command: string;
}

export interface FirstRunStatus {
  ok: true;
  comfy: { reachable: boolean; url: string };
  /** COMFY_ROOT as the server sees it (for copyable commands). */
  comfyRoot: string;
  createModel: CreateModelCheck;
}

/**
 * SDXL base 1.0, pinned to the same revision as models/download-list.json
 * (fetch-models.mjs "minimal" set). 6.9 GB.
 */
export const SDXL_STARTER: StarterModel = {
  label: "SDXL base 1.0",
  file: "sd_xl_base_1.0.safetensors",
  folder: "checkpoints",
  url: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/462165984030d82259a11f4367a4eed129e94a7b/sd_xl_base_1.0.safetensors",
  sizeBytes: 6_938_078_334,
};

/** A prompt that works on any SD-style checkpoint; filled, never auto-run. */
export const SAMPLE_PROMPT =
  "a red fox curled up asleep in fresh snow, soft morning light, close-up photo";

/** ComfyUI's default port; the start script uses it unless COMFY_PORT is set. */
const DEFAULT_COMFY_PORT = "8188";
/** start-comfyui.sh's default CJ_ORIGIN. */
const DEFAULT_ORIGIN = "http://localhost:3000";

/** POSIX shell quoting: bare when safe, else single quotes. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function comfyPort(comfyUrl: string | undefined): string {
  if (!comfyUrl) return DEFAULT_COMFY_PORT;
  try {
    const u = new URL(comfyUrl);
    return u.port || (u.protocol === "https:" ? "443" : "80");
  } catch {
    return DEFAULT_COMFY_PORT;
  }
}

/** True when ComfyUI is configured on this machine (we can tell them to start it). */
export function isLocalComfyUrl(comfyUrl: string | undefined): boolean {
  if (!comfyUrl) return true;
  try {
    const host = new URL(comfyUrl).hostname.replace(/^\[|\]$/g, "");
    return (
      host === "localhost" ||
      host === "::1" ||
      /^127\./.test(host) ||
      host === "0.0.0.0"
    );
  } catch {
    return true;
  }
}

export interface StartCommandInput {
  /** COMFY_ROOT from the server; placeholder when unknown. */
  comfyRoot?: string;
  /** COMFY_HTTP_URL from the server. */
  comfyUrl?: string;
  /** window.location.origin: ComfyUI must allow this origin (CORS). */
  origin?: string;
}

/** Shown when COMFY_ROOT is unknown. */
export const COMFY_ROOT_PLACEHOLDER = "~/ComfyUI";

/**
 * Home-relative form of a path ("/Users/ana/ComfyUI" -> "~/ComfyUI") so a
 * copyable command never shows the account name. Windows profile paths
 * become %USERPROFILE%; anything else is returned unchanged.
 */
export function abbreviateHome(p: string): string {
  const posix = p.match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/);
  if (posix) return `~${posix[1] ?? ""}`;
  if (p === "/root" || p.startsWith("/root/")) return `~${p.slice(5)}`;
  const win = p.match(/^[A-Za-z]:\\Users\\[^\\]+(\\.*)?$/);
  if (win) return `%USERPROFILE%${win[1] ?? ""}`;
  return p;
}

/** shellQuote that keeps a leading "~/" outside the quotes so it expands. */
export function shellQuotePath(p: string): string {
  if (p === "~") return p;
  if (p.startsWith("~/")) return `~/${shellQuote(p.slice(2))}`;
  return shellQuote(p);
}

/** `scripts/start-comfyui.sh` with the env it needs, run from the Adrift folder. */
export function startComfyCommand({
  comfyRoot,
  comfyUrl,
  origin,
}: StartCommandInput): string {
  const root = comfyRoot ? abbreviateHome(comfyRoot) : COMFY_ROOT_PLACEHOLDER;
  const parts = [`COMFY_DIR=${shellQuotePath(root)}`];
  const port = comfyPort(comfyUrl);
  if (port !== DEFAULT_COMFY_PORT) parts.push(`COMFY_PORT=${port}`);
  if (origin && origin !== DEFAULT_ORIGIN)
    parts.push(`CJ_ORIGIN=${shellQuote(origin)}`);
  parts.push("scripts/start-comfyui.sh");
  return parts.join(" ");
}

/** The same start, typed from inside the ComfyUI folder (any OS). */
export function comfyMainCommand({
  comfyUrl,
  origin,
}: Omit<StartCommandInput, "comfyRoot">): string {
  return `python main.py --listen 127.0.0.1 --port ${comfyPort(comfyUrl)} --enable-cors-header ${shellQuote(origin || DEFAULT_ORIGIN)}`;
}

function joinPath(root: string, ...segs: string[]): string {
  // Windows path (C:\ComfyUI) keeps backslashes; everything else uses "/".
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return [root.replace(/[\\/]+$/, ""), ...segs].join(sep);
}

/** One-line resumable download of the starter model into ComfyUI. */
export function starterDownloadCommand(
  starter: StarterModel,
  comfyRoot?: string,
): string {
  const dest = joinPath(
    comfyRoot || "/path/to/ComfyUI",
    "models",
    starter.folder,
    starter.file,
  );
  return `curl -L -C - -o ${shellQuote(dest)} ${shellQuote(starter.url)}`;
}

/** "6.9 GB" */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** "checkpoints/*" → "any model in models/checkpoints"; "node:X" → "the X node". */
export function describeMissing(entry: string): string {
  if (entry.startsWith("node:")) return `the ${entry.slice(5)} node`;
  if (entry.endsWith("/*")) return `a model in models/${entry.slice(0, -2)}`;
  return `models/${entry}`;
}

export interface ChecklistRow {
  id: "comfy" | "model" | "sample";
  state: CheckState | "todo";
}

/**
 * Row states for the checklist. A row after a failing/unknown one can't be
 * judged yet ("unknown"); the sample row is "todo" once both checks pass.
 */
export function checklistRows(status: FirstRunStatus | null): ChecklistRow[] {
  if (!status) {
    return [
      { id: "comfy", state: "unknown" },
      { id: "model", state: "unknown" },
      { id: "sample", state: "unknown" },
    ];
  }
  const comfy: CheckState = status.comfy.reachable ? "ok" : "fail";
  const model: CheckState =
    comfy === "ok" ? status.createModel.state : "unknown";
  return [
    { id: "comfy", state: comfy },
    { id: "model", state: model },
    { id: "sample", state: model === "ok" ? "todo" : "unknown" },
  ];
}

/** Narrow an unknown JSON body to FirstRunStatus (null when it isn't one). */
export function parseFirstRunStatus(body: unknown): FirstRunStatus | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Partial<FirstRunStatus>;
  if (b.ok !== true || !b.comfy || typeof b.comfy.reachable !== "boolean")
    return null;
  if (!b.createModel || !Array.isArray(b.createModel.missing)) return null;
  return {
    ok: true,
    comfy: { reachable: b.comfy.reachable, url: String(b.comfy.url ?? "") },
    comfyRoot: typeof b.comfyRoot === "string" ? b.comfyRoot : "",
    createModel: b.createModel as CreateModelCheck,
  };
}

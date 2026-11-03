/**
 * Runtime settings: the few things the first-run wizard can change without a
 * restart, saved to data/runtime_settings.json (data/ is gitignored).
 *
 * That is the ComfyUI connection (which URL Adrift talks to, how the user
 * reached it: this computer / local network / internet, and an optional
 * bearer token for a ComfyUI behind an auth-checking reverse proxy), whether
 * the setup wizard was finished on any device (`onboardedAt`), and the
 * session generation counter that revokes every signed-in session when bumped
 * (`sessionGeneration`, see lib/session.ts), and how long the video editor's
 * saved projects keep their uploads pinned (`videoEditRefDays`, absent =
 * forever; see lib/videoEdit/projectRefs.ts).
 *
 * Precedence (documented in docs + the wizard): an EXPLICIT env var always
 * wins. `COMFY_HTTP_URL` set in the environment pins the URL and the wizard
 * shows it as locked; `COMFY_BEARER` wins over the saved token. The saved file
 * only fills in when env leaves the value unset; the built-in default
 * (http://127.0.0.1:8188) applies when neither is set.
 *
 * The file never holds other secrets (no Civitai key, no admin key). It is
 * written atomically (tmp + rename) with mode 0600 and carries a schema
 * version so a future format can migrate it.
 *
 * Server-side only. Deliberately does not import "@/lib/env" (env imports
 * this module for its getters).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseRefKeepDays, type RefKeepDays } from "@/lib/videoEdit/projectRefs";
import {
  sanitizeVideoQcSettings,
  type VideoQcSettings,
} from "@/lib/videoQc/settings";
import {
  sanitizeTrainingSettings,
  type TrainingSettings,
} from "@/lib/training/local/schema";
import {
  DEFAULT_PREVIEW_METHOD,
  parsePreviewMethod,
  type PreviewMethod,
} from "@/lib/comfy/previewMethod";
import {
  sanitizeComfyRouting,
  type ComfyRoutingSetting,
} from "@/lib/comfy/routingSettings";
import {
  sanitizeUpscalerPref,
  type UpscalerPref,
} from "@/lib/upscale/upscalerPref";

export const RUNTIME_SETTINGS_VERSION = 1;

export type ComfyConnectionMode = "local" | "lan" | "wan";

export interface ComfyConnectionSetting {
  /** Normalized base URL, no trailing slash ("http://192.168.1.20:8188"). */
  httpUrl: string;
  mode: ComfyConnectionMode;
  /** Bearer token for an auth proxy in front of ComfyUI. Never sent to clients. */
  authToken?: string;
  /** ISO timestamp of the last save. */
  updatedAt: string;
}

/** What a ComfyUI machine is used for ("Use for: Everything / Images / Video"). */
export type ComfyInstanceRole = "all" | "image" | "video";

/**
 * An additional ComfyUI machine (beyond the main connection in `comfy`).
 * The main connection keeps living in `comfy` (so older builds still read
 * it); `comfyMain` only carries its display name / role.
 */
export interface ComfyInstanceSetting {
  /** Stable id: also names the output marker subfolder "adrift-<id>". */
  id: string;
  name: string;
  /** Normalized base URL, no trailing slash. */
  httpUrl: string;
  role: ComfyInstanceRole;
  enabled: boolean;
  /** Bearer token for this machine's auth proxy. Never sent to clients. */
  authToken?: string;
}

export interface ComfyMainSetting {
  name?: string;
  role?: ComfyInstanceRole;
}

/** Total machines including the main one. */
export const MAX_COMFY_INSTANCES = 8;
/** Ids the routing layer reserves ("default" = main backend, "video" = env). */
export const RESERVED_INSTANCE_IDS: ReadonlySet<string> = new Set([
  "main",
  "default",
  "video",
]);
const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const ROLES: ReadonlySet<string> = new Set(["all", "image", "video"]);

export function isValidInstanceId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    INSTANCE_ID_RE.test(id) &&
    !RESERVED_INSTANCE_IDS.has(id)
  );
}

export function isInstanceRole(v: unknown): v is ComfyInstanceRole {
  return typeof v === "string" && ROLES.has(v);
}

function cleanName(v: unknown, fallback: string): string {
  const s =
    typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, "").trim() : "";
  return (s || fallback).slice(0, 48);
}

function validHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return raw.replace(/\/+$/, "");
}

/** Folders the setup wizard / Settings can set (see lib/paths/resolveDirs.ts). */
export type DirKey = "comfyRoot" | "models" | "input" | "output" | "data";

const DIR_SETTING_KEYS: readonly DirKey[] = [
  "comfyRoot",
  "models",
  "input",
  "output",
  "data",
];

/** Longest folder path accepted in the settings file. */
export const MAX_DIR_LENGTH = 1024;

/** A saved folder as typed: absolute or ~-relative, no control characters. */
export function isValidDirSetting(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s || s.length > MAX_DIR_LENGTH || s !== v) return false;
  if (/[\x00-\x1f\x7f]/.test(s)) return false;
  return (
    s === "~" ||
    s.startsWith("~/") ||
    s.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(s) ||
    s.startsWith("\\\\")
  );
}

export interface RuntimeSettings {
  version: number;
  /**
   * Folders chosen in the wizard / Settings. Env vars still win; absent keys
   * use the default (lib/paths/resolveDirs.ts).
   */
  dirs?: Partial<Record<DirKey, string>>;
  comfy?: ComfyConnectionSetting;
  /** Display name / role of the main connection (all fields optional). */
  comfyMain?: ComfyMainSetting;
  /** Additional ComfyUI machines, in routing tie-break order. */
  comfyInstances?: ComfyInstanceSetting[];
  /**
   * "One GPU job at a time across machines". Absent = the implicit default
   * (on only when env configures a video backend); env
   * COMFY_EXCLUSIVE_BACKENDS always wins.
   */
  comfyExclusive?: boolean;
  /** Per-job machine routing (auto mode, per-tool pins, priorities). */
  comfyRouting?: ComfyRoutingSetting;
  /** ISO time the setup wizard was finished or skipped (any device). */
  onboardedAt?: string;
  /** Session key generation; bumping it signs out every session. */
  sessionGeneration?: number;
  /**
   * Video editor: days a saved project not opened keeps its uploads pinned
   * (30 / 90 / 365). Absent = forever (the default).
   */
  videoEditRefDays?: RefKeepDays;
  /** Local LoRA trainers (repo + python per backend, model files). */
  training?: TrainingSettings;
  /**
   * Live previews sent with every prompt (`extra_data.preview_method`).
   * Absent = "auto".
   */
  previewMethod?: PreviewMethod;
  /** Post-render video QC; only keys that differ from the defaults. */
  videoQc?: Partial<VideoQcSettings>;
  /** Adrift recipe in output files (PNG chunk / video comment). Absent = on. */
  embedRecipe?: boolean;
  /** Upscaler of choice per content type + lock (lib/upscale/upscalerPref.ts). */
  upscaler?: UpscalerPref;
  /** Blender executable (absolute or ~/…); env BLENDER_PATH wins. */
  blenderPath?: string;
}

/** Highest accepted generation (keeps the counter a small safe integer). */
export const MAX_SESSION_GENERATION = 1_000_000_000;

/** Path of the settings file. ADRIFT_RUNTIME_SETTINGS_FILE overrides it (tests). */
export function runtimeSettingsPath(): string {
  const override = process.env.ADRIFT_RUNTIME_SETTINGS_FILE?.trim();
  if (override) return path.resolve(override);
  return path.join(process.cwd(), "data", "runtime_settings.json");
}

/**
 * Under vitest, only an explicitly pointed-at file is read, so a developer's
 * real data/runtime_settings.json can never change unrelated test results.
 */
function disabledInTests(): boolean {
  return (
    !!process.env.VITEST && !process.env.ADRIFT_RUNTIME_SETTINGS_FILE?.trim()
  );
}

const MODES: ReadonlySet<string> = new Set(["local", "lan", "wan"]);

/** Validate a parsed document; anything unexpected is dropped, not trusted. */
export function sanitizeRuntimeSettings(raw: unknown): RuntimeSettings {
  const out: RuntimeSettings = { version: RUNTIME_SETTINGS_VERSION };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  // A newer schema we do not understand: ignore it rather than misread it.
  if (typeof r.version === "number" && r.version > RUNTIME_SETTINGS_VERSION)
    return out;
  const c = r.comfy as Record<string, unknown> | undefined;
  if (c && typeof c === "object" && typeof c.httpUrl === "string") {
    let url: URL | null = null;
    try {
      url = new URL(c.httpUrl);
    } catch {
      url = null;
    }
    if (
      url &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    ) {
      out.comfy = {
        httpUrl: c.httpUrl.replace(/\/+$/, ""),
        mode: MODES.has(String(c.mode))
          ? (c.mode as ComfyConnectionMode)
          : "local",
        updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : "",
      };
      if (typeof c.authToken === "string" && c.authToken.trim())
        out.comfy.authToken = c.authToken.trim();
    }
  }
  const m = r.comfyMain as Record<string, unknown> | undefined;
  if (m && typeof m === "object") {
    const main: ComfyMainSetting = {};
    if (typeof m.name === "string" && m.name.trim())
      main.name = cleanName(m.name, "");
    if (isInstanceRole(m.role) && m.role !== "all") main.role = m.role;
    if (main.name || main.role) out.comfyMain = main;
  }
  if (Array.isArray(r.comfyInstances)) {
    const list: ComfyInstanceSetting[] = [];
    const ids = new Set<string>();
    const urls = new Set<string>(out.comfy ? [out.comfy.httpUrl] : []);
    for (const raw of r.comfyInstances) {
      if (list.length >= MAX_COMFY_INSTANCES - 1) break;
      if (!raw || typeof raw !== "object") continue;
      const i = raw as Record<string, unknown>;
      const httpUrl = validHttpUrl(i.httpUrl);
      if (!isValidInstanceId(i.id) || ids.has(i.id) || !httpUrl) continue;
      if (urls.has(httpUrl)) continue;
      ids.add(i.id);
      urls.add(httpUrl);
      const inst: ComfyInstanceSetting = {
        id: i.id,
        name: cleanName(i.name, i.id),
        httpUrl,
        role: isInstanceRole(i.role) ? i.role : "all",
        enabled: i.enabled !== false,
      };
      if (typeof i.authToken === "string" && i.authToken.trim())
        inst.authToken = i.authToken.trim();
      list.push(inst);
    }
    if (list.length > 0) out.comfyInstances = list;
  }
  if (typeof r.comfyExclusive === "boolean")
    out.comfyExclusive = r.comfyExclusive;
  const routing = sanitizeComfyRouting(r.comfyRouting);
  if (routing) out.comfyRouting = routing;
  if (typeof r.onboardedAt === "string" && r.onboardedAt.trim())
    out.onboardedAt = r.onboardedAt.trim().slice(0, 64);
  if (
    typeof r.sessionGeneration === "number" &&
    Number.isInteger(r.sessionGeneration) &&
    r.sessionGeneration > 0 &&
    r.sessionGeneration <= MAX_SESSION_GENERATION
  )
    out.sessionGeneration = r.sessionGeneration;
  const d = r.dirs as Record<string, unknown> | undefined;
  if (d && typeof d === "object" && !Array.isArray(d)) {
    const dirs: Partial<Record<DirKey, string>> = {};
    for (const k of DIR_SETTING_KEYS)
      if (isValidDirSetting(d[k])) dirs[k] = d[k] as string;
    if (Object.keys(dirs).length > 0) out.dirs = dirs;
  }
  const refDays = parseRefKeepDays(r.videoEditRefDays);
  if (refDays !== null) out.videoEditRefDays = refDays;
  const training = sanitizeTrainingSettings(r.training);
  if (training) out.training = training;
  const pm = parsePreviewMethod(r.previewMethod);
  if (pm !== null) out.previewMethod = pm;
  const qc = sanitizeVideoQcSettings(r.videoQc);
  if (qc) out.videoQc = qc;
  if (r.embedRecipe === false) out.embedRecipe = false;
  const upscaler = sanitizeUpscalerPref(r.upscaler);
  if (upscaler) out.upscaler = upscaler;
  if (isValidDirSetting(r.blenderPath)) out.blenderPath = r.blenderPath;
  return out;
}

// Sync read with a short mtime-checked cache: env getters call this on every
// ComfyUI request, so it must be cheap.
const CACHE_TTL_MS = 1000;
let cache: {
  file: string;
  at: number;
  mtimeMs: number;
  value: RuntimeSettings;
} | null = null;

export function readRuntimeSettings(): RuntimeSettings {
  if (disabledInTests()) return { version: RUNTIME_SETTINGS_VERSION };
  const file = runtimeSettingsPath();
  const now = Date.now();
  if (cache && cache.file === file && now - cache.at < CACHE_TTL_MS)
    return cache.value;
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    mtimeMs = -1;
  }
  if (cache && cache.file === file && cache.mtimeMs === mtimeMs) {
    cache.at = now;
    return cache.value;
  }
  let value: RuntimeSettings = { version: RUNTIME_SETTINGS_VERSION };
  if (mtimeMs >= 0) {
    try {
      value = sanitizeRuntimeSettings(
        JSON.parse(fs.readFileSync(file, "utf8")),
      );
    } catch {
      // Corrupt or unreadable: behave as if nothing is saved.
      value = { version: RUNTIME_SETTINGS_VERSION };
    }
  }
  cache = { file, at: now, mtimeMs, value };
  return value;
}

export function invalidateRuntimeSettingsCache(): void {
  cache = null;
}

/** Write a file atomically (tmp + rename, mode 0600). Also used by lib/sessionRegistry. */
export function writeAtomic(file: string, payload: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/**
 * Read-modify-write of the whole document: `mutate` edits a copy of the
 * current settings, the result is sanitized and written atomically.
 */
export function updateRuntimeSettings(
  mutate: (doc: RuntimeSettings) => void,
): RuntimeSettings {
  // Never let a test overwrite a developer's real settings file.
  if (disabledInTests())
    throw new Error(
      "runtimeSettings: set ADRIFT_RUNTIME_SETTINGS_FILE in tests",
    );
  const file = runtimeSettingsPath();
  invalidateRuntimeSettingsCache();
  const doc: RuntimeSettings = {
    ...readRuntimeSettings(),
    version: RUNTIME_SETTINGS_VERSION,
  };
  mutate(doc);
  const clean = sanitizeRuntimeSettings(doc);
  writeAtomic(file, `${JSON.stringify(clean, null, 2)}\n`);
  invalidateRuntimeSettingsCache();
  return clean;
}

/** Record that the setup wizard was finished or skipped (idempotent). */
export function writeOnboarded(): RuntimeSettings {
  const current = readRuntimeSettings();
  if (current.onboardedAt) return current;
  return updateRuntimeSettings((doc) => {
    doc.onboardedAt = new Date().toISOString();
  });
}

/** Current session generation (0 = never bumped). */
export function readSessionGeneration(): number {
  return readRuntimeSettings().sessionGeneration ?? 0;
}

/** Bump the session generation: every session token issued before is void. */
export function bumpSessionGeneration(): number {
  const next = Math.min(readSessionGeneration() + 1, MAX_SESSION_GENERATION);
  updateRuntimeSettings((doc) => {
    doc.sessionGeneration = next;
  });
  return next;
}

/** Video editor upload pin lifetime in days; null = forever (default). */
export function readVideoEditRefDays(): RefKeepDays | null {
  return readRuntimeSettings().videoEditRefDays ?? null;
}

/** Save the video editor upload pin lifetime (null = forever). */
export function writeVideoEditRefDays(days: RefKeepDays | null): RuntimeSettings {
  return updateRuntimeSettings((doc) => {
    if (days === null) delete doc.videoEditRefDays;
    else doc.videoEditRefDays = days;
  });
}

/** Stored video QC overrides ({} = all defaults). */
export function readVideoQcSettings(): Partial<VideoQcSettings> {
  return readRuntimeSettings().videoQc ?? {};
}

/** Replace the video QC overrides (sanitized; defaults are dropped). */
export function writeVideoQcSettings(
  next: Partial<VideoQcSettings>,
): RuntimeSettings {
  return updateRuntimeSettings((doc) => {
    const clean = sanitizeVideoQcSettings(next);
    if (clean) doc.videoQc = clean;
    else delete doc.videoQc;
  });
}

/** Saved local trainer settings ({} when none). */
export function readTrainingSettings(): TrainingSettings {
  return readRuntimeSettings().training ?? {};
}

/** Replace the local trainer settings (already validated by the route). */
export function writeTrainingSettings(next: TrainingSettings): RuntimeSettings {
  return updateRuntimeSettings((doc) => {
    const clean = sanitizeTrainingSettings(next);
    if (clean) doc.training = clean;
    else delete doc.training;
  });
}

/** Live preview method sent with every prompt; "auto" when unset. */
export function readPreviewMethod(): PreviewMethod {
  try {
    return readRuntimeSettings().previewMethod ?? DEFAULT_PREVIEW_METHOD;
  } catch {
    return DEFAULT_PREVIEW_METHOD;
  }
}

/** Save the live preview method ("auto" is stored as absent). */
export function writePreviewMethod(method: PreviewMethod): RuntimeSettings {
  return updateRuntimeSettings((doc) => {
    if (method === DEFAULT_PREVIEW_METHOD) delete doc.previewMethod;
    else doc.previewMethod = method;
  });
}

/** Saved upscaler preference (null = all defaults). */
export function readUpscalerPref(): UpscalerPref | null {
  try {
    return readRuntimeSettings().upscaler ?? null;
  } catch {
    return null;
  }
}

/** Replace the upscaler preference (sanitized; null clears it). */
export function writeUpscalerPref(next: UpscalerPref | null): RuntimeSettings {
  return updateRuntimeSettings((doc) => {
    const clean = sanitizeUpscalerPref(next);
    if (clean) doc.upscaler = clean;
    else delete doc.upscaler;
  });
}

/** Blender path saved in Settings (unexpanded), or null. */
export function readBlenderPathSetting(): string | null {
  try {
    return readRuntimeSettings().blenderPath ?? null;
  } catch {
    return null;
  }
}

/** Save (or with null, clear) the Blender path. Input must be validated. */
export function writeBlenderPathSetting(next: string | null): RuntimeSettings {
  return updateRuntimeSettings((doc) => {
    if (next) doc.blenderPath = next;
    else delete doc.blenderPath;
  });
}

/** Whether outputs carry their Adrift recipe; on unless turned off. */
export function readEmbedRecipe(): boolean {
  try {
    return readRuntimeSettings().embedRecipe !== false;
  } catch {
    return true;
  }
}

/** Save the recipe-embedding switch (on is stored as absent). */
export function writeEmbedRecipe(on: boolean): RuntimeSettings {
  return updateRuntimeSettings((doc) => {
    if (on) delete doc.embedRecipe;
    else doc.embedRecipe = false;
  });
}

/**
 * Save folders: a string sets it, null clears it (back to the default),
 * absent keys stay as they are. Input must already be validated.
 */
export function writeDirs(
  next: Partial<Record<DirKey, string | null>>,
): RuntimeSettings {
  return updateRuntimeSettings((doc) => {
    const dirs = { ...(doc.dirs ?? {}) };
    for (const k of DIR_SETTING_KEYS) {
      if (!(k in next)) continue;
      const v = next[k];
      if (v === null || v === undefined) delete dirs[k];
      else dirs[k] = v;
    }
    if (Object.keys(dirs).length > 0) doc.dirs = dirs;
    else delete doc.dirs;
  });
}

/** Save (or with null, clear) the ComfyUI connection. */
export function writeComfyConnection(
  next: Omit<ComfyConnectionSetting, "updatedAt"> | null,
): RuntimeSettings {
  return updateRuntimeSettings((doc) => {
    if (next) {
      doc.comfy = {
        httpUrl: next.httpUrl.replace(/\/+$/, ""),
        mode: next.mode,
        updatedAt: new Date().toISOString(),
      };
      if (next.authToken?.trim()) doc.comfy.authToken = next.authToken.trim();
    } else {
      delete doc.comfy;
    }
  });
}

/**
 * Save the extra ComfyUI machines, the main connection's name/role and the
 * exclusive-GPU setting (undefined leaves a field as it is; null clears it).
 * Input must already be validated (the settings route does that).
 */
export function writeComfyInstances(next: {
  instances?: ComfyInstanceSetting[];
  main?: ComfyMainSetting | null;
  exclusive?: boolean | null;
}): RuntimeSettings {
  return updateRuntimeSettings((doc) => {
    if (next.instances !== undefined) {
      if (next.instances.length > 0) doc.comfyInstances = next.instances;
      else delete doc.comfyInstances;
    }
    if (next.main !== undefined) {
      if (next.main) doc.comfyMain = next.main;
      else delete doc.comfyMain;
    }
    if (next.exclusive !== undefined) {
      if (next.exclusive === null) delete doc.comfyExclusive;
      else doc.comfyExclusive = next.exclusive;
    }
  });
}

/** Save the routing preferences (null clears them). Input must be sanitized. */
export function writeComfyRouting(
  next: ComfyRoutingSetting | null,
): RuntimeSettings {
  return updateRuntimeSettings((doc) => {
    if (next && Object.keys(next).length > 0) doc.comfyRouting = next;
    else delete doc.comfyRouting;
  });
}

/** Saved extra machines (empty when none). */
export function readComfyInstances(): ComfyInstanceSetting[] {
  return readRuntimeSettings().comfyInstances ?? [];
}

/**
 * Token lookup for an extra machine by base URL: `found` false when the URL
 * is not one of them (the caller then applies the main connection's rule).
 */
export function runtimeInstanceToken(baseUrl: string): {
  found: boolean;
  token?: string;
} {
  const base = baseUrl.replace(/\/+$/, "");
  const inst = readComfyInstances().find((i) => i.httpUrl === base);
  return inst ? { found: true, token: inst.authToken } : { found: false };
}

/** True when the environment pins the ComfyUI URL (the saved one is ignored). */
export function comfyUrlFromEnv(): string | undefined {
  return process.env.COMFY_HTTP_URL?.trim() || undefined;
}

/** The saved ComfyUI URL, unless env pins one. */
export function runtimeComfyHttpUrl(): string | undefined {
  if (comfyUrlFromEnv()) return undefined;
  return readRuntimeSettings().comfy?.httpUrl;
}

/**
 * The saved bearer token, only while the saved URL is the one in use
 * (a token saved for a remote box must never go to an env-pinned host).
 */
export function runtimeComfyToken(): string | undefined {
  if (comfyUrlFromEnv()) return undefined;
  return readRuntimeSettings().comfy?.authToken;
}

/** http(s)://host:port -> ws(s)://host:port (path kept, no trailing slash). */
export function wsBaseFromHttp(httpUrl: string): string {
  return httpUrl.replace(/^http(s?):\/\//i, "ws$1://").replace(/\/+$/, "");
}

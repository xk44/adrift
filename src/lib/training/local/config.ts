/**
 * Local trainer configuration: validate what Settings → Training saves,
 * resolve the paths a job will use, and detect whether a backend is ready.
 * Server-side only. Paths only ever come from the saved settings, never from
 * a training request.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { env } from "@/lib/env";
import { readTrainingSettings } from "@/lib/runtimeSettings";
import { comfyModelsPath, expandHome } from "@/lib/paths/resolveDirs";
import {
  TRAINER_BACKENDS,
  TRAINING_MODEL_KEYS,
  isTrainingPathSetting,
  type TrainerBackendId,
  type TrainingModelKey,
  type TrainingSettings,
} from "./schema";
import {
  BACKEND_ENTRYPOINTS,
  FAMILY_ROUTES,
  MODEL_LABELS,
  routesForFamily,
  type FamilyRoute,
} from "./families";

export class TrainingSettingsError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
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

function isExecutable(p: string): boolean {
  if (!isFile(p)) return false;
  if (process.platform === "win32") return true;
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const abs = (p: string) => path.resolve(expandHome(p));

/** The MOSS model is a diffusers-style folder; everything else is a file. */
const DIR_MODELS: ReadonlySet<TrainingModelKey> = new Set(["mossModel"]);

/**
 * Validate a PUT body into settings. Each path must be absolute (or ~/),
 * exist, and be the right kind (repo = folder, python = executable file,
 * model = file). Empty string / null clears a field.
 */
export function parseTrainingSettingsInput(raw: unknown): TrainingSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new TrainingSettingsError("Expected an object.", "training");
  const r = raw as Record<string, unknown>;
  const out: TrainingSettings = {};
  const check = (
    v: unknown,
    field: string,
    kind: "dir" | "file" | "exe",
  ): string | undefined => {
    if (v === undefined || v === null || v === "") return undefined;
    if (!isTrainingPathSetting(v))
      throw new TrainingSettingsError(
        `${field}: use a full path (starting with / or ~/).`,
        field,
      );
    const p = abs(v);
    const ok =
      kind === "dir" ? isDir(p) : kind === "exe" ? isExecutable(p) : isFile(p);
    if (!ok)
      throw new TrainingSettingsError(
        kind === "dir"
          ? `${field}: no folder at ${v}.`
          : kind === "exe"
            ? `${field}: ${v} is not an executable file.`
            : `${field}: no file at ${v}.`,
        field,
      );
    return v;
  };
  const b = r.backends as Record<string, unknown> | undefined;
  if (b !== undefined) {
    if (!b || typeof b !== "object" || Array.isArray(b))
      throw new TrainingSettingsError(
        "backends must be an object.",
        "backends",
      );
    for (const k of Object.keys(b))
      if (!(TRAINER_BACKENDS as readonly string[]).includes(k))
        throw new TrainingSettingsError(`Unknown trainer: ${k}.`, "backends");
    for (const id of TRAINER_BACKENDS) {
      const e = b[id] as Record<string, unknown> | undefined;
      if (!e || typeof e !== "object") continue;
      const repoPath = check(e.repoPath, `${id}.repoPath`, "dir");
      const pythonBin = check(e.pythonBin, `${id}.pythonBin`, "exe");
      if (repoPath || pythonBin)
        (out.backends ??= {})[id] = {
          ...(repoPath ? { repoPath } : {}),
          ...(pythonBin ? { pythonBin } : {}),
        };
    }
  }
  const m = r.models as Record<string, unknown> | undefined;
  if (m !== undefined) {
    if (!m || typeof m !== "object" || Array.isArray(m))
      throw new TrainingSettingsError("models must be an object.", "models");
    for (const k of Object.keys(m))
      if (!(TRAINING_MODEL_KEYS as readonly string[]).includes(k))
        throw new TrainingSettingsError(`Unknown model key: ${k}.`, "models");
    for (const k of TRAINING_MODEL_KEYS) {
      const v = check(m[k], `models.${k}`, DIR_MODELS.has(k) ? "dir" : "file");
      if (v) (out.models ??= {})[k] = v;
    }
  }
  return out;
}

/** Built-in model locations inside the ComfyUI models folder. */
function defaultModelPath(key: TrainingModelKey): string | undefined {
  switch (key) {
    case "krea2TextEncoder":
      return comfyModelsPath(
        env.COMFY_ROOT,
        "text_encoders",
        "qwen3vl_4b_bf16.safetensors",
      );
    case "krea2Vae":
      return comfyModelsPath(
        env.COMFY_ROOT,
        "vae",
        "qwen_image_vae.safetensors",
      );
    default:
      return undefined;
  }
}

export interface ResolvedModel {
  key: TrainingModelKey;
  label: string;
  path: string | null;
  source: "saved" | "default" | "missing";
  exists: boolean;
}

export function resolveModel(
  key: TrainingModelKey,
  settings: TrainingSettings = readTrainingSettings(),
): ResolvedModel {
  const saved = settings.models?.[key];
  const check = DIR_MODELS.has(key) ? isDir : isFile;
  if (saved) {
    const p = abs(saved);
    return {
      key,
      label: MODEL_LABELS[key],
      path: p,
      source: "saved",
      exists: check(p),
    };
  }
  const def = defaultModelPath(key);
  if (def && check(def))
    return {
      key,
      label: MODEL_LABELS[key],
      path: def,
      source: "default",
      exists: true,
    };
  return {
    key,
    label: MODEL_LABELS[key],
    path: null,
    source: "missing",
    exists: false,
  };
}

export interface BackendPaths {
  id: TrainerBackendId;
  repoPath: string | null;
  pythonBin: string | null;
}

export function backendPaths(
  id: TrainerBackendId,
  settings: TrainingSettings = readTrainingSettings(),
): BackendPaths {
  const s = settings.backends?.[id];
  return {
    id,
    repoPath: s?.repoPath ? abs(s.repoPath) : null,
    pythonBin: s?.pythonBin ? abs(s.pythonBin) : null,
  };
}

/** Problems that stop a backend from running (empty = ready). Sync, no git. */
export function backendProblems(p: BackendPaths): string[] {
  const out: string[] = [];
  if (!p.repoPath) out.push("Repo folder is not set.");
  else if (!isDir(p.repoPath)) out.push(`Repo folder not found: ${p.repoPath}`);
  else
    for (const rel of BACKEND_ENTRYPOINTS[p.id])
      if (!isFile(path.join(p.repoPath, rel)))
        out.push(`Missing ${rel} in the repo (is this a ${p.id} clone?).`);
  if (!p.pythonBin) out.push("Python path is not set.");
  else if (!isExecutable(p.pythonBin))
    out.push(`Python not found or not executable: ${p.pythonBin}`);
  return out;
}

/** Non-fatal hints about a backend that otherwise looks ready. */
function backendWarnings(p: BackendPaths): string[] {
  if (p.id !== "musubi-tuner" || !p.repoPath) return [];
  const mmdit = path.join(p.repoPath, "src/musubi_tuner/krea2/krea2_mmdit.py");
  try {
    const src = fs.readFileSync(mmdit, "utf8");
    if (!src.includes("self.up(self.down(x))"))
      return [
        "krea2_mmdit.py has no last-layer down/up projection; Krea 2 RAW checkpoints that carry last.down/last.up weights will fail to load (see SETUP → Training LoRAs).",
      ];
  } catch {
    /* missing file is already a problem */
  }
  return [];
}

export interface RouteReadiness {
  route: FamilyRoute;
  ready: boolean;
  problems: string[];
  models: ResolvedModel[];
}

export function routeReadiness(
  route: FamilyRoute,
  settings: TrainingSettings = readTrainingSettings(),
): RouteReadiness {
  const problems = backendProblems(backendPaths(route.backend, settings));
  const models = route.models.map((k) => resolveModel(k, settings));
  for (const m of models)
    if (!m.path) problems.push(`${m.label}: not set.`);
    else if (!m.exists) problems.push(`${m.label}: not found at ${m.path}`);
  return { route, ready: problems.length === 0, problems, models };
}

/** First ready route for a family (validated before untested), or null. */
export function pickRoute(
  family: string,
  settings: TrainingSettings = readTrainingSettings(),
): RouteReadiness | null {
  for (const r of routesForFamily(family)) {
    const rr = routeReadiness(r, settings);
    if (rr.ready) return rr;
  }
  return null;
}

/** Families with at least one ready route. */
export function readyFamilies(
  settings: TrainingSettings = readTrainingSettings(),
): string[] {
  const out = new Set<string>();
  for (const r of FAMILY_ROUTES)
    if (r.status !== "unsupported" && routeReadiness(r, settings).ready)
      out.add(r.family);
  return [...out].sort();
}

function gitCommit(repo: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", repo, "rev-parse", "--short", "HEAD"],
      { timeout: 5000, shell: false },
      (err, stdout) => {
        const s = String(stdout ?? "").trim();
        resolve(err || !/^[0-9a-f]{4,40}$/.test(s) ? null : s);
      },
    );
  });
}

export interface BackendDetect {
  id: TrainerBackendId;
  repoPath: string | null;
  pythonBin: string | null;
  ok: boolean;
  commit: string | null;
  problems: string[];
  warnings: string[];
  families: {
    family: string;
    status: FamilyRoute["status"];
    ready: boolean;
    note?: string;
    problems: string[];
  }[];
}

export async function detectBackend(
  id: TrainerBackendId,
  settings: TrainingSettings = readTrainingSettings(),
): Promise<BackendDetect> {
  const p = backendPaths(id, settings);
  const problems = backendProblems(p);
  const commit =
    p.repoPath && isDir(p.repoPath) ? await gitCommit(p.repoPath) : null;
  return {
    ...p,
    ok: problems.length === 0,
    commit,
    problems,
    warnings: problems.length === 0 ? backendWarnings(p) : [],
    families: FAMILY_ROUTES.filter((r) => r.backend === id).map((r) => {
      const rr = routeReadiness(r, settings);
      return {
        family: r.family,
        status: r.status,
        ready: r.status !== "unsupported" && rr.ready,
        note: r.note,
        problems: rr.problems.filter((x) => !problems.includes(x)),
      };
    }),
  };
}

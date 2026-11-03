/**
 * Local LoRA trainer settings as saved in data/runtime_settings.json
 * (`training`). Pure: no fs, no env, safe to import from runtimeSettings.
 *
 * The trainers themselves (kohya-ss/musubi-tuner, ostris/ai-toolkit) are
 * cloned and installed by the user; Adrift only stores where they live and
 * which model files to hand them.
 */

export const TRAINER_BACKENDS = ["musubi-tuner", "ai-toolkit"] as const;
export type TrainerBackendId = (typeof TRAINER_BACKENDS)[number];

export interface TrainerBackendSetting {
  /** Cloned trainer repo folder (absolute or ~/...). */
  repoPath?: string;
  /** Python interpreter of the trainer's venv. */
  pythonBin?: string;
}

export const TRAINING_MODEL_KEYS = [
  "krea2Dit",
  "krea2TextEncoder",
  "krea2Vae",
  "aitkKrea2Model",
  "mossModel",
  "mossTextEncoder",
  "mossVae",
] as const;
export type TrainingModelKey = (typeof TRAINING_MODEL_KEYS)[number];

export interface TrainingSettings {
  backends?: Partial<Record<TrainerBackendId, TrainerBackendSetting>>;
  models?: Partial<Record<TrainingModelKey, string>>;
}

export const MAX_TRAINING_PATH_LENGTH = 1024;

/** Absolute or ~-relative, no control characters, no surrounding spaces. */
export function isTrainingPathSetting(v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (!v || v.length > MAX_TRAINING_PATH_LENGTH || v.trim() !== v) return false;
  if (/[\x00-\x1f\x7f]/.test(v)) return false;
  return (
    v.startsWith("~/") ||
    v.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(v) ||
    v.startsWith("\\\\")
  );
}

export function isTrainerBackendId(v: unknown): v is TrainerBackendId {
  return (
    typeof v === "string" &&
    (TRAINER_BACKENDS as readonly string[]).includes(v)
  );
}

/** Drop anything unexpected; undefined when nothing valid is left. */
export function sanitizeTrainingSettings(
  raw: unknown,
): TrainingSettings | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: TrainingSettings = {};
  const b = r.backends as Record<string, unknown> | undefined;
  if (b && typeof b === "object" && !Array.isArray(b)) {
    const backends: TrainingSettings["backends"] = {};
    for (const id of TRAINER_BACKENDS) {
      const e = b[id] as Record<string, unknown> | undefined;
      if (!e || typeof e !== "object") continue;
      const s: TrainerBackendSetting = {};
      if (isTrainingPathSetting(e.repoPath)) s.repoPath = e.repoPath;
      if (isTrainingPathSetting(e.pythonBin)) s.pythonBin = e.pythonBin;
      if (s.repoPath || s.pythonBin) backends[id] = s;
    }
    if (Object.keys(backends).length > 0) out.backends = backends;
  }
  const m = r.models as Record<string, unknown> | undefined;
  if (m && typeof m === "object" && !Array.isArray(m)) {
    const models: TrainingSettings["models"] = {};
    for (const k of TRAINING_MODEL_KEYS)
      if (isTrainingPathSetting(m[k])) models[k] = m[k] as string;
    if (Object.keys(models).length > 0) out.models = models;
  }
  return out.backends || out.models ? out : undefined;
}

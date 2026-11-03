/**
 * Payload of GET /api/settings/training: what is saved, which model files
 * resolve, and which families each backend could train right now.
 */
import { readTrainingSettings } from "@/lib/runtimeSettings";
import { tildePath } from "@/lib/paths/resolveDirs";
import {
  backendPaths,
  backendProblems,
  resolveModel,
  routeReadiness,
} from "./config";
import { BACKEND_REPOS, FAMILY_ROUTES } from "./families";
import {
  TRAINER_BACKENDS,
  TRAINING_MODEL_KEYS,
  type TrainerBackendId,
  type TrainingSettings,
} from "./schema";
import { styleVaultTrains } from "./service";

/** Copy-paste setup text shown in Settings (text only, never run). */
export function setupSnippet(id: TrainerBackendId): string {
  return [
    `git clone ${BACKEND_REPOS[id]}`,
    `cd ${id}`,
    "python3 -m venv .venv",
    "source .venv/bin/activate   # Windows: .venv\\Scripts\\activate",
    "# Install PyTorch for your GPU first, then the trainer's own",
    "# requirements, following the install section of its README.",
    id === "musubi-tuner"
      ? "pip install -e ."
      : "pip install -r requirements.txt",
    "",
    `# Repo folder:  <where you cloned>/${id}`,
    `# Python:       <where you cloned>/${id}/.venv/bin/python`,
  ].join("\n");
}

const show = (p: string | null) => (p ? tildePath(p) : null);

export function trainingSettingsStatus(
  settings: TrainingSettings = readTrainingSettings(),
) {
  return {
    ok: true as const,
    styleVault: styleVaultTrains(),
    saved: settings,
    backends: TRAINER_BACKENDS.map((id) => {
      const p = backendPaths(id, settings);
      return {
        id,
        repoUrl: BACKEND_REPOS[id],
        repoPath: show(p.repoPath),
        pythonBin: show(p.pythonBin),
        problems: backendProblems(p),
        setup: setupSnippet(id),
        families: FAMILY_ROUTES.filter((r) => r.backend === id).map((r) => ({
          family: r.family,
          status: r.status,
          note: r.note ?? null,
          ready:
            r.status !== "unsupported" && routeReadiness(r, settings).ready,
        })),
      };
    }),
    models: TRAINING_MODEL_KEYS.map((k) => {
      const m = resolveModel(k, settings);
      return { ...m, path: show(m.path) };
    }),
  };
}

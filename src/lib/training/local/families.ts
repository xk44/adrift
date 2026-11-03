/**
 * Which local trainer can train which model family, and how far each route
 * has been proven. Mirrors StyleVault's trainer routing: musubi-tuner Krea 2
 * is the path that has produced LoRAs; the ai-toolkit routes are wired but
 * have not been run end to end from Adrift.
 */
import type { TrainerBackendId, TrainingModelKey } from "./schema";

export type RouteStatus = "validated" | "untested" | "unsupported";

export interface FamilyRoute {
  family: string;
  backend: TrainerBackendId;
  status: RouteStatus;
  /** Model files this route needs (settings keys). */
  models: TrainingModelKey[];
  note?: string;
}

export const FAMILY_ROUTES: readonly FamilyRoute[] = [
  {
    family: "krea2",
    backend: "musubi-tuner",
    status: "validated",
    models: ["krea2Dit", "krea2TextEncoder", "krea2Vae"],
  },
  {
    family: "krea2",
    backend: "ai-toolkit",
    status: "untested",
    models: ["aitkKrea2Model"],
    note: "Wired from StyleVault's template; not run end to end from Adrift.",
  },
  {
    family: "moss_image",
    backend: "ai-toolkit",
    status: "untested",
    models: ["mossModel", "mossTextEncoder", "mossVae"],
    note: "Needs a moss_image arch in ai-toolkit, which upstream does not ship yet.",
  },
  {
    family: "z-image-turbo",
    backend: "ai-toolkit",
    status: "unsupported",
    models: [],
    note: "No working ai-toolkit config yet.",
  },
  {
    family: "z-image-base",
    backend: "ai-toolkit",
    status: "unsupported",
    models: [],
    note: "No working ai-toolkit config yet.",
  },
];

/** Files a backend's repo must contain to be usable (relative to the repo). */
export const BACKEND_ENTRYPOINTS: Record<TrainerBackendId, string[]> = {
  "musubi-tuner": [
    "src/musubi_tuner/krea2_cache_latents.py",
    "src/musubi_tuner/krea2_cache_text_encoder_outputs.py",
    "src/musubi_tuner/krea2_train_network.py",
  ],
  "ai-toolkit": ["run.py"],
};

export const BACKEND_REPOS: Record<TrainerBackendId, string> = {
  "musubi-tuner": "https://github.com/kohya-ss/musubi-tuner",
  "ai-toolkit": "https://github.com/ostris/ai-toolkit",
};

/** Routes for a family in preference order (validated first). */
export function routesForFamily(family: string): FamilyRoute[] {
  return FAMILY_ROUTES.filter(
    (r) => r.family === family && r.status !== "unsupported",
  );
}

export const MODEL_LABELS: Record<TrainingModelKey, string> = {
  krea2Dit: "Krea 2 raw DiT (musubi-tuner)",
  krea2TextEncoder: "Qwen3-VL 4B text encoder, bf16 (musubi-tuner)",
  krea2Vae: "Qwen-Image VAE (musubi-tuner)",
  aitkKrea2Model: "Krea 2 Turbo checkpoint (ai-toolkit)",
  mossModel: "MOSS-Image checkpoint folder (ai-toolkit)",
  mossTextEncoder: "MOSS-Image text encoder (ai-toolkit)",
  mossVae: "MOSS-Image VAE (ai-toolkit)",
};

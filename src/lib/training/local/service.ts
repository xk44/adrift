/**
 * Local trainer entry points used by the API routes: status (what can be
 * trained), start, job detail, cancel and deploy into ComfyUI's loras folder.
 */
import fs from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";
import { integrationsFromEnv } from "@/lib/integrations";
import { readTrainingSettings } from "@/lib/runtimeSettings";
import { comfyIsLocalMachine, comfyModelsPath } from "@/lib/paths/resolveDirs";
import {
  backendPaths,
  pickRoute,
  readyFamilies,
  routeReadiness,
} from "./config";
import { routesForFamily } from "./families";
import { buildTrainPlan, PlanError, type PlanParams } from "./plan";
import {
  cancelJob,
  getJob,
  isLocalJobId,
  jobDetail,
  jobDirFor,
  newJobId,
  startJob,
  updateJob,
  type LocalJobDetail,
  type LocalJobRecord,
} from "./runner";

export { isLocalJobId, TrainerBusyError } from "./runner";

/** StyleVault keeps training only when STYLEVAULT_API_URL is set explicitly. */
export function styleVaultTrains(): boolean {
  return integrationsFromEnv().styleVault;
}

export const TRAINER_SETUP_HINT = "Set up a trainer in Settings → Training.";

export interface LocalTrainerStatus {
  configured: boolean;
  families: string[];
  error?: string;
}

export function localTrainerStatus(): LocalTrainerStatus {
  const families = readyFamilies();
  if (families.length > 0) return { configured: true, families };
  const settings = readTrainingSettings();
  const anyBackend = Object.values(settings.backends ?? {}).some(
    (b) => b?.repoPath || b?.pythonBin,
  );
  if (!anyBackend)
    return {
      configured: false,
      families: [],
      error: `Trainer not configured: no local trainer is set up. ${TRAINER_SETUP_HINT}`,
    };
  const first = routesForFamily("krea2")
    .map((r) => routeReadiness(r, settings))
    .find((r) => r.problems.length > 0);
  return {
    configured: false,
    families: [],
    error: `Trainer not configured: ${first?.problems[0] ?? "the saved trainer is incomplete."} ${TRAINER_SETUP_HINT}`,
  };
}

export class LocalTrainingError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function lorasDir(): string | null {
  if (!comfyIsLocalMachine()) return null;
  const dir = comfyModelsPath(env.COMFY_ROOT, "loras");
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

function safeLoraName(name: string): string {
  const base = path
    .basename(name)
    .replace(/\.safetensors$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 100);
  return base || "lora";
}

/** Symlink (copy when links are unavailable) a LoRA into ComfyUI's loras. */
export function linkIntoComfy(
  source: string,
  name: string,
): { deployed_path: string; lora_name: string } {
  const dir = lorasDir();
  if (!dir)
    throw new LocalTrainingError(
      `ComfyUI's loras folder is not on this machine. Copy ${source} into it by hand.`,
      409,
    );
  let target = path.join(dir, `${safeLoraName(name)}.safetensors`);
  if (fs.existsSync(target) || isSymlink(target)) {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\..*$/, "Z");
    target = path.join(dir, `${safeLoraName(name)}-${stamp}.safetensors`);
  }
  try {
    fs.symlinkSync(path.resolve(source), target);
  } catch {
    fs.copyFileSync(source, target);
  }
  return {
    deployed_path: target,
    lora_name: path.basename(target, ".safetensors"),
  };
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export interface StartLocalInput {
  family: string;
  runName: string;
  datasetDir: string;
  params: PlanParams;
}

export function startLocalTraining(input: StartLocalInput): LocalJobRecord {
  const settings = readTrainingSettings();
  const ready = pickRoute(input.family, settings);
  if (!ready) {
    const routes = routesForFamily(input.family);
    const why = routes.length
      ? routeReadiness(routes[0], settings).problems[0]
      : `no local trainer supports ${input.family}`;
    throw new LocalTrainingError(
      `Trainer not configured for ${input.family}: ${why} ${TRAINER_SETUP_HINT}`,
      409,
    );
  }
  const backend = ready.route.backend;
  const paths = backendPaths(backend, settings);
  const model = (k: string) =>
    ready.models.find((m) => m.key === k)?.path ?? undefined;
  const jobId = newJobId();
  let plan;
  try {
    plan = buildTrainPlan({
      backend,
      family: input.family,
      repoPath: paths.repoPath!,
      pythonBin: paths.pythonBin!,
      jobDir: jobDirFor(jobId),
      datasetDir: input.datasetDir,
      runName: input.runName,
      params: input.params,
      models:
        backend === "musubi-tuner"
          ? {
              dit: model("krea2Dit"),
              textEncoder: model("krea2TextEncoder"),
              vae: model("krea2Vae"),
            }
          : input.family === "krea2"
            ? { model: model("aitkKrea2Model") }
            : {
                model: model("mossModel"),
                textEncoder: model("mossTextEncoder"),
                vae: model("mossVae"),
              },
    });
  } catch (e) {
    if (e instanceof PlanError) throw new LocalTrainingError(e.message, 409);
    throw e;
  }
  return startJob({
    plan,
    jobId,
    runName: input.runName,
    datasetDir: input.datasetDir,
    onDone: async (rec) => {
      if (!rec.output_lora_path || !lorasDir()) return;
      return {
        deployed_path: linkIntoComfy(rec.output_lora_path, rec.run_name)
          .deployed_path,
      };
    },
  });
}

export function getLocalJob(id: string): LocalJobDetail | null {
  if (!isLocalJobId(id)) return null;
  const rec = getJob(id);
  return rec ? jobDetail(rec) : null;
}

export function cancelLocalJob(id: string): boolean {
  if (!isLocalJobId(id)) return false;
  return cancelJob(id) !== null;
}

/** Deploy a finished job's LoRA (reuses the auto-link when the name matches). */
export function deployLocalJob(
  id: string,
  name?: string,
): { deployed_path: string; lora_name: string } {
  const rec = isLocalJobId(id) ? getJob(id) : null;
  if (!rec) throw new LocalTrainingError("Training job not found.", 404);
  if (rec.status !== "done" || !rec.output_lora_path)
    throw new LocalTrainingError("Training job has no LoRA output.", 400);
  if (!fs.existsSync(rec.output_lora_path))
    throw new LocalTrainingError("LoRA output file not found.", 404);
  const wanted = safeLoraName(name || rec.run_name);
  if (
    rec.deployed_path &&
    path.basename(rec.deployed_path, ".safetensors") === wanted &&
    fs.existsSync(rec.deployed_path)
  )
    return { deployed_path: rec.deployed_path, lora_name: wanted };
  const res = linkIntoComfy(rec.output_lora_path, wanted);
  updateJob(id, { deployed_path: res.deployed_path });
  return res;
}

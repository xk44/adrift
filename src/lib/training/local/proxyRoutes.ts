/**
 * Local-job branch of /api/vault/training/jobs/{id}[/cancel|/deploy]: the
 * training UI talks to one set of URLs, and ids starting with "local-" are
 * answered here instead of being proxied to StyleVault. Response shapes match
 * StyleVault's (TrainingJobDetail, { ok }, TrainingDeployResult).
 */
import fs from "node:fs";
import { NextResponse } from "next/server";
import { BodyTooLargeError, readJsonCapped } from "@/lib/net/readCapped";
import { readTrainingSettings } from "@/lib/runtimeSettings";
import { routeReadiness } from "./config";
import { FAMILY_ROUTES } from "./families";
import { jobsRoot, TrainerBusyError as RunnerBusyError } from "./runner";
import {
  LocalTrainingError,
  cancelLocalJob,
  deployLocalJob,
  getLocalJob,
  isLocalJobId,
  startLocalTraining,
} from "./service";

const MAX_DEPLOY_BODY = 4096;

/** True when the proxied path addresses a local job. */
export function isLocalJobPath(segments: string[]): boolean {
  return (
    segments[0] === "training" &&
    segments[1] === "jobs" &&
    isLocalJobId(segments[2])
  );
}

function err(message: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function handleLocalJobPath(
  request: Request,
  segments: string[],
): Promise<NextResponse> {
  const [, , id, action, ...rest] = segments;
  if (rest.length > 0) return err("Not found", 404);
  if (action === undefined) {
    if (request.method !== "GET") return err("Method not allowed", 405);
    const detail = getLocalJob(id);
    return detail
      ? NextResponse.json(detail)
      : err("Training job not found.", 404);
  }
  if (request.method !== "POST") return err("Method not allowed", 405);
  if (action === "cancel")
    return cancelLocalJob(id)
      ? NextResponse.json({ ok: true })
      : err("Training job not found.", 404);
  if (action === "deploy") {
    let body: unknown;
    try {
      body = await readJsonCapped(request, MAX_DEPLOY_BODY, { emptyValue: {} });
    } catch (e) {
      return e instanceof BodyTooLargeError
        ? err("Payload too large", 413)
        : err("Invalid JSON body", 400);
    }
    const name =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).name
        : undefined;
    if (name !== undefined && (typeof name !== "string" || name.length > 200))
      return err("name must be a short string", 400);
    try {
      return NextResponse.json(deployLocalJob(id, name || undefined));
    } catch (e) {
      if (e instanceof LocalTrainingError) return err(e.message, e.status);
      throw e;
    }
  }
  return err("Not found", 404);
}

const MAX_LISTED_JOBS = 50;

function localBackends() {
  const settings = readTrainingSettings();
  return (["musubi-tuner", "ai-toolkit"] as const).map((name) => {
    const families = FAMILY_ROUTES.filter(
      (r) =>
        r.backend === name &&
        r.status !== "unsupported" &&
        routeReadiness(r, settings).ready,
    ).map((r) => r.family);
    return { name, installed: families.length > 0, model_families: families };
  });
}

function localJobs() {
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(jobsRoot()).filter((id) => isLocalJobId(id));
  } catch {
    return [];
  }
  return ids
    .map((id) => getLocalJob(id))
    .filter((job) => job !== null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, MAX_LISTED_JOBS);
}

function startFromBody(bytes: Uint8Array | null): NextResponse {
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array()));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return err("Invalid JSON body", 400);
    body = parsed as Record<string, unknown>;
  } catch {
    return err("Invalid JSON body", 400);
  }
  const dataset = (body.dataset ?? {}) as Record<string, unknown>;
  const params = (body.params ?? {}) as Record<string, unknown>;
  const imagesDir = dataset.images_dir;
  if (typeof imagesDir !== "string" || !imagesDir) {
    return err(
      "Training from a cluster needs the library service with a trainer installed. Use an image folder instead.",
      409,
    );
  }
  if (params.auto_caption) {
    return err(
      "Auto-caption needs the library service with a trainer installed. Caption the images first, or turn it off.",
      409,
    );
  }
  if (!fs.statSync(imagesDir, { throwIfNoEntry: false })?.isDirectory())
    return err("That image folder doesn't exist.", 400);

  const num = (v: unknown): number | undefined => {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : undefined;
  };
  const trigger = params.trigger_word;
  const runName =
    (typeof body.run_name === "string" ? body.run_name : "")
      .replace(/[^A-Za-z0-9_.-]+/g, "-")
      .slice(0, 80) || `local-run-${Date.now()}`;
  try {
    const job = startLocalTraining({
      family: typeof body.model_family === "string" ? body.model_family : "krea2",
      runName,
      datasetDir: imagesDir,
      params: {
        steps: num(params.steps),
        lr: num(params.lr),
        rank: num(params.rank),
        resolution: num(params.resolution),
        blocksToSwap: num(params.blocks_to_swap),
        excludeShared:
          typeof params.exclude_shared === "boolean"
            ? params.exclude_shared
            : undefined,
        lrWarmupSteps: num(params.lr_warmup_steps),
        triggerWord: typeof trigger === "string" && trigger ? trigger : undefined,
      },
    });
    return NextResponse.json({ job_id: job.job_id, status: "queued" });
  } catch (e) {
    if (e instanceof RunnerBusyError || e instanceof LocalTrainingError)
      return err(e.message, e instanceof LocalTrainingError ? e.status : 409);
    throw e;
  }
}

/**
 * The service is unreachable: answer the list and start calls with Adrift's
 * own local trainer so Train keeps working. Null for any other path. The
 * proxy has already checked images_dir against CJ_VAULT_DATASET_ROOTS.
 */
export function handleLocalTrainingOffline(
  method: string,
  segments: string[],
  body: Uint8Array | null,
): NextResponse | null {
  if (segments[0] !== "training" || segments.length !== 2) return null;
  if (segments[1] === "backends" && method === "GET")
    return NextResponse.json({ backends: localBackends() });
  if (segments[1] === "jobs" && method === "GET")
    return NextResponse.json(localJobs());
  if (segments[1] === "jobs" && method === "POST") return startFromBody(body);
  return null;
}

type BackendRow = { installed?: unknown };

function hasInstalledBackend(body: unknown): boolean {
  const rows = (body as { backends?: unknown } | null)?.backends;
  return Array.isArray(rows) && rows.some((row: BackendRow) => row?.installed === true);
}

/** True when the service answers and has at least one trainer installed. */
export async function serviceHasTrainer(
  svUrl: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const res = await fetch(`${svUrl}/training/backends`, { signal });
    return res.ok && hasInstalledBackend(await res.json());
  } catch {
    return false;
  }
}

/**
 * The service answered a list call. With no trainer of its own, offer the
 * local ones. Jobs from both show in one list. Null for any other path, or an
 * answer that isn't the expected shape.
 */
export async function mergeLocalTraining(
  method: string,
  segments: string[],
  res: Response,
): Promise<NextResponse | null> {
  if (method !== "GET" || segments[0] !== "training" || segments.length !== 2)
    return null;
  if (!res.ok) return null;
  if (segments[1] !== "backends" && segments[1] !== "jobs") return null;
  const body: unknown = await res.clone().json().catch(() => undefined);
  if (segments[1] === "backends") {
    if (body === undefined || hasInstalledBackend(body)) return null;
    return NextResponse.json({ backends: localBackends() });
  }
  if (!Array.isArray(body)) return null;
  const local = localJobs();
  if (local.length === 0) return null;
  const when = (job: { created_at?: unknown }) => String(job.created_at ?? "");
  return NextResponse.json(
    [...local, ...(body as { created_at?: unknown }[])].sort((a, b) =>
      when(b).localeCompare(when(a)),
    ),
  );
}

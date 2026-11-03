import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { apiCorsHeaders } from "@/lib/api";
import { guardRoute } from "@/lib/routeGuard";
import { env } from "@/lib/env";
import { withLock } from "@/lib/locks";
import {
  MOODBOARD_TRAINING_DIR,
  extFromUrl,
  getMoodboard,
  isInside,
  nextTrainingVersion,
  readImageBytes,
  recordTrainingRun,
  resolveImageSource,
  updateTrainingRun,
} from "@/lib/moodboards";
import {
  buildMetadataJsonl,
  captionText,
  captionTrainingParams,
  normalizeCaptionSettings,
} from "@/lib/moodboards/captions";
import {
  TRAINING_MODEL_FAMILIES,
  type TrainingModelFamily,
} from "@/lib/sref/apiClient";
import type { MoodboardImage } from "@/types";
import {
  LocalTrainingError,
  TrainerBusyError,
  getLocalJob,
  isLocalJobId,
  startLocalTraining,
  styleVaultTrains,
  TRAINER_SETUP_HINT,
} from "@/lib/training/local/service";
import { pickRoute } from "@/lib/training/local/config";
import { activeJobId } from "@/lib/training/local/runner";
import {
  assessMaterialized,
  validateTrainParams,
} from "@/lib/training/limits";

const MATERIALIZE_CONCURRENCY = 4;
const OLD_RUN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Trainer backend per model family (moss_image: ai-toolkit, untested). */
const FAMILY_BACKEND: Record<TrainingModelFamily, string> = {
  krea2: "musubi-tuner",
  moss_image: "ai-toolkit",
};

const trainSchema = z.object({
  /** Target model family (default krea2). */
  model_family: z.enum(TRAINING_MODEL_FAMILIES).default("krea2"),
  /** Omitted = the board's saved trigger word (captionSettings.triggerWord). */
  trigger_word: z.string().trim().min(1).max(100).optional(),
  steps: z.number().int().positive().optional(),
  lr: z.number().positive().optional(),
  rank: z.number().int().positive().optional(),
  resolution: z.number().int().positive().optional(),
  blocks_to_swap: z.number().int().nonnegative().optional(),
  exclude_shared: z.boolean().optional(),
  auto_caption: z.boolean().optional(),
  /** Caption sidecar extension — the formats krea2 trainers (musubi-tuner,
   * ai-toolkit) and other kohya-style trainers read. */
  caption_ext: z.enum(["txt", "caption"]).optional(),
  /** LoRA version for this dataset; omitted = next after highest recorded. */
  version: z.number().int().min(1).max(99).optional(),
});

function jsonResponse(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: apiCorsHeaders(null, "POST, OPTIONS"),
  });
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "moodboard"
  );
}

/**
 * Materialize one image into the dataset dir. Returns the written file path
 * (so a caption sidecar can be placed next to it) or null on failure.
 */
async function materializeImage(
  urlValue: string,
  targetDir: string,
  index: number,
): Promise<string | null> {
  const source = await resolveImageSource(urlValue);
  if (!source) return null;
  const stem = `${String(index).padStart(4, "0")}-${randomUUID()}`;
  try {
    await fs.mkdir(targetDir, { recursive: true });
    if (source.kind === "local") {
      const target = path.join(
        targetDir,
        `${stem}${path.extname(source.path).toLowerCase()}`,
      );
      await fs.copyFile(source.path, target);
      return target;
    }
    // Shared reader: 30s timeout + MAX_REMOTE_IMAGE_BYTES cap.
    const bytes = await readImageBytes(source);
    if (!bytes) return null;
    const target = path.join(targetDir, `${stem}${extFromUrl(source.url)}`);
    await fs.writeFile(target, bytes);
    return target;
  } catch {
    return null;
  }
}

/**
 * Materialize all images; images with a manual/stored caption get a sidecar
 * written next to them (SV auto-captioning only fills images WITHOUT one).
 * `triggerOnly` gives uncaptioned images a trigger-word-only sidecar (the
 * local trainer has no auto-captioner).
 */
async function materializeImages(
  images: Pick<MoodboardImage, "url" | "caption">[],
  targetDir: string,
  captionExt: string,
  triggerWord: string,
  triggerOnly = false,
): Promise<{
  materialized: number;
  captioned: number;
  entries: { index: number; fileName: string; caption?: string }[];
}> {
  let cursor = 0;
  let materialized = 0;
  let captioned = 0;
  const entries: { index: number; fileName: string; caption?: string }[] = [];
  const workers = Array.from(
    { length: Math.min(MATERIALIZE_CONCURRENCY, images.length) },
    async () => {
      while (cursor < images.length) {
        const index = cursor++;
        const image = images[index];
        const written = await materializeImage(image.url, targetDir, index + 1);
        if (!written) continue;
        materialized += 1;
        entries.push({
          index,
          fileName: path.basename(written),
          caption: image.caption,
        });
        if (image.caption?.trim() || triggerOnly) {
          const sidecar = written.replace(/\.[^.]+$/, `.${captionExt}`);
          try {
            await fs.writeFile(
              sidecar,
              captionText(image.caption ?? "", triggerWord),
              "utf-8",
            );
            captioned += 1;
          } catch {
            // missing sidecar just falls back to auto-captioning
          }
        }
      }
    },
  );
  await Promise.all(workers);
  entries.sort((a, b) => a.index - b.index);
  return { materialized, captioned, entries };
}

async function cleanupOldRunDirs(boardDir: string): Promise<void> {
  try {
    const cutoff = Date.now() - OLD_RUN_MAX_AGE_MS;
    const entries = await fs.readdir(boardDir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory()) return;
        const runDir = path.resolve(path.join(boardDir, entry.name));
        if (!isInside(boardDir, runDir)) return;
        const stat = await fs.stat(runDir).catch(() => null);
        if (!stat || stat.mtimeMs >= cutoff) return;
        await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
      }),
    );
  } catch {}
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "GET, POST, OPTIONS"),
  });
}

// StyleVault job statuses: queued | running | done | error (cancel → error).
const TERMINAL_STATUSES = new Set(["done", "error"]);

/**
 * GET /api/moodboards/[id]/train — the board's recorded LoRA runs.
 * Non-terminal runs get their status refreshed from StyleVault (best-effort;
 * SV being down still returns the recorded history).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = guardRoute(request, { max: 120 });
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    let moodboard = await getMoodboard(id);
    if (!moodboard)
      return jsonResponse({ ok: false, error: "Moodboard not found" }, 404);

    const stale = (moodboard.trainingRuns ?? []).filter(
      (run) => !TERMINAL_STATUSES.has(run.status ?? ""),
    );
    for (const run of stale) {
      if (isLocalJobId(run.jobId)) {
        const detail = getLocalJob(run.jobId);
        if (!detail) continue;
        const updated = await updateTrainingRun(id, run.jobId, {
          status: detail.status,
          outputLoraPath: detail.output_lora_path ?? undefined,
        });
        if (updated) moodboard = updated;
        continue;
      }
      try {
        const res = await fetch(
          `${env.STYLEVAULT_API_URL}/training/jobs/${encodeURIComponent(run.jobId)}`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (!res.ok) continue;
        const detail = await res.json();
        const updated = await updateTrainingRun(id, run.jobId, {
          status: typeof detail.status === "string" ? detail.status : undefined,
          outputLoraPath: detail.output_lora_path ?? undefined,
        });
        if (updated) moodboard = updated;
      } catch {
        // SV unreachable — serve recorded state.
      }
    }

    return jsonResponse({
      ok: true,
      runs: moodboard.trainingRuns ?? [],
      nextVersion: nextTrainingVersion(moodboard),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Moodboard Train GET] Error:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = guardRoute(request, { max: 5 });
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    const parsed = trainSchema.safeParse(await request.json());
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      return jsonResponse(
        {
          ok: false,
          error: `Validation: ${firstError?.path.join(".")} - ${firstError?.message}`,
        },
        400,
      );
    }

    const limitError = validateTrainParams(parsed.data);
    if (limitError)
      return jsonResponse({ ok: false, error: `Validation: ${limitError}` }, 400);

    const local = !styleVaultTrains();
    if (local) {
      const p = parsed.data;
      if (!pickRoute(p.model_family))
        return jsonResponse(
          {
            ok: false,
            error: `Trainer not configured for ${p.model_family}. ${TRAINER_SETUP_HINT}`,
            setup: true,
          },
          409,
        );
      const busy = activeJobId();
      if (busy)
        return jsonResponse(
          {
            ok: false,
            error: "Another training job is already running.",
            active_job_id: busy,
          },
          409,
        );
    }

    return await withLock(`train:${id}`, async () => {
      const moodboard = await getMoodboard(id);
      if (!moodboard)
        return jsonResponse({ ok: false, error: "Moodboard not found" }, 404);
      if (!moodboard.images.length) {
        return jsonResponse(
          { ok: false, error: "Moodboard has no images" },
          400,
        );
      }

      const captionSettings = normalizeCaptionSettings(
        moodboard.captionSettings,
      );
      const {
        trigger_word: requestedTrigger,
        version,
        caption_ext,
        model_family,
        ...optionalParams
      } = parsed.data;
      const trigger_word = requestedTrigger || captionSettings.triggerWord;
      if (!trigger_word) {
        return jsonResponse(
          {
            ok: false,
            error:
              "Validation: trigger_word - Required (set one on the dataset or in the request)",
          },
          400,
        );
      }

      const trainingRoot = path.resolve(MOODBOARD_TRAINING_DIR);
      const boardDir = path.resolve(path.join(trainingRoot, id));
      if (!isInside(trainingRoot, boardDir)) {
        return jsonResponse({ ok: false, error: "Invalid moodboard id" }, 400);
      }
      await cleanupOldRunDirs(boardDir);
      const targetDir = path.join(boardDir, randomUUID());
      await fs.mkdir(targetDir, { recursive: true });
      const captionExt = caption_ext ?? "txt";
      const { materialized, captioned, entries } = await materializeImages(
        moodboard.images,
        targetDir,
        captionExt,
        trigger_word,
        local,
      );
      const dataset = assessMaterialized(moodboard.images.length, materialized);
      if (dataset.error) {
        await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
        return jsonResponse(
          {
            ok: false,
            error: dataset.error,
            materialized,
            skipped: dataset.skipped,
          },
          400,
        );
      }
      const datasetReport = {
        materialized,
        skipped: dataset.skipped,
        ...(dataset.warning ? { warning: dataset.warning } : {}),
      };

      // Dataset manifest next to the images: HF/ai-toolkit metadata.jsonl
      // (captioned pairs) + dataset.json with the caption knobs, so trainers
      // that read the dir instead of SV params still get them.
      const knobParams = captionTrainingParams(captionSettings);
      try {
        await fs.writeFile(
          path.join(targetDir, "metadata.jsonl"),
          buildMetadataJsonl(entries, trigger_word),
          "utf-8",
        );
        await fs.writeFile(
          path.join(targetDir, "dataset.json"),
          JSON.stringify(
            {
              board_id: id,
              kind: moodboard.kind ?? "moodboard",
              trigger_word,
              caption_ext: `.${captionExt}`,
              caption_dropout_rate: captionSettings.dropoutRate ?? 0,
              shuffle_caption: captionSettings.shuffle ?? false,
              keep_tokens: captionSettings.keepTokens ?? 0,
              images: entries.map((e) => ({
                file_name: e.fileName,
                captioned: Boolean(e.caption?.trim()),
              })),
            },
            null,
            2,
          ),
          "utf-8",
        );
      } catch (err) {
        console.error("[Moodboard Train] manifest write failed:", err);
      }

      const paramsBody = {
        auto_caption: true,
        trigger_word,
        caption_ext: `.${captionExt}`,
        ...knobParams,
        ...Object.fromEntries(
          Object.entries(optionalParams).filter(
            ([, value]) => value !== undefined,
          ),
        ),
      };

      const runVersion = version ?? nextTrainingVersion(moodboard);
      const kindPrefix = moodboard.kind ?? "moodboard";
      const runName =
        `${kindPrefix}-${slug(moodboard.name)}` +
        (runVersion > 1 ? `-v${runVersion}` : "");

      // A run that never reached StyleVault leaves nothing to train from, so
      // drop its fresh materialized copy (deleted boards never get pruned).
      const discardRunDir = async () => {
        await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
        await fs.rmdir(boardDir).catch(() => {}); // only succeeds when empty
      };
      if (local) {
        let job;
        try {
          job = startLocalTraining({
            family: model_family,
            runName,
            datasetDir: targetDir,
            params: {
              steps: optionalParams.steps,
              lr: optionalParams.lr,
              rank: optionalParams.rank,
              resolution: optionalParams.resolution,
              blocksToSwap: optionalParams.blocks_to_swap,
              excludeShared: optionalParams.exclude_shared,
              triggerWord: trigger_word,
              captionExt: `.${captionExt}`,
            },
          });
        } catch (err) {
          await discardRunDir();
          if (err instanceof TrainerBusyError)
            return jsonResponse(
              {
                ok: false,
                error: err.message,
                active_job_id: err.activeJobId,
              },
              409,
            );
          if (err instanceof LocalTrainingError)
            return jsonResponse({ ok: false, error: err.message }, err.status);
          throw err;
        }
        await recordTrainingRun(id, {
          jobId: job.job_id,
          runName,
          version: runVersion,
          triggerWord: trigger_word,
          startedAt: job.created_at,
          status: "queued",
        }).catch((err) =>
          console.error("[Moodboard Train] history record failed:", err),
        );
        return jsonResponse({
          job_id: job.job_id,
          status: "queued",
          backend: job.backend,
          trainer: "local",
          ...datasetReport,
          captioned,
          run_name: runName,
          version: runVersion,
        });
      }

      const svResponse = await fetch(
        `${env.STYLEVAULT_API_URL}/training/jobs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            backend: FAMILY_BACKEND[model_family],
            model_family,
            run_name: runName,
            dataset: { images_dir: targetDir, caption_ext: `.${captionExt}` },
            params: paramsBody,
          }),
          signal: AbortSignal.timeout(30000),
        },
      ).catch(async (err: unknown) => {
        await discardRunDir();
        const reason = err instanceof Error ? err.message : String(err);
        console.error("[Moodboard Train] StyleVault unreachable:", reason);
        return null;
      });
      if (!svResponse) {
        return jsonResponse(
          {
            ok: false,
            error:
              "StyleVault is unreachable (is the training server running?)",
          },
          502,
        );
      }

      const body = await svResponse.json().catch(() => ({}));
      if (!svResponse.ok) {
        await discardRunDir();
        return jsonResponse(
          {
            ok: false,
            error: body?.detail || body?.error || "StyleVault training failed",
          },
          502,
        );
      }

      if (body?.job_id != null) {
        await recordTrainingRun(id, {
          jobId: String(body.job_id),
          runName,
          version: runVersion,
          triggerWord: trigger_word,
          startedAt: new Date().toISOString(),
          status: typeof body.status === "string" ? body.status : "queued",
        }).catch((err) =>
          console.error("[Moodboard Train] history record failed:", err),
        );
      }

      return jsonResponse({
        ...body,
        ...datasetReport,
        captioned,
        run_name: runName,
        version: runVersion,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Moodboard Train] Error:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
}

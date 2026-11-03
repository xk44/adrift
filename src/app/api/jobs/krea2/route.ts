/**
 * POST /api/jobs/krea2
 * Synchronous Krea 2 direct backend generation.
 */

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import path from "path";
import { apiCorsHeaders, apiLog } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { env } from "@/lib/env";
import { parseImagineInput } from "@/lib/oj/parser";
import {
  buildImagineRuns,
  buildNegativePrompt,
  calculateDims,
} from "@/lib/oj/engine";
import {
  insertPrompt,
  insertRun,
  insertJob,
  insertOutput,
  updateJobStatus,
  updateRunStatus,
} from "@/lib/db";
import { addActiveRun } from "@/lib/comfy/runs";
import {
  validateBatchSize,
  validatePrompt,
  validateRequiredString,
} from "@/lib/validate";
import type { ImageAttachment, ImagineResponse } from "@/types";
import { selectControlOverridesForGraph } from "@/lib/workflowControlScope";
import { comfyOutputDir } from "@/lib/paths/resolveDirs";

const MAX_BYTES = 8_388_608;
const OUTPUT_SUBFOLDER = "krea2_direct";

type Krea2GenerateResponse = {
  images?: unknown;
  meta?: Record<string, unknown>;
};

function jsonResponse(
  data: unknown,
  status = 200,
  request?: NextRequest,
): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: apiCorsHeaders(request ?? null, "POST, OPTIONS"),
  });
}

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(request, "POST, OPTIONS"),
  });
}

function numberParam(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stylizationParam(params: Record<string, unknown>): number | undefined {
  const explicit = numberParam(params.stylization);
  if (explicit !== undefined) return explicit;
  const stylize = numberParam(params.stylize);
  return stylize !== undefined ? stylize / 1000 : undefined;
}

function pngDimensions(buffer: Buffer): { width?: number; height?: number } {
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  return {};
}

function isMoodboardPayload(value: string): boolean {
  if (value.startsWith("data:image/png;base64,")) return true;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length > 64;
}

function moodboardFromAttachments(
  attachments: ImageAttachment[] | undefined,
): string[] | undefined {
  const images = (attachments ?? [])
    .filter(
      (attachment) =>
        attachment.mode === "style_ref" || attachment.mode === "image_prompt",
    )
    .map((attachment) => attachment.url)
    .filter((url) => typeof url === "string" && isMoodboardPayload(url));
  return images.length > 0 ? images : undefined;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = uuidv4();
  const startTime = Date.now();

  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 12 });
  if (!rl.ok) return rl.response;

  const contentLength = parseInt(
    request.headers.get("content-length") || "0",
    10,
  );
  if (contentLength > MAX_BYTES) {
    return jsonResponse({ ok: false, error: "Payload too large" }, 413);
  }

  try {
    const body = await request.json();
    const {
      prompt: rawPrompt,
      client_id: clientId,
      batch_size: rawBatchSize,
      base_negative: baseNegative = "ugly, blurry, low quality, distorted",
      source_images: sourceImages,
      workflow_control_overrides: workflowControlOverrides,
    } = body as {
      prompt?: string;
      client_id?: string;
      batch_size?: number;
      base_negative?: string;
      source_images?: ImageAttachment[];
      workflow_control_overrides?: Record<string, unknown>;
    };

    if (typeof rawPrompt !== "string") {
      return jsonResponse(
        { ok: false, error: "Missing or invalid 'prompt' field" },
        400,
      );
    }
    const promptResult = validatePrompt(rawPrompt);
    if (!promptResult.ok) {
      return jsonResponse({ ok: false, error: promptResult.error }, 400);
    }
    const prompt = promptResult.text;

    const clientIdResult = validateRequiredString(clientId, "client_id", 200);
    if (!clientIdResult.ok) {
      return jsonResponse({ ok: false, error: clientIdResult.error }, 400);
    }

    const batchSize = validateBatchSize(rawBatchSize ?? 1);
    const parseResult = parseImagineInput(prompt);
    const dims = calculateDims((parseResult.params.ar as string) ?? "1:1");
    const negativePrompt = buildNegativePrompt(
      parseResult.params.raw ? "" : baseNegative,
      parseResult.params.no as string[] | undefined,
    );
    const params: Record<string, unknown> = {
      ...parseResult.params,
      negativePrompt,
      // No graph here: graph-scoped panel overrides never apply.
      ...selectControlOverridesForGraph(workflowControlOverrides, null),
    };
    const moodboard = moodboardFromAttachments(sourceImages);
    const runs = buildImagineRuns(parseResult, {} as never, {
      batchSize,
      baseNegative,
      sourceImages,
    });

    insertPrompt(requestId, prompt, JSON.stringify(params), "krea2-direct");

    const outputDir = path.join(comfyOutputDir(env.COMFY_ROOT), OUTPUT_SUBFOLDER);
    await fs.mkdir(outputDir, { recursive: true });

    for (const run of runs) {
      insertRun(run.run_id, requestId, 0);

      for (const job of run.jobs) {
        const jobId = `${run.run_id}:${job.index}`;
        insertJob(jobId, run.run_id, job.seed);
        // A throw (backend down, 30-min timeout, disk error) must not escape
        // to the outer catch and leave this job/run stuck non-terminal in
        // the DB forever: record it and move on to the next job.
        try {
          const backendPayload = {
            prompt: parseResult.prompt,
            negative_prompt: negativePrompt,
            checkpoint: parseResult.params.raw ? "raw" : "turbo",
            steps: numberParam(params.steps),
            cfg: numberParam(params.cfg),
            width: dims.width,
            height: dims.height,
            seed: job.seed,
            num_images: 1,
            stylization: stylizationParam(params),
            minimalism_maximalism: numberParam(params.minimalism_maximalism),
            moodboard,
            moodboard_strength: numberParam(params.moodboard_strength),
          };

          const response = await fetch(`${env.KREA2_BACKEND_URL}/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(backendPayload),
            signal: AbortSignal.timeout(30 * 60_000),
          });

          if (!response.ok) {
            const text = await response.text();
            const error = `Krea2 backend returned ${response.status}: ${text.slice(0, 200)}`;
            updateJobStatus(jobId, "error", error);
            job.status = "error";
            job.error = error;
            continue;
          }

          const result = (await response.json()) as Krea2GenerateResponse;
          const images = Array.isArray(result.images)
            ? result.images.filter(
                (img): img is string => typeof img === "string",
              )
            : [];

          if (images.length === 0) {
            const error = "Krea2 backend returned no images";
            updateJobStatus(jobId, "error", error);
            job.status = "error";
            job.error = error;
            continue;
          }

          job.images = [];
          for (let i = 0; i < images.length; i++) {
            const raw = images[i].includes(",")
              ? images[i].split(",", 2)[1]
              : images[i];
            const buffer = Buffer.from(raw, "base64");
            const filename = `CJ_Krea2_${requestId}_${job.index}_${i}.png`;
            await fs.writeFile(path.join(outputDir, filename), buffer);
            const size = pngDimensions(buffer);
            insertOutput(
              jobId,
              filename,
              OUTPUT_SUBFOLDER,
              size.width ?? dims.width,
              size.height ?? dims.height,
              "image",
            );
            const url = `/api/comfy/image?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(OUTPUT_SUBFOLDER)}&type=output`;
            job.images.push(url);
          }

          updateJobStatus(jobId, "done");
          job.status = "done";
          job.progress = 100;
          job.completedAt = Date.now();
        } catch (err) {
          const error = `Krea2 job failed: ${err instanceof Error ? err.message : String(err)}`;
          updateJobStatus(jobId, "error", error);
          job.status = "error";
          job.error = error;
        }
      }

      const runStatus = run.jobs.some((job) => job.status === "error")
        ? "error"
        : "done";
      updateRunStatus(run.run_id, runStatus);
      run.status = runStatus;
      addActiveRun(run);
    }

    const hasImages = runs.some((run) =>
      run.jobs.some((job) => job.images.length > 0),
    );
    if (!hasImages) {
      return jsonResponse(
        {
          ok: false,
          error: "Krea2 backend failed to generate any images",
          request_id: requestId,
          runs,
        },
        502,
      );
    }

    apiLog(
      "Krea2",
      `[${requestId}] Completed ${batchSize} image(s) in ${Date.now() - startTime}ms`,
    );

    const response: ImagineResponse = {
      ok: true,
      request_id: requestId,
      runs,
    };
    if (parseResult.unknownFlags.length > 0) {
      response.warnings = { unknownFlags: parseResult.unknownFlags };
    }
    return jsonResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return jsonResponse(
      {
        ok: false,
        error: `Server error: ${message}`,
        request_id: requestId,
      },
      500,
    );
  }
}

/**
 * Style Preview API
 * Generate thumbnail previews for style codes.
 *
 * POST /api/style/preview
 * - code: Style code to preview
 * - prompt: Optional test prompt (default: "a beautiful landscape, nature photography")
 * - size: Preview size (default: 256)
 *
 * GET /api/style/preview?code=<code>
 * - Returns cached preview URL if available
 *
 * GET /api/style/preview?image=<code>
 * - Serves the preview PNG (admin-gated). Previews live under data/, not
 *   public/, so they are not world-readable static files.
 */

import { selfBaseUrl, selfRequestHeaders } from "@/lib/net/selfUrl";
import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import path from "path";
import { apiCorsHeaders } from "@/lib/api";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { fetchHistory, fetchImage } from "@/lib/comfy/http";
import { isMissingDbError } from "@/lib/jsonDbLoad";
import type { ComfyHistoryEntry, ComfyOutputImage } from "@/types";
import { extractOutputs } from "@/lib/comfy/outputs";
import {
  validatePlainObject,
  validatePrompt,
  validateRequiredString,
} from "@/lib/validate";
import { adriftDataPath } from "@/lib/paths/resolveDirs";

interface PreviewJob {
  id: string;
  code: string;
  status: "queued" | "processing" | "done" | "error";
  prompt: string;
  createdAt: number;
  previewUrl?: string;
  error?: string;
}

interface PreviewCache {
  version: number;
  previews: Record<
    string,
    {
      url: string;
      generatedAt: number;
      prompt: string;
    }
  >;
  pendingJobs: PreviewJob[];
}

type PreviewPostResult =
  | { ok: true; cached: true; preview: PreviewCache["previews"][string] }
  | { ok: true; pending: true; job: PreviewJob }
  | { ok: true; queued: true; job: PreviewJob };

const CACHE_PATH = adriftDataPath("style_previews.json");
const PREVIEW_DIR = adriftDataPath("style-previews");
/** Legacy location (publicly served by Next); read-only fallback. */
const LEGACY_PREVIEW_DIR = path.join(process.cwd(), "public/previews");
const previewUrlFor = (code: string) => `/api/style/preview?image=${code}`;
const LEGACY_URL = /^\/previews\/(\d{6,12})\.png$/;

/** Rewrite cached legacy "/previews/<code>.png" URLs to the authed route. */
function migrateLegacyUrls(cache: PreviewCache): PreviewCache {
  for (const p of Object.values(cache.previews ?? {})) {
    const m = typeof p?.url === "string" ? LEGACY_URL.exec(p.url) : null;
    if (m) p.url = previewUrlFor(m[1]);
  }
  for (const j of cache.pendingJobs ?? []) {
    const m = typeof j.previewUrl === "string" ? LEGACY_URL.exec(j.previewUrl) : null;
    if (m) j.previewUrl = previewUrlFor(m[1]);
  }
  return cache;
}
const PREVIEW_POLL_INTERVAL_MS = 2_000;
const PREVIEW_POLL_TIMEOUT_MS = 120_000;

const DEFAULT_PROMPT =
  "a beautiful landscape with mountains and a lake, nature photography, golden hour lighting";

async function loadCache(): Promise<PreviewCache> {
  try {
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    const content = await fs.readFile(CACHE_PATH, "utf-8");
    return migrateLegacyUrls(JSON.parse(content) as PreviewCache);
  } catch (err) {
    // Only a missing file means "empty cache". A corrupt/unreadable file must
    // surface, otherwise the next save silently wipes every stored preview.
    if (!isMissingDbError(err)) throw err;
    return { version: 1, previews: {}, pendingJobs: [] };
  }
}

// Finished jobs are only needed briefly for GET ?job= polling; without pruning
// the cache file grows by one entry per preview forever.
const FINISHED_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FINISHED_JOBS = 200;

function pruneFinishedJobs(
  jobs: PreviewJob[],
  now = Date.now(),
): PreviewJob[] {
  const active = jobs.filter(
    (j) => j.status === "queued" || j.status === "processing",
  );
  const finished = jobs
    .filter(
      (j) =>
        (j.status === "done" || j.status === "error") &&
        now - j.createdAt <= FINISHED_JOB_TTL_MS,
    )
    .slice(-MAX_FINISHED_JOBS);
  const keep = new Set([...active, ...finished]);
  return jobs.filter((j) => keep.has(j));
}

async function saveCache(cache: PreviewCache): Promise<void> {
  const dir = path.dirname(CACHE_PATH);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.style_previews.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, JSON.stringify(cache, null, 2), "utf-8");
    await fs.rename(tempPath, CACHE_PATH);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

let cacheMutationQueue: Promise<void> = Promise.resolve();

async function withCacheUpdate<T>(
  update: (
    cache: PreviewCache,
  ) => Promise<{ value: T; changed: boolean }> | { value: T; changed: boolean },
): Promise<T> {
  const run = cacheMutationQueue.then(async () => {
    const cache = await loadCache();
    const { value, changed } = await update(cache);
    if (changed) await saveCache(cache);
    return value;
  });
  cacheMutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function jsonResponse(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: apiCorsHeaders(null, "GET, POST, OPTIONS"),
  });
}

function badRequest(error: string): NextResponse {
  return jsonResponse({ ok: false, error }, 400);
}

function validateStyleCode(value: unknown): string | { error: string } {
  const validated = validateRequiredString(value, "code", 12);
  if (!validated.ok) return { error: validated.error };
  if (!/^\d{6,12}$/.test(validated.text)) {
    return { error: "Style code must be 6-12 digits" };
  }
  return validated.text;
}

function parsePreviewPrompt(value: unknown): string | { error: string } {
  if (value === undefined || value === null) return DEFAULT_PROMPT;
  const validated = validatePrompt(typeof value === "string" ? value : "");
  if (!validated.ok) return { error: validated.error };
  return validated.text;
}

function clampPreviewSize(value: unknown): number {
  if (value === undefined || value === null) return 256;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 256;
  const rounded = Math.round(parsed / 64) * 64;
  return Math.max(64, Math.min(2048, rounded));
}

function hasError(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractPromptIds(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const runs = (result as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) return [];

  const promptIds: string[] = [];
  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    const jobs = (run as { jobs?: unknown }).jobs;
    if (!Array.isArray(jobs)) continue;
    for (const job of jobs) {
      if (!job || typeof job !== "object") continue;
      const promptId = (job as { prompt_id?: unknown }).prompt_id;
      if (typeof promptId === "string" && promptId.trim()) {
        promptIds.push(promptId);
      }
    }
  }

  return promptIds;
}

function extractFirstOutputImage(
  entry: ComfyHistoryEntry,
): ComfyOutputImage | null {
  // First still image; a video/mesh/text output can't be a style preview.
  const first = extractOutputs(entry).find(
    (o) => (o.kind === "image" || o.kind === "animated") && o.view,
  );
  return first?.view ?? null;
}

async function waitForPreviewImage(
  promptIds: string[],
  timeoutMs = PREVIEW_POLL_TIMEOUT_MS,
): Promise<ComfyOutputImage> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  while (Date.now() < deadline) {
    for (const promptId of promptIds) {
      const entry = await fetchHistory(promptId);
      if (!entry) continue;

      const status = entry.status?.status_str?.toLowerCase() ?? "";
      if (status.includes("error") || status.includes("failed")) {
        throw new Error(`Generation failed for prompt ${promptId}`);
      }
      if (entry.status?.completed === false) continue;

      const image = extractFirstOutputImage(entry);
      if (image) return image;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(PREVIEW_POLL_INTERVAL_MS, remaining));
  }

  throw new Error("Preview generation timed out");
}

async function writePreviewImage(
  code: string,
  image: ComfyOutputImage,
): Promise<string> {
  const buffer = await fetchImage(
    image.filename,
    image.subfolder || "",
    image.type || "output",
  );
  await fs.mkdir(PREVIEW_DIR, { recursive: true });
  await fs.writeFile(path.join(PREVIEW_DIR, `${code}.png`), buffer);
  return previewUrlFor(code);
}

async function servePreviewImage(code: string): Promise<NextResponse> {
  for (const dir of [PREVIEW_DIR, LEGACY_PREVIEW_DIR]) {
    try {
      const buf = await fs.readFile(path.join(dir, `${code}.png`));
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      /* try the next location */
    }
  }
  return jsonResponse({ ok: false, error: "Preview not found" }, 404);
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "GET, POST, OPTIONS"),
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;

  try {
    const { searchParams } = new URL(request.url);
    const imageParam = searchParams.get("image");
    if (imageParam !== null) {
      const imageCode = validateStyleCode(imageParam);
      if (hasError(imageCode)) return badRequest(imageCode.error);
      return servePreviewImage(imageCode);
    }
    const codeParam = searchParams.get("code");
    const jobIdParam = searchParams.get("jobId");
    const code = codeParam ? validateStyleCode(codeParam) : undefined;
    if (hasError(code)) return badRequest(code.error);
    const jobId = jobIdParam?.slice(0, 80);

    const cache = await loadCache();

    // Check specific job status
    if (jobId) {
      const job = cache.pendingJobs.find((j) => j.id === jobId);
      if (!job) {
        return jsonResponse({ ok: false, error: "Job not found" }, 404);
      }
      return jsonResponse({
        ok: true,
        job,
        preview: job.status === "done" ? cache.previews[job.code] : undefined,
      });
    }

    // Check cached preview for code
    if (code) {
      const preview = cache.previews[code];
      const pendingJob = cache.pendingJobs.find(
        (j) =>
          j.code === code &&
          (j.status === "queued" || j.status === "processing"),
      );

      return jsonResponse({
        ok: true,
        code,
        hasPreview: !!preview,
        preview: preview ?? undefined,
        pending: pendingJob ?? undefined,
      });
    }

    // List all previews
    return jsonResponse({
      ok: true,
      totalPreviews: Object.keys(cache.previews).length,
      pendingJobs: cache.pendingJobs.filter(
        (j) => j.status === "queued" || j.status === "processing",
      ).length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Preview GET] Error:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 10 });
  if (!rl.ok) return rl.response;

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return badRequest("Invalid JSON body");
    }

    const object = validatePlainObject(body, "body");
    if (typeof object === "string") return badRequest(object);

    const code = validateStyleCode(object.code);
    if (hasError(code)) return badRequest(code.error);

    const prompt = parsePreviewPrompt(object.prompt);
    if (hasError(prompt)) return badRequest(prompt.error);

    const size = clampPreviewSize(object.size);
    const force = typeof object.force === "boolean" ? object.force : false;

    let jobToQueue: PreviewJob | undefined;
    const result = await withCacheUpdate<PreviewPostResult>((cache) => {
      // Check if already cached (unless force regenerate)
      if (!force && cache.previews[code]) {
        return {
          changed: false,
          value: {
            ok: true,
            cached: true,
            preview: cache.previews[code],
          },
        };
      }

      // Check if already pending
      const existingJob = cache.pendingJobs.find(
        (j) =>
          j.code === code &&
          (j.status === "queued" || j.status === "processing"),
      );

      if (existingJob && !force) {
        // A queued/processing job older than the poll timeout means the
        // process restarted mid-generation — expire it so this POST requeues
        // instead of reporting "pending" forever.
        const stale =
          Date.now() - existingJob.createdAt > PREVIEW_POLL_TIMEOUT_MS;
        if (!stale) {
          return {
            changed: false,
            value: {
              ok: true,
              pending: true,
              job: existingJob,
            },
          };
        }
        existingJob.status = "error";
        existingJob.error = "Preview generation expired";
      }

      const jobId = uuidv4();
      const previewPrompt = `${prompt} --sref ${code} --sw 500 --ar 1:1`;

      const job: PreviewJob = {
        id: jobId,
        code,
        status: "queued",
        prompt: previewPrompt,
        createdAt: Date.now(),
      };

      cache.pendingJobs = pruneFinishedJobs(cache.pendingJobs);
      cache.pendingJobs.push(job);
      jobToQueue = job;
      return { changed: true, value: { ok: true, queued: true, job } };
    });

    // Queue to ComfyUI (async - don't wait)
    if (jobToQueue) {
      queuePreviewGeneration(jobToQueue, size).catch((error) => {
        console.error(`[Preview] Generation failed for ${code}:`, error);
      });
    }

    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Preview POST] Error:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
}

/**
 * Queue preview generation to ComfyUI
 * This is called async and updates the cache when done
 */
async function queuePreviewGeneration(
  job: PreviewJob,
  size: number,
): Promise<void> {
  const markedProcessing = await withCacheUpdate((cache) => {
    const jobIndex = cache.pendingJobs.findIndex((j) => j.id === job.id);
    if (jobIndex < 0) return { value: false, changed: false };
    cache.pendingJobs[jobIndex].status = "processing";
    return { value: true, changed: true };
  });

  if (!markedProcessing) return;

  try {
    // Call imagine API
    // X-Requested-With: passes the CSRF check in no-key mode too
    const headers = selfRequestHeaders(env.ADMIN_API_KEY);

    const response = await fetch(`${getBaseUrl()}/api/jobs/imagine`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify({
        prompt: job.prompt,
        client_id: `preview-${job.id}`,
        batch_size: 1,
      }),
    });

    const result = await response.json();

    if (!result.ok) {
      throw new Error(result.error ?? "Generation failed");
    }

    const promptIds = extractPromptIds(result);
    if (promptIds.length === 0) {
      throw new Error("Generation failed to return a ComfyUI prompt_id");
    }

    const outputImage = await waitForPreviewImage(promptIds);
    const previewUrl = await writePreviewImage(job.code, outputImage);

    await withCacheUpdate((cache) => {
      const updatedJobIndex = cache.pendingJobs.findIndex(
        (j) => j.id === job.id,
      );
      if (updatedJobIndex < 0) return { value: undefined, changed: false };

      cache.pendingJobs[updatedJobIndex].status = "done";
      cache.pendingJobs[updatedJobIndex].previewUrl = previewUrl;

      cache.previews[job.code] = {
        url: previewUrl,
        generatedAt: Date.now(),
        prompt: job.prompt,
      };

      return { value: undefined, changed: true };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    await withCacheUpdate((cache) => {
      const updatedJobIndex = cache.pendingJobs.findIndex(
        (j) => j.id === job.id,
      );
      if (updatedJobIndex < 0) return { value: undefined, changed: false };
      cache.pendingJobs[updatedJobIndex].status = "error";
      cache.pendingJobs[updatedJobIndex].error = message;
      return { value: undefined, changed: true };
    });
  }
}

function getBaseUrl(): string {
  // Server-side fetch needs an absolute URL on the address we listen on
  return selfBaseUrl();
}

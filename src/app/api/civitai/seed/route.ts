/**
 * POST /api/civitai/seed
 * Scans a ComfyUI models subdirectory, hashes model files, looks them up on
 * Civitai by SHA256 in batch, and returns DownloadedModel records for the download store.
 *
 * Body: { targetDir?: string }   e.g. "loras", "checkpoints"
 */

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { createReadStream, statSync } from "fs";
import { mkdir, readFile, writeFile, readdir, rename, rm } from "fs/promises";
import path from "path";
import { env } from "@/lib/env";
import { batchLookupByHash } from "@/lib/civitai";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { BodyTooLargeError, readJsonCapped } from "@/lib/net/readCapped";
import { apiCorsHeaders } from "@/lib/api";
import { validatePlainObject, validateRequiredString } from "@/lib/validate";
import type { DownloadedModel } from "@/store/downloadStore";
import { comfyModelsDir } from "@/lib/paths/resolveDirs";

// Types

interface HashCacheEntry {
  hash: string;
  mtime: number;
  size: number;
}

type HashCache = Record<string, HashCacheEntry>;

// Helpers

const MODEL_EXTS = new Set([".safetensors", ".ckpt", ".pt"]);
const CACHE_FILENAME = ".adrift-hashes.json";
/** Hash cache name written before the Adrift rename; read as a fallback. */
const LEGACY_CACHE_FILENAME = ".comfyjourney-hashes.json"; // legacy-name
const MAX_BODY_BYTES = 1024;
const CORS_HEADERS = apiCorsHeaders(null, "POST, OPTIONS");

const ALLOWED_TARGET_DIRS = new Set([
  "checkpoints",
  "loras",
  "controlnet",
  "embeddings",
  "vae",
  "upscale_models",
]);

function jsonResponse(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: CORS_HEADERS });
}

function badRequest(error: string): NextResponse {
  return jsonResponse({ ok: false, error }, 400);
}

function parseTargetDir(value: unknown): string | { error: string } {
  if (value === undefined) return "loras";
  const validated = validateRequiredString(value, "targetDir", 64);
  if (!validated.ok) return { error: validated.error };
  if (!ALLOWED_TARGET_DIRS.has(validated.text)) {
    return {
      error: `targetDir must be one of: ${[...ALLOWED_TARGET_DIRS].join(", ")}`,
    };
  }
  return validated.text;
}

function hasError(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value;
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

function streamSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex").toUpperCase()));
    stream.on("error", reject);
  });
}

async function loadHashCache(
  cacheFile: string,
  legacyCacheFile?: string,
): Promise<HashCache> {
  for (const file of legacyCacheFile ? [cacheFile, legacyCacheFile] : [cacheFile]) {
    try {
      const raw = await readFile(file, "utf8");
      return JSON.parse(raw) as HashCache;
    } catch {
      /* missing or unreadable: try the next candidate */
    }
  }
  return {};
}

async function saveHashCache(
  cacheFile: string,
  cache: HashCache,
): Promise<void> {
  const dir = path.dirname(cacheFile);
  await mkdir(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.adrift-hashes.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await writeFile(tempPath, JSON.stringify(cache, null, 2), "utf8");
    await rename(tempPath, cacheFile);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function collectModelFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const ext = path.extname(entry).toLowerCase();
    if (MODEL_EXTS.has(ext)) {
      results.push(path.join(dir, entry));
    }
  }
  return results;
}

// Route

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);

  const rl = withRateLimit(request, { windowMs: 60_000, max: 5 });
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, error: "Too many requests" },
      {
        status: 429,
        headers: { ...CORS_HEADERS, "Retry-After": "60" },
      },
    );
  }

  const contentLengthHeader = request.headers.get("content-length");
  const contentLengthVal = Number(contentLengthHeader ?? "0");
  if (
    contentLengthHeader &&
    Number.isFinite(contentLengthVal) &&
    contentLengthVal > MAX_BODY_BYTES
  ) {
    return jsonResponse({ ok: false, error: "Payload too large" }, 413);
  }

  let body: unknown = {};
  if (request.body !== null) {
    try {
      body = await readJsonCapped(request, MAX_BODY_BYTES, { emptyValue: {} });
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        return jsonResponse({ ok: false, error: "Payload too large" }, 413);
      }
      return badRequest("Invalid JSON body");
    }
  }

  const object = validatePlainObject(body, "body");
  if (typeof object === "string") return badRequest(object);

  const targetDir = parseTargetDir(object.targetDir);
  if (hasError(targetDir)) return badRequest(targetDir.error);

  const modelsRoot = comfyModelsDir(env.COMFY_ROOT);
  const scanDir = path.join(modelsRoot, targetDir);
  const cacheFile = path.join(modelsRoot, CACHE_FILENAME);

  const files = await collectModelFiles(scanDir);
  if (files.length === 0) {
    return jsonResponse({ ok: true, models: [], scanned: 0 });
  }

  // Phase 1: Hash all files (using local cache for unchanged files)
  const hashCache = await loadHashCache(
    cacheFile,
    path.join(modelsRoot, LEGACY_CACHE_FILENAME),
  );
  let cacheUpdated = false;
  const fileHashes: Array<{ filePath: string; hash: string }> = [];
  const errors: string[] = [];

  for (const filePath of files) {
    let fileStat: ReturnType<typeof statSync>;
    try {
      fileStat = statSync(filePath);
    } catch {
      continue;
    }

    const cached = hashCache[filePath];
    let hash: string;

    if (
      cached &&
      cached.mtime === fileStat.mtimeMs &&
      cached.size === fileStat.size
    ) {
      hash = cached.hash;
    } else {
      try {
        hash = await streamSha256(filePath);
        hashCache[filePath] = {
          hash,
          mtime: fileStat.mtimeMs,
          size: fileStat.size,
        };
        cacheUpdated = true;
      } catch (err) {
        errors.push(
          `Hash failed: ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
    }

    fileHashes.push({ filePath, hash });
  }

  // Phase 2: Batch lookup all hashes on Civitai
  const allHashes = fileHashes.map((f) => f.hash);
  const lookupResults = await batchLookupByHash(allHashes);

  // Phase 3: Build matched results
  const matched: DownloadedModel[] = [];

  for (const { filePath, hash } of fileHashes) {
    const version = lookupResults.get(hash);
    if (!version) continue;

    const primaryFile =
      version.files.find((f) => f.primary) ?? version.files[0];
    const filename = primaryFile?.name ?? path.basename(filePath);

    matched.push({
      civitaiModelId: version.modelId,
      civitaiVersionId: version.id,
      modelName: version.model?.name ?? "Unknown",
      versionName: version.name,
      type: version.model?.type ?? "Unknown",
      filename,
      localPath: filePath,
      sha256: hash,
      trainedWords: version.trainedWords ?? [],
      downloadedAt: new Date().toISOString(),
    });
  }

  if (cacheUpdated) {
    try {
      await saveHashCache(cacheFile, hashCache);
    } catch {
      // Non-fatal
    }
  }

  return jsonResponse({
    ok: true,
    models: matched,
    scanned: files.length,
    matched: matched.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}

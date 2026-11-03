import { NextRequest, NextResponse } from "next/server";
import { createHash, randomUUID } from "crypto";
import { createReadStream } from "fs";
import { unlink, rename, readFile, writeFile } from "fs/promises";
import path from "path";
import {
  fetchCivitaiModelVersion,
  sourceFromNsfw,
  type CivitaiSource,
} from "@/lib/civitai";
import { getCivitaiApiKey, getCivitaiConfig } from "@/lib/civitaiConfig";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/auth";
import { withLock } from "@/lib/locks";
import { withRateLimit } from "@/lib/rateLimit";
import { apiCorsHeaders } from "@/lib/api";
import { statfs } from "fs/promises";
import { validateRequiredString } from "@/lib/validate";
import {
  CIVITAI_DESTS,
  DEST_MAX_BYTES,
  destAllowsExt,
  destLabel,
  civitaiProgressKey,
  isCivitaiDest,
  isPickleFilename,
  planCivitaiFile,
  type CivitaiDest,
} from "@/lib/civitaiFolders";
import {
  DownloadError,
  downloadToFile,
  hostMatches,
} from "@/lib/net/downloadToFile";
import {
  SafeDestError,
  finalizeTemp,
  inspectDest,
  tempPathFor,
} from "@/lib/fs/safeDest";
import { resolveDownloadDest } from "@/lib/modelDownloadDest";
import {
  addProgress,
  finishProgress,
  getProgress,
  progressPercent,
  startProgress,
} from "@/lib/net/downloadProgress";
import { comfyModelsPath } from "@/lib/paths/resolveDirs";

const MAX_BYTES = 524_288;
const CORS_HEADERS = apiCorsHeaders(null, "GET, POST, OPTIONS");

/** Hosts a Civitai download may start on or be redirected to. */
const CIVITAI_HOSTS = ["civitai.com", "civitai.red"];
const CIVITAI_CDN_HOSTS = ["r2.cloudflarestorage.com", "backblazeb2.com"];

const HISTORY_FILENAME = ".civitai_history.json";

interface DownloadBody {
  modelVersionId: number;
  filename: string;
  targetDir: string;
  nsfw?: boolean;
  source?: unknown;
  /** Civitai file id, when the version has several files. */
  fileId?: number;
  /** The user saw the pickle-format warning and chose to continue. */
  acceptPickle?: boolean;
  /** Replace a different file with the same name. */
  overwrite?: boolean;
}

interface DownloadHistoryEntry {
  modelVersionId: number;
  filename: string;
  sha256: string;
  downloadedAt: string;
}

type DownloadHistory = Record<string, DownloadHistoryEntry>;

function parseCivitaiSource(value: unknown): CivitaiSource | null {
  if (value === "com" || value === "red") return value;
  return null;
}

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: CORS_HEADERS });
}

function civitaiApiHost(): string | null {
  try {
    return new URL(env.CIVITAI_API_URL).hostname;
  } catch {
    return null;
  }
}

function isCivitaiHost(hostname: string): boolean {
  const apiHost = civitaiApiHost();
  return hostMatches(
    hostname,
    apiHost ? [...CIVITAI_HOSTS, apiHost] : CIVITAI_HOSTS,
  );
}

function allowDownloadHost(hostname: string): boolean {
  return isCivitaiHost(hostname) || hostMatches(hostname, CIVITAI_CDN_HOSTS);
}

// Helpers

async function loadHistory(): Promise<DownloadHistory> {
  const historyPath = comfyModelsPath(env.COMFY_ROOT, HISTORY_FILENAME);
  try {
    const raw = await readFile(historyPath, "utf8");
    return JSON.parse(raw) as DownloadHistory;
  } catch {
    return {};
  }
}

async function saveHistory(history: DownloadHistory): Promise<void> {
  const historyPath = comfyModelsPath(env.COMFY_ROOT, HISTORY_FILENAME);
  const tmpPath = `${historyPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(history, null, 2), "utf8");
    await rename(tmpPath, historyPath);
  } catch {
    await unlink(tmpPath).catch(() => {});
  }
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

async function checkDiskSpace(
  destDir: string,
  requiredBytes: number,
): Promise<boolean> {
  try {
    const stats = await statfs(destDir);
    const available = stats.bavail * stats.bsize;
    return available > requiredBytes * 1.1; // 10% buffer
  } catch {
    return true; // Can't check — proceed optimistically
  }
}

// Route

/** GET ?key=civitai:<versionId>:<filename> → live progress of a running download. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(request, { windowMs: 60_000, max: 240 });
  if (!rl.ok) return rl.response;
  const key = request.nextUrl.searchParams.get("key") ?? "";
  if (!key.startsWith("civitai:") || key.length > 400) {
    return json({ ok: false, error: "key required" }, 400);
  }
  const p = getProgress(key);
  if (!p) return json({ ok: true, active: false });
  return json({
    ok: true,
    active: !p.done && !p.error,
    received: p.received,
    total: p.total,
    percent: progressPercent(p),
    error: p.error,
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 10 });
  if (!rl.ok) return rl.response;

  const contentLength = parseInt(
    request.headers.get("content-length") || "0",
    10,
  );
  if (contentLength > MAX_BYTES)
    return json({ ok: false, error: "Payload too large" }, 413);

  let body: DownloadBody;
  try {
    body = (await request.json()) as DownloadBody;
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const { modelVersionId, filename, targetDir } = body;
  const config = await getCivitaiConfig();
  const nsfw =
    typeof body.nsfw === "boolean" ? body.nsfw : (config.showNsfw ?? false);
  if (body.source !== undefined && parseCivitaiSource(body.source) === null) {
    return json({ ok: false, error: "source must be com or red" }, 400);
  }
  const source =
    parseCivitaiSource(body.source) ?? config.source ?? sourceFromNsfw(nsfw);

  if (
    typeof modelVersionId !== "number" ||
    !Number.isInteger(modelVersionId) ||
    modelVersionId <= 0
  ) {
    return json({ ok: false, error: "modelVersionId required" }, 400);
  }

  const filenameResult = validateRequiredString(filename, "filename", 255);
  if (!filenameResult.ok)
    return json({ ok: false, error: filenameResult.error }, 400);
  const requestedName = filenameResult.text;
  if (
    path.basename(requestedName) !== requestedName ||
    /[/\\\0]/.test(requestedName) ||
    requestedName === "." ||
    requestedName === ".."
  ) {
    return json({ ok: false, error: "Invalid filename" }, 400);
  }

  if (!isCivitaiDest(targetDir)) {
    return json(
      {
        ok: false,
        error: `targetDir must be one of: ${CIVITAI_DESTS.join(", ")}`,
      },
      400,
    );
  }
  const fileId =
    typeof body.fileId === "number" && Number.isInteger(body.fileId)
      ? body.fileId
      : undefined;

  let tempPath: string | null = null;
  let key: string | null = null;

  try {
    const version = await fetchCivitaiModelVersion(
      modelVersionId,
      nsfw,
      source,
    );
    if (!version)
      return json(
        { ok: false, error: "Model version not found on Civitai" },
        404,
      );

    // Bind the request to a real file of this version: its name, its URL,
    // its hash. The client only picks which one.
    const file = version.files.find(
      (f) =>
        f.name === requestedName && (fileId === undefined || f.id === fileId),
    );
    if (!file) {
      return json(
        { ok: false, error: "That file isn't part of this model version" },
        400,
      );
    }

    // The folder comes from the type Civitai reports, not from the client.
    const modelType = version.model?.type;
    let dest: CivitaiDest = targetDir;
    if (modelType) {
      const plan = planCivitaiFile(modelType, file);
      if (!plan.ok)
        return json({ ok: false, browseOnly: true, error: plan.reason }, 400);
      if (plan.dest !== targetDir) {
        return json(
          {
            ok: false,
            error: `This file belongs in ${destLabel(plan.dest)}`,
            expectedDir: plan.dest,
          },
          400,
        );
      }
      dest = plan.dest;
    } else if (!destAllowsExt(targetDir, file.name)) {
      return json(
        {
          ok: false,
          error: `ComfyUI can't load this file type from ${destLabel(targetDir)}`,
        },
        400,
      );
    }

    if (isPickleFilename(file.name) && body.acceptPickle !== true) {
      return json(
        {
          ok: false,
          needsPickleAck: true,
          error:
            "This file uses an older format that can run code when it loads. Only download it if you trust the creator.",
        },
        409,
      );
    }

    const target = await resolveDownloadDest(dest, file.name);
    const expectedHash = file.hashes?.SHA256?.toUpperCase();
    const expectedSize = file.sizeKB ? Math.round(file.sizeKB * 1024) : 0;

    // Existing file: same content → skip; different → ask before replacing.
    let replace = body.overwrite === true;
    const existing = await inspectDest(target.fullPath);
    if (existing.kind === "file" && existing.size > 0) {
      const same = expectedHash
        ? (await streamSha256(target.fullPath)) === expectedHash
        : expectedSize > 0 && Math.abs(existing.size - expectedSize) < 1024;
      if (same) {
        return json({
          ok: true,
          path: target.fullPath,
          filename: target.name,
          dest,
          skipped: true,
          message: "Already downloaded",
          trainedWords: version.trainedWords ?? [],
        });
      }
      if (!replace) {
        return json(
          {
            ok: false,
            conflict: true,
            error: `A different file named ${target.name} is already in ${destLabel(dest)}.`,
          },
          409,
        );
      }
    } else if (existing.kind === "file") {
      replace = true; // zero-byte leftover
    }

    if (expectedSize > 0 && !(await checkDiskSpace(target.dir, expectedSize))) {
      return json({ ok: false, error: "Insufficient disk space" }, 507);
    }

    const downloadUrl =
      file.downloadUrl || (file.primary ? version.downloadUrl : "");
    if (!downloadUrl)
      return json(
        { ok: false, error: "Civitai gave no download link for this file" },
        502,
      );

    const apiKey = await getCivitaiApiKey();
    const maxBytes =
      expectedSize > 0
        ? Math.min(
            DEST_MAX_BYTES[dest],
            Math.ceil(expectedSize * 1.02) + 1024 * 1024,
          )
        : DEST_MAX_BYTES[dest];

    key = civitaiProgressKey(modelVersionId, file.name);
    startProgress(key, expectedSize);
    tempPath = tempPathFor(target.dir, target.name);
    const progress = key;
    const result = await downloadToFile({
      url: downloadUrl,
      dest: tempPath,
      allowHost: allowDownloadHost,
      // The API key only ever goes to Civitai itself, never to the CDN.
      headersFor: (u) => ({
        "User-Agent": "Adrift/1.0",
        ...(apiKey && isCivitaiHost(u.hostname)
          ? { Authorization: `Bearer ${apiKey}` }
          : {}),
      }),
      maxBytes,
      signal: request.signal,
      onBytes: (n) => addProgress(progress, n),
    });

    if (expectedHash && result.sha256 !== expectedHash) {
      await unlink(tempPath).catch(() => {});
      tempPath = null;
      finishProgress(key, "Checksum mismatch");
      return json(
        {
          ok: false,
          error: `The download doesn't match Civitai's checksum (expected ${expectedHash}, got ${result.sha256}). Nothing was saved.`,
        },
        502,
      );
    }

    await finalizeTemp(tempPath, target.fullPath, { overwrite: replace });
    tempPath = null;
    finishProgress(key);

    await withLock("civitai-download-history", async () => {
      const history = await loadHistory();
      history[`${modelVersionId}:${target.name}`] = {
        modelVersionId,
        filename: target.name,
        sha256: expectedHash ?? result.sha256,
        downloadedAt: new Date().toISOString(),
      };
      await saveHistory(history);
    });

    return json({
      ok: true,
      path: target.fullPath,
      filename: target.name,
      dest,
      sha256: expectedHash ?? result.sha256,
      trainedWords: version.trainedWords ?? [],
    });
  } catch (error) {
    if (tempPath) await unlink(tempPath).catch(() => {});
    const message = error instanceof Error ? error.message : "Unknown error";
    if (key) finishProgress(key, message);

    if (error instanceof SafeDestError) {
      if (error.code === "exists")
        return json({ ok: false, conflict: true, error: message }, 409);
      return json({ ok: false, error: message }, 400);
    }
    if (error instanceof DownloadError) {
      switch (error.code) {
        case "auth":
          return json(
            {
              ok: false,
              error:
                "Civitai requires authentication to download this model. Add your API key in Settings.",
              needsAuth: true,
            },
            403,
          );
        case "host":
        case "redirects":
          return json(
            {
              ok: false,
              error:
                "The download was sent to an unexpected site, so it was stopped.",
            },
            502,
          );
        case "too_large":
          return json(
            {
              ok: false,
              error:
                "The file is bigger than Civitai said it would be, so it was stopped.",
            },
            413,
          );
        case "idle":
          return json(
            {
              ok: false,
              error:
                "The download stalled for a minute and was stopped. Try again.",
            },
            504,
          );
        case "aborted":
          return json({ ok: false, error: "Download cancelled" }, 499);
        default:
          break;
      }
    }

    console.error("[CivitaiAPI] Download failed:", message);
    return json({ ok: false, error: message }, 500);
  }
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

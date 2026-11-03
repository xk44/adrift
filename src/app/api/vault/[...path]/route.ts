import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { capBytes, safeProxiedTypeHeaders } from "@/lib/net/safeContentType";
import { STYLE_CODES_ENABLED } from "@/lib/features";
import { comfyModelsPath, comfyOutputDir } from "@/lib/paths/resolveDirs";
import {
  handleLocalJobPath,
  handleLocalTrainingOffline,
  isLocalJobPath,
  mergeLocalTraining,
  serviceHasTrainer,
} from "@/lib/training/local/proxyRoutes";

const MAX_BYTES = 2_097_152;

const ALLOWED_PATH_PREFIXES = [
  "styles",
  "clusters",
  "representatives",
  "moodboards",
  "health",
  // UMAP projections (Map view)
  "umap",
  // Full-text asset search (Images view)
  "search",
  // Asset thumbnails/files and rating.
  "assets",
  // LoRA training runs & deployment (Train view)
  "training",
  "lora",
  "loras",
  // Imported collections, and the folder indexer (library/index)
  "library",
];

const MUTABLE_PATH_PREFIXES = [
  "assets",
  "clusters",
  "moodboards",
  "styles",
  "training",
  "lora",
  "loras",
  // Only POST library/index; see isAllowedLibraryMutation.
  "library",
];

/**
 * Path groups whose JSON bodies StyleVault turns into filesystem work. A
 * client-supplied `images_dir` there makes StyleVault expand the path and
 * write caption files into that folder, so the proxy refuses it unless the
 * folder sits under a root listed in CJ_VAULT_DATASET_ROOTS (absolute paths,
 * comma/space/colon separated). Server-side callers (moodboard training)
 * talk to StyleVault directly and are unaffected.
 */
const DATASET_PATH_PREFIXES = new Set(["training", "lora", "loras"]);
const DIR_KEYS = new Set(["images_dir", "imagesdir", "image_dir", "dataset_dir"]);
/**
 * Where a trained LoRA is deployed (training/jobs/:id/deploy). The client may
 * leave it out (StyleVault then uses its own configured ComfyUI loras
 * folder); when it is sent it must be COMFY_ROOT/models/loras or a folder
 * inside it, so the proxy never makes StyleVault write a file anywhere else.
 */
const LORA_DIR_KEYS = new Set(["lora_dir", "loradir", "loras_dir"]);

function loraRoots(): string[] {
  return [path.resolve(comfyModelsPath(env.COMFY_ROOT, "loras")).replace(/\/+$/, "")];
}

function datasetRoots(): string[] {
  return (process.env.CJ_VAULT_DATASET_ROOTS ?? "")
    .split(/[\s,:]+/)
    .map((r) => r.trim().replace(/\/+$/, ""))
    .filter((r) => r.startsWith("/") && r.length > 1);
}

/** True when `dir` is a plain absolute path inside one of the allowed roots. */
function isAllowedDatasetDir(dir: unknown, roots = datasetRoots()): boolean {
  if (typeof dir !== "string" || !dir.startsWith("/")) return false;
  if (dir.includes("\0") || dir.includes("\\")) return false;
  const parts = dir.split("/");
  if (parts.some((p) => p === ".." || p === ".")) return false;
  const norm = dir.replace(/\/+$/, "");
  return roots.some((root) => norm === root || norm.startsWith(`${root}/`));
}

type DirViolation = { key: string; kind: "dataset" | "lora" };

/** First disallowed directory value found anywhere in a JSON body, if any. */
function findDisallowedDir(value: unknown, depth = 0): DirViolation | null {
  if (depth > 32 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findDisallowedDir(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (v !== undefined && v !== null && v !== "") {
      if (DIR_KEYS.has(key) && !isAllowedDatasetDir(v)) return { key: k, kind: "dataset" };
      if (LORA_DIR_KEYS.has(key) && !isAllowedDatasetDir(v, loraRoots()))
        return { key: k, kind: "lora" };
    }
    const hit = findDisallowedDir(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Nothing else under library/ may change state through this proxy. */
function isAllowedLibraryMutation(method: string, segments: string[]): boolean {
  return (
    method === "POST" && segments.length === 2 && segments[1] === "index"
  );
}

async function realOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

/**
 * Turn a library/index body into a real folder the proxy allows: anything
 * under CJ_VAULT_DATASET_ROOTS, or the ComfyUI output folder itself. Compares
 * real paths, so ".." and symlinks can't lead out of a root.
 */
async function resolveIndexFolder(
  body: unknown,
): Promise<{ folder: string } | { error: string }> {
  const fields =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const outputDir = comfyOutputDir(env.COMFY_ROOT);
  const realOutput = await realOrNull(outputDir);

  if (fields.source === "comfy-output") {
    if (!realOutput)
      return { error: "The ComfyUI output folder doesn't exist yet." };
    return { folder: realOutput };
  }

  const folder = fields.folder;
  if (
    typeof folder !== "string" ||
    !folder.startsWith("/") ||
    folder.includes("\0")
  ) {
    return { error: "folder must be an absolute path." };
  }
  const real = await realOrNull(folder);
  if (!real) return { error: "That folder doesn't exist." };

  const roots = await Promise.all(datasetRoots().map(realOrNull));
  const allowed =
    real === realOutput ||
    roots.some(
      (root) => root && (real === root || real.startsWith(`${root}${path.sep}`)),
    );
  if (!allowed) {
    return {
      error:
        "That folder isn't allowed. Add it to CJ_VAULT_DATASET_ROOTS in .env.local, " +
        "or use the ComfyUI output folder.",
    };
  }
  return { folder: real };
}

async function readCappedBody(
  body: ReadableStream<Uint8Array>,
  max: number,
): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9._~-]{1,128}$/;

const MUTATING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

/** The only write allowed on assets is rating one. */
function isAllowedAssetMutation(method: string, segments: string[]): boolean {
  return method === "POST" && segments.length === 3 && segments[2] === "rate";
}

/** One page of Images or Clusters asks for dozens of these at once. */
function isThumbnailRead(method: string, segments: string[]): boolean {
  return (
    method === "GET" &&
    segments[0] === "assets" &&
    segments.length === 3 &&
    segments[2] === "thumb"
  );
}

function isAllowedPath(segments: string[]): boolean {
  if (segments.length === 0) return false;
  return ALLOWED_PATH_PREFIXES.some((prefix) => segments[0] === prefix);
}

function allowsMutation(segments: string[]): boolean {
  return segments.length > 0 && MUTABLE_PATH_PREFIXES.includes(segments[0]);
}

function reject(message: string, status = 403) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

async function proxyToSV(
  request: NextRequest,
  pathSegments: string[],
): Promise<NextResponse> {
  // Require admin auth for all requests (before any path validation, so
  // unauthenticated callers learn nothing about the allowlist).
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  // Block path traversal and malformed segments before constructing upstream URL.
  if (
    pathSegments.some(
      (s) =>
        s === "." ||
        s === ".." ||
        s === "" ||
        s.includes("/") ||
        s.includes("\\") ||
        !SAFE_PATH_SEGMENT_RE.test(s),
    )
  ) {
    return reject("Invalid path", 400);
  }

  if (!isAllowedPath(pathSegments)) {
    return reject(`Path not allowed: ${pathSegments[0]}`);
  }

  // Restrict mutating methods to explicitly mutable API groups.
  if (MUTATING_METHODS.has(request.method) && !allowsMutation(pathSegments)) {
    return reject(`Method ${request.method} not allowed on ${pathSegments[0]}`);
  }
  if (
    MUTATING_METHODS.has(request.method) &&
    pathSegments[0] === "library" &&
    !isAllowedLibraryMutation(request.method, pathSegments)
  ) {
    return reject(`Method ${request.method} not allowed on ${pathSegments.join("/")}`);
  }
  if (
    MUTATING_METHODS.has(request.method) &&
    pathSegments[0] === "assets" &&
    !isAllowedAssetMutation(request.method, pathSegments)
  ) {
    return reject(`Method ${request.method} not allowed on ${pathSegments.join("/")}`);
  }
  // Mix returns a style code, which is off in the public build.
  if (!STYLE_CODES_ENABLED && pathSegments[0] === "styles" && pathSegments[1] === "mix") {
    return reject("Style codes are off in this build.");
  }

  if (!isThumbnailRead(request.method, pathSegments)) {
    const rlMax = MUTATING_METHODS.has(request.method) ? 30 : 120;
    const rl = withRateLimit(request, { windowMs: 60_000, max: rlMax });
    if (!rl.ok) return rl.response;
  }

  // Jobs run by Adrift's own local trainer never go to StyleVault.
  if (isLocalJobPath(pathSegments))
    return handleLocalJobPath(request, pathSegments);

  const svUrl = env.STYLEVAULT_API_URL;
  const pathStr = pathSegments.join("/");
  const url = new URL(request.url);
  const target = `${svUrl}/${pathStr}${url.search}`;

  const headers: Record<string, string> = {
    "User-Agent": "Adrift/1.0",
  };
  const contentType = request.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;

  // The timeout only guards the upstream request: once headers arrive the
  // response body is streamed to the client, and an armed AbortSignal.timeout
  // would destroy large asset transfers mid-stream.
  const controller = new AbortController();
  const cap = { exceeded: false };

  let bufferedBody: Uint8Array | null = null;

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    signal: controller.signal,
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    const contentLength = parseInt(
      request.headers.get("content-length") || "0",
      10,
    );
    if (contentLength > MAX_BYTES)
      return NextResponse.json(
        { ok: false, error: "Payload too large" },
        { status: 413 },
      );
    if (pathSegments[0] === "library") {
      const bytes = request.body
        ? await readCappedBody(request.body, MAX_BYTES)
        : new Uint8Array();
      if (!bytes) {
        return NextResponse.json(
          { ok: false, error: "Payload too large" },
          { status: 413 },
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return reject("Send JSON with a folder.", 400);
      }
      const resolved = await resolveIndexFolder(parsed);
      if ("error" in resolved) return reject(resolved.error, 400);
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify({ folder: resolved.folder });
    } else if (request.body && DATASET_PATH_PREFIXES.has(pathSegments[0])) {
      // Buffer (capped) so the dataset folder can be checked before it
      // reaches StyleVault.
      const bytes = await readCappedBody(request.body, MAX_BYTES);
      if (!bytes) {
        return NextResponse.json(
          { ok: false, error: "Payload too large" },
          { status: 413 },
        );
      }
      const text = new TextDecoder().decode(bytes);
      let parsed: unknown = undefined;
      try {
        parsed = text.trim() ? JSON.parse(text) : undefined;
      } catch {
        // The service's parser accepts things this one doesn't (NaN), so a
        // body that can't be checked here must not reach it.
        return reject("Send a JSON body.", 400);
      }
      const bad = findDisallowedDir(parsed);
      if (bad?.kind === "lora") {
        return reject(
          `${bad.key} must be COMFY_ROOT/models/loras or a folder inside it. ` +
            "Leave it out to use StyleVault's own loras folder.",
          400,
        );
      }
      if (bad) {
        return reject(
          `${bad.key} must be a folder under CJ_VAULT_DATASET_ROOTS (set it in .env.local), ` +
            "or train from a cluster instead.",
          400,
        );
      }
      // Send what was checked, not the original bytes.
      if (parsed !== undefined) {
        bufferedBody = new TextEncoder().encode(JSON.stringify(parsed));
        init.body = bufferedBody.buffer as ArrayBuffer;
      }
    } else if (request.body) {
      // Content-Length is optional (chunked uploads omit it), so enforce the
      // cap on the bytes actually streamed as well.
      init.body = request.body.pipeThrough(capBytes(MAX_BYTES, cap));
      init.duplex = "half";
    }
  }

  // Armed only once we're actually going upstream.
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    // Train and Datasets agree on who trains: the service only when it has a
    // trainer, otherwise Adrift's own.
    if (
      request.method === "POST" &&
      pathStr === "training/jobs" &&
      !(await serviceHasTrainer(svUrl, controller.signal))
    ) {
      clearTimeout(timeout);
      const local = handleLocalTrainingOffline(
        request.method,
        pathSegments,
        bufferedBody,
      );
      if (local) return local;
    }
    const res = await fetch(target, init);
    clearTimeout(timeout);
    const merged = await mergeLocalTraining(request.method, pathSegments, res);
    if (merged) return merged;
    return new NextResponse(res.body, {
      status: res.status,
      headers: safeProxiedTypeHeaders(res.headers.get("content-type")),
    });
  } catch {
    clearTimeout(timeout);
    if (cap.exceeded)
      return NextResponse.json(
        { ok: false, error: "Payload too large" },
        { status: 413 },
      );
    // Training still works without the service: see proxyRoutes.
    const local = handleLocalTrainingOffline(
      request.method,
      pathSegments,
      bufferedBody,
    );
    if (local) return local;
    return NextResponse.json(
      { ok: false, error: "StyleVault API unreachable" },
      { status: 502 },
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, X-Requested-With, Authorization",
    },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  return proxyToSV(request, path);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  return proxyToSV(request, path);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  return proxyToSV(request, path);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  return proxyToSV(request, path);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  return proxyToSV(request, path);
}

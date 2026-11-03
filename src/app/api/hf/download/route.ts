import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withLock } from "@/lib/locks";
import { withRateLimit } from "@/lib/rateLimit";
import { isAllowedHuggingFaceApiUrl } from "@/lib/validate";
import { inspectDest } from "@/lib/fs/safeDest";
import { resolveDownloadDest } from "@/lib/modelDownloadDest";
import { DEST_MAX_BYTES } from "@/lib/civitaiFolders";
import {
  addProgress,
  finishProgress,
  getProgress,
  progressPercent,
  startProgress,
} from "@/lib/net/downloadProgress";
import {
  HF_MAX_BYTES,
  downloadErrorStatus,
  downloadHfFile,
} from "@/lib/net/hfFileDownload";
import {
  hfUpscaleProgressKey,
  isHfUpscaleFolder,
  isHfUpscalerFile,
  isPickleFilename,
  suggestedUpscaleFolder,
  type HfUpscalerFile,
} from "@/lib/hfUpscalers";

/**
 * /api/hf/download — Hugging Face downloads, upscalers only.
 *
 *   GET ?repo=owner/name  → upscaler files in the repo (pinned to its commit)
 *   GET ?key=hf:…         → live progress of a running download
 *   POST { repo, file, revision, folder, acceptPickle?, overwrite? }
 *
 * The POST re-reads the repo at that exact commit, so the file, its size
 * and its SHA-256 come from the Hub, not the client. Files land only in
 * models/upscale_models or models/latent_upscale_models. Gated and private
 * repos are refused (no token is ever sent).
 */

const CORS_HEADERS = apiCorsHeaders(null, "GET, POST, OPTIONS");
const INFO_TIMEOUT_MS = 10_000;
const REPO_RE =
  /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const REVISION_RE = /^[0-9a-f]{40}$/;
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9 _.+()\[\]-]{0,199}$/;

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: CORS_HEADERS });
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

function validRepoFile(file: string): boolean {
  if (file.length > 300) return false;
  return file
    .split("/")
    .every((seg) => SEGMENT_RE.test(seg) && seg !== "." && seg !== "..");
}

interface HubSibling {
  rfilename: string;
  size: number | null;
  sha256: string | null;
}
interface HubInfo {
  id: string;
  sha: string;
  gated: boolean;
  private: boolean;
  tags: string[];
  siblings: HubSibling[];
}

async function fetchHubInfo(repo: string, revision?: string): Promise<HubInfo> {
  const url = revision
    ? `https://huggingface.co/api/models/${repo}/revision/${revision}?blobs=true`
    : `https://huggingface.co/api/models/${repo}?blobs=true`;
  if (!isAllowedHuggingFaceApiUrl(url)) throw new Error("Repo not allowed");
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "Adrift/1.0" },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 404) {
    throw Object.assign(new Error("Repo not found or private"), {
      status: 404,
    });
  }
  if (!res.ok) throw new Error(`Hugging Face API error ${res.status}`);
  const raw = (await res.json()) as Record<string, unknown>;
  const siblings = Array.isArray(raw.siblings) ? raw.siblings : [];
  return {
    id: typeof raw.id === "string" ? raw.id : repo,
    sha: typeof raw.sha === "string" ? raw.sha : "",
    gated: raw.gated !== false && raw.gated !== undefined,
    private: raw.private === true,
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((t): t is string => typeof t === "string")
      : [],
    siblings: siblings.flatMap((s): HubSibling[] => {
      if (!s || typeof s !== "object") return [];
      const r = s as Record<string, unknown>;
      if (typeof r.rfilename !== "string") return [];
      const lfs = (r.lfs ?? null) as Record<string, unknown> | null;
      const size =
        typeof lfs?.size === "number"
          ? lfs.size
          : typeof r.size === "number"
            ? r.size
            : null;
      const sha256 =
        typeof lfs?.sha256 === "string" && /^[0-9a-f]{64}$/i.test(lfs.sha256)
          ? lfs.sha256
          : null;
      return [{ rfilename: r.rfilename, size, sha256 }];
    }),
  };
}

function upscalerFiles(info: HubInfo): HfUpscalerFile[] {
  return info.siblings
    .filter(
      (s) =>
        validRepoFile(s.rfilename) &&
        isHfUpscalerFile(info, s.rfilename) &&
        (s.size === null || s.size <= HF_MAX_BYTES),
    )
    .map((s) => ({
      file: s.rfilename,
      size: s.size,
      sha256: s.sha256,
      folder: suggestedUpscaleFolder(s.rfilename, info.tags),
      pickle: isPickleFilename(s.rfilename),
    }));
}

function hubErrorStatus(err: unknown): number {
  const status = (err as { status?: number })?.status;
  if (status === 404) return 404;
  if (
    err instanceof DOMException &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  )
    return 504;
  return 502;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const sp = request.nextUrl.searchParams;

  const key = sp.get("key");
  if (key !== null) {
    const rl = withRateLimit(request, { windowMs: 60_000, max: 240 });
    if (!rl.ok) return rl.response;
    if (!key.startsWith("hf:") || key.length > 600) {
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

  const rl = withRateLimit(request, { windowMs: 60_000, max: 30 });
  if (!rl.ok) return rl.response;
  const repo = sp.get("repo") ?? "";
  if (!REPO_RE.test(repo))
    return json({ ok: false, error: "repo required" }, 400);
  try {
    const info = await fetchHubInfo(repo);
    return json({
      ok: true,
      repo: info.id,
      revision: info.sha,
      gated: info.gated || info.private,
      files: upscalerFiles(info),
    });
  } catch (err) {
    return json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      hubErrorStatus(err),
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(request, { windowMs: 60_000, max: 10 });
  if (!rl.ok) return rl.response;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const repo = typeof body.repo === "string" ? body.repo : "";
  const file = typeof body.file === "string" ? body.file : "";
  const revision = typeof body.revision === "string" ? body.revision : "";
  if (!REPO_RE.test(repo))
    return json({ ok: false, error: "Invalid repo" }, 400);
  if (!validRepoFile(file))
    return json({ ok: false, error: "Invalid file" }, 400);
  if (!REVISION_RE.test(revision))
    return json({ ok: false, error: "revision must be a commit hash" }, 400);
  if (!isHfUpscaleFolder(body.folder)) {
    return json(
      {
        ok: false,
        error:
          "Hugging Face downloads can only go to upscale_models or latent_upscale_models",
      },
      400,
    );
  }
  const folder = body.folder;

  let info: HubInfo;
  try {
    info = await fetchHubInfo(repo, revision);
  } catch (err) {
    return json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      hubErrorStatus(err),
    );
  }
  if (info.gated || info.private) {
    return json(
      {
        ok: false,
        gated: true,
        error:
          "This repo is gated. Accept its license and download it on Hugging Face instead.",
      },
      403,
    );
  }
  const sibling = info.siblings.find((s) => s.rfilename === file);
  if (!sibling) {
    return json({ ok: false, error: "That file isn't in this repo" }, 400);
  }
  if (!isHfUpscalerFile(info, file)) {
    return json(
      {
        ok: false,
        error: "Only upscaler models can be downloaded from Hugging Face",
      },
      400,
    );
  }
  const cap = Math.min(HF_MAX_BYTES, DEST_MAX_BYTES[folder]);
  if (sibling.size !== null && sibling.size > cap) {
    return json({ ok: false, error: "File is too large" }, 413);
  }
  if (isPickleFilename(file) && body.acceptPickle !== true) {
    return json(
      {
        ok: false,
        needsPickleAck: true,
        error:
          "This is a pickle file (.pth/.pt/.ckpt/.bin). It can run code when ComfyUI loads it. Only download it from people you trust.",
      },
      409,
    );
  }

  const remoteName = file.split("/").pop() ?? file;
  const key = hfUpscaleProgressKey(repo, file);
  try {
    const dest = await resolveDownloadDest(folder, remoteName);
    return await withLock(`hf-download:${dest.fullPath}`, async () => {
      const existing = await inspectDest(dest.fullPath);
      if (existing.kind === "file") {
        if (sibling.size !== null && existing.size === sibling.size) {
          return json({
            ok: true,
            skipped: true,
            path: dest.fullPath,
            filename: dest.name,
            folder,
          });
        }
        if (body.overwrite !== true) {
          return json(
            {
              ok: false,
              conflict: true,
              error: `A different ${dest.name} is already in ${folder}`,
            },
            409,
          );
        }
      }
      startProgress(key, sibling.size ?? 0);
      try {
        const url = `https://huggingface.co/${repo}/resolve/${revision}/${file
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`;
        const res = await downloadHfFile({
          url,
          dir: dest.dir,
          name: dest.name,
          maxBytes:
            sibling.size !== null
              ? Math.min(cap, Math.ceil(sibling.size * 1.02) + 2 ** 20)
              : cap,
          expectedSha256: sibling.sha256 ?? undefined,
          overwrite: body.overwrite === true,
          signal: request.signal,
          onBytes: (n) => addProgress(key, n),
        });
        finishProgress(key);
        return json({
          ok: true,
          path: res.path,
          filename: dest.name,
          folder,
          bytes: res.bytes,
          sha256: res.sha256,
        });
      } catch (err) {
        finishProgress(key, err instanceof Error ? err.message : String(err));
        throw err;
      }
    });
  } catch (err) {
    const status = downloadErrorStatus(err);
    return json(
      {
        ok: false,
        conflict: status === 409 || undefined,
        error: err instanceof Error ? err.message : String(err),
      },
      status,
    );
  }
}

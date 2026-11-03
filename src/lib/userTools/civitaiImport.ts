/**
 * Fetch a workflow file for a Civitai model / version URL, server side.
 *
 *  - Only https URLs on civitai.com / civitai.red (and subdomains) plus the
 *    Cloudflare R2 delivery hosts Civitai redirects downloads to. Redirects
 *    are followed by hand so every hop is re-checked.
 *  - The Civitai API key (if set) is sent only to Civitai's own hosts, never
 *    to the storage redirect, and is never logged or returned.
 *  - Byte cap and idle timeout so a slow or huge file cannot tie up the server.
 */

import {
  fetchCivitaiModel,
  fetchCivitaiModelVersion,
  type CivitaiModelVersion,
  type CivitaiSource,
} from "@/lib/civitai";
import { hostMatchesAllowlist } from "@/lib/validate";

export const CIVITAI_PAGE_HOSTS = [
  "civitai.com",
  "*.civitai.com",
  "civitai.red",
  "*.civitai.red",
];
/** Civitai's download storage (Cloudflare R2 delivery worker buckets). */
const DELIVERY_HOST_RE =
  /^civitai-delivery-worker-[a-z0-9-]+\.[a-z0-9]+\.r2\.cloudflarestorage\.com$/i;

export const MAX_WORKFLOW_DOWNLOAD_BYTES = 25 * 1024 * 1024;
export const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const DOWNLOAD_TOTAL_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;

export class CivitaiImportError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "CivitaiImportError";
  }
}

export function isCivitaiHost(hostname: string): boolean {
  return hostMatchesAllowlist(hostname, CIVITAI_PAGE_HOSTS);
}

export function isAllowedDownloadHost(hostname: string): boolean {
  return isCivitaiHost(hostname) || DELIVERY_HOST_RE.test(hostname);
}

export interface CivitaiWorkflowRef {
  source: CivitaiSource;
  modelId?: number;
  versionId?: number;
}

function posInt(v: string | null | undefined): number | undefined {
  if (!v || !/^\d{1,12}$/.test(v)) return undefined;
  const n = Number(v);
  return n > 0 ? n : undefined;
}

/**
 * Parse civitai.com/models/<id>[/slug][?modelVersionId=<v>] or
 * civitai.com/api/download/models/<versionId>. Returns null for anything else.
 */
export function parseCivitaiWorkflowUrl(
  raw: string,
): CivitaiWorkflowRef | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !isCivitaiHost(url.hostname)) return null;
  const source: CivitaiSource = /(^|\.)civitai\.red$/i.test(url.hostname)
    ? "red"
    : "com";
  const dl = url.pathname.match(/^\/api\/download\/models\/(\d+)\/?$/);
  if (dl) {
    const versionId = posInt(dl[1]);
    return versionId ? { source, versionId } : null;
  }
  const m = url.pathname.match(/^\/models\/(\d+)(?:\/[^/]*)?\/?$/);
  if (!m) return null;
  const modelId = posInt(m[1]);
  if (!modelId) return null;
  const versionId = posInt(url.searchParams.get("modelVersionId"));
  return { source, modelId, ...(versionId ? { versionId } : {}) };
}

type VersionFile = CivitaiModelVersion["files"][number] & { type?: string };

/** Pick the file most likely to hold the workflow (zip / json / png). */
export function pickWorkflowFile(files: VersionFile[]): VersionFile | null {
  const usable = files.filter(
    (f) => typeof f.downloadUrl === "string" && f.downloadUrl,
  );
  const rank = (f: VersionFile): number => {
    const name = f.name.toLowerCase();
    let score = 0;
    if (name.endsWith(".json")) score += 30;
    else if (name.endsWith(".zip")) score += 20;
    else if (name.endsWith(".png")) score += 10;
    else return -1;
    if (f.primary) score += 5;
    return score;
  };
  const ranked = usable
    .map((f) => ({ f, s: rank(f) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s);
  if (ranked.length > 0) return ranked[0].f;
  // Civitai sometimes names archives without an extension: fall back to primary.
  return usable.find((f) => f.primary) ?? usable[0] ?? null;
}

export interface ResolvedCivitaiWorkflow {
  ref: CivitaiWorkflowRef;
  modelId: number;
  versionId: number;
  title: string;
  file: VersionFile;
  pageUrl: string;
}

export async function resolveCivitaiWorkflow(
  ref: CivitaiWorkflowRef,
): Promise<ResolvedCivitaiWorkflow> {
  let version: CivitaiModelVersion | null = null;
  let title = "";
  let modelType: string | undefined;
  if (ref.versionId) {
    version = await fetchCivitaiModelVersion(
      ref.versionId,
      undefined,
      ref.source,
    );
    const model = (
      version as unknown as {
        model?: { name?: unknown; type?: unknown };
      } | null
    )?.model;
    if (typeof model?.name === "string") title = model.name;
    if (typeof model?.type === "string") modelType = model.type;
  } else if (ref.modelId) {
    const model = await fetchCivitaiModel(ref.modelId, undefined, ref.source);
    if (model) {
      title = model.name;
      modelType = model.type;
      version = model.modelVersions?.[0] ?? null;
    }
  }
  if (!version)
    throw new CivitaiImportError("That Civitai page was not found", 404);
  if (modelType && modelType.toLowerCase() !== "workflows") {
    throw new CivitaiImportError(
      `That Civitai page is a ${modelType}, not a workflow`,
      422,
    );
  }
  const file = pickWorkflowFile(version.files ?? []);
  if (!file)
    throw new CivitaiImportError(
      "That Civitai version has no files to import",
      422,
    );
  const modelId = version.modelId ?? ref.modelId ?? 0;
  const host = ref.source === "red" ? "civitai.red" : "civitai.com";
  return {
    ref,
    modelId,
    versionId: version.id,
    title: title || version.name || "Civitai workflow",
    file,
    pageUrl: `https://${host}/models/${modelId}?modelVersionId=${version.id}`,
  };
}

export interface DownloadOptions {
  apiKey?: string | null;
  maxBytes?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * GET `url` following up to 5 redirects by hand (each hop allow-listed),
 * reading at most `maxBytes` with an idle timeout between chunks.
 */
export async function downloadCapped(
  url: string,
  opts: DownloadOptions = {},
): Promise<Uint8Array> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? MAX_WORKFLOW_DOWNLOAD_BYTES;
  const idleMs = opts.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS;
  const controller = new AbortController();
  const total = setTimeout(
    () => controller.abort(),
    opts.totalTimeoutMs ?? DOWNLOAD_TOTAL_TIMEOUT_MS,
  );
  let idle: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), idleMs);
  };

  try {
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(current);
      } catch {
        throw new CivitaiImportError(
          "Civitai returned a bad download link",
          502,
        );
      }
      if (
        parsed.protocol !== "https:" ||
        !isAllowedDownloadHost(parsed.hostname)
      ) {
        throw new CivitaiImportError(
          `Download host not allowed: ${parsed.hostname}`,
          502,
        );
      }
      const headers: Record<string, string> = { "User-Agent": "Adrift/1.0" };
      if (opts.apiKey && isCivitaiHost(parsed.hostname))
        headers.Authorization = `Bearer ${opts.apiKey}`;
      armIdle();
      const r = await fetchImpl(parsed.toString(), {
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        await r.body?.cancel().catch(() => {});
        if (!loc)
          throw new CivitaiImportError("Civitai redirect had no target", 502);
        current = new URL(loc, parsed).toString();
        continue;
      }
      res = r;
      break;
    }
    if (!res)
      throw new CivitaiImportError("Too many redirects from Civitai", 502);
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new CivitaiImportError(
        "Civitai asked for a login to download this. Add your Civitai API key in Settings and try again.",
        401,
      );
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new CivitaiImportError(
        `Civitai download failed (HTTP ${res.status})`,
        502,
      );
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new CivitaiImportError(
        `The file is too large to import (over ${Math.round(maxBytes / 1048576)} MB)`,
        413,
      );
    }
    if (!res.body) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      armIdle();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new CivitaiImportError(
          `The file is too large to import (over ${Math.round(maxBytes / 1048576)} MB)`,
          413,
        );
      }
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  } catch (err) {
    if (err instanceof CivitaiImportError) throw err;
    if (controller.signal.aborted) {
      throw new CivitaiImportError(
        "Civitai took too long to send the file",
        504,
      );
    }
    throw new CivitaiImportError("Could not reach Civitai", 502);
  } finally {
    clearTimeout(total);
    if (idle) clearTimeout(idle);
  }
}

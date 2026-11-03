/**
 * Read-only access to ComfyUI's own workflow library (the "Workflows"
 * sidebar): GET /api/userdata?dir=workflows and
 * GET /api/userdata/workflows%2F<file>. Also the allowlist for remote
 * combo option routes. Route files may only export handlers, so the
 * logic lives here (and is unit-tested with a mocked fetch).
 */

import {
  flattenComposedWorkflowDetailed,
  parseWorkflowJson,
  WorkflowGraphError,
} from "@/lib/comfy/workflows";
import { comfyFetch } from "@/lib/comfy/comfyFetch";

export interface ComfyLibraryEntry {
  /** Path relative to the workflows dir, e.g. "3d/Figure.json" */
  path: string;
  name: string;
  folder: string;
  size?: number;
  modified?: number;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 15_000;

/** Library paths are relative, .json, no traversal / absolute / control chars. */
export function isSafeLibraryPath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > 512) return false;
  if (!p.toLowerCase().endsWith(".json")) return false;
  if (p.startsWith("/") || p.includes("\\") || /[\u0000-\u001f]/.test(p))
    return false;
  return p
    .split("/")
    .every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

function toEntry(raw: unknown): ComfyLibraryEntry | null {
  const obj =
    typeof raw === "string"
      ? { path: raw }
      : raw && typeof raw === "object"
        ? (raw as { path?: unknown; size?: unknown; modified?: unknown })
        : null;
  if (!obj || !isSafeLibraryPath(obj.path)) return null;
  const p = obj.path;
  const slash = p.lastIndexOf("/");
  return {
    path: p,
    name: p.slice(slash + 1).replace(/\.json$/i, ""),
    folder: slash >= 0 ? p.slice(0, slash) : "",
    size: typeof obj.size === "number" ? obj.size : undefined,
    modified: typeof obj.modified === "number" ? obj.modified : undefined,
  };
}

/** List workflows saved in ComfyUI's user library (recursively). */
export async function listComfyLibrary(
  baseUrl: string,
  fetchImpl: FetchLike = comfyFetch,
): Promise<ComfyLibraryEntry[]> {
  const url = `${baseUrl}/api/userdata?dir=workflows&recurse=true&split=false&full_info=true`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) return []; // no workflows dir yet
  if (!res.ok)
    throw new Error(`ComfyUI library listing failed: HTTP ${res.status}`);
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data))
    throw new Error("ComfyUI library listing was not an array");
  return data
    .map(toEntry)
    .filter((e): e is ComfyLibraryEntry => e !== null)
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

export interface ComfyLibraryWorkflow {
  path: string;
  name: string;
  /** Raw JSON exactly as ComfyUI stored it (UI or API format). */
  workflow: unknown;
  format: "api" | "ui";
  /** Node count after conversion/flattening to API format. */
  nodeCount: number;
  subgraphCount: number;
  warnings: string[];
}

/**
 * Fetch one library workflow and prove it converts. Conversion errors
 * (missing subgraph, cycle, dangling link, …) are thrown with the file
 * name prefixed so the picker can show them verbatim.
 */
export async function fetchComfyLibraryWorkflow(
  baseUrl: string,
  file: string,
  fetchImpl: FetchLike = comfyFetch,
): Promise<ComfyLibraryWorkflow> {
  if (!isSafeLibraryPath(file)) throw new Error("Invalid library path");
  const url = `${baseUrl}/api/userdata/${encodeURIComponent(`workflows/${file}`)}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404)
    throw new Error(`"${file}" is not in the ComfyUI library`);
  if (!res.ok)
    throw new Error(`ComfyUI returned HTTP ${res.status} for "${file}"`);
  const text = await res.text();
  let workflow: unknown;
  try {
    workflow = JSON.parse(text);
  } catch {
    throw new Error(`"${file}" is not valid JSON`);
  }

  const name = file.slice(file.lastIndexOf("/") + 1).replace(/\.json$/i, "");
  const obj = (workflow ?? {}) as {
    nodes?: unknown[];
    definitions?: { subgraphs?: unknown[] };
  };
  const subgraphCount = Array.isArray(obj.definitions?.subgraphs)
    ? obj.definitions!.subgraphs!.length
    : 0;
  const format: "api" | "ui" = Array.isArray(obj.nodes) ? "ui" : "api";

  let warnings: string[] = [];
  let nodeCount: number;
  try {
    if (subgraphCount > 0) {
      warnings = flattenComposedWorkflowDetailed(
        workflow as Parameters<typeof flattenComposedWorkflowDetailed>[0],
      ).warnings;
    }
    nodeCount = Object.keys(parseWorkflowJson(workflow, file)).length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const e = new Error(`Can't import "${file}": ${msg}`);
    if (err instanceof WorkflowGraphError)
      (e as Error & { code?: string }).code = err.code;
    throw e;
  }

  return {
    path: file,
    name,
    workflow,
    format,
    nodeCount,
    subgraphCount,
    warnings,
  };
}

/**
 * Remote combo routes (`remote.route` in object_info) we'll proxy: GET
 * only, relative ComfyUI paths under /internal or /api, no traversal or
 * query string.
 */
export function isAllowedRemoteRoute(route: unknown): route is string {
  if (typeof route !== "string") return false;
  if (!/^\/(internal|api)\/[A-Za-z0-9_\-/.]+$/.test(route)) return false;
  if (route.split("/").some((s) => s === ".." || s === ".")) return false;
  // Never proxy anything that could enqueue or mutate.
  return !/^\/(api\/)?(prompt|queue|interrupt|free|upload|history|userdata)\b/.test(
    route,
  );
}

/** Normalize a remote combo response to option strings. */
export function normalizeRemoteOptions(
  data: unknown,
  responseKey?: string,
): string[] {
  let list: unknown = data;
  if (responseKey && data && typeof data === "object" && !Array.isArray(data)) {
    list = (data as Record<string, unknown>)[responseKey];
  }
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item === "string" || typeof item === "number")
      out.push(String(item));
    else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const v = o.value ?? o.name ?? o.id ?? o.filename;
      if (typeof v === "string" || typeof v === "number") out.push(String(v));
    }
  }
  return out;
}

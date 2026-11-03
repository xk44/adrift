/**
 * Which workflow packs/modes can actually run on the connected ComfyUI:
 * per pack + workflow kind, the node class_types the graph uses that
 * /object_info does not know (custom node not installed).
 *
 * Server-only (reads public/workflows from disk). Result is memoised per
 * object_info snapshot, so it follows objectInfoCache's TTL and is rebuilt
 * whenever a fresh object_info is fetched.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { getAllPacks, type WorkflowPack } from "@/lib/oj/packs";
import {
  findMissingClassTypes,
  validatePrompt,
} from "@/lib/comfy/validatePrompt";
import { bypassMissingOptionalNodes } from "@/lib/comfy/optionalNodes";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import {
  fetchCustomNodeMappings,
  resolveMissingNodePacks,
  type MissingNodePackCandidate,
} from "@/lib/comfy/manager";
import { env } from "@/lib/env";

export type WorkflowGraphFormat = "api" | "ui" | "unknown" | "missing_file";

export interface PackKindNodeStatus {
  file: string;
  format: WorkflowGraphFormat;
  /** Only meaningful when format === "api". Sorted, distinct. */
  missing: string[];
  /**
   * Missing but optional (`_meta.optional`): the graph still runs, the node
   * is bypassed at queue time. Not in `missing`. Absent when none.
   */
  optionalMissing?: string[];
  /**
   * The graph's `_fallback` was taken (see workflows.applyWorkflowFallback):
   * `missing` is then the fallback graph's; `primaryMissing` is why.
   */
  fallback?: { file: string; primaryMissing: string[] };
  /**
   * Model files the graph pins (`unet_name: x.gguf`, `lora_name: …`) that the
   * installed loader nodes don't list as choices: ComfyUI rejects the prompt
   * (422) until they're downloaded. `"<input>: <file>"`, sorted. Absent when
   * none. Only checked for installed classes (missing nodes cover the rest).
   */
  missingAssets?: string[];
}

export interface PackNodeAvailability {
  /** False when ComfyUI was unreachable: nothing was checked. */
  checked: boolean;
  /** packId → kind → status. */
  packs: Record<string, Record<string, PackKindNodeStatus>>;
  /** Missing class_type → likely node packs (ComfyUI-Manager mappings). */
  candidates: Record<string, MissingNodePackCandidate[]>;
  /** Distinct missing class_types across all packs. */
  missingClassTypes: string[];
}

const WORKFLOWS_DIR = path.join(process.cwd(), "public", "workflows");

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * API format = { "<id>": { class_type, inputs }, _meta?, _comment? }.
 * UI (litegraph) format = { nodes: [...], links: [...] } and may carry
 * subgraph definitions whose node types are not object_info classes, so it
 * is flagged rather than judged.
 */
export function detectGraphFormat(graph: unknown): WorkflowGraphFormat {
  if (!isRecord(graph)) return "unknown";
  if (Array.isArray(graph.nodes)) return "ui";
  // Underscore keys (_meta, _comment) are annotations, not nodes.
  const nodes = Object.entries(graph).filter(([k]) => !k.startsWith("_"));
  if (nodes.length === 0) return "unknown";
  const allApi = nodes.every(
    ([, v]) => isRecord(v) && typeof v.class_type === "string",
  );
  return allApi ? "api" : "unknown";
}

const MODEL_FILE_RE = /\.(safetensors|gguf|ckpt|pt|pth|bin|sft|onnx)$/i;

/**
 * Model-file combo values the installed nodes reject (file not downloaded).
 * Non-file combos (sampler names, style keys) are left to the engine, which
 * rewrites many of them per request.
 */
export function findMissingModelAssets(
  prompt: unknown,
  objectInfo: Record<string, unknown>,
): string[] {
  const nodes = isRecord(prompt) ? prompt : {};
  const out = new Set<string>();
  for (const p of validatePrompt(prompt, objectInfo)) {
    if (p.kind !== "invalid_combo_value" || !p.input) continue;
    const node = nodes[p.nodeId];
    const inputs = isRecord(node) && isRecord(node.inputs) ? node.inputs : {};
    const value = inputs[p.input];
    if (typeof value === "string" && MODEL_FILE_RE.test(value)) {
      out.add(`${p.input}: ${value}`);
    }
  }
  return [...out].sort();
}

export function analyzeWorkflowGraph(
  graph: unknown,
  objectInfo: Record<string, unknown>,
): {
  format: WorkflowGraphFormat;
  missing: string[];
  optionalMissing?: string[];
  missingAssets?: string[];
} {
  const format = detectGraphFormat(graph);
  if (format !== "api") return { format, missing: [] };
  // What still fails after the queue-time optional-node bypass.
  const { prompt, bypassed } = bypassMissingOptionalNodes(graph as object, objectInfo);
  const missing = findMissingClassTypes(prompt, objectInfo);
  const assets = findMissingModelAssets(prompt, objectInfo);
  return {
    format,
    missing,
    ...(bypassed.length > 0
      ? {
          optionalMissing: [
            ...new Set(bypassed.map((b) => b.classType)),
          ].sort(),
        }
      : {}),
    ...(assets.length > 0 ? { missingAssets: assets } : {}),
  };
}

/** Same lookup order as /api/oj/packs: packs/<id>/<file>, then <file>. */
async function readPackGraph(
  packId: string,
  file: string,
): Promise<unknown | undefined> {
  const candidates = [
    path.join(WORKFLOWS_DIR, "packs", packId, file),
    path.join(WORKFLOWS_DIR, file),
  ];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(WORKFLOWS_DIR + path.sep)) continue;
    try {
      return JSON.parse(await fs.readFile(resolved, "utf8"));
    } catch {
      // try the next location
    }
  }
  return undefined;
}

export type GraphReader = (
  packId: string,
  file: string,
) => Promise<unknown | undefined>;

export async function computePackNodeAvailability(
  objectInfo: Record<string, unknown>,
  opts: {
    packs?: WorkflowPack[];
    readGraph?: GraphReader;
  } = {},
): Promise<Omit<PackNodeAvailability, "candidates">> {
  const packs = opts.packs ?? getAllPacks();
  const readGraph = opts.readGraph ?? readPackGraph;
  const out: PackNodeAvailability["packs"] = {};
  const allMissing = new Set<string>();
  // Many kinds share one file (vary_* → i2i.json): analyse each once.
  const memo = new Map<string, Promise<PackKindNodeStatus>>();

  for (const pack of packs) {
    const kinds: Record<string, PackKindNodeStatus> = {};
    for (const [kind, file] of Object.entries(pack.workflows)) {
      if (!file) continue;
      const key = `${pack.id}\0${file}`;
      let pending = memo.get(key);
      if (!pending) {
        pending = readGraph(pack.id, file).then(async (graph) => {
          if (graph === undefined) {
            return { file, format: "missing_file" as const, missing: [] };
          }
          const status: PackKindNodeStatus = {
            file,
            ...analyzeWorkflowGraph(graph, objectInfo),
          };
          const fb = isRecord(graph) ? graph._fallback : undefined;
          if (
            status.missing.length > 0 &&
            isRecord(fb) &&
            typeof fb.file === "string"
          ) {
            const alt = await readGraph(pack.id, fb.file);
            const altStatus =
              alt === undefined ? null : analyzeWorkflowGraph(alt, objectInfo);
            if (altStatus && altStatus.format === "api") {
              return {
                ...status,
                ...altStatus,
                fallback: { file: fb.file, primaryMissing: status.missing },
              };
            }
          }
          return status;
        });
        memo.set(key, pending);
      }
      const status = await pending;
      status.missing.forEach((m) => allMissing.add(m));
      kinds[kind] = status;
    }
    out[pack.id] = kinds;
  }

  return {
    checked: true,
    packs: out,
    missingClassTypes: [...allMissing].sort(),
  };
}

// Cached entry point

const MAPPINGS_TTL_MS = 10 * 60_000;
let mappingsCache: {
  at: number;
  /** The ComfyUI it came from: another backend has another Manager. */
  url: string;
  data: Awaited<ReturnType<typeof fetchCustomNodeMappings>>;
} | null = null;

/** Keyed by object_info snapshot identity: a fresh fetch busts it. */
let resultCache = new WeakMap<object, PackNodeAvailability>();

export function clearPackNodeAvailabilityCache(): void {
  mappingsCache = null;
  resultCache = new WeakMap();
}

async function candidatesFor(
  missing: string[],
  baseUrl: string,
): Promise<Record<string, MissingNodePackCandidate[]>> {
  if (missing.length === 0) return {};
  try {
    const url = baseUrl.replace(/\/$/, "");
    if (
      !mappingsCache ||
      mappingsCache.url !== url ||
      Date.now() - mappingsCache.at > MAPPINGS_TTL_MS
    ) {
      // ComfyUI-Manager GET (cached channel data); absent without Manager.
      mappingsCache = {
        at: Date.now(),
        url,
        data: await fetchCustomNodeMappings(url),
      };
    }
    const out: Record<string, MissingNodePackCandidate[]> = {};
    for (const r of resolveMissingNodePacks(missing, mappingsCache.data)) {
      out[r.nodeType] = r.candidates;
    }
    return out;
  } catch {
    return {};
  }
}

export async function getPackNodeAvailability(
  opts: { fresh?: boolean; baseUrl?: string } = {},
): Promise<PackNodeAvailability> {
  const baseUrl = opts.baseUrl ?? env.COMFY_HTTP_URL;
  const info = await getObjectInfoCached(baseUrl, { fresh: opts.fresh });
  if (!info) {
    return { checked: false, packs: {}, candidates: {}, missingClassTypes: [] };
  }
  const hit = resultCache.get(info);
  if (hit) return hit;
  const base = await computePackNodeAvailability(info);
  const result: PackNodeAvailability = {
    ...base,
    candidates: await candidatesFor(base.missingClassTypes, baseUrl),
  };
  resultCache.set(info, result);
  return result;
}

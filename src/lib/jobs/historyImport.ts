/**
 * Import finished ComfyUI jobs (GET /history) into Adrift's job list.
 * Read-only against ComfyUI; dedupes by ComfyUI prompt_id (jobs.prompt_id_comfy).
 * Server-side only (touches the DB).
 */
import {
  existingComfyPromptIds,
  importComfyHistoryJob,
  type ComfyHistoryImport,
} from "@/lib/db";
import {
  extractOutputs,
  promptGraphOf,
  type ComfyOutputKind,
} from "@/lib/comfy/outputs";
import { sanitizeCjParams } from "@/lib/comfy/pnginfo";

export const HISTORY_IMPORT_MAX = 200;
export const HISTORY_IMPORT_DEFAULT = 50;

const DB_MEDIA: Partial<
  Record<ComfyOutputKind, ComfyHistoryImport["outputs"][number]["mediaType"]>
> = {
  image: "image",
  animated: "image",
  video: "video",
  audio: "audio",
  mesh: "mesh",
};

const SAMPLER_SEED_KEYS = ["seed", "noise_seed"] as const;
const TEXT_KEYS = ["text", "prompt", "text_g", "positive"] as const;

type Node = { class_type?: unknown; inputs?: Record<string, unknown> };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function nodeText(node: Node | undefined): string | null {
  const inputs = node?.inputs;
  if (!isRecord(inputs)) return null;
  for (const k of TEXT_KEYS) {
    const v = inputs[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function linkTarget(v: unknown): string | null {
  return Array.isArray(v) &&
    (typeof v[0] === "string" || typeof v[0] === "number")
    ? String(v[0])
    : null;
}

/** Positive prompt: follow a sampler's `positive` link, else any text input. */
function graphPromptText(
  graph: Record<string, Node | undefined>,
): string | null {
  for (const node of Object.values(graph)) {
    const pos = linkTarget(node?.inputs?.positive);
    if (pos) {
      const text = nodeText(graph[pos]);
      if (text) return text;
    }
  }
  for (const node of Object.values(graph)) {
    const cls = typeof node?.class_type === "string" ? node.class_type : "";
    if (/negative/i.test(cls)) continue;
    const text = nodeText(node);
    if (text) return text;
  }
  return null;
}

function graphSeed(graph: Record<string, Node | undefined>): number | null {
  for (const node of Object.values(graph)) {
    for (const k of SAMPLER_SEED_KEYS) {
      const v = node?.inputs?.[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
  }
  return null;
}

function graphSize(graph: Record<string, Node | undefined>): {
  width: number | null;
  height: number | null;
} {
  for (const node of Object.values(graph)) {
    const w = node?.inputs?.width;
    const h = node?.inputs?.height;
    if (typeof w === "number" && typeof h === "number" && w > 0 && h > 0) {
      return { width: w, height: h };
    }
  }
  return { width: null, height: null };
}

/** [start, end] unix seconds from status.messages timestamps (ms). */
function statusTimes(status: unknown): {
  start: number | null;
  end: number | null;
} {
  const messages =
    isRecord(status) && Array.isArray(status.messages) ? status.messages : [];
  const stamps: number[] = [];
  for (const m of messages) {
    if (Array.isArray(m) && isRecord(m[1])) {
      const ts = m[1].timestamp;
      if (typeof ts === "number" && Number.isFinite(ts)) stamps.push(ts);
    }
  }
  if (!stamps.length) return { start: null, end: null };
  return {
    start: Math.floor(Math.min(...stamps) / 1000),
    end: Math.floor(Math.max(...stamps) / 1000),
  };
}

/**
 * Map one /history entry to an import record, or null when it isn't a
 * successful job with at least one saved (type "output") file.
 */
export function historyEntryToImport(
  comfyPromptId: string,
  entry: unknown,
  nowSec: number = Math.floor(Date.now() / 1000),
): ComfyHistoryImport | null {
  if (!isRecord(entry)) return null;
  const status = entry.status;
  if (
    !isRecord(status) ||
    status.status_str !== "success" ||
    status.completed === false
  ) {
    return null;
  }
  const outputs: ComfyHistoryImport["outputs"] = [];
  const seen = new Set<string>();
  for (const out of extractOutputs(
    entry as Parameters<typeof extractOutputs>[0],
  )) {
    const mediaType = DB_MEDIA[out.kind];
    if (!mediaType || !out.view || (out.view.type || "output") !== "output") {
      continue;
    }
    const key = `${out.view.subfolder}/${out.view.filename}`;
    if (seen.has(key)) continue;
    seen.add(key);
    outputs.push({
      filename: out.view.filename,
      subfolder: out.view.subfolder || "",
      mediaType,
    });
  }
  if (!outputs.length) return null;

  const graph = promptGraphOf(
    entry as Parameters<typeof promptGraphOf>[0],
  ) as Record<string, Node | undefined>;
  const prompt = entry.prompt;
  const extraData =
    Array.isArray(prompt) && isRecord(prompt[3]) ? prompt[3] : null;
  const pnginfo =
    extraData && isRecord(extraData.extra_pnginfo)
      ? extraData.extra_pnginfo
      : null;
  const cj =
    pnginfo && isRecord(pnginfo.cj) && isRecord(pnginfo.cj.params)
      ? sanitizeCjParams(pnginfo.cj.params)
      : null;

  const cjPrompt =
    cj && typeof cj.fullPrompt === "string" && cj.fullPrompt.trim()
      ? cj.fullPrompt.trim()
      : null;
  const text =
    cjPrompt ??
    graphPromptText(graph) ??
    `ComfyUI import ${comfyPromptId.slice(0, 8)}`;
  const seed = cj && typeof cj.seed === "number" ? cj.seed : graphSeed(graph);
  const { width, height } = graphSize(graph);
  const { start, end } = statusTimes(status);

  return {
    comfyPromptId,
    createdAt: start ?? end ?? nowSec,
    completedAt: end ?? start ?? nowSec,
    text: text.slice(0, 4000),
    params: {
      ...(cj ?? {}),
      imported_from: "comfyui_history",
      comfy_prompt_id: comfyPromptId,
    },
    seed,
    width,
    height,
    nodeCount: Object.keys(graph).length || null,
    outputs,
  };
}

export type HistoryImportResult = {
  scanned: number;
  imported: number;
  skipped_existing: number;
  skipped_unusable: number;
  imported_ids: string[];
};

/** Import a GET /history response body. Idempotent (dedupe by prompt_id). */
export function importComfyHistory(history: unknown): HistoryImportResult {
  const result: HistoryImportResult = {
    scanned: 0,
    imported: 0,
    skipped_existing: 0,
    skipped_unusable: 0,
    imported_ids: [],
  };
  if (!isRecord(history)) return result;
  const ids = Object.keys(history).filter((id) => id && id.length <= 200);
  result.scanned = ids.length;
  const existing = existingComfyPromptIds(ids);
  for (const id of ids) {
    if (existing.has(id)) {
      result.skipped_existing += 1;
      continue;
    }
    const item = historyEntryToImport(id, history[id]);
    if (!item) {
      result.skipped_unusable += 1;
      continue;
    }
    if (importComfyHistoryJob(item)) {
      result.imported += 1;
      result.imported_ids.push(id);
    } else {
      result.skipped_existing += 1;
    }
  }
  return result;
}

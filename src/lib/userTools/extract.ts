/**
 * Pull a ComfyUI workflow out of an uploaded/downloaded file: .json (UI or
 * API format), .png (embedded "prompt"/"workflow" text chunks) or .zip (the
 * first workflow-looking .json inside, else the first .png with one).
 *
 * Conversion to API format reuses parseWorkflowJson (UI -> API, subgraph
 * flattening) so imported tools run the same graph Adrift would load from a
 * saved workflow.
 */

import type { Workflow } from "@/types";
import { parseWorkflowJson } from "@/lib/comfy/workflows";
import { isPng, readPngTextChunks } from "@/lib/pngMeta";
import { isZip, listZipEntries, readZipEntry, ZipError } from "./zip";

export type WorkflowSourceFormat = "api" | "ui";

export interface ExtractedWorkflow {
  /** API-format graph. */
  workflow: Workflow;
  /** Format the source graph was in. */
  format: WorkflowSourceFormat;
  /** File the workflow came from (zip member name or the file itself). */
  sourceFile: string;
  /** Other workflow files found in an archive (not imported). */
  otherFiles: string[];
}

export class WorkflowExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowExtractError";
  }
}

const MAX_ZIP_MEMBER_BYTES = 16 * 1024 * 1024;

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** True when `v` looks like an API-format prompt ({id: {class_type, inputs}}). */
export function looksLikeApiGraph(v: unknown): boolean {
  if (!isObj(v)) return false;
  const nodes = Object.values(v).filter(isObj);
  return (
    nodes.length > 0 &&
    nodes.some((n) => typeof n.class_type === "string" && isObj(n.inputs))
  );
}

/** True when `v` looks like a UI-format workflow (nodes[] or subgraphs). */
export function looksLikeUiGraph(v: unknown): boolean {
  if (!isObj(v)) return false;
  if (Array.isArray(v.nodes) && v.nodes.length > 0) return true;
  const defs = v.definitions;
  return (
    isObj(defs) && Array.isArray(defs.subgraphs) && defs.subgraphs.length > 0
  );
}

function toWorkflow(
  parsed: unknown,
  label: string,
): { workflow: Workflow; format: WorkflowSourceFormat } {
  const format: WorkflowSourceFormat = looksLikeApiGraph(parsed) ? "api" : "ui";
  let workflow: Workflow;
  try {
    workflow = parseWorkflowJson(parsed, label);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkflowExtractError(
      `Could not read the workflow in ${label}: ${msg}`,
    );
  }
  if (!workflow || Object.keys(workflow).length === 0) {
    throw new WorkflowExtractError(`The workflow in ${label} has no nodes`);
  }
  return { workflow, format };
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

/** Pick the graph out of PNG text chunks. Prefer the API "prompt" (what ran). */
function graphFromPng(bytes: Uint8Array): unknown {
  const chunks = readPngTextChunks(bytes);
  const prompt = parseJsonText(chunks.prompt ?? "");
  if (looksLikeApiGraph(prompt)) return prompt;
  const workflow = parseJsonText(chunks.workflow ?? "");
  if (looksLikeUiGraph(workflow) || looksLikeApiGraph(workflow))
    return workflow;
  return undefined;
}

function isGraph(v: unknown): boolean {
  return looksLikeApiGraph(v) || looksLikeUiGraph(v);
}

function extractFromZip(
  bytes: Uint8Array,
  filename: string,
): ExtractedWorkflow {
  let entries;
  try {
    entries = listZipEntries(bytes);
  } catch (err) {
    throw new WorkflowExtractError(
      err instanceof ZipError ? err.message : "Could not open the zip file",
    );
  }
  const files = entries.filter(
    (e) =>
      !e.isDirectory &&
      !e.name.startsWith("__MACOSX/") &&
      !/(^|\/)\./.test(e.name),
  );
  const jsons = files.filter((e) => /\.json$/i.test(e.name));
  const pngs = files.filter((e) => /\.png$/i.test(e.name));

  const found: { name: string; graph: unknown }[] = [];
  for (const e of jsons) {
    try {
      const parsed = parseJsonText(
        readZipEntry(bytes, e, {
          maxEntryBytes: MAX_ZIP_MEMBER_BYTES,
        }).toString("utf8"),
      );
      if (isGraph(parsed)) found.push({ name: e.name, graph: parsed });
    } catch {
      // unreadable member: skip
    }
  }
  if (found.length === 0) {
    for (const e of pngs) {
      try {
        const graph = graphFromPng(
          readZipEntry(bytes, e, { maxEntryBytes: MAX_ZIP_MEMBER_BYTES }),
        );
        if (graph !== undefined) {
          found.push({ name: e.name, graph });
          break;
        }
      } catch {
        // skip
      }
    }
  }
  if (found.length === 0) {
    throw new WorkflowExtractError(
      `No ComfyUI workflow found inside ${filename}`,
    );
  }
  // Prefer UI-format files (they carry titles and subgraphs) over API exports
  // when both are shipped; otherwise keep archive order.
  const ordered = [...found].sort(
    (a, b) =>
      Number(looksLikeApiGraph(a.graph)) - Number(looksLikeApiGraph(b.graph)),
  );
  const pick = ordered[0];
  const { workflow, format } = toWorkflow(pick.graph, pick.name);
  return {
    workflow,
    format,
    sourceFile: pick.name,
    otherFiles: found.filter((f) => f !== pick).map((f) => f.name),
  };
}

/** Extract an API-format workflow from raw file bytes. */
export function extractWorkflow(
  bytes: Uint8Array,
  filename = "workflow",
): ExtractedWorkflow {
  if (bytes.length === 0) throw new WorkflowExtractError("The file is empty");
  if (isZip(bytes)) return extractFromZip(bytes, filename);
  if (isPng(bytes)) {
    const graph = graphFromPng(bytes);
    if (graph === undefined) {
      throw new WorkflowExtractError(
        `${filename} has no ComfyUI workflow saved inside it`,
      );
    }
    return {
      ...toWorkflow(graph, filename),
      sourceFile: filename,
      otherFiles: [],
    };
  }
  const parsed = parseJsonText(Buffer.from(bytes).toString("utf8"));
  if (parsed === undefined) {
    throw new WorkflowExtractError(
      `${filename} is not a .json, .png or .zip workflow`,
    );
  }
  if (!isGraph(parsed)) {
    throw new WorkflowExtractError(
      `${filename} does not look like a ComfyUI workflow`,
    );
  }
  return {
    ...toWorkflow(parsed, filename),
    sourceFile: filename,
    otherFiles: [],
  };
}

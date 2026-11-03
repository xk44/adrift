/**
 * Human-readable mapping of ComfyUI failure payloads (POST /prompt
 * node_errors, WS execution_error / execution_interrupted) with node ids
 * resolved to titles. Pure; safe for client and server.
 */

export type NodeTitles = Record<string, string>;

export interface ExecutionEventData {
  prompt_id?: string;
  node_id?: string | number;
  node_type?: string;
  exception_message?: string;
  exception_type?: string;
}

export interface DescribedFailure {
  /** "cancelled" must never be presented as a failure. */
  state: "error" | "cancelled";
  message: string;
}

/** Map of node id -> _meta.title (or class_type) for an API-format prompt. */
export function extractNodeTitles(prompt: unknown): NodeTitles {
  const out: NodeTitles = {};
  if (typeof prompt !== "object" || prompt === null) return out;
  for (const [id, node] of Object.entries(prompt as Record<string, unknown>)) {
    if (typeof node !== "object" || node === null) continue;
    const n = node as { class_type?: unknown; _meta?: { title?: unknown } };
    const t = n._meta?.title;
    if (typeof t === "string" && t.trim()) out[id] = t;
    else if (typeof n.class_type === "string") out[id] = n.class_type;
  }
  return out;
}

function label(
  nodeId: string | number | undefined,
  titles: NodeTitles | undefined,
  fallbackType?: string,
): string {
  const id = nodeId === undefined ? "" : String(nodeId);
  const title =
    (id && titles?.[id]) ||
    fallbackType ||
    (id ? `Node ${id}` : "Unknown node");
  return id ? `${title} (#${id})` : title;
}

interface NodeErrorEntry {
  class_type?: string;
  errors?: Array<{ type?: string; message?: string; details?: string }>;
}

/** Format POST /prompt `node_errors` into one readable line per problem. */
export function formatNodeErrors(
  nodeErrors: Record<string, unknown> | undefined | null,
  titles?: NodeTitles,
): string {
  if (!nodeErrors) return "";
  const lines: string[] = [];
  for (const [id, raw] of Object.entries(nodeErrors)) {
    const entry = (raw ?? {}) as NodeErrorEntry;
    const where = label(id, titles, entry.class_type);
    const errs = entry.errors ?? [];
    if (errs.length === 0) {
      lines.push(`${where}: invalid`);
      continue;
    }
    for (const e of errs) {
      const msg = e.message ?? e.type ?? "error";
      lines.push(`${where}: ${msg}${e.details ? ` (${e.details})` : ""}`);
    }
  }
  return lines.join("\n");
}

export function describeExecutionError(
  data: ExecutionEventData,
  titles?: NodeTitles,
): DescribedFailure {
  const where = label(data.node_id, titles, data.node_type);
  const msg = data.exception_message?.trim() || "Unknown execution error";
  const type = data.exception_type ? ` [${data.exception_type}]` : "";
  return { state: "error", message: `${where} failed: ${msg}${type}` };
}

export function describeExecutionInterrupted(
  data: ExecutionEventData,
  titles?: NodeTitles,
): DescribedFailure {
  const at =
    data.node_id !== undefined || data.node_type
      ? ` at ${label(data.node_id, titles, data.node_type)}`
      : "";
  return { state: "cancelled", message: `Cancelled${at}` };
}

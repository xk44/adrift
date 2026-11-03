/**
 * Golden graph snapshots: the API-format prompt graph an action tool would
 * queue, normalised so it can be stored as a JSON fixture and diffed node by
 * node (src/__tests__/goldenGraphs.test.ts, scripts/golden-render.mjs).
 */
import type { Workflow } from "@/types";

export interface GoldenNode {
  class_type: string;
  title?: string;
  inputs: Record<string, unknown>;
}

export type GoldenGraph = Record<string, GoldenNode>;

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Epoch milliseconds from 2001 to 2286 (13 digits starting 1-9).
const EPOCH_MS_RE = /(?<![0-9])[1-9][0-9]{12}(?![0-9])/g;

function scrub(value: unknown): unknown {
  if (typeof value === "string")
    return value.replace(UUID_RE, "<uuid>").replace(EPOCH_MS_RE, "<time>");
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort())
      out[k] = scrub((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

function byNodeId(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Stable, comparable form of a prompt graph: only real nodes (class_type),
 * ids in numeric order, input keys sorted, `_meta.title` kept (builders find
 * nodes by title), uuids and epoch-ms stamps replaced by placeholders.
 */
export function normalizeGraph(
  wf: Workflow | Record<string, unknown>,
): GoldenGraph {
  const out: GoldenGraph = {};
  const entries = Object.entries(wf as Record<string, unknown>);
  for (const id of entries.map(([k]) => k).sort(byNodeId)) {
    const node = (wf as Record<string, unknown>)[id] as {
      class_type?: unknown;
      inputs?: Record<string, unknown>;
      _meta?: { title?: unknown };
    } | null;
    if (
      !node ||
      typeof node !== "object" ||
      typeof node.class_type !== "string"
    )
      continue;
    const title = node._meta?.title;
    out[id] = {
      class_type: node.class_type,
      ...(typeof title === "string" && title ? { title } : {}),
      inputs: scrub(node.inputs ?? {}) as Record<string, unknown>,
    };
  }
  return out;
}

function show(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined
    ? "(unset)"
    : s.length > 120
      ? `${s.slice(0, 117)}...`
      : s;
}

/**
 * Readable node-level diff, one line per change:
 *   + 12 SaveImage                  node added
 *   - 5 LoadImage                   node removed
 *   ~ 3 KSampler: class was X       class_type changed
 *   ~ 3 KSampler.seed: 1 -> 2       input changed / added / removed
 * Empty when the graphs match.
 */
export function diffGraphs(
  expected: GoldenGraph,
  actual: GoldenGraph,
): string[] {
  const lines: string[] = [];
  const ids = [
    ...new Set([...Object.keys(expected), ...Object.keys(actual)]),
  ].sort(byNodeId);
  for (const id of ids) {
    const a = expected[id];
    const b = actual[id];
    if (!b) {
      lines.push(`- ${id} ${a.class_type}`);
      continue;
    }
    if (!a) {
      lines.push(`+ ${id} ${b.class_type}`);
      continue;
    }
    if (a.class_type !== b.class_type)
      lines.push(`~ ${id} ${b.class_type}: class was ${a.class_type}`);
    if ((a.title ?? "") !== (b.title ?? ""))
      lines.push(
        `~ ${id} ${b.class_type}: title ${show(a.title)} -> ${show(b.title)}`,
      );
    const keys = [
      ...new Set([...Object.keys(a.inputs), ...Object.keys(b.inputs)]),
    ].sort();
    for (const k of keys) {
      const before = JSON.stringify(a.inputs[k]);
      const after = JSON.stringify(b.inputs[k]);
      if (before !== after)
        lines.push(
          `~ ${id} ${b.class_type}.${k}: ${show(a.inputs[k])} -> ${show(b.inputs[k])}`,
        );
    }
  }
  return lines;
}

/** File-safe fixture name ("Video lipsync: smart select" -> "video-lipsync-smart-select"). */
export function goldenSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Deterministic Math.random stand-in (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

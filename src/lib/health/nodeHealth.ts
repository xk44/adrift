/**
 * GET /api/health?nodes=1 node inventory, derived from the pack graphs
 * instead of a hand-kept list:
 *
 * - required: node classes in the default pack's t2i graph (plain
 *   generation must work). Missing any of these = unhealthy.
 * - optional: per pack, the classes its other graphs use (plus nodes the
 *   engine injects for that model family) that are not already required.
 *   A missing optional node only disables that pack's extras; it never
 *   fails the check (e.g. SeFi not installed).
 *
 * `missing` / `checked` cover required nodes only so existing
 * clients (iOS "Test connection") keep working.
 */

export interface NodeRequirements {
  required: string[];
  /** packId -> node classes only that pack needs. */
  optional: Record<string, string[]>;
}

export interface NodeHealth {
  /** Required classes missing from /object_info. */
  missing: string[];
  /** Number of required classes checked. */
  checked: number;
  /** packId -> optional classes missing (packs with none missing omitted). */
  optional: Record<string, string[]>;
  /** No required class is missing. */
  ok: boolean;
}

/** Minimal pack shape (lib/oj/packs.ts WorkflowPack). */
export interface PackGraphs {
  id: string;
  modelFamily: string;
  workflows: Partial<Record<string, string>>;
}

/**
 * Nodes the engine adds at queue time (not in any graph file), by model
 * family. Only used when the matching params are set, so optional.
 */
export const ENGINE_INJECTED_NODES: Readonly<Record<string, readonly string[]>> =
  {
    // lib/oj/engine.ts: projector tuner.
    krea2: ["Krea2ProjectorTuner"],
  };

/** Node classes used by a workflow (API format or UI format). */
export function graphClasses(wf: unknown): string[] {
  const out = new Set<string>();
  if (!wf || typeof wf !== "object") return [];
  const nodes = (wf as { nodes?: unknown }).nodes;
  if (Array.isArray(nodes)) {
    for (const n of nodes) {
      const t = (n as { type?: unknown })?.type;
      if (typeof t === "string" && t) out.add(t);
    }
  } else {
    for (const v of Object.values(wf as Record<string, unknown>)) {
      const t = (v as { class_type?: unknown } | null)?.class_type;
      if (typeof t === "string" && t) out.add(t);
    }
  }
  // Frontend-only helpers never reach /object_info.
  for (const t of ["Note", "MarkdownNote", "Reroute", "PrimitiveNode"])
    out.delete(t);
  return [...out].sort();
}

export type LoadGraph = (rel: string) => Promise<unknown>;

/**
 * Required/optional split from the registered packs' graphs. Graphs that
 * fail to load are skipped (a missing file is a pack bug, not a node gap).
 */
export async function nodeRequirements(
  packs: readonly PackGraphs[],
  defaultPackId: string,
  load: LoadGraph,
): Promise<NodeRequirements> {
  const cache = new Map<string, string[]>();
  const classesOf = async (rel: string | undefined): Promise<string[]> => {
    if (!rel) return [];
    if (!cache.has(rel)) {
      try {
        cache.set(rel, graphClasses(await load(rel)));
      } catch {
        cache.set(rel, []);
      }
    }
    return cache.get(rel)!;
  };
  const def = packs.find((p) => p.id === defaultPackId);
  const required = new Set(await classesOf(def?.workflows.t2i));
  const optional: Record<string, string[]> = {};
  for (const p of packs) {
    const own = new Set<string>();
    for (const rel of new Set(Object.values(p.workflows)))
      for (const c of await classesOf(rel)) own.add(c);
    for (const c of ENGINE_INJECTED_NODES[p.modelFamily] ?? []) own.add(c);
    const extra = [...own].filter((c) => !required.has(c)).sort();
    if (extra.length) optional[p.id] = extra;
  }
  return { required: [...required].sort(), optional };
}

/** Compare requirements against /object_info. */
export function nodeHealth(
  req: NodeRequirements,
  objectInfo: Record<string, unknown>,
): NodeHealth {
  const missing = req.required.filter((c) => !(c in objectInfo));
  const optional: Record<string, string[]> = {};
  for (const [pack, classes] of Object.entries(req.optional)) {
    const gone = classes.filter((c) => !(c in objectInfo));
    if (gone.length) optional[pack] = gone;
  }
  return {
    missing,
    checked: req.required.length,
    optional,
    ok: missing.length === 0,
  };
}

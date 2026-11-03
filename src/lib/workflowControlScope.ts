/**
 * Graph-scoped workflow control overrides.
 *
 * Control-panel overrides are keyed `nodeId.inputKey`. Node ids are only
 * meaningful inside the graph they were read from, so a tweak made on
 * one pack's t2i graph must never be applied to a different graph (e.g.
 * the i2v graph) that happens to reuse the same node id.
 *
 * The UI store keeps them in an envelope:
 *   { __byGraph: { "<graphId>": { "3.steps": 30, ... } } }
 * where graphId is the workflow path relative to public/workflows
 * ("packs/flux/t2i.json") or a saved id ("saved:<file>").
 *
 * Flat maps (no envelope) are explicit per-request overrides built for the
 * graph being submitted (e.g. the enhance options) and pass through as-is.
 */

export const SCOPED_OVERRIDES_KEY = "__byGraph";

export type ScopedControlOverrides = {
  [SCOPED_OVERRIDES_KEY]: Record<string, Record<string, unknown>>;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isScopedOverrides(v: unknown): v is ScopedControlOverrides {
  return isPlainObject(v) && isPlainObject(v[SCOPED_OVERRIDES_KEY]);
}

/** Normalize a workflow path (absolute, relative, saved:) to a graph id. */
export function graphIdFromWorkflowPath(
  p: string | null | undefined,
): string | null {
  if (typeof p !== "string") return null;
  let s = p.trim().replace(/\\/g, "/");
  if (!s) return null;
  if (s.startsWith("saved:")) return s;
  const marker = "public/workflows/";
  const idx = s.lastIndexOf(marker);
  if (idx >= 0) s = s.slice(idx + marker.length);
  while (s.startsWith("./")) s = s.slice(2);
  s = s.replace(/^\/+/, "");
  if (s.startsWith("workflows/")) s = s.slice("workflows/".length);
  // The action route may queue a `.video.json` sibling of the same graph.
  s = s.replace(/\.video\.json$/i, ".json");
  return s || null;
}

/** Store `values` for one graph, keeping other graphs' tweaks. */
export function mergeScopedOverrides(
  prev: unknown,
  graphPath: string,
  values: Record<string, unknown>,
): ScopedControlOverrides {
  const byGraph: Record<string, Record<string, unknown>> = isScopedOverrides(
    prev,
  )
    ? { ...prev[SCOPED_OVERRIDES_KEY] }
    : {};
  const id = graphIdFromWorkflowPath(graphPath);
  if (id) {
    if (Object.keys(values).length === 0) delete byGraph[id];
    else byGraph[id] = { ...values };
  }
  return { [SCOPED_OVERRIDES_KEY]: byGraph };
}

/**
 * Overrides that apply to the graph at `workflowPath`.
 * - envelope: only that graph's entry (else {}).
 * - flat map: returned unchanged (explicit, per-request).
 * - anything else: {}.
 */
export function selectControlOverridesForGraph(
  raw: unknown,
  workflowPath: string | null | undefined,
): Record<string, unknown> {
  if (!isPlainObject(raw)) return {};
  if (isScopedOverrides(raw)) {
    const id = graphIdFromWorkflowPath(workflowPath);
    if (!id) return {};
    const hit = raw[SCOPED_OVERRIDES_KEY][id];
    return isPlainObject(hit) ? { ...hit } : {};
  }
  if (SCOPED_OVERRIDES_KEY in raw) {
    const { [SCOPED_OVERRIDES_KEY]: _drop, ...rest } = raw;
    void _drop;
    return rest;
  }
  return raw;
}

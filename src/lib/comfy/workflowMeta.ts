/**
 * Pack API workflows carry top-level metadata keys ("_meta", "_comment") next
 * to the nodes. ComfyUI rejects any top-level entry without a class_type
 * ("Node 'ID #_meta' has no class_type"), and node walkers that read
 * `node.inputs` crash on them, so drop everything that is not a node.
 */
export function stripWorkflowMetaKeys<T extends object>(workflow: T): T {
  const out: Record<string, unknown> = {};
  for (const [id, node] of Object.entries(workflow)) {
    const n = node as { class_type?: unknown } | null;
    if (n && typeof n === "object" && typeof n.class_type === "string") out[id] = n;
  }
  return out as T;
}

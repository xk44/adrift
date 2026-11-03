/**
 * "Show graph" (Tools runner): the exact ComfyUI API workflow a tool would
 * queue, built by the job route's dry_run mode. Pure helpers so the summary
 * and the copied text are unit-tested.
 */
import type { ApiWorkflowJson } from "@/lib/tools/runTool";

export interface GraphClassCount {
  classType: string;
  count: number;
}

export interface GraphSummary {
  nodeCount: number;
  /** Node classes, most used first (ties by name). */
  classes: GraphClassCount[];
}

export function graphSummary(workflow: ApiWorkflowJson): GraphSummary {
  const counts = new Map<string, number>();
  let nodeCount = 0;
  for (const node of Object.values(workflow ?? {})) {
    const c = node?.class_type;
    if (typeof c !== "string") continue;
    nodeCount++;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const classes = [...counts]
    .map(([classType, count]) => ({ classType, count }))
    .sort(
      (a, b) => b.count - a.count || a.classType.localeCompare(b.classType),
    );
  return { nodeCount, classes };
}

/**
 * The text "Copy" puts on the clipboard: pretty-printed API JSON with node
 * ids in numeric order, the same shape ComfyUI's "Save (API)" writes.
 */
export function graphJson(workflow: ApiWorkflowJson): string {
  const ids = Object.keys(workflow ?? {}).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    return Number.isFinite(na) && Number.isFinite(nb)
      ? na - nb
      : a.localeCompare(b);
  });
  const ordered: ApiWorkflowJson = {};
  for (const id of ids) ordered[id] = workflow[id];
  return JSON.stringify(ordered, null, 2);
}

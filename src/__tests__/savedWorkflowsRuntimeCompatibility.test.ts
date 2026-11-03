import { describe, expect, it } from "vitest";
import {
  listSavedWorkflows,
  loadWorkflowFromSelection,
} from "@/lib/comfy/workflows";
import type { Workflow } from "@/types";

const comfyBaseUrl = process.env.COMFY_HTTP_URL ?? "http://127.0.0.1:8188";
const runRuntimeCompat = process.env.COMFY_RUNTIME_COMPAT === "1";

type RuntimeReport = {
  workflow: string;
  missingNodeTypes: string[];
  nodeTypeCount: number;
};

function nodeTypesForWorkflow(workflow: Workflow): string[] {
  return [...new Set(Object.values(workflow).map((node) => node.class_type))].sort();
}

async function fetchRuntimeNodeTypes(): Promise<Set<string>> {
  const response = await fetch(`${comfyBaseUrl}/object_info`);
  if (!response.ok) {
    throw new Error(`ComfyUI object_info failed: ${response.status}`);
  }
  const objectInfo = (await response.json()) as Record<string, unknown>;
  return new Set(Object.keys(objectInfo));
}

describe.runIf(runRuntimeCompat)("saved ComfyUI workflows against running ComfyUI", () => {
  it("classifies every discovered saved workflow against runtime node support", async () => {
    const runtimeNodeTypes = await fetchRuntimeNodeTypes();
    const workflows = await listSavedWorkflows();
    expect(runtimeNodeTypes.size).toBeGreaterThan(0);
    expect(workflows.length).toBeGreaterThan(0);

    const reports: RuntimeReport[] = [];
    for (const saved of workflows) {
      const workflow = await loadWorkflowFromSelection(`saved:${saved.file}`);
      const nodeTypes = nodeTypesForWorkflow(workflow);
      const missingNodeTypes = nodeTypes.filter((nodeType) => !runtimeNodeTypes.has(nodeType));
      reports.push({
        workflow: saved.file,
        missingNodeTypes,
        nodeTypeCount: nodeTypes.length,
      });
    }

    const compatible = reports.filter((report) => report.missingNodeTypes.length === 0);
    const incompatible = reports.filter((report) => report.missingNodeTypes.length > 0);
    const missingTypeCounts = new Map<string, number>();
    for (const report of incompatible) {
      for (const nodeType of report.missingNodeTypes) {
        missingTypeCounts.set(nodeType, (missingTypeCounts.get(nodeType) ?? 0) + 1);
      }
    }
    const topMissing = [...missingTypeCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 20);

    console.info(
      JSON.stringify(
        {
          comfyBaseUrl,
          totalSavedWorkflows: workflows.length,
          runtimeNodeTypes: runtimeNodeTypes.size,
          fullyNodeCompatibleWorkflows: compatible.length,
          workflowsWithMissingNodeTypes: incompatible.length,
          topMissingNodeTypes: topMissing,
          sampleIncompatibleWorkflows: incompatible.slice(0, 10),
        },
        null,
        2,
      ),
    );

    // Broad compatibility gate: Adrift must parse every saved workflow and
    // the running ComfyUI install must support at least some of the imported set.
    // Individual imported workflows may still need custom nodes/models and should
    // be reported, not fail the whole suite.
    expect(reports).toHaveLength(workflows.length);
    expect(compatible.length).toBeGreaterThan(0);
  });
});

describe.skipIf(runRuntimeCompat)("saved ComfyUI workflows against running ComfyUI", () => {
  it("is opt-in for local runtime checks", () => {
    expect(process.env.COMFY_RUNTIME_COMPAT).not.toBe("1");
  });
});

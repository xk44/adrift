/**
 * Server: load the graph behind a "user:<id>" workflow selection (a user tool
 * assigned as a Create mode / action on the Workflows page). Loaded lazily by
 * loadWorkflowFromSelection so lib/comfy/workflows does not import the store.
 */

import type { Workflow } from "@/types";
import { getUserTool } from "./store";
import { isUserToolSelection, userToolIdFromKey } from "./types";

export async function loadUserToolSelection(
  selection: string,
): Promise<Workflow> {
  const id = isUserToolSelection(selection)
    ? userToolIdFromKey(selection)
    : null;
  const tool = id ? await getUserTool(id) : null;
  if (!tool) {
    throw new Error(
      "That imported tool was deleted. Pick another workflow on the Workflows page.",
    );
  }
  return structuredClone(tool.workflow) as Workflow;
}

/**
 * Retry a finished prompt run from the queue drawer: re-POST its prompt to
 * /api/jobs/imagine, the same request the Lightbox's Rerun sends (current
 * promptbar.imagine workflow + control overrides, batch of 1). The prompt
 * bar's attachments and layout boxes are deliberately NOT sent: they belong
 * to whatever the user is composing now, not to the run being retried.
 */

import type { ImagineRun } from "@/types";
import {
  imagineWorkflowPathForPrompt,
  mergeActionAndSlotAssignments,
  resolveWorkflowForAction,
} from "@/lib/workflowAssignments";

export interface RetryWorkflowState {
  actionWorkflowMap: Parameters<typeof mergeActionAndSlotAssignments>[0];
  selectedWorkflowPath: string | null;
  selectedWorkflowName: string | null;
  defaultWorkflowPath: string | null;
  defaultWorkflowName: string | null;
  workflowControlOverrides: Record<string, unknown>;
}

export interface RetryRunDeps {
  fetchImpl?: typeof fetch;
  clientId: string;
  ui: RetryWorkflowState;
}

export function retryWorkflowPath(
  prompt: string,
  ui: RetryWorkflowState,
): string | undefined {
  const resolved = resolveWorkflowForAction("promptbar.imagine", {
    assignments: mergeActionAndSlotAssignments(ui.actionWorkflowMap),
    selectedWorkflowPath: ui.selectedWorkflowPath,
    selectedWorkflowName: ui.selectedWorkflowName,
    defaultWorkflowPath: ui.defaultWorkflowPath,
    defaultWorkflowName: ui.defaultWorkflowName,
  });
  return imagineWorkflowPathForPrompt(resolved?.workflowPath, prompt);
}

/** Queues the prompt again; resolves the new runs, throws on failure. */
export async function retryPromptRun(
  prompt: string,
  { fetchImpl = fetch, clientId, ui }: RetryRunDeps,
): Promise<ImagineRun[]> {
  const text = prompt.trim();
  if (!text) throw new Error("Nothing to retry: the run has no prompt");
  const overrides = ui.workflowControlOverrides;
  const res = await fetchImpl("/api/jobs/imagine", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: text,
      client_id: clientId,
      batch_size: 1,
      workflow_path: retryWorkflowPath(text, ui),
      ...(overrides && Object.keys(overrides).length > 0
        ? { workflow_control_overrides: overrides }
        : {}),
    }),
  });
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean;
    runs?: ImagineRun[];
    error?: string;
  } | null;
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error ?? `Retry failed (${res.status})`);
  }
  return data.runs ?? [];
}

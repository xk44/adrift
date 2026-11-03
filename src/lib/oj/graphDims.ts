/**
 * The pixel dims a queued graph will actually render, read from its latent
 * node. Runs without --ar are otherwise recorded at the 1:1 default
 * (1024x1024) even when the graph's own latent says otherwise (LTXV video
 * renders 768x512), which skews the DB row and the gallery placeholder.
 */

import type { Workflow, WorkflowSlots } from "@/types";

export function graphLatentDims(
  workflow: Workflow,
  slots: WorkflowSlots,
): { width: number; height: number } | null {
  const id = slots.latentDimsId;
  const node = id ? workflow[id] : undefined;
  const inputs = node?.inputs as Record<string, unknown> | undefined;
  const width = inputs?.width;
  const height = inputs?.height;
  // Linked (array) or missing dims can't be read statically.
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !(width > 0) ||
    !(height > 0)
  ) {
    return null;
  }
  return { width, height };
}

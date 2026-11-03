/**
 * Actions offered on a built-in pack workflow in the Packs browser:
 * "Use in Create" (text-to-image graphs only) and "Assign to…" (slots whose
 * kind matches the graph).
 */
import {
  WORKFLOW_ASSIGNMENT_SLOTS,
  type WorkflowAssignment,
  type WorkflowAssignmentSlot,
} from "@/lib/workflowAssignments";
import { packKeyToKind } from "@/lib/workflowSources";

/** Slots a pack workflow of `packKey` (e.g. "vary_subtle") can fill. */
export function slotsForPackKey(packKey: string): WorkflowAssignmentSlot[] {
  const kind = packKeyToKind(packKey);
  if (!kind) return [];
  return WORKFLOW_ASSIGNMENT_SLOTS.filter((s) => s.recommendedKind === kind);
}

/** Only text-to-image graphs can drive the Create prompt bar. */
export function canUseInCreate(packKey: string): boolean {
  return packKeyToKind(packKey) === "t2i";
}

/** Slot ids currently bound to this exact graph file. */
export function slotsAssignedTo(
  assignments: Record<string, WorkflowAssignment | undefined>,
  file: string,
  slots: readonly WorkflowAssignmentSlot[],
): string[] {
  return slots
    .filter((s) => assignments[s.id]?.workflowPath === file)
    .map((s) => s.id);
}

/**
 * Model family Create will run right now, for the Character pill's
 * "Different model family" check. Reads the same inputs useImagine uses to
 * pick a checkpoint (engine version, chosen model, default model, workflow).
 */

import { useUIStore } from "@/store";
import { useModelStore } from "@/store/modelStore";
import { detectModelFamilyStrict } from "@/lib/oj/packs";
import { activeFamilyGroup } from "@/lib/characters/characterLoras";

interface FamilyInputs {
  modelVersion: string;
  model?: string;
  defaultModel?: string | null;
  workflowName?: string | null;
}

export function familyFromInputs(i: FamilyInputs): string | null {
  const engineManaged = i.modelVersion !== "custom" && i.modelVersion !== "v7";
  const model = i.model || (!engineManaged ? i.defaultModel : "") || "";
  return activeFamilyGroup({
    modelVersion: i.modelVersion,
    modelFamily: model ? detectModelFamilyStrict(model) : null,
    workflowName: i.workflowName ?? null,
  });
}

/** Snapshot (submit time). */
export function currentCharacterFamily(): string | null {
  const ui = useUIStore.getState();
  return familyFromInputs({
    modelVersion: ui.settings.modelVersion,
    model: ui.settings.model,
    defaultModel: useModelStore.getState().defaultModel,
    workflowName: ui.selectedWorkflowName,
  });
}

/** Reactive (chips + picker). */
export function useCharacterFamily(): string | null {
  const modelVersion = useUIStore((s) => s.settings.modelVersion);
  const model = useUIStore((s) => s.settings.model);
  const workflowName = useUIStore((s) => s.selectedWorkflowName);
  const defaultModel = useModelStore((s) => s.defaultModel);
  return familyFromInputs({ modelVersion, model, defaultModel, workflowName });
}

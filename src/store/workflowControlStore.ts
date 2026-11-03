/**
 * Zustand store for persisting per-workflow control overrides.
 *
 * Storage key format: `${workflowPath}.${controlKey}` where controlKey is
 * `${nodeId}.${inputKey}` (from ControlSchema.key).
 *
 * Overrides are keyed by a "selection" which identifies the workflow context
 * — typically the pack ID + workflow kind (e.g. "flux.t2i") or a saved
 * workflow path (e.g. "saved:t2i.json"). This keeps overrides scoped so that
 * changing workflows doesn't carry stale values.
 */

import { STORAGE_KEYS, legacyAwareJSONStorage } from "@/lib/storageKeys";
import { createWithEqualityFn } from "zustand/traditional";
import { persist } from "zustand/middleware";
import type { ControlSchema } from "@/lib/oj/workflowControlSchema";

// Types

/**
 * A per-selection override map. Key is the ControlSchema.key (`nodeId.inputKey`),
 * value is the user's override value.
 */
export type ControlOverrides = Record<string, unknown>;

/** A single entry in the undo/redo history stack. */
export interface HistoryEntry {
  /** The control key that changed */
  key: string;
  /** Value before the change */
  previousValue: unknown;
  /** Value after the change */
  newValue: unknown;
  timestamp: number;
}

/** Maximum undo/redo history entries per selection */
const MAX_HISTORY = 50;

/** Batch override entry — multiple values for a single control */
export interface BatchOverride {
  key: string;
  /** Multiple values to generate with */
  values: unknown[];
}

/**
 * The full store state: each selection (pack workflow or saved workflow) maps
 * to its own set of control overrides.
 */
export interface WorkflowControlState {
  /** Per-selection overrides: selection ID → overrides map */
  overrides: Record<string, ControlOverrides>;

  /** Per-selection undo history stack (past changes, most recent last) */
  undoStack: Record<string, HistoryEntry[]>;

  /** Per-selection redo stack (undone changes, most recent last) */
  redoStack: Record<string, HistoryEntry[]>;

  /** Per-selection batch overrides — controls with multiple values for batch generation */
  batchOverrides: Record<string, BatchOverride[]>;

  /**
   * Per-selection set of control keys that have been flagged as "may need update"
   * due to a dependency change (e.g. checkpoint changed → LoRA may need review).
   */
  dependencyDirtyKeys: Record<string, Set<string>>;
}

export interface WorkflowControlActions {
  /**
   * Set an override value for a control in the active selection.
   */
  setOverride: (selection: string, key: string, value: unknown) => void;

  /**
   * Reset a single override back to default (removes the override entry).
   */
  resetOverride: (selection: string, key: string) => void;

  /**
   * Reset all overrides for a selection.
   */
  resetAllOverrides: (selection: string) => void;

  /**
   * Reset only the overrides whose keys belong to a given group.
   * Takes the set of control keys that belong to the group and removes
   * any matching overrides.
   */
  resetGroupOverrides: (selection: string, groupKeys: Set<string>) => void;

  /**
   * Batch-set overrides (e.g. when loading a workflow and applying initial
   * defaults as overrides). Merges into existing overrides.
   */
  setOverrides: (selection: string, overrides: ControlOverrides) => void;

  /**
   * Get the effective value for a control, considering overrides then defaults.
   * Returns the override value if one exists, otherwise the default.
   */
  getEffectiveValue: (
    selection: string,
    key: string,
    defaultValue: unknown,
  ) => unknown;

  /**
   * Check whether a specific control has been overridden (differs from default).
   */
  isOverridden: (
    selection: string,
    key: string,
    defaultValue: unknown,
  ) => boolean;

  getOverridesForSelection: (selection: string) => ControlOverrides;

  // Undo / Redo

  /** Undo the last control change for a selection. Returns true if an undo was performed. */
  undo: (selection: string) => boolean;

  /** Redo the last undone change for a selection. Returns true if a redo was performed. */
  redo: (selection: string) => boolean;

  /** Check if undo is available for a selection */
  canUndo: (selection: string) => boolean;

  /** Check if redo is available for a selection */
  canRedo: (selection: string) => boolean;

  /** Get the undo stack length for a selection */
  getUndoCount: (selection: string) => number;

  /** Get the redo stack length for a selection */
  getRedoCount: (selection: string) => number;

  // Batch overrides

  /** Set batch values for a control. Pass empty array to clear batch mode. */
  setBatchOverride: (selection: string, key: string, values: unknown[]) => void;

  /** Remove a single value from a batch override */
  removeBatchValue: (selection: string, key: string, index: number) => void;

  /** Get batch overrides for a selection */
  getBatchOverrides: (selection: string) => BatchOverride[];

  /** Clear all batch overrides for a selection */
  clearBatchOverrides: (selection: string) => void;

  // Dependency dirty tracking

  /** Mark a set of dependent control keys as "may need update" */
  markDependencyDirty: (selection: string, keys: string[]) => void;

  /** Clear dirty flag for a specific key (user has reviewed it) */
  clearDependencyDirty: (selection: string, key: string) => void;

  /** Clear all dirty flags for a selection */
  clearAllDependencyDirty: (selection: string) => void;

  /** Check if a key is dirty */
  isDependencyDirty: (selection: string, key: string) => boolean;
}

// Store

export const useWorkflowControlStore = createWithEqualityFn<
  WorkflowControlState & WorkflowControlActions
>()(
  persist(
    (set, get) => ({
      overrides: {},
      undoStack: {},
      redoStack: {},
      batchOverrides: {},
      dependencyDirtyKeys: {},

      setOverride: (selection, key, value) => {
        const state = get();
        const currentOverrides = state.overrides[selection] ?? {};
        const previousValue =
          key in currentOverrides ? currentOverrides[key] : undefined;

        // Push to undo stack, clear redo stack (new change invalidates redo)
        const undoEntry: HistoryEntry = {
          key,
          previousValue,
          newValue: value,
          timestamp: Date.now(),
        };
        const currentUndo = state.undoStack[selection] ?? [];
        const newUndo = [...currentUndo, undoEntry].slice(-MAX_HISTORY);

        set({
          overrides: {
            ...state.overrides,
            [selection]: {
              ...currentOverrides,
              [key]: value,
            },
          },
          undoStack: { ...state.undoStack, [selection]: newUndo },
          redoStack: { ...state.redoStack, [selection]: [] },
        });
      },

      resetOverride: (selection, key) =>
        set((state) => {
          const current = state.overrides[selection];
          if (!current || !(key in current)) return state;
          const next = { ...current };
          delete next[key];
          // Clean up empty selection entries
          if (Object.keys(next).length === 0) {
            const overrides = { ...state.overrides };
            delete overrides[selection];
            return { overrides };
          }
          return {
            overrides: {
              ...state.overrides,
              [selection]: next,
            },
          };
        }),

      resetAllOverrides: (selection) =>
        set((state) => {
          const overrides = { ...state.overrides };
          delete overrides[selection];
          return { overrides };
        }),

      resetGroupOverrides: (selection, groupKeys) =>
        set((state) => {
          const current = state.overrides[selection];
          if (!current) return state;
          const next: ControlOverrides = {};
          let removedAny = false;
          for (const [key, value] of Object.entries(current)) {
            if (groupKeys.has(key)) {
              removedAny = true;
            } else {
              next[key] = value;
            }
          }
          if (!removedAny) return state;
          if (Object.keys(next).length === 0) {
            const overrides = { ...state.overrides };
            delete overrides[selection];
            return { overrides };
          }
          return {
            overrides: {
              ...state.overrides,
              [selection]: next,
            },
          };
        }),

      setOverrides: (selection, overrides) =>
        set((state) => ({
          overrides: {
            ...state.overrides,
            [selection]: {
              ...(state.overrides[selection] ?? {}),
              ...overrides,
            },
          },
        })),

      getEffectiveValue: (selection, key, defaultValue) => {
        const overrides = get().overrides[selection];
        if (overrides && key in overrides) {
          return overrides[key];
        }
        return defaultValue;
      },

      isOverridden: (selection, key, defaultValue) => {
        const overrides = get().overrides[selection];
        if (!overrides || !(key in overrides)) return false;
        return overrides[key] !== defaultValue;
      },

      getOverridesForSelection: (selection) => {
        return get().overrides[selection] ?? {};
      },

      // Undo / Redo

      undo: (selection) => {
        const state = get();
        const stack = state.undoStack[selection];
        if (!stack || stack.length === 0) return false;

        const entry = stack[stack.length - 1];
        const newUndoStack = stack.slice(0, -1);
        const currentRedo = state.redoStack[selection] ?? [];
        const newRedoStack = [...currentRedo, entry].slice(-MAX_HISTORY);

        // Restore the previous value
        const currentOverrides = { ...(state.overrides[selection] ?? {}) };
        if (entry.previousValue === undefined) {
          delete currentOverrides[entry.key];
        } else {
          currentOverrides[entry.key] = entry.previousValue;
        }

        // Clean up empty override maps
        const overrides = { ...state.overrides };
        if (Object.keys(currentOverrides).length === 0) {
          delete overrides[selection];
        } else {
          overrides[selection] = currentOverrides;
        }

        set({
          overrides,
          undoStack: { ...state.undoStack, [selection]: newUndoStack },
          redoStack: { ...state.redoStack, [selection]: newRedoStack },
        });
        return true;
      },

      redo: (selection) => {
        const state = get();
        const stack = state.redoStack[selection];
        if (!stack || stack.length === 0) return false;

        const entry = stack[stack.length - 1];
        const newRedoStack = stack.slice(0, -1);
        const currentUndo = state.undoStack[selection] ?? [];
        const newUndoStack = [...currentUndo, entry].slice(-MAX_HISTORY);

        // Re-apply the change
        const currentOverrides = { ...(state.overrides[selection] ?? {}) };
        currentOverrides[entry.key] = entry.newValue;

        set({
          overrides: {
            ...state.overrides,
            [selection]: currentOverrides,
          },
          undoStack: { ...state.undoStack, [selection]: newUndoStack },
          redoStack: { ...state.redoStack, [selection]: newRedoStack },
        });
        return true;
      },

      canUndo: (selection) => {
        const stack = get().undoStack[selection];
        return !!stack && stack.length > 0;
      },

      canRedo: (selection) => {
        const stack = get().redoStack[selection];
        return !!stack && stack.length > 0;
      },

      getUndoCount: (selection) => {
        return get().undoStack[selection]?.length ?? 0;
      },

      getRedoCount: (selection) => {
        return get().redoStack[selection]?.length ?? 0;
      },

      // Batch overrides

      setBatchOverride: (selection, key, values) => {
        const state = get();
        const current = state.batchOverrides[selection] ?? [];
        let next: BatchOverride[];
        if (values.length === 0) {
          // Remove batch override for this key
          next = current.filter((b) => b.key !== key);
        } else {
          const existing = current.findIndex((b) => b.key === key);
          if (existing >= 0) {
            next = [...current];
            next[existing] = { key, values };
          } else {
            next = [...current, { key, values }];
          }
        }
        set({
          batchOverrides: { ...state.batchOverrides, [selection]: next },
        });
      },

      removeBatchValue: (selection, key, index) => {
        const state = get();
        const current = state.batchOverrides[selection] ?? [];
        const entry = current.find((b) => b.key === key);
        if (!entry) return;
        const newValues = entry.values.filter((_, i) => i !== index);
        if (newValues.length === 0) {
          set({
            batchOverrides: {
              ...state.batchOverrides,
              [selection]: current.filter((b) => b.key !== key),
            },
          });
        } else {
          set({
            batchOverrides: {
              ...state.batchOverrides,
              [selection]: current.map((b) =>
                b.key === key ? { key, values: newValues } : b,
              ),
            },
          });
        }
      },

      getBatchOverrides: (selection) => {
        return get().batchOverrides[selection] ?? [];
      },

      clearBatchOverrides: (selection) => {
        set((state) => {
          const batchOverrides = { ...state.batchOverrides };
          delete batchOverrides[selection];
          return { batchOverrides };
        });
      },

      // Dependency dirty tracking

      markDependencyDirty: (selection, keys) => {
        set((state) => {
          const current = state.dependencyDirtyKeys[selection] ?? new Set();
          const next = new Set(current);
          for (const k of keys) next.add(k);
          return {
            dependencyDirtyKeys: {
              ...state.dependencyDirtyKeys,
              [selection]: next,
            },
          };
        });
      },

      clearDependencyDirty: (selection, key) => {
        set((state) => {
          const current = state.dependencyDirtyKeys[selection];
          if (!current || !current.has(key)) return state;
          const next = new Set(current);
          next.delete(key);
          if (next.size === 0) {
            const dependencyDirtyKeys = { ...state.dependencyDirtyKeys };
            delete dependencyDirtyKeys[selection];
            return { dependencyDirtyKeys };
          }
          return {
            dependencyDirtyKeys: {
              ...state.dependencyDirtyKeys,
              [selection]: next,
            },
          };
        });
      },

      clearAllDependencyDirty: (selection) => {
        set((state) => {
          const dependencyDirtyKeys = { ...state.dependencyDirtyKeys };
          delete dependencyDirtyKeys[selection];
          return { dependencyDirtyKeys };
        });
      },

      isDependencyDirty: (selection, key) => {
        const dirty = get().dependencyDirtyKeys[selection];
        return !!dirty && dirty.has(key);
      },
    }),
    {
      name: STORAGE_KEYS.workflowControls,
      storage: legacyAwareJSONStorage(),
      partialize: (state) => ({
        overrides: state.overrides,
      }),
    },
  ),
);

// Convenience helpers

/**
 * Build a selection key from a pack ID and workflow kind.
 * Example: "flux::t2i", "sdxl::i2i"
 */
export function packSelectionKey(packId: string, kind: string): string {
  return `pack::${packId}::${kind}`;
}

/**
 * Build a selection key from a saved workflow file path.
 * Example: "saved::t2i.json"
 */
export function savedSelectionKey(file: string): string {
  return `saved::${file}`;
}

/**
 * Given a ControlSchema array and current overrides, return an array
 * of controls with their effective (override or default) values,
 * and a flag indicating whether each is overridden.
 */
export function computeEffectiveControls(
  controls: ControlSchema[],
  overrides: ControlOverrides,
): Array<ControlSchema & { effectiveValue: unknown; isOverridden: boolean }> {
  return controls.map((ctrl) => {
    const overrideValue = overrides[ctrl.key];
    const isOverridden =
      overrideValue !== undefined && overrideValue !== ctrl.defaultValue;
    return {
      ...ctrl,
      effectiveValue:
        overrideValue !== undefined ? overrideValue : ctrl.defaultValue,
      isOverridden,
    };
  });
}

/**
 * Filter controls to only those that are "user-editable" — visible and
 * of a kind that has a meaningful inline editor (number, seed, string,
 * enum, boolean, model, image, file).
 */
export function getEditableControls(
  controls: ControlSchema[],
): ControlSchema[] {
  const editableKinds = new Set([
    "number",
    "seed",
    "string",
    "enum",
    "boolean",
    "model",
    "image",
    "file",
  ]);
  return controls.filter((c) => c.visible && editableKinds.has(c.kind));
}

/**
 * Get the control schema for a specific key from a list of controls.
 */
export function findControlByKey(
  controls: ControlSchema[],
  key: string,
): ControlSchema | undefined {
  return controls.find((c) => c.key === key);
}

// Dependency map — which controls depend on which

/**
 * Known dependency relationships between control input keys.
 * When a "source" control changes, all controls matching a "dependent"
 * pattern should be flagged for review.
 *
 * Key: source inputKey pattern. Value: list of dependent inputKey patterns.
 */
const DEPENDENCY_RULES: Array<{
  sourceKeys: Set<string>;
  dependentKeys: Set<string>;
}> = [
  {
    // Changing checkpoint may invalidate LoRA, VAE, CLIP choices
    sourceKeys: new Set([
      "ckpt_name",
      "checkpoint_name",
      "model_name",
      "unet_name",
    ]),
    dependentKeys: new Set([
      "lora_name",
      "vae_name",
      "clip_name",
      "clip_name1",
      "clip_name2",
      "clip_name3",
      "embed_name",
    ]),
  },
  {
    // Changing sampler may affect scheduler recommendations
    sourceKeys: new Set(["sampler_name"]),
    dependentKeys: new Set(["scheduler"]),
  },
];

/**
 * Given a control key that just changed, compute the set of dependent
 * control keys that should be flagged for review.
 *
 * @param changedControl The control that was just modified
 * @param allControls All controls in the workflow
 * @returns Set of control keys that depend on the changed control
 */
export function computeDependentKeys(
  changedControl: ControlSchema,
  allControls: ControlSchema[],
): string[] {
  const dependentInputKeys = new Set<string>();

  for (const rule of DEPENDENCY_RULES) {
    if (rule.sourceKeys.has(changedControl.inputKey)) {
      for (const depKey of rule.dependentKeys) {
        dependentInputKeys.add(depKey);
      }
    }
  }

  if (dependentInputKeys.size === 0) return [];

  // Map dependent inputKeys to actual control keys in the workflow
  return allControls
    .filter(
      (c) => dependentInputKeys.has(c.inputKey) && c.key !== changedControl.key,
    )
    .map((c) => c.key);
}

// Comparison view helpers

/** A single entry in the comparison view */
export interface ComparisonEntry {
  key: string;
  label: string;
  group: string;
  kind: string;
  defaultValue: unknown;
  currentValue: unknown;
  isChanged: boolean;
}

/**
 * Build a comparison between current effective values and workflow defaults.
 * Returns all controls with changed/unchanged status for the diff view.
 */
export function buildComparisonEntries(
  controls: ControlSchema[],
  overrides: ControlOverrides,
): ComparisonEntry[] {
  return controls.map((ctrl) => {
    const overrideValue = overrides[ctrl.key];
    const currentValue =
      overrideValue !== undefined ? overrideValue : ctrl.defaultValue;
    const isChanged =
      overrideValue !== undefined && overrideValue !== ctrl.defaultValue;
    return {
      key: ctrl.key,
      label: ctrl.label,
      group: ctrl.group,
      kind: ctrl.kind,
      defaultValue: ctrl.defaultValue,
      currentValue,
      isChanged,
    };
  });
}

// Smart defaults based on workflow type

import type { WorkflowType } from "@/lib/oj/workflow-analysis";

/** Recommended default overrides for specific workflow types */
export interface SmartDefaultRecommendation {
  inputKey: string;
  recommendedValue?: unknown;
  recommendedMin?: number;
  recommendedMax?: number;
  hint: string;
}

/**
 * Get smart default recommendations based on detected workflow type.
 * These are hints, not automatic overrides — the UI shows them as suggestions.
 */
export function getSmartDefaults(
  workflowType: WorkflowType,
): SmartDefaultRecommendation[] {
  switch (workflowType) {
    case "upscale":
      return [
        {
          inputKey: "denoise",
          recommendedValue: 0.4,
          recommendedMin: 0.2,
          recommendedMax: 0.6,
          hint: "Lower denoise preserves details during upscale",
        },
        {
          inputKey: "steps",
          recommendedValue: 20,
          recommendedMin: 15,
          recommendedMax: 30,
          hint: "Fewer steps often sufficient for upscale",
        },
        {
          inputKey: "cfg",
          recommendedValue: 7,
          recommendedMin: 5,
          recommendedMax: 10,
          hint: "Moderate CFG for upscale fidelity",
        },
      ];
    case "inpaint":
    case "outpaint":
      return [
        {
          inputKey: "denoise",
          recommendedValue: 0.8,
          recommendedMin: 0.6,
          recommendedMax: 1.0,
          hint: "Higher denoise for inpaint to regenerate masked region",
        },
        {
          inputKey: "steps",
          recommendedValue: 25,
          recommendedMin: 20,
          recommendedMax: 40,
          hint: "More steps for cleaner inpaint blending",
        },
      ];
    case "i2i":
      return [
        {
          inputKey: "denoise",
          recommendedValue: 0.6,
          recommendedMin: 0.3,
          recommendedMax: 0.8,
          hint: "Balance between source preservation and creative freedom",
        },
        {
          inputKey: "cfg",
          recommendedValue: 7,
          recommendedMin: 4,
          recommendedMax: 12,
          hint: "Lower CFG for more natural img2img results",
        },
      ];
    case "t2i":
      return [
        {
          inputKey: "steps",
          recommendedValue: 25,
          recommendedMin: 15,
          recommendedMax: 50,
          hint: "Standard range for text-to-image quality",
        },
        {
          inputKey: "cfg",
          recommendedValue: 7.5,
          recommendedMin: 4,
          recommendedMax: 15,
          hint: "Standard CFG for prompt adherence",
        },
      ];
    case "t2v":
    case "i2v":
      return [
        {
          inputKey: "steps",
          recommendedValue: 20,
          recommendedMin: 15,
          recommendedMax: 30,
          hint: "Video generation typically uses fewer steps",
        },
        {
          inputKey: "cfg",
          recommendedValue: 6,
          recommendedMin: 3,
          recommendedMax: 10,
          hint: "Lower CFG for smoother video output",
        },
      ];
    default:
      return [];
  }
}

/**
 * Match smart default recommendations to actual controls in a workflow.
 * Returns recommendations paired with their matching control keys.
 */
export function matchSmartDefaults(
  workflowType: WorkflowType,
  controls: ControlSchema[],
): Array<SmartDefaultRecommendation & { controlKey: string }> {
  const recommendations = getSmartDefaults(workflowType);
  const matched: Array<SmartDefaultRecommendation & { controlKey: string }> =
    [];

  for (const rec of recommendations) {
    const ctrl = controls.find((c) => c.inputKey === rec.inputKey && c.visible);
    if (ctrl) {
      matched.push({ ...rec, controlKey: ctrl.key });
    }
  }

  return matched;
}

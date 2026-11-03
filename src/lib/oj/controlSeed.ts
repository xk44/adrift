/**
 * Seed precedence for Workflow Control overrides.
 *
 * The Workflow Control panel sends its seed (and the value produced by its
 * increment / decrement / randomize control_after_generate modes) as a
 * `${nodeId}.${inputKey}` override. The imagine pipeline then writes the run
 * seed into the sampler's seed input, which would silently discard that
 * override — so the override is lifted into the run's base seed instead.
 *
 * Precedence: `--seed` in the prompt > control-panel override > random.
 */

import type { Workflow, WorkflowSlots } from "@/types";
import { validateSeed } from "@/lib/validate";

/** The node/input the pipeline injects the run seed into (see injectParams). */
export function seedSlotKey(slots: WorkflowSlots): string | undefined {
  const cs = slots.customSampling;
  const nodeId = cs?.noiseId ?? slots.ksamplerId;
  if (!nodeId) return undefined;
  return `${nodeId}.${cs ? "noise_seed" : "seed"}`;
}

/**
 * The seed the control-panel overrides pin for this workflow's seed slot, or
 * undefined when there is none (or it isn't a valid non-negative integer).
 */
export function controlOverrideSeed(
  workflow: Workflow,
  slots: WorkflowSlots,
  overrides: Record<string, unknown> | undefined,
): number | undefined {
  if (!overrides) return undefined;
  const key = seedSlotKey(slots);
  if (!key || !Object.prototype.hasOwnProperty.call(overrides, key)) {
    return undefined;
  }
  const nodeId = key.slice(0, key.indexOf("."));
  if (!workflow[nodeId]) return undefined;
  return validateSeed(overrides[key]);
}

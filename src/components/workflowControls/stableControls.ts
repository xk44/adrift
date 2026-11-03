import type { ControlSchema } from "@/lib/oj/workflowControlSchema";
import { shallowEqualDeep1, stabilizeByKey } from "@/lib/ui/stableIdentity";

export type EffectiveControl = ControlSchema & {
  effectiveValue: unknown;
  isOverridden: boolean;
};

/**
 * Reuse last pass's control object for every control whose fields are
 * unchanged. Spec enrichment (applyInputSpecs) and computeEffectiveControls
 * rebuild every control on each override edit; without this, editing one
 * slider re-renders every editor in the panel.
 */
export function stabilizeEffectiveControls<T extends EffectiveControl>(
  next: readonly T[],
  prev: ReadonlyMap<string, T>,
): { items: T[]; cache: Map<string, T> } {
  return stabilizeByKey(
    next,
    prev,
    (c) => c.key,
    (a, b) => shallowEqualDeep1(a, b),
  );
}

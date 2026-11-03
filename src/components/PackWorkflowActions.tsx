"use client";

import { useMemo, useState } from "react";
import { Check, Wand2 } from "lucide-react";
import { useUIStore } from "@/store";
import { mergeActionAndSlotAssignments } from "@/lib/workflowAssignments";
import {
  canUseInCreate,
  slotsAssignedTo,
  slotsForPackKey,
} from "@/lib/packWorkflowActions";

const chipClass =
  "inline-flex items-center gap-1 rounded-full border border-light-200 px-3 py-1.5 text-xs font-medium text-light-600 transition-colors hover:border-splash/40 hover:bg-splash/5 hover:text-splash dark:border-dark-700 dark:text-dark-300 dark:hover:border-splash/40 dark:hover:bg-splash/10 dark:hover:text-splash";

/** "Use in Create" + "Assign to…" for one built-in pack workflow. */
export function PackWorkflowActions({
  packName,
  packKey,
  file,
}: {
  packName: string;
  /** Pack workflow key, e.g. "t2i" or "vary_subtle" */
  packKey: string;
  /** Path under public/workflows (what the job routes accept) */
  file: string;
}) {
  const setSelectedWorkflow = useUIStore((s) => s.setSelectedWorkflow);
  const setActiveNav = useUIStore((s) => s.setActiveNav);
  const actionWorkflowMap = useUIStore((s) => s.actionWorkflowMap);
  const setActionWorkflowMapping = useUIStore(
    (s) => s.setActionWorkflowMapping,
  );
  const [justAssigned, setJustAssigned] = useState<string | null>(null);

  const label = `${packName} · ${packKey.replace(/_/g, " ")}`;
  const slots = useMemo(() => slotsForPackKey(packKey), [packKey]);
  const assignedIds = useMemo(
    () =>
      slotsAssignedTo(
        mergeActionAndSlotAssignments(actionWorkflowMap),
        file,
        slots,
      ),
    [actionWorkflowMap, file, slots],
  );
  const useInCreate = canUseInCreate(packKey);

  if (!useInCreate && slots.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {useInCreate && (
        <button
          type="button"
          className={chipClass}
          onClick={() => {
            setSelectedWorkflow(file, label);
            setActiveNav("create");
          }}
          title="Make this the workflow the Create prompt bar uses"
        >
          <Wand2 className="h-3.5 w-3.5" />
          Use in Create
        </button>
      )}
      {slots.length > 0 && (
        <select
          aria-label={`Assign ${label} to an action`}
          value=""
          onChange={(e) => {
            const slotId = e.target.value;
            if (!slotId) return;
            setActionWorkflowMapping(slotId, file, label);
            setJustAssigned(
              slots.find((s) => s.id === slotId)?.label ?? slotId,
            );
          }}
          className="input h-8 rounded-full py-0 pl-3 pr-8 text-xs"
        >
          <option value="">Assign to an action…</option>
          {slots.map((s) => (
            <option key={s.id} value={s.id}>
              {assignedIds.includes(s.id) ? `${s.label} (already)` : s.label}
            </option>
          ))}
        </select>
      )}
      {justAssigned ? (
        <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
          <Check className="h-3.5 w-3.5" />
          {justAssigned} now uses this workflow
        </span>
      ) : assignedIds.length > 0 ? (
        <span className="text-xs text-light-500 dark:text-dark-400">
          Used by{" "}
          {slots
            .filter((s) => assignedIds.includes(s.id))
            .map((s) => s.label)
            .join(", ")}
        </span>
      ) : null}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useUIStore } from "@/store";
import type { WorkflowKind } from "@/types";
import {
  ACTION_ASSIGNMENT_GROUPS,
  getAssignmentLabel,
  listUnslottedMappings,
  mappingKeysForSlot,
  mergeActionAndSlotAssignments,
  type WorkflowAssignmentSlot,
} from "@/lib/workflowAssignments";
import {
  filterSourcesForSlot,
  findSourceByPath,
  kindFitsSlot,
  listWorkflowSources,
  type WorkflowSourceEntry,
} from "@/lib/workflowSources";
import {
  formatWorkflowName,
  getTypeColorClasses,
} from "@/lib/oj/workflow-analysis";
import {
  useInstallConfirmFlow,
  type InstallConfirmState,
} from "@/lib/hooks/useInstallConfirmFlow";
import {
  AlertCircle,
  AlertTriangle,
  Box,
  Check,
  CheckCircle2,
  ChevronDown,
  Download,
  FileJson,
  GitBranch,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import { UserToolAssignmentOptions } from "@/components/tools/userTools/UserToolAssignmentOptions";
import { userToolSelectionName } from "@/store/userToolsStore";
import { compactPath } from "@/lib/ui/displayPath";
import { openSetupTab } from "@/lib/setupNav";

interface MissingNodePackCandidate {
  id: string;
  label: string;
  source: "cnr" | "git" | "unknown";
}

interface MissingWorkflowNodeReport {
  nodeType: string;
  candidates: MissingNodePackCandidate[];
}

interface WorkflowRuntimeCompatibility {
  checked: boolean;
  comfyBaseUrl: string;
  managerAvailable: boolean;
  runtimeNodeTypes: number;
  missingNodeTypes: string[];
  missingNodes: MissingWorkflowNodeReport[];
  unambiguousInstallPackIds: string[];
  ambiguousNodeTypes: string[];
  unresolvedNodeTypes: string[];
  error?: string;
}

interface WorkflowOption {
  id: string;
  name: string;
  file: string;
  path: string;
  source: string;
  kind?: WorkflowKind | "unknown";
  runtime?: WorkflowRuntimeCompatibility;
}

const SOURCE_GROUP_LABELS: Record<WorkflowSourceEntry["source"], string> = {
  saved: "Your saved workflows",
  user: "Imported tools",
  pack: "Built-in packs",
};

const SLOT_KIND_LABELS: Record<string, string> = {
  t2i: "Text → Image",
  i2i: "Image → Image",
  upscale: "Upscale",
  inpaint: "Inpaint",
  outpaint: "Outpaint",
  t2v: "Text → Video",
  i2v: "Image → Video",
  t23d: "Text → 3D",
  i23d: "Image → 3D",
  t2a: "Text → Audio",
};

export function WorkflowPipelinePage() {
  const selectedWorkflowPath = useUIStore((s) => s.selectedWorkflowPath);
  const selectedWorkflowName = useUIStore((s) => s.selectedWorkflowName);
  const defaultWorkflowPath = useUIStore((s) => s.defaultWorkflowPath);
  const defaultWorkflowName = useUIStore((s) => s.defaultWorkflowName);
  const actionWorkflowMap = useUIStore((s) => s.actionWorkflowMap);
  const setActionWorkflowMapping = useUIStore(
    (s) => s.setActionWorkflowMapping,
  );
  const clearActionWorkflowMapping = useUIStore(
    (s) => s.clearActionWorkflowMapping,
  );

  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  const [directory, setDirectory] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showMissing, setShowMissing] = useState(false);

  const installFlow = useInstallConfirmFlow();

  const loadWorkflows = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/comfy/workflows?includeRuntime=1", {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      setWorkflows(data.workflows || []);
      setDirectory(data.directory || "");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workflows");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

  // Slot assignments plus legacy action-id entries, resolved per slot.
  const assignments = useMemo(
    () => mergeActionAndSlotAssignments(actionWorkflowMap),
    [actionWorkflowMap],
  );
  const sources = useMemo(
    () => listWorkflowSources({ saved: workflows }),
    [workflows],
  );
  const unslotted = useMemo(
    () => listUnslottedMappings(actionWorkflowMap),
    [actionWorkflowMap],
  );
  const selectedSource = findSourceByPath(sources, selectedWorkflowPath);
  const defaultSource = findSourceByPath(sources, defaultWorkflowPath);
  const assignedCount = useMemo(
    () =>
      ACTION_ASSIGNMENT_GROUPS.reduce(
        (count, group) =>
          count +
          group.slots.filter((slot) => assignments[slot.id]?.workflowPath)
            .length,
        0,
      ),
    [assignments],
  );
  const slotCount = ACTION_ASSIGNMENT_GROUPS.reduce(
    (count, group) => count + group.slots.length,
    0,
  );
  const missingWorkflows = useMemo(
    () =>
      workflows.filter((wf) => (wf.runtime?.missingNodeTypes.length ?? 0) > 0),
    [workflows],
  );
  const workflowsWithMissingNodes = missingWorkflows.length;

  // Writes only the slot key; legacy action-id entries are still read
  // through mergeActionAndSlotAssignments, and cleared with the slot.
  const assignSlot = (slot: WorkflowAssignmentSlot, workflowPath: string) => {
    if (!workflowPath) {
      // Clear the slot key and every older key that routes to it.
      for (const key of new Set([
        slot.id,
        ...(slot.legacyActionId ? [slot.legacyActionId] : []),
        ...mappingKeysForSlot(actionWorkflowMap, slot.id),
      ]))
        clearActionWorkflowMapping(key);
      return;
    }
    const entry = findSourceByPath(sources, workflowPath);
    setActionWorkflowMapping(slot.id, workflowPath, entry?.label ?? userToolSelectionName(workflowPath));
  };

  const quickAssign = (
    slot: WorkflowAssignmentSlot,
    source: "selected" | "default",
  ) => {
    const workflowPath =
      source === "selected" ? selectedWorkflowPath : defaultWorkflowPath;
    const workflowName =
      source === "selected" ? selectedWorkflowName : defaultWorkflowName;
    const entry = source === "selected" ? selectedSource : defaultSource;
    if (!workflowPath || !kindFitsSlot(entry?.kind, slot.recommendedKind)) {
      return;
    }
    setActionWorkflowMapping(slot.id, workflowPath, workflowName ?? null);
  };

  const handleRequestInstall = useCallback(
    (wf: WorkflowOption) => {
      const packIds = wf.runtime?.unambiguousInstallPackIds ?? [];
      if (packIds.length === 0) return;
      installFlow.requestConfirm(wf.id, formatWorkflowName(wf.name), packIds);
    },
    [installFlow],
  );

  return (
    <div className="text-light-primary dark:text-dark-primary">
      <div className="flex w-full flex-col gap-6">
        <header className="overflow-hidden rounded-3xl border border-light-100 bg-light-input p-5 dark:border-dark-750 dark:bg-dark-input">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <h2 className="flex items-center gap-2 text-xl font-semibold text-balance tracking-[-0.02em] text-light-primary dark:text-dark-primary">
                <GitBranch className="h-5 w-5" aria-hidden /> Button routing
              </h2>
              <p className="mt-2 max-w-xl text-sm text-pretty leading-6 text-light-500 dark:text-dark-400">
                Choose which workflow runs behind each button. Leave a slot
                empty to keep Adrift&rsquo;s built-in routing.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2 rounded-2xl bg-light-bg/70 p-2 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] dark:bg-dark-900/60 dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
              <Metric
                label="Assigned"
                value={`${assignedCount}/${slotCount}`}
              />
              <Metric
                label="Workflows"
                value={loading ? "…" : String(workflows.length)}
              />
              <Metric
                label="Missing"
                value={loading ? "…" : String(workflowsWithMissingNodes)}
                onClick={
                  !loading && workflowsWithMissingNodes > 0
                    ? () => setShowMissing((v) => !v)
                    : undefined
                }
                pressed={showMissing}
                title="Saved workflows that need custom nodes ComfyUI doesn't have"
              />
            </div>
          </div>
        </header>

        <details className="group rounded-2xl border border-light-100 bg-light-input px-4 py-3 dark:border-dark-750 dark:bg-dark-input">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-light-600 dark:text-dark-300 [&::-webkit-details-marker]:hidden">
            <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
            What is this?
          </summary>
          <div className="mt-3 space-y-3">
            <div className="overflow-hidden rounded-3xl border border-light-100 bg-light-input p-5 dark:border-dark-750 dark:bg-dark-input">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-indigo-500/20 text-indigo-500 dark:text-indigo-300">
                    <Box className="h-6 w-6" />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold tracking-[-0.02em] text-light-primary dark:text-dark-primary">
                      Create 3D from Image
                    </h2>
                    <p className="mt-0.5 text-sm text-light-500 dark:text-dark-400">
                      &ldquo;Make 3D&rdquo; in the image viewer runs the built-in
                      TRELLIS.2 workflow. Assign a different image-to-3D workflow
                      under Media expansion to replace it.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {assignments["expand.make_3d"]?.workflowPath ? (
                    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-300">
                      <Check className="h-3.5 w-3.5" /> Custom workflow
                    </span>
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-light-100 bg-light-50 px-3 py-1.5 text-xs font-medium text-light-500 dark:border-dark-700 dark:bg-dark-850 dark:text-dark-400">
                      Built-in
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="rounded-3xl bg-light-input p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] dark:bg-dark-input dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-splash/10 text-splash">
                  <Sparkles className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="font-medium text-balance text-light-primary dark:text-dark-primary">
                    Empty slots use the built-in routing
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-light-500 dark:text-dark-400">
                    A workflow you assign here always wins. Empty image, editor,
                    and video slots use the built-in workflow for the active
                    model. Only the prompt bar falls back to your selected
                    workflow, then the app default.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </details>

        <div className="rounded-2xl bg-light-input p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] dark:bg-dark-input dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-light-400 dark:text-dark-500">
                Workflow source
              </p>
              <p
                className="mt-1 truncate text-xs text-light-500 dark:text-dark-400"
                title={directory || undefined}
              >
                {directory
                  ? compactPath(directory)
                  : loading
                    ? "Loading…"
                    : "Saved ComfyUI workflows + built-in packs"}
              </p>
            </div>
            <button
              onClick={() => void loadWorkflows()}
              disabled={loading}
              className="inline-flex h-9 items-center gap-2 rounded-full border border-light-100 px-3 text-sm font-medium text-light-600 transition-[background-color,color,transform] hover:bg-light-50 hover:text-light-primary active:scale-[0.98] disabled:opacity-60 dark:border-dark-700 dark:text-dark-300 dark:hover:bg-dark-750 dark:hover:text-dark-primary"
            >
              <RefreshCw
                className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
          </div>
        </div>

        {showMissing && missingWorkflows.length > 0 ? (
          <section
            aria-label="Workflows with missing nodes"
            className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-4 text-xs leading-5 text-light-500 dark:text-dark-400"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium text-amber-700 dark:text-amber-300">
                {missingWorkflows.length} saved workflow
                {missingWorkflows.length === 1 ? "" : "s"} need custom nodes
              </p>
              <button
                type="button"
                onClick={() => setShowMissing(false)}
                aria-label="Hide workflows with missing nodes"
                className="rounded-full p-1 hover:bg-amber-500/15"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <ul className="mt-2 divide-y divide-amber-500/15">
              {missingWorkflows.map((wf) => {
                const missing = wf.runtime?.missingNodeTypes.length ?? 0;
                const installable =
                  wf.runtime?.unambiguousInstallPackIds.length ?? 0;
                return (
                  <li
                    key={wf.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <span className="min-w-0 truncate">
                      <span className="font-medium text-light-primary dark:text-dark-primary">
                        {formatWorkflowName(wf.name)}
                      </span>{" "}
                      · {missing} missing node{missing === 1 ? "" : "s"}
                    </span>
                    {installable > 0 ? (
                      <button
                        type="button"
                        onClick={() => handleRequestInstall(wf)}
                        className="pipeline-mini-button border-amber-500/25 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
                      >
                        <Download className="h-3.5 w-3.5" /> Install nodes
                      </button>
                    ) : (
                      <span className="text-light-400 dark:text-dark-500">
                        No one-click install
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {error ? (
          <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-500 dark:text-red-300">
            <div className="flex items-center gap-2 font-medium">
              <AlertCircle className="h-4 w-4" /> Couldn&rsquo;t load your
              saved workflows
            </div>
            <p className="mt-1 opacity-85">{error}</p>
            <p className="mt-1 opacity-85">
              Built-in packs are still listed below. Check that ComfyUI is
              running, then press Refresh.
            </p>
          </div>
        ) : !loading && workflows.length === 0 ? (
          <div className="flex items-start gap-3 rounded-2xl bg-light-input p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] dark:bg-dark-input dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
            <FileJson className="mt-0.5 h-5 w-5 shrink-0 text-light-400 dark:text-dark-500" />
            <div>
              <h2 className="text-sm font-medium text-balance">
                No saved workflows yet
              </h2>
              <p className="mt-1 text-xs text-light-500 dark:text-dark-400">
                You can still pick a built-in pack for any slot. To use your
                own graph, save it in ComfyUI (Workflow → Save), then press
                Refresh.
              </p>
            </div>
          </div>
        ) : null}

        {installFlow.state.phase === "result" && installFlow.state.result ? (
          <button
            type="button"
            onClick={installFlow.dismissResult}
            className={`w-full rounded-2xl border p-4 text-left text-xs leading-5 transition-colors ${
              installFlow.state.result.isError
                ? "border-red-500/20 bg-red-500/10 text-red-500 dark:text-red-300"
                : "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
            }`}
          >
            <div className="flex items-start gap-3">
              {installFlow.state.result.isError ? (
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              ) : (
                <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              )}
              <span className="flex-1">{installFlow.state.result.message}</span>
              <X className="h-3.5 w-3.5 shrink-0 opacity-50 hover:opacity-100" />
            </div>
          </button>
        ) : null}

        {installFlow.state.phase === "confirming" && installFlow.state.pending ? (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs leading-5 text-light-500 dark:text-dark-400">
            <p className="font-medium text-amber-600 dark:text-amber-300">
              Queue missing-node install for {installFlow.state.pending.workflowName}?
            </p>
            <p className="mt-1 line-clamp-2 break-all">
              Packs: {installFlow.state.pending.packIds.join(", ")}
            </p>
            <p className="mt-1 opacity-75">
              Only unambiguous packs are queued. Restart ComfyUI after Manager finishes.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => void installFlow.executeInstall()}
                className="inline-flex items-center gap-1.5 rounded-full bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white transition-transform active:scale-[0.97]"
              >
                <Download className="h-3.5 w-3.5" /> Confirm install
              </button>
              <button
                type="button"
                onClick={installFlow.cancelConfirm}
                className="inline-flex items-center gap-1.5 rounded-full border border-light-100 px-3 py-1.5 text-xs font-medium text-light-600 transition-[background-color,color] hover:bg-light-50 hover:text-light-primary dark:border-dark-700 dark:text-dark-300 dark:hover:bg-dark-750"
              >
                <X className="h-3.5 w-3.5" /> Cancel
              </button>
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className="rounded-2xl bg-light-input p-6 text-xs text-light-500 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] dark:bg-dark-input dark:text-dark-400 dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
            <div className="flex items-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-splash" /> Loading
              workflows…
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {ACTION_ASSIGNMENT_GROUPS.map((group) => (
              <section
                key={group.id}
                className="overflow-hidden rounded-3xl border border-light-100 bg-light-input shadow-[0_12px_30px_rgba(31,35,40,0.05)] dark:border-dark-750 dark:bg-dark-input dark:shadow-[0_12px_30px_rgba(0,0,0,0.22)]"
              >
                <div className="border-b border-light-100 px-4 py-4 dark:border-dark-750">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <p className="text-[11px] font-medium text-splash">
                        {group.eyebrow}
                      </p>
                      <h2 className="mt-1 text-lg font-semibold text-balance tracking-[-0.02em]">
                        {group.label}
                      </h2>
                      <p className="mt-1 text-xs text-light-500 dark:text-dark-400">
                        {group.description}
                      </p>
                    </div>
                    <div className="self-start whitespace-nowrap rounded-full border border-light-100 px-3 py-1 text-xs font-medium text-light-500 dark:border-dark-700 dark:text-dark-400 sm:self-auto">
                      {
                        group.slots.filter(
                          (slot) => assignments[slot.id]?.workflowPath,
                        ).length
                      }
                      /{group.slots.length} assigned
                    </div>
                  </div>
                </div>
                <div className="divide-y divide-light-100 dark:divide-dark-750">
                  {group.slots.map((slot) => (
                    <AssignmentRow
                      key={slot.id}
                      slot={slot}
                      workflows={workflows}
                      sources={sources}
                      value={assignments[slot.id]?.workflowPath ?? ""}
                      effectiveLabel={getAssignmentLabel(slot.id, assignments)}
                      selectedFits={
                        !!selectedWorkflowPath &&
                        kindFitsSlot(selectedSource?.kind, slot.recommendedKind)
                      }
                      defaultFits={
                        !!defaultWorkflowPath &&
                        kindFitsSlot(defaultSource?.kind, slot.recommendedKind)
                      }
                      onAssign={(workflowPath) =>
                        assignSlot(slot, workflowPath)
                      }
                      onUseSelected={() => quickAssign(slot, "selected")}
                      onUseDefault={() => quickAssign(slot, "default")}
                      onRequestInstall={handleRequestInstall}
                      installFlowState={installFlow.state}
                    />
                  ))}
                </div>
              </section>
            ))}
            {unslotted.length > 0 ? (
              <section className="rounded-2xl bg-light-input p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] dark:bg-dark-input dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
                <h2 className="font-medium text-balance text-light-primary dark:text-dark-primary">
                  Other action mappings
                </h2>
                <p className="mt-1 text-sm text-light-500 dark:text-dark-400">
                  Set up earlier on the Workflows page. They still apply to
                  these actions. Clear one to go back to the built-in workflow.
                </p>
                <ul className="mt-3 space-y-2">
                  {unslotted.map((m) => (
                    <li
                      key={m.key}
                      className="flex flex-wrap items-center justify-between gap-2 text-sm"
                    >
                      <span className="min-w-0 truncate">
                        <span className="font-medium">
                          {m.key.replace(/[._]/g, " ")}
                        </span>
                        <span className="text-light-500 dark:text-dark-400">
                          {" "}
                          → {m.workflowName ?? m.workflowPath}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => clearActionWorkflowMapping(m.key)}
                        className="pipeline-mini-button"
                      >
                        Clear
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-light-input p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] dark:bg-dark-input dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
          <p className="text-xs text-light-500 dark:text-dark-400">
            Need to import, inspect, or set the global default workflow?
          </p>
          <button
            onClick={() => openSetupTab("workflows")}
            className="inline-flex items-center gap-2 rounded-full bg-splash px-4 py-2 text-sm font-semibold text-white transition-transform active:scale-[0.98]"
          >
            Open Workflows
          </button>
        </div>
      </div>
    </div>
  );
}

function AssignmentRow({
  slot,
  workflows,
  sources,
  value,
  effectiveLabel,
  selectedFits,
  defaultFits,
  onAssign,
  onUseSelected,
  onUseDefault,
  onRequestInstall,
  installFlowState,
}: {
  slot: WorkflowAssignmentSlot;
  workflows: WorkflowOption[];
  sources: WorkflowSourceEntry[];
  value: string;
  effectiveLabel: string;
  /** Selected/default workflow exists and its kind fits this slot */
  selectedFits: boolean;
  defaultFits: boolean;
  onAssign: (workflowPath: string) => void;
  onUseSelected: () => void;
  onUseDefault: () => void;
  onRequestInstall: (workflow: WorkflowOption) => void;
  installFlowState: InstallConfirmState;
}) {
  const assignedWorkflow = workflows.find((wf) => `saved:${wf.file}` === value);
  const runtime = assignedWorkflow?.runtime;
  const missingCount = runtime?.missingNodeTypes.length ?? 0;
  const installableCount = runtime?.unambiguousInstallPackIds.length ?? 0;
  const isInstallingTarget =
    installFlowState.phase === "installing" &&
    installFlowState.pending?.workflowId === assignedWorkflow?.id;
  const isConfirmingTarget =
    installFlowState.phase === "confirming" &&
    installFlowState.pending?.workflowId === assignedWorkflow?.id;
  const { matching, unknown } = filterSourcesForSlot(
    sources,
    slot.recommendedKind,
  );
  const listed = [...matching, ...unknown];
  // Keep a current value visible even if its kind no longer matches.
  const orphanValue =
    value && !listed.some((e) => e.workflowPath === value) ? value : null;
  const optionLabel = (e: WorkflowSourceEntry) =>
    `${e.source === "saved" ? formatWorkflowName(e.label) : e.label}${
      e.missingCount ? ` · ${e.missingCount} missing` : ""
    }`;
  const kindLabel = slot.recommendedKind
    ? SLOT_KIND_LABELS[slot.recommendedKind]
    : "this slot";

  return (
    <div className="grid gap-3 px-4 py-4 lg:grid-cols-[minmax(210px,0.75fr)_minmax(0,1.25fr)_auto] lg:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium text-balance text-light-primary dark:text-dark-primary">
            {slot.label}
          </h3>
          {slot.recommendedKind ? (
            <span className="rounded-full border border-light-100 bg-light-50 px-2 py-0.5 text-[11px] font-medium text-light-500 dark:border-dark-700 dark:bg-dark-850 dark:text-dark-400">
              {SLOT_KIND_LABELS[slot.recommendedKind]}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-sm leading-5 text-light-500 dark:text-dark-400">
          {slot.description}
        </p>
        <p className="mt-1 truncate text-xs text-light-400 dark:text-dark-500">
          Effective: {effectiveLabel}
        </p>
      </div>

      <div className="min-w-0 space-y-2">
        <div className="relative">
          <select
            aria-label={`Workflow for ${slot.label}`}
            value={value}
            onChange={(event) => onAssign(event.target.value)}
            className="input h-11 w-full appearance-none rounded-xl pr-9"
          >
            <option value="">Built-in routing (no assignment)</option>
            {orphanValue ? (
              <option value={orphanValue}>
                {effectiveLabel} (current, type does not match)
              </option>
            ) : null}
            {(["saved", "user", "pack"] as const).map((origin) => {
              const items = matching.filter((e) => e.source === origin);
              if (items.length === 0) return null;
              return (
                <optgroup key={origin} label={SOURCE_GROUP_LABELS[origin]}>
                  {items.map((e) => (
                    <option key={e.id} value={e.workflowPath}>
                      {optionLabel(e)}
                    </option>
                  ))}
                </optgroup>
              );
            })}
            {unknown.length > 0 ? (
              <optgroup label="Type not detected (check it fits)">
                {unknown.map((e) => (
                  <option key={e.id} value={e.workflowPath}>
                    {optionLabel(e)}
                  </option>
                ))}
              </optgroup>
            ) : null}
            <UserToolAssignmentOptions />
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-light-400 dark:text-dark-500" />
        </div>

        {runtime?.checked && missingCount > 0 ? (
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-light-500 dark:text-dark-400">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1 font-medium text-amber-600 dark:text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5" /> {missingCount} missing
                node{missingCount === 1 ? "" : "s"}
              </span>
              <span className="tabular-nums text-light-400 dark:text-dark-400">
                {installableCount} installable ·{" "}
                {runtime.ambiguousNodeTypes.length} ambiguous
              </span>
            </div>
            <p className="mt-1 line-clamp-1 break-all text-light-500 dark:text-dark-400">
              {runtime.missingNodeTypes.slice(0, 5).join(", ")}
              {runtime.missingNodeTypes.length > 5
                ? ` +${runtime.missingNodeTypes.length - 5} more`
                : ""}
            </p>
          </div>
        ) : runtime?.checked && assignedWorkflow ? (
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-600 dark:text-emerald-300">
            Runtime nodes available
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap justify-start gap-2 lg:justify-end">
        {assignedWorkflow && installableCount > 0 ? (
          isConfirmingTarget ? (
            <span className="pipeline-mini-button min-h-10 border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300">
              Awaiting confirm…
            </span>
          ) : isInstallingTarget ? (
            <span className="pipeline-mini-button min-h-10 border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Installing…
            </span>
          ) : (
            <button
              onClick={() => onRequestInstall(assignedWorkflow)}
              aria-label={`Install missing nodes for ${slot.label}`}
              className="pipeline-mini-button min-h-10 border-amber-500/25 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
              title="Queue ComfyUI Manager install tasks for unambiguous missing node packs"
            >
              <Download className="h-3.5 w-3.5" />
              Install nodes
            </button>
          )
        ) : null}
        <button
          onClick={onUseSelected}
          disabled={!selectedFits}
          aria-label={`Use the selected workflow for ${slot.label}`}
          className="pipeline-mini-button"
          title={
            selectedFits
              ? "Assign the workflow selected in Create"
              : `The workflow selected in Create isn't detected as ${kindLabel}`
          }
        >
          <Check className="h-3.5 w-3.5" /> Selected
        </button>
        <button
          onClick={onUseDefault}
          disabled={!defaultFits}
          aria-label={`Use the default workflow for ${slot.label}`}
          className="pipeline-mini-button"
          title={
            defaultFits
              ? "Assign the app default workflow"
              : `The app default workflow isn't detected as ${kindLabel}`
          }
        >
          <FileJson className="h-3.5 w-3.5" /> Default
        </button>
        <button
          onClick={() => onAssign("")}
          disabled={!value}
          aria-label={`Clear the workflow for ${slot.label}`}
          className="pipeline-mini-button"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Clear
        </button>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  onClick,
  pressed,
  title,
}: {
  label: string;
  value: string;
  /** When set, the tile is a toggle button (e.g. show the missing list). */
  onClick?: () => void;
  pressed?: boolean;
  title?: string;
}) {
  const body = (
    <>
      <div className="text-[11px] font-medium text-light-400 dark:text-dark-500">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-light-primary dark:text-dark-primary">
        {value}
      </div>
    </>
  );
  if (!onClick) {
    return (
      <div
        className="rounded-xl bg-light-input px-3 py-2 dark:bg-dark-input"
        title={title}
      >
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      title={title}
      className={`rounded-xl px-3 py-2 text-left underline-offset-4 transition-colors hover:underline ${
        pressed
          ? "bg-amber-500/15 ring-1 ring-amber-500/40"
          : "bg-light-input hover:bg-light-50 dark:bg-dark-input dark:hover:bg-dark-750"
      }`}
    >
      {body}
    </button>
  );
}

export default WorkflowPipelinePage;

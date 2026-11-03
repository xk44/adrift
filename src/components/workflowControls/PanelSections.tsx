"use client";

/**
 * Memoized chrome sections of WorkflowControlPanel. Each takes only
 * primitives, stable callbacks, or identity-stabilized lists, so editing one
 * control override skips the sections whose inputs did not change.
 */
import React, { useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  GitCompareArrows,
  Layers,
  Redo2,
  RotateCcw,
  SlidersHorizontal,
  Undo2,
  XCircle,
} from "lucide-react";
import {
  useWorkflowControlStore,
  type BatchOverride,
} from "@/store/workflowControlStore";
import {
  BASE_MODEL_BADGE,
  type BaseModelType,
} from "@/components/workflowControls/panelHelpers";
import { BatchChips } from "@/components/workflowControls/PanelBits";

/** Minimal per-control facts the chrome sections need (no values). */
export interface ControlMeta {
  key: string;
  label: string;
  kind: string;
}

/**
 * Keep the previous array when every item is identical (Object.is), or when
 * `same` says the items match. Lets memoized children skip on recomputes
 * that produced equal content.
 */
export function useStableList<T>(
  next: readonly T[],
  same: (a: T, b: T) => boolean = Object.is,
): readonly T[] {
  const ref = useRef(next);
  const prev = ref.current;
  if (
    prev !== next &&
    (prev.length !== next.length ||
      next.some((item, i) => !same(item, prev[i])))
  ) {
    ref.current = next;
  }
  return ref.current;
}

export const sameControlMeta = (a: ControlMeta, b: ControlMeta) =>
  a.key === b.key && a.label === b.label && a.kind === b.kind;

// Workflow info header

export const PanelInfoHeader = React.memo(function PanelInfoHeader({
  workflowName,
  workflowKind,
  nodeCount,
  detectedBaseModel,
  missingNodesCount,
}: {
  workflowName?: string;
  workflowKind: string;
  nodeCount?: number;
  detectedBaseModel?: string;
  missingNodesCount?: number;
}) {
  if (!(workflowName || nodeCount !== undefined || detectedBaseModel)) {
    return null;
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-light-100 bg-light-50/50 px-2.5 py-1.5 dark:border-dark-750 dark:bg-dark-850/60">
      {/* Name + kind */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          {workflowName && (
            <span className="text-[11px] font-semibold text-light-700 dark:text-dark-200 truncate">
              {workflowName}
            </span>
          )}
          {workflowKind && (
            <span className="text-[10px] text-light-400 dark:text-dark-500 font-mono">
              {workflowKind}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {nodeCount !== undefined && (
            <span className="text-[10px] text-light-400 dark:text-dark-500">
              {nodeCount} nodes
            </span>
          )}
          {detectedBaseModel && (
            <span
              className={`text-[9px] rounded border px-1 py-0 ${BASE_MODEL_BADGE[detectedBaseModel as BaseModelType] ?? BASE_MODEL_BADGE.Other}`}
            >
              {detectedBaseModel}
            </span>
          )}
        </div>
      </div>
      {/* Compatibility badge */}
      {missingNodesCount !== undefined && (
        <div className="shrink-0">
          {missingNodesCount === 0 ? (
            <span
              className="flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
              title="All required nodes are installed"
            >
              <CheckCircle2 className="h-3 w-3" />
              Compatible
            </span>
          ) : (
            <span
              className="flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400"
              title={`${missingNodesCount} missing node type${missingNodesCount !== 1 ? "s" : ""}`}
            >
              <XCircle className="h-3 w-3" />
              {missingNodesCount} missing
            </span>
          )}
        </div>
      )}
    </div>
  );
});

// "Controls" header: count, reset-all, invalid summary

export const PanelSummaryHeader = React.memo(function PanelSummaryHeader({
  controlCount,
  overrideCount,
  totalInvalid,
  invalidOverrideCount,
  onResetAll,
  onResetInvalid,
}: {
  controlCount: number;
  overrideCount: number;
  totalInvalid: number;
  invalidOverrideCount: number;
  onResetAll: () => void;
  onResetInvalid: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <SlidersHorizontal className="h-4 w-4 text-light-400 dark:text-dark-500" />
      <span className="text-[11px] font-medium text-light-400 dark:text-dark-500">
        Controls
      </span>
      <span className="ml-auto rounded-full border border-light-200 bg-light-50 px-1.5 py-0.5 text-[10px] text-light-500 dark:border-dark-700 dark:bg-dark-900 dark:text-dark-400">
        {controlCount}
      </span>
      {overrideCount > 0 && (
        <button
          onClick={onResetAll}
          className="flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-300 transition-colors hover:bg-amber-500/20"
          title={`Reset ${overrideCount} override${overrideCount !== 1 ? "s" : ""}`}
        >
          <RotateCcw className="h-3 w-3" />
          Reset {overrideCount}
        </button>
      )}
      {totalInvalid > 0 && (
        <button
          type="button"
          onClick={invalidOverrideCount > 0 ? onResetInvalid : undefined}
          disabled={invalidOverrideCount === 0}
          className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] transition-colors ${
            invalidOverrideCount > 0
              ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300 hover:bg-amber-500/20 cursor-pointer"
              : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300 cursor-default disabled:opacity-100"
          }`}
          title={
            invalidOverrideCount > 0
              ? `${totalInvalid} control${totalInvalid !== 1 ? "s" : ""} not found in local inventory — click to reset ${invalidOverrideCount} overridden invalid`
              : `${totalInvalid} control${totalInvalid !== 1 ? "s" : ""} not found in local inventory`
          }
        >
          <AlertTriangle className="h-3 w-3" />
          {totalInvalid} invalid
          {invalidOverrideCount > 0 && (
            <RotateCcw className="h-2.5 w-2.5 ml-0.5" />
          )}
        </button>
      )}
    </div>
  );
});

// Toolbar: undo/redo + batch + compare. Subscribes to its own history
// counts so the panel does not need to.

const TOOL_BUTTON =
  "flex items-center gap-0.5 rounded border border-light-200 bg-light-50 px-1.5 py-0.5 text-[10px] text-light-500 dark:border-dark-700 dark:bg-dark-900 dark:text-dark-400 transition-colors hover:border-splash/40 disabled:opacity-30 disabled:cursor-not-allowed";

export const PanelToolbar = React.memo(function PanelToolbar({
  selectionKey,
  batchModeActive,
  batchCount,
  showComparison,
  onToggleBatchMode,
  onToggleComparison,
}: {
  selectionKey: string;
  batchModeActive: boolean;
  batchCount: number;
  showComparison: boolean;
  onToggleBatchMode: () => void;
  onToggleComparison: () => void;
}) {
  const undo = useWorkflowControlStore((s) => s.undo);
  const redo = useWorkflowControlStore((s) => s.redo);
  const undoCount = useWorkflowControlStore(
    (s) => s.undoStack[selectionKey]?.length ?? 0,
  );
  const redoCount = useWorkflowControlStore(
    (s) => s.redoStack[selectionKey]?.length ?? 0,
  );

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <button
        type="button"
        onClick={() => undo(selectionKey)}
        disabled={undoCount === 0}
        className={TOOL_BUTTON}
        title={`Undo (Ctrl+Z) — ${undoCount} change${undoCount !== 1 ? "s" : ""} in history`}
      >
        <Undo2 className="h-3 w-3" />
        {undoCount > 0 && <span className="tabular-nums">{undoCount}</span>}
      </button>

      <button
        type="button"
        onClick={() => redo(selectionKey)}
        disabled={redoCount === 0}
        className={TOOL_BUTTON}
        title={`Redo (Ctrl+Y) — ${redoCount} change${redoCount !== 1 ? "s" : ""} available`}
      >
        <Redo2 className="h-3 w-3" />
        {redoCount > 0 && <span className="tabular-nums">{redoCount}</span>}
      </button>

      <span className="w-px h-3 bg-light-200 dark:bg-dark-700" />

      <button
        type="button"
        onClick={onToggleBatchMode}
        className={`flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
          batchModeActive
            ? "border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-300"
            : "border-light-200 bg-light-50 text-light-500 dark:border-dark-700 dark:bg-dark-900 dark:text-dark-400 hover:border-splash/40"
        }`}
        title="Toggle batch mode — specify multiple values per control to generate multiple jobs"
      >
        <Layers className="h-3 w-3" />
        Batch
        {batchCount > 0 && (
          <span className="rounded-full bg-purple-500/20 px-1 text-[9px] tabular-nums">
            {batchCount}
          </span>
        )}
      </button>

      <button
        type="button"
        onClick={onToggleComparison}
        className={`flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
          showComparison
            ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300"
            : "border-light-200 bg-light-50 text-light-500 dark:border-dark-700 dark:bg-dark-900 dark:text-dark-400 hover:border-splash/40"
        }`}
        title="Compare current overrides against workflow defaults"
      >
        <GitCompareArrows className="h-3 w-3" />
        Compare
      </button>
    </div>
  );
});

// Batch mode input. Stays mounted while hidden so the picked control and
// draft value survive toggling batch mode off and on.

const BATCHABLE_KINDS = new Set(["number", "seed", "string", "enum"]);

export const BatchModeSection = React.memo(function BatchModeSection({
  active,
  controls,
  batchOverrides,
  onAddValue,
  onRemoveValue,
}: {
  active: boolean;
  controls: readonly ControlMeta[];
  batchOverrides: BatchOverride[];
  onAddValue: (key: string, value: unknown) => void;
  onRemoveValue: (key: string, index: number) => void;
}) {
  const [batchInputKey, setBatchInputKey] = useState<string | null>(null);
  const [batchInputValue, setBatchInputValue] = useState("");

  if (!active) return null;

  const addCurrent = () => {
    if (!batchInputKey || !batchInputValue) return;
    const ctrl = controls.find((c) => c.key === batchInputKey);
    const val =
      ctrl?.kind === "number" || ctrl?.kind === "seed"
        ? Number(batchInputValue)
        : batchInputValue;
    onAddValue(batchInputKey, val);
    setBatchInputValue("");
  };

  return (
    <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 px-2.5 py-1.5">
      <div className="flex items-center gap-1 mb-1">
        <Layers className="h-3 w-3 text-purple-500" />
        <span className="text-[10px] font-semibold text-purple-600 dark:text-purple-400">
          Batch Mode
        </span>
        <span className="text-[9px] text-purple-400 dark:text-purple-500 ml-1">
          Click a control label, then add values below
        </span>
      </div>
      <div className="flex items-center gap-1">
        <select
          aria-label="Batch control"
          value={batchInputKey ?? ""}
          onChange={(e) => setBatchInputKey(e.target.value || null)}
          className="flex-1 rounded border border-purple-500/20 bg-transparent px-1.5 py-1 text-[10px] text-light-primary dark:text-dark-primary outline-none"
        >
          <option value="">Select control...</option>
          {controls
            .filter((c) => BATCHABLE_KINDS.has(c.kind))
            .map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
        </select>
        <input
          aria-label="Batch value"
          type="text"
          value={batchInputValue}
          onChange={(e) => setBatchInputValue(e.target.value)}
          placeholder="Value..."
          className="w-24 rounded border border-purple-500/20 bg-transparent px-1.5 py-1 text-[10px] text-light-primary dark:text-dark-primary outline-none"
          onKeyDown={(e) => {
            if (e.key === "Enter") addCurrent();
          }}
        />
        <button
          type="button"
          disabled={!batchInputKey || !batchInputValue}
          onClick={addCurrent}
          className="rounded border border-purple-500/30 bg-purple-500/10 px-1.5 py-1 text-[10px] text-purple-600 dark:text-purple-300 hover:bg-purple-500/20 transition-colors disabled:opacity-30"
        >
          Add
        </button>
      </div>
      {batchOverrides.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {batchOverrides.map((b) => {
            const ctrl = controls.find((c) => c.key === b.key);
            return (
              <div key={b.key} className="flex items-start gap-1">
                <span className="text-[10px] text-purple-500 font-medium shrink-0 pt-0.5">
                  {ctrl?.label ?? b.key}:
                </span>
                <BatchChips
                  values={b.values}
                  controlKey={b.key}
                  onRemove={(index) => onRemoveValue(b.key, index)}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

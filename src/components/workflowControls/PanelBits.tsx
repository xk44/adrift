"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  X,
  Info,
  GitCompareArrows,
  Lightbulb,
} from "lucide-react";
import type { ControlSchema } from "@/lib/oj/workflowControlSchema";
import type { ComparisonEntry } from "@/store/workflowControlStore";

// Node documentation tooltip — shows class_type, input name, data type, bounds

export function ControlDocTooltip({
  control,
}: {
  control: ControlSchema & { effectiveValue: unknown; isOverridden: boolean };
}) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen]);

  return (
    <div className="relative inline-flex" ref={ref}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="text-light-300 dark:text-dark-600 hover:text-light-500 dark:hover:text-dark-400 transition-colors"
        title="Show control details"
      >
        <Info className="h-3 w-3" />
      </button>
      {isOpen && (
        <div className="absolute z-50 left-0 top-5 w-56 rounded-lg border border-light-200 bg-light-50 dark:border-dark-700 dark:bg-dark-850 shadow-lg p-2 space-y-1">
          <div className="text-[10px] text-light-500 dark:text-dark-400">
            <span className="font-semibold text-light-600 dark:text-dark-300">
              Node:
            </span>{" "}
            <span className="font-mono">{control.classType}</span>
          </div>
          <div className="text-[10px] text-light-500 dark:text-dark-400">
            <span className="font-semibold text-light-600 dark:text-dark-300">
              Input:
            </span>{" "}
            <span className="font-mono">{control.inputKey}</span>
          </div>
          <div className="text-[10px] text-light-500 dark:text-dark-400">
            <span className="font-semibold text-light-600 dark:text-dark-300">
              Type:
            </span>{" "}
            <span className="font-mono">{control.kind}</span>
            {control.modelCategory && (
              <span className="ml-1 text-purple-400">
                ({control.modelCategory})
              </span>
            )}
          </div>
          <div className="text-[10px] text-light-500 dark:text-dark-400">
            <span className="font-semibold text-light-600 dark:text-dark-300">
              Key:
            </span>{" "}
            <span className="font-mono text-[9px]">{control.key}</span>
          </div>
          {(control.min !== undefined || control.max !== undefined) && (
            <div className="text-[10px] text-light-500 dark:text-dark-400">
              <span className="font-semibold text-light-600 dark:text-dark-300">
                Range:
              </span>{" "}
              {control.min ?? "?"} .. {control.max ?? "?"}
              {control.step !== undefined && (
                <span className="ml-1 text-light-400 dark:text-dark-500">
                  (step {control.step})
                </span>
              )}
            </div>
          )}
          {control.defaultValue !== null &&
            control.defaultValue !== undefined && (
              <div className="text-[10px] text-light-500 dark:text-dark-400">
                <span className="font-semibold text-light-600 dark:text-dark-300">
                  Default:
                </span>{" "}
                <span className="font-mono truncate inline-block max-w-[140px] align-bottom">
                  {String(control.defaultValue)}
                </span>
              </div>
            )}
          {control.options && control.options.length > 0 && (
            <div className="text-[10px] text-light-500 dark:text-dark-400">
              <span className="font-semibold text-light-600 dark:text-dark-300">
                Options:
              </span>{" "}
              {control.options.length} choices
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Dependency badge — subtle "(may need update)" indicator

export function DependencyBadge({ onDismiss }: { onDismiss: () => void }) {
  return (
    <button
      type="button"
      onClick={onDismiss}
      className="inline-flex items-center gap-0.5 rounded border border-amber-500/20 bg-amber-500/5 px-1 py-0 text-[9px] text-amber-500 dark:text-amber-300 hover:bg-amber-500/15 transition-colors"
      title="This control may need updating after a related model change. Click to dismiss."
    >
      <AlertTriangle className="h-2.5 w-2.5" />
      may need update
    </button>
  );
}

// Batch value chips — show comma-separated batch values with remove buttons

export function BatchChips({
  values,
  controlKey,
  onRemove,
}: {
  values: unknown[];
  controlKey: string;
  onRemove: (index: number) => void;
}) {
  if (values.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {values.map((v, i) => (
        <span
          key={`${controlKey}-batch-${i}`}
          className="inline-flex items-center gap-0.5 rounded-full border border-purple-500/20 bg-purple-500/10 px-1.5 py-0 text-[10px] text-purple-600 dark:text-purple-300"
        >
          {String(v).length > 20 ? String(v).slice(0, 17) + "..." : String(v)}
          <button
            type="button"
            onClick={() => onRemove(i)}
            className="hover:text-purple-800 dark:hover:text-purple-100 transition-colors"
            title="Remove this batch value"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}
      <span className="text-[9px] text-purple-400 dark:text-purple-500 self-center">
        = {values.length} jobs
      </span>
    </div>
  );
}

// Comparison view — two-column diff between defaults and current overrides

export function ComparisonView({
  entries,
  onClose,
}: {
  entries: ComparisonEntry[];
  onClose: () => void;
}) {
  const changedEntries = entries.filter((e) => e.isChanged);
  const unchangedEntries = entries.filter((e) => !e.isChanged);

  const formatValue = (v: unknown): string => {
    if (v === null || v === undefined) return "(none)";
    const s = String(v);
    if (s.length > 40) return s.slice(0, 37) + "...";
    return s;
  };

  return (
    <div className="rounded-lg border border-light-200 dark:border-dark-700 bg-light-50/50 dark:bg-dark-850/50 overflow-hidden">
      <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-light-200 dark:border-dark-700">
        <span className="text-[11px] font-semibold text-light-600 dark:text-dark-300 flex items-center gap-1">
          <GitCompareArrows className="h-3.5 w-3.5" />
          Override Comparison
        </span>
        <button
          aria-label="Close comparison"
          onClick={onClose}
          className="text-light-400 hover:text-light-600 dark:text-dark-500 dark:hover:text-dark-300 transition-colors"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {changedEntries.length === 0 ? (
        <div className="px-2.5 py-3 text-center text-[11px] text-light-400 dark:text-dark-500 italic">
          No overrides active -- all values match workflow defaults
        </div>
      ) : (
        <div className="divide-y divide-light-100 dark:divide-dark-750">
          {changedEntries.map((entry) => (
            <div
              key={entry.key}
              className="px-2.5 py-1.5 bg-amber-500/5 dark:bg-amber-500/5"
            >
              <div className="flex items-center gap-1 mb-0.5">
                <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">
                  {entry.label}
                </span>
                <span className="text-[9px] text-light-400 dark:text-dark-500 font-mono">
                  {entry.group}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className="text-[9px] text-light-400 dark:text-dark-500">
                    Default
                  </span>
                  <div className="text-[10px] text-light-500 dark:text-dark-400 font-mono truncate line-through opacity-60">
                    {formatValue(entry.defaultValue)}
                  </div>
                </div>
                <div>
                  <span className="text-[9px] text-amber-500">
                    Current
                  </span>
                  <div className="text-[10px] text-amber-600 dark:text-amber-300 font-mono truncate font-medium">
                    {formatValue(entry.currentValue)}
                  </div>
                </div>
              </div>
            </div>
          ))}
          {/* Unchanged entries — dimmed */}
          {unchangedEntries.length > 0 && (
            <details className="group">
              <summary className="px-2.5 py-1 text-[10px] text-light-400 dark:text-dark-500 cursor-pointer hover:text-light-500 dark:hover:text-dark-400 transition-colors">
                {unchangedEntries.length} unchanged control
                {unchangedEntries.length !== 1 ? "s" : ""}
              </summary>
              {unchangedEntries.map((entry) => (
                <div key={entry.key} className="px-2.5 py-1 opacity-40">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-light-500 dark:text-dark-400">
                      {entry.label}
                    </span>
                    <span className="text-[10px] text-light-400 dark:text-dark-500 font-mono truncate max-w-[120px]">
                      {formatValue(entry.currentValue)}
                    </span>
                  </div>
                </div>
              ))}
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// Smart defaults indicator — shows recommendations for workflow type

export function SmartDefaultsBar({
  recommendations,
  onApply,
  onDismiss,
}: {
  recommendations: Array<{
    inputKey: string;
    controlKey: string;
    recommendedValue?: unknown;
    hint: string;
  }>;
  onApply: (controlKey: string, value: unknown) => void;
  onDismiss: () => void;
}) {
  if (recommendations.length === 0) return null;

  return (
    <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 dark:border-emerald-500/20 dark:bg-emerald-500/5 px-2.5 py-1.5">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
          <Lightbulb className="h-3 w-3" />
          Smart Defaults
        </span>
        <button
          onClick={onDismiss}
          className="text-emerald-500/50 hover:text-emerald-500 transition-colors"
          title="Dismiss suggestions"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="space-y-1">
        {recommendations.map((rec) => (
          <div
            key={rec.controlKey}
            className="flex items-center gap-1.5 text-[10px]"
          >
            <span className="text-emerald-600 dark:text-emerald-400 font-medium shrink-0">
              {rec.inputKey}
            </span>
            {rec.recommendedValue !== undefined && (
              <>
                <span className="text-emerald-500/60">-&gt;</span>
                <button
                  type="button"
                  onClick={() => onApply(rec.controlKey, rec.recommendedValue)}
                  className="font-mono text-emerald-600 dark:text-emerald-300 hover:underline cursor-pointer"
                  title={`Apply recommended value: ${rec.recommendedValue}`}
                >
                  {String(rec.recommendedValue)}
                </button>
              </>
            )}
            <span className="text-emerald-500/50 dark:text-emerald-500/40 truncate">
              {rec.hint}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

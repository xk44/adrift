"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  RotateCcw,
  Boxes,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import type { ControlSchema } from "@/lib/oj/workflowControlSchema";
import {
  readRecentModels,
  pushRecentModel,
  detectBaseModel,
  BASE_MODEL_BADGE,
  groupModelsByBase,
  KIND_DOT_COLORS,
} from "@/components/workflowControls/panelHelpers";

// Model selector component — dropdown with search, validation indicator

interface ModelSelectorProps {
  control: ControlSchema & { effectiveValue: unknown; isOverridden: boolean };
  options: string[];
  isValid: boolean;
  hasInventory: boolean;
  currentValue: string;
  isOverridden: boolean;
  onSetOverride: (key: string, value: unknown) => void;
  onResetOverride: (key: string) => void;
  categoryLabel?: string;
}

export function ModelSelector({
  control,
  options,
  isValid,
  hasInventory,
  currentValue,
  isOverridden,
  onSetOverride,
  onResetOverride,
  categoryLabel,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(-1);

  // Grouped models — only when no search active and category is checkpoint
  const isCheckpointCategory =
    control.modelCategory === "checkpoint" || control.modelCategory === "unet";

  const groupedModels = useMemo(
    () => (isCheckpointCategory ? groupModelsByBase(options) : null),
    [isCheckpointCategory, options],
  );

  // For keyboard nav: flat list in current display order
  const flatOptions = useMemo(() => {
    if (!search && groupedModels) {
      return groupedModels.flatMap((g) => g.models);
    }
    if (!search) return options;
    const lq = search.toLowerCase();
    return options.filter((o) => o.toLowerCase().includes(lq));
  }, [options, search, groupedModels]);

  const displayValue = useMemo(() => {
    const val = String(currentValue);
    if (!val) return `Select ${control.label}…`;
    // Truncate long filenames — strip directory prefix for display
    const basename = val.includes("/") ? val.split("/").pop()! : val;
    if (basename.length > 28) return basename.slice(0, 25) + "…";
    return basename;
  }, [currentValue, control.label]);

  const selectedBase = useMemo(
    () => (currentValue ? detectBaseModel(currentValue) : null),
    [currentValue],
  );

  // Recently used models — read on open, update on select
  const [recentModels, setRecentModels] = useState<string[]>([]);
  useEffect(() => {
    if (isOpen) setRecentModels(readRecentModels());
  }, [isOpen]);

  // Recent models that exist in current options (and aren't the current value)
  const validRecent = useMemo(
    () => recentModels.filter((m) => options.includes(m) && m !== currentValue),
    [recentModels, options, currentValue],
  );

  const [collapsedModelGroups, setCollapsedModelGroups] = useState<Set<string>>(
    () => new Set(),
  );

  const toggleModelGroup = useCallback((type: string) => {
    setCollapsedModelGroups((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const handleSelect = useCallback(
    (value: string) => {
      onSetOverride(control.key, value);
      pushRecentModel(value);
      setIsOpen(false);
      setSearch("");
      setHighlightIndex(-1);
    },
    [control.key, onSetOverride],
  );

  const handleReset = useCallback(
    () => onResetOverride(control.key),
    [control.key, onResetOverride],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIndex((i) => Math.min(i + 1, flatOptions.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIndex((i) => Math.max(i - 1, 0));
      } else if (
        e.key === "Enter" &&
        highlightIndex >= 0 &&
        highlightIndex < flatOptions.length
      ) {
        e.preventDefault();
        handleSelect(flatOptions[highlightIndex]);
      } else if (e.key === "Escape") {
        setIsOpen(false);
        setSearch("");
        setHighlightIndex(-1);
      }
    },
    [isOpen, flatOptions, highlightIndex, handleSelect],
  );

  const validationIcon = !hasInventory ? null : isValid ? null : (
    <span title="Model not found in local inventory">
      <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
    </span>
  );

  const dotColor =
    KIND_DOT_COLORS[control.kind] ?? "bg-light-400 dark:bg-dark-500";

  return (
    <div
      className={`flex items-start gap-2 py-1.5 group/model ${isOverridden ? "border-l-2 border-splash/40 pl-1.5 -ml-2" : ""}`}
    >
      {/* Override indicator dot + label */}
      <div className="w-28 shrink-0 flex items-center gap-1.5 pt-1">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotColor}`} />
        <span className="text-[11px] font-medium text-light-600 dark:text-dark-300 truncate flex items-center gap-1">
          <Boxes className="h-3 w-3 shrink-0" />
          {control.label}
        </span>
        {isOverridden && (
          <button
            onClick={handleReset}
            className="transition-opacity text-splash/60 hover:text-splash"
            title={`Reset to default: ${String(control.defaultValue ?? "")}`}
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        )}
      </div>

      <div className="flex-1 min-w-0 relative" onKeyDown={handleKeyDown}>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              setIsOpen(!isOpen);
              setHighlightIndex(-1);
            }}
            className={`flex-1 min-w-0 flex items-center justify-between rounded-lg border bg-light-input px-2 py-1.5 text-xs text-light-primary dark:bg-dark-input dark:text-dark-primary outline-none transition-colors text-left ${
              isOverridden
                ? "border-splash/40 ring-1 ring-splash/20"
                : "border-light-200 dark:border-dark-700 focus:border-splash/60"
            } ${!isValid && hasInventory ? "!border-amber-500/50 !ring-1 !ring-amber-500/20" : ""}`}
          >
            <span
              className={`truncate ${!currentValue ? "text-light-400 dark:text-dark-500" : ""}`}
            >
              {displayValue}
            </span>
            <span className="flex items-center gap-1 shrink-0">
              {/* Base model badge for selected value */}
              {selectedBase && selectedBase !== "Other" && currentValue && (
                <span
                  className={`text-[9px] rounded border px-1 py-0 tabular-nums ${BASE_MODEL_BADGE[selectedBase]}`}
                >
                  {selectedBase}
                </span>
              )}
              {categoryLabel && !selectedBase && (
                <span className="text-[9px] text-light-500 dark:text-dark-400 tabular-nums">
                  {categoryLabel}
                </span>
              )}
              {hasInventory && options.length > 0 && (
                <span className="text-[9px] text-light-400 dark:text-dark-500 tabular-nums">
                  {options.length}
                </span>
              )}
              <ChevronDown className="h-3 w-3 shrink-0 text-light-400 dark:text-dark-500" />
            </span>
          </button>
          {validationIcon}
        </div>

        {/* Default ghost text when overridden */}
        {isOverridden && control.defaultValue != null && (
          <p className="mt-0.5 text-[10px] text-dark-500/60 truncate">
            default:{" "}
            {(() => {
              const dv = String(control.defaultValue);
              const base = dv.includes("/") ? dv.split("/").pop()! : dv;
              return base.length > 30 ? base.slice(0, 27) + "…" : base;
            })()}
          </p>
        )}

        {isOpen && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => {
                setIsOpen(false);
                setSearch("");
                setHighlightIndex(-1);
              }}
            />
            <div className="absolute z-50 mt-1 left-0 right-0 max-h-56 overflow-auto rounded-lg border border-light-200 bg-light-input dark:border-dark-700 dark:bg-dark-input shadow-lg">
              <div className="p-1.5 border-b border-light-100 dark:border-dark-700">
                <input
                  aria-label="Search models"
                  type="text"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setHighlightIndex(-1);
                  }}
                  placeholder="Search…"
                  className="w-full rounded border-0 bg-transparent px-1.5 py-1 text-[11px] text-light-primary dark:text-dark-primary outline-none placeholder:text-light-400 dark:placeholder:text-dark-500"
                  autoFocus
                />
              </div>
              {/* Options list — recently used, then grouped when no search */}
              <div className="py-0.5">
                {flatOptions.length === 0 && hasInventory && (
                  <div className="px-2 py-1.5 text-[11px] text-light-400 dark:text-dark-500 italic">
                    {search ? `No match for "${search}"` : "No models found"}
                  </div>
                )}
                {!hasInventory && (
                  <div className="px-2 py-1.5 text-[11px] text-light-400 dark:text-dark-500 italic">
                    Loading model inventory…
                  </div>
                )}
                {/* Recently used section — only when no search active */}
                {hasInventory && !search && validRecent.length > 0 && (
                  <div className="border-b border-light-100 dark:border-dark-700 pb-0.5 mb-0.5">
                    <div className="px-2 pt-1 pb-0.5 flex items-center gap-1">
                      <span className="text-[9px] font-medium text-light-400 dark:text-dark-500">
                        Recent
                      </span>
                    </div>
                    {validRecent.map((opt) => {
                      const basename = opt.includes("/")
                        ? opt.split("/").pop()!
                        : opt;
                      const base = detectBaseModel(opt);
                      return (
                        <button
                          key={`recent-${opt}`}
                          onClick={() => handleSelect(opt)}
                          className="w-full px-3 py-1 text-left text-[11px] hover:bg-splash/10 transition-colors flex items-center gap-1.5 text-light-primary dark:text-dark-primary"
                          title={opt}
                        >
                          <span className="truncate flex-1">{basename}</span>
                          {base !== "Other" && (
                            <span
                              className={`text-[8px] rounded border px-1 py-0 shrink-0 ${BASE_MODEL_BADGE[base]}`}
                            >
                              {base}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
                {hasInventory && !search && groupedModels
                  ? groupedModels.map((grp) => {
                      const isGrpCollapsed = collapsedModelGroups.has(grp.type);
                      return (
                        <div key={grp.type}>
                          <button
                            type="button"
                            onClick={() => toggleModelGroup(grp.type)}
                            className="w-full px-2 pt-1.5 pb-0.5 flex items-center gap-1.5 hover:bg-light-50/50 dark:hover:bg-dark-800/50 transition-colors"
                          >
                            {isGrpCollapsed ? (
                              <ChevronRight className="h-2.5 w-2.5 text-dark-500" />
                            ) : (
                              <ChevronDown className="h-2.5 w-2.5 text-dark-500" />
                            )}
                            <span
                              className={`text-[9px] rounded border px-1 py-0 ${BASE_MODEL_BADGE[grp.type]}`}
                            >
                              {grp.type}
                            </span>
                            <span className="text-[9px] text-dark-500">
                              {grp.models.length}
                            </span>
                          </button>
                          {!isGrpCollapsed &&
                            grp.models.map((opt) => {
                              const flatIdx = flatOptions.indexOf(opt);
                              const basename = opt.includes("/")
                                ? opt.split("/").pop()!
                                : opt;
                              return (
                                <button
                                  key={opt}
                                  onClick={() => handleSelect(opt)}
                                  className={`w-full px-3 py-1 text-left text-[11px] hover:bg-splash/10 transition-colors ${
                                    flatIdx === highlightIndex
                                      ? "bg-splash/5"
                                      : ""
                                  } ${
                                    opt === currentValue
                                      ? "bg-splash/5 text-splash font-medium"
                                      : "text-light-primary dark:text-dark-primary"
                                  }`}
                                  title={opt}
                                >
                                  <span className="truncate block">
                                    {basename}
                                  </span>
                                </button>
                              );
                            })}
                        </div>
                      );
                    })
                  : hasInventory &&
                    flatOptions.map((opt, idx) => {
                      const basename = opt.includes("/")
                        ? opt.split("/").pop()!
                        : opt;
                      const base = detectBaseModel(opt);
                      return (
                        <button
                          key={opt}
                          onClick={() => handleSelect(opt)}
                          className={`w-full px-2 py-1 text-left text-[11px] hover:bg-splash/10 transition-colors flex items-center gap-1.5 ${
                            idx === highlightIndex ? "bg-splash/5" : ""
                          } ${
                            opt === currentValue
                              ? "bg-splash/5 text-splash font-medium"
                              : "text-light-primary dark:text-dark-primary"
                          }`}
                          title={opt}
                        >
                          <span className="truncate flex-1">{basename}</span>
                          {base !== "Other" && (
                            <span
                              className={`text-[8px] rounded border px-1 py-0 shrink-0 ${BASE_MODEL_BADGE[base]}`}
                            >
                              {base}
                            </span>
                          )}
                        </button>
                      );
                    })}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Image control — filename input with upload hint


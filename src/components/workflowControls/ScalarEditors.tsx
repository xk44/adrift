"use client";

import React, { useCallback, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { type ControlSchema, enrichEnumOptions, type LocalInventory } from "@/lib/oj/workflowControlSchema";
import { snapToCommon } from "@/components/workflowControls/panelHelpers";

// Enum editor — searchable dropdown for large option sets, validation

/** Threshold for showing search in enum dropdowns */
const ENUM_SEARCH_THRESHOLD = 8;

interface EnumEditorProps {
  control: ControlSchema & { effectiveValue: unknown; isOverridden: boolean };
  effectiveValue: string;
  isOverridden: boolean;
  defaultStr: string | null;
  modelInventory: LocalInventory;
  onSetOverride: (key: string, value: unknown) => void;
}

export function EnumEditor({
  control,
  effectiveValue,
  isOverridden,
  defaultStr,
  modelInventory,
  onSetOverride,
}: EnumEditorProps) {
  const enrichedOptions = useMemo(
    () => enrichEnumOptions(control, modelInventory),
    [control, modelInventory],
  );

  // Detect unknown value — effective value not in enriched options
  const isUnknownValue =
    effectiveValue !== "" &&
    effectiveValue !== null &&
    effectiveValue !== undefined &&
    enrichedOptions.length > 0 &&
    !enrichedOptions.includes(effectiveValue);

  const useSearchableDropdown = enrichedOptions.length >= ENUM_SEARCH_THRESHOLD;

  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(-1);

  const filteredOptions = useMemo(() => {
    if (!search) return enrichedOptions;
    const lq = search.toLowerCase();
    return enrichedOptions.filter((o) => o.toLowerCase().includes(lq));
  }, [enrichedOptions, search]);

  const handleSelect = useCallback(
    (value: string) => {
      onSetOverride(control.key, value);
      setIsOpen(false);
      setSearch("");
      setHighlightIndex(-1);
    },
    [control.key, onSetOverride],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIndex((i) => Math.min(i + 1, filteredOptions.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIndex((i) => Math.max(i - 1, 0));
      } else if (
        e.key === "Enter" &&
        highlightIndex >= 0 &&
        highlightIndex < filteredOptions.length
      ) {
        e.preventDefault();
        handleSelect(filteredOptions[highlightIndex]);
      } else if (e.key === "Escape") {
        setIsOpen(false);
        setSearch("");
        setHighlightIndex(-1);
      }
    },
    [isOpen, filteredOptions, highlightIndex, handleSelect],
  );

  // Plain <select> for small enum sets without unknown values
  if (!useSearchableDropdown && !isUnknownValue) {
    return (
      <div>
        <select
          aria-label={control.label}
          value={effectiveValue}
          onChange={(e) => onSetOverride(control.key, e.target.value)}
          className={`w-full rounded-lg border bg-light-input px-2 py-1.5 text-xs text-light-primary dark:bg-dark-input dark:text-dark-primary outline-none transition-colors ${
            isOverridden
              ? "border-splash/40 ring-1 ring-splash/20"
              : "border-light-200 dark:border-dark-700 focus:border-splash/60"
          }`}
        >
          {enrichedOptions.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        {isOverridden && defaultStr && (
          <p className="mt-0.5 text-[10px] text-dark-500/60">
            default: {defaultStr}
          </p>
        )}
      </div>
    );
  }

  // Searchable dropdown for large option sets or unknown values
  return (
    <div className="relative" onKeyDown={handleKeyDown}>
      <div className="flex items-center gap-1">
        <button
          onClick={() => {
            setIsOpen(!isOpen);
            setHighlightIndex(-1);
          }}
          className={`flex-1 min-w-0 flex items-center justify-between rounded-lg border bg-light-input px-2 py-1.5 text-xs text-light-primary dark:bg-dark-input dark:text-dark-primary outline-none transition-colors text-left ${
            isUnknownValue
              ? "border-amber-500/50 ring-1 ring-amber-500/20"
              : isOverridden
                ? "border-splash/40 ring-1 ring-splash/20"
                : "border-light-200 dark:border-dark-700 focus:border-splash/60"
          }`}
        >
          <span className={isUnknownValue ? "text-amber-500" : ""}>
            {effectiveValue || `Select ${control.label}…`}
          </span>
          <span className="flex items-center gap-1 shrink-0">
            <span className="text-[9px] text-light-400 dark:text-dark-500 tabular-nums">
              {enrichedOptions.length}
            </span>
            <ChevronDown className="h-3 w-3 shrink-0 text-light-400 dark:text-dark-500" />
          </span>
        </button>
        {isUnknownValue && (
          <span title={`"${effectiveValue}" not in known options`}>
            <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
          </span>
        )}
      </div>

      {isUnknownValue && (
        <p className="mt-0.5 text-[10px] text-amber-500/80">
          Unknown value — may not be supported by this node
        </p>
      )}
      {!isUnknownValue && isOverridden && defaultStr && (
        <p className="mt-0.5 text-[10px] text-dark-500/60">
          default: {defaultStr}
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
          <div className="absolute z-50 mt-1 left-0 right-0 max-h-48 overflow-auto rounded-lg border border-light-200 bg-light-input dark:border-dark-700 dark:bg-dark-input shadow-lg">
            {/* Search — only shown for large sets */}
            {useSearchableDropdown && (
              <div className="p-1.5 border-b border-light-100 dark:border-dark-700">
                <input
                  aria-label="Search options"
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
            )}
            <div className="py-0.5">
              {filteredOptions.length === 0 && (
                <div className="px-2 py-1.5 text-[11px] text-light-400 dark:text-dark-500 italic">
                  {search ? `No match for "${search}"` : "No options available"}
                </div>
              )}
              {filteredOptions.map((opt, idx) => (
                <button
                  key={opt}
                  onClick={() => handleSelect(opt)}
                  className={`w-full px-2 py-1 text-left text-[11px] hover:bg-splash/10 transition-colors truncate ${
                    idx === highlightIndex ? "bg-splash/5" : ""
                  } ${
                    opt === effectiveValue
                      ? "bg-splash/5 text-splash font-medium"
                      : "text-light-primary dark:text-dark-primary"
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Number editor using MJSlider for compact feel

interface NumberEditorProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  inputKey?: string;
  /** Accessible name for the slider */
  label?: string;
  isOverridden: boolean;
  defaultValue?: number;
  onChange: (v: number) => void;
  onReset?: () => void;
}

export function NumberEditor({
  value,
  min = 0,
  max = 100,
  step = 1,
  inputKey = "",
  label,
  isOverridden,
  defaultValue,
  onChange,
  onReset,
}: NumberEditorProps) {
  // While the slider is being dragged, track the value locally and commit to
  // the store on release — per-tick commits give the overrides map a new
  // identity on every setOverride and re-render the entire panel.
  const [dragValue, setDragValue] = useState<number | null>(null);
  const shownValue = dragValue ?? value;

  // Compute fill percentage for the slider track gradient
  const fillPct = Math.round(
    Math.max(0, Math.min(100, ((shownValue - min) / (max - min)) * 100)),
  );

  // Default-value tick position on the slider (shown when overridden)
  const defaultPct =
    defaultValue !== undefined
      ? Math.round(
          Math.max(
            0,
            Math.min(100, ((defaultValue - min) / (max - min)) * 100),
          ),
        )
      : null;

  // Out-of-range detection for typed numeric input
  const isOutOfRange = shownValue < min || shownValue > max;

  const handleSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = Number(e.target.value);
      setDragValue(snapToCommon(raw, inputKey));
    },
    [inputKey],
  );

  const commitDrag = useCallback(() => {
    if (dragValue !== null && dragValue !== value) onChange(dragValue);
    setDragValue(null);
  }, [dragValue, value, onChange]);

  // Clamp value to valid range on blur
  const handleBlur = useCallback(() => {
    if (isOutOfRange) {
      onChange(Math.max(min, Math.min(max, shownValue)));
    }
  }, [isOutOfRange, min, max, shownValue, onChange]);

  const handleNumberInputDblClick = useCallback(() => {
    if (onReset) onReset();
  }, [onReset]);

  return (
    <div>
      <div
        className={`flex items-center gap-2 rounded-lg border px-2 py-1 transition-colors ${
          isOutOfRange
            ? "border-amber-500/50 bg-amber-500/5 ring-1 ring-amber-500/20"
            : isOverridden
              ? "border-splash/40 bg-splash/5 ring-1 ring-splash/20"
              : "border-light-200 bg-light-input dark:border-dark-700 dark:bg-dark-input"
        }`}
      >
        {/* Slider with optional default-value tick overlay */}
        <div className="flex-1 min-w-0 relative">
          <input
            aria-label={label}
            type="range"
            min={min}
            max={max}
            step={step}
            value={Math.max(min, Math.min(max, shownValue))}
            onChange={handleSliderChange}
            onPointerUp={commitDrag}
            onKeyUp={commitDrag}
            onBlur={commitDrag}
            className="slider w-full h-4"
            style={{
              background: `linear-gradient(to right, rgb(var(--color-splash, 99 102 241)) ${fillPct}%, rgb(var(--color-dark-600, 75 85 99)) ${fillPct}%)`,
            }}
          />
          {isOverridden && defaultPct !== null && (
            <div
              className="pointer-events-none absolute top-1/2 -translate-y-1/2 w-0.5 h-2.5 rounded-full bg-splash/30"
              style={{ left: `${defaultPct}%` }}
              title={`Default: ${defaultValue}`}
            />
          )}
        </div>
        {/* Value display — double-click resets to default, clamps on blur */}
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={shownValue}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!isNaN(n)) onChange(n);
          }}
          onBlur={handleBlur}
          onDoubleClick={handleNumberInputDblClick}
          title={
            onReset && defaultValue !== undefined
              ? `Double-click to reset to default (${defaultValue})`
              : undefined
          }
          className={`w-14 shrink-0 rounded border-0 bg-transparent text-[11px] font-mono tabular-nums text-right outline-none cursor-default select-none ${
            isOutOfRange
              ? "text-amber-500 dark:text-amber-400"
              : "text-light-primary dark:text-dark-primary"
          }`}
        />
        {isOutOfRange && (
          <span
            title={`Value out of range (${min}–${max}), will clamp on blur`}
          >
            <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
          </span>
        )}
      </div>
      {isOutOfRange && (
        <p className="mt-0.5 text-[10px] text-amber-500/80">
          Range: {min}–{max} (will clamp on blur)
        </p>
      )}
      {/* Range hint — shown when not out of range and overridden */}
      {!isOutOfRange && isOverridden && defaultValue !== undefined && (
        <p className="mt-0.5 text-[10px] text-dark-500/60 tabular-nums">
          default: {defaultValue} · range: {min}–{max}
        </p>
      )}
      {/* Default ghost below slider when overridden but no range issue */}
      {!isOutOfRange && isOverridden && defaultValue === undefined && (
        <p className="mt-0.5 text-[10px] text-dark-500/60 tabular-nums">
          range: {min}–{max}
        </p>
      )}
    </div>
  );
}

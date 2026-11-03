"use client";

import React, { useCallback, useMemo, useState } from "react";
import {
  RotateCcw,
  ImageIcon,
  AlertTriangle,
  ChevronDown,
  FileIcon,
} from "lucide-react";
import {
  type ControlSchema,
  getFileOptionsForControl,
  getImageOptionsForControl,
  deriveControlSubtype,
  getSubtypeHint,
  SUBTYPE_EXTENSIONS,
  validateImageChoice,
  validateFileChoice,
  filterBySubtypeExtensions,
  type LocalInventory,
} from "@/lib/oj/workflowControlSchema";
import { KIND_DOT_COLORS } from "@/components/workflowControls/panelHelpers";

interface ImageControlProps {
  control: ControlSchema & { effectiveValue: unknown; isOverridden: boolean };
  onSetOverride: (key: string, value: unknown) => void;
  onResetOverride: (key: string) => void;
  localInventory: LocalInventory;
}

export function ImageControl({
  control,
  onSetOverride,
  onResetOverride,
  localInventory,
}: ImageControlProps) {
  const handleStringChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) =>
      onSetOverride(control.key, e.target.value),
    [control.key, onSetOverride],
  );

  const handleReset = useCallback(
    () => onResetOverride(control.key),
    [control.key, onResetOverride],
  );

  const dotColor =
    KIND_DOT_COLORS[control.kind] ?? "bg-light-400 dark:bg-dark-500";

  const subtype = useMemo(() => deriveControlSubtype(control), [control]);
  const hint = useMemo(() => getSubtypeHint(subtype), [subtype]);

  // Inventory-backed options + validation
  const imageOptions = useMemo(
    () => getImageOptionsForControl(control, localInventory),
    [control, localInventory],
  );
  const imageValidation = useMemo(
    () => validateImageChoice(control, localInventory),
    [control, localInventory],
  );
  const filteredOptions = useMemo(
    () => filterBySubtypeExtensions(imageOptions, subtype),
    [imageOptions, subtype],
  );
  const hasOptions = filteredOptions.length > 0;

  const displayValue = useMemo(() => {
    const val = String(control.effectiveValue ?? "");
    if (!val) return `Select ${control.label}…`;
    if (val.length > 28) return val.slice(0, 25) + "…";
    return val;
  }, [control.effectiveValue, control.label]);

  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(-1);

  const filteredSearchOptions = useMemo(() => {
    if (!search) return filteredOptions;
    const lq = search.toLowerCase();
    return filteredOptions.filter((o) => o.toLowerCase().includes(lq));
  }, [filteredOptions, search]);

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
        setHighlightIndex((i) =>
          Math.min(i + 1, filteredSearchOptions.length - 1),
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIndex((i) => Math.max(i - 1, 0));
      } else if (
        e.key === "Enter" &&
        highlightIndex >= 0 &&
        highlightIndex < filteredSearchOptions.length
      ) {
        e.preventDefault();
        handleSelect(filteredSearchOptions[highlightIndex]);
      } else if (e.key === "Escape") {
        setIsOpen(false);
        setSearch("");
        setHighlightIndex(-1);
      }
    },
    [isOpen, filteredSearchOptions, highlightIndex, handleSelect],
  );

  // Show dropdown picker when inventory has options, text fallback otherwise
  if (hasOptions) {
    return (
      <div
        className={`flex items-start gap-2 py-1.5 group/image ${control.isOverridden ? "border-l-2 border-splash/40 pl-1.5 -ml-2" : ""}`}
      >
        <div className="w-28 shrink-0 flex items-center gap-1.5 pt-1">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${dotColor}`}
          />
          <span className="text-[11px] font-medium text-light-600 dark:text-dark-300 truncate flex items-center gap-1">
            <ImageIcon className="h-3 w-3 shrink-0" />
            {control.label}
          </span>
          {control.isOverridden && (
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
                control.isOverridden
                  ? "border-splash/40 ring-1 ring-splash/20"
                  : "border-light-200 dark:border-dark-700 focus:border-splash/60"
              } ${!imageValidation.isValid && imageValidation.hasInventory ? "!border-amber-500/50 !ring-1 !ring-amber-500/20" : ""}`}
            >
              <span
                className={`truncate ${!control.effectiveValue ? "text-light-400 dark:text-dark-500" : ""}`}
              >
                {displayValue}
              </span>
              <span className="flex items-center gap-1 shrink-0">
                <span className="text-[9px] text-light-500 dark:text-dark-400 tabular-nums">
                  {imageValidation.categoryLabel}
                </span>
                {imageValidation.hasInventory && (
                  <span className="text-[9px] text-light-400 dark:text-dark-500 tabular-nums">
                    {filteredOptions.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3 shrink-0 text-light-400 dark:text-dark-500" />
              </span>
            </button>
            {!imageValidation.hasInventory ? null : imageValidation.isValid ? null : (
              <span title="File not found in local inventory">
                <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
              </span>
            )}
          </div>
          {/* Inline image thumbnail preview */}
          {typeof control.effectiveValue === "string" &&
            control.effectiveValue.length > 0 && (
              <div className="mt-1 h-12 w-12 rounded border border-light-200 dark:border-dark-700 overflow-hidden bg-light-50 dark:bg-dark-800 flex items-center justify-center">
                <img
                  src={`/api/comfy/image?filename=${encodeURIComponent(String(control.effectiveValue))}&subfolder=input&type=input`}
                  alt=""
                  className="h-full w-full object-cover"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              </div>
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
                <div className="py-0.5">
                  {filteredSearchOptions.length === 0 &&
                    imageValidation.hasInventory && (
                      <div className="px-2 py-1.5 text-[11px] text-light-400 dark:text-dark-500 italic">
                        {search
                          ? `No match for "${search}"`
                          : "No images found"}
                      </div>
                    )}
                  {imageValidation.hasInventory &&
                    filteredSearchOptions.map((opt, idx) => (
                      <button
                        key={opt}
                        onClick={() => handleSelect(opt)}
                        className={`w-full px-2 py-1 text-left text-[11px] hover:bg-splash/10 transition-colors truncate ${
                          idx === highlightIndex ? "bg-splash/5" : ""
                        } ${
                          opt === String(control.effectiveValue ?? "")
                            ? "bg-splash/5 text-splash font-medium"
                            : "text-light-primary dark:text-dark-primary"
                        }`}
                        title={opt}
                      >
                        {opt}
                      </button>
                    ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // Fallback: plain text input when no inventory
  return (
    <div
      className={`flex items-start gap-2 py-1.5 group/image ${control.isOverridden ? "border-l-2 border-splash/40 pl-1.5 -ml-2" : ""}`}
    >
      {/* Override indicator dot + label */}
      <div className="w-28 shrink-0 flex items-center gap-1.5 pt-1">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotColor}`} />
        <span className="text-[11px] font-medium text-light-600 dark:text-dark-300 truncate flex items-center gap-1">
          <ImageIcon className="h-3 w-3 shrink-0" />
          {control.label}
        </span>
        {control.isOverridden && (
          <button
            onClick={handleReset}
            className="transition-opacity text-splash/60 hover:text-splash"
            title={`Reset to default: ${String(control.defaultValue ?? "")}`}
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <input
          aria-label={control.label}
          type="text"
          value={String(control.effectiveValue ?? "")}
          onChange={handleStringChange}
          placeholder={`${subtype === "mask" ? "Mask" : subtype === "reference" ? "Reference" : "Image"} filename…`}
          className={`w-full rounded-lg border bg-light-input px-2.5 py-1.5 text-xs text-light-primary dark:bg-dark-input dark:text-dark-primary outline-none transition-colors ${
            control.isOverridden
              ? "border-splash/40 ring-1 ring-splash/20"
              : "border-light-200 dark:border-dark-700 focus:border-splash/60"
          }`}
        />
        <p className="mt-0.5 text-[10px] text-light-400 dark:text-dark-500">
          {hint}
        </p>
      </div>
    </div>
  );
}

// File control — file path input for video/audio/misc files

interface FileControlProps {
  control: ControlSchema & { effectiveValue: unknown; isOverridden: boolean };
  onSetOverride: (key: string, value: unknown) => void;
  onResetOverride: (key: string) => void;
  localInventory: LocalInventory;
}

export function FileControl({
  control,
  onSetOverride,
  onResetOverride,
  localInventory,
}: FileControlProps) {
  const handleStringChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) =>
      onSetOverride(control.key, e.target.value),
    [control.key, onSetOverride],
  );

  const handleReset = useCallback(
    () => onResetOverride(control.key),
    [control.key, onResetOverride],
  );

  const dotColor =
    KIND_DOT_COLORS[control.kind] ?? "bg-light-400 dark:bg-dark-500";

  // Derive subtype hint and file extensions from the control schema
  const subtype = useMemo(() => deriveControlSubtype(control), [control]);
  const hint = useMemo(() => getSubtypeHint(subtype), [subtype]);
  const extensions = useMemo(
    () => SUBTYPE_EXTENSIONS[subtype] ?? [],
    [subtype],
  );
  const acceptAttr = extensions.length > 0 ? extensions.join(",") : undefined;

  // Inventory-backed options + validation for file controls
  const fileOptions = useMemo(
    () => getFileOptionsForControl(control, localInventory),
    [control, localInventory],
  );
  const fileValidation = useMemo(
    () => validateFileChoice(control, localInventory),
    [control, localInventory],
  );
  const filteredOptions = useMemo(
    () => filterBySubtypeExtensions(fileOptions, subtype),
    [fileOptions, subtype],
  );
  const hasOptions = filteredOptions.length > 0;

  const displayValue = useMemo(() => {
    const val = String(control.effectiveValue ?? "");
    if (!val) return `Select ${control.label}…`;
    if (val.length > 28) return val.slice(0, 25) + "…";
    return val;
  }, [control.effectiveValue, control.label]);

  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(-1);

  const filteredSearchOptions = useMemo(() => {
    if (!search) return filteredOptions;
    const lq = search.toLowerCase();
    return filteredOptions.filter((o) => o.toLowerCase().includes(lq));
  }, [filteredOptions, search]);

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
        setHighlightIndex((i) =>
          Math.min(i + 1, filteredSearchOptions.length - 1),
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIndex((i) => Math.max(i - 1, 0));
      } else if (
        e.key === "Enter" &&
        highlightIndex >= 0 &&
        highlightIndex < filteredSearchOptions.length
      ) {
        e.preventDefault();
        handleSelect(filteredSearchOptions[highlightIndex]);
      } else if (e.key === "Escape") {
        setIsOpen(false);
        setSearch("");
        setHighlightIndex(-1);
      }
    },
    [isOpen, filteredSearchOptions, highlightIndex, handleSelect],
  );

  const typeLabel =
    subtype === "video" ? "Video" : subtype === "audio" ? "Audio" : "File";

  // Show dropdown picker when inventory has options, text fallback otherwise
  if (hasOptions) {
    return (
      <div
        className={`flex items-start gap-2 py-1.5 group/file ${control.isOverridden ? "border-l-2 border-splash/40 pl-1.5 -ml-2" : ""}`}
      >
        <div className="w-28 shrink-0 flex items-center gap-1.5 pt-1">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${dotColor}`}
          />
          <span className="text-[11px] font-medium text-light-600 dark:text-dark-300 truncate flex items-center gap-1">
            <FileIcon className="h-3 w-3 shrink-0" />
            {control.label}
          </span>
          {control.isOverridden && (
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
                control.isOverridden
                  ? "border-splash/40 ring-1 ring-splash/20"
                  : "border-light-200 dark:border-dark-700 focus:border-splash/60"
              } ${!fileValidation.isValid && fileValidation.hasInventory ? "!border-amber-500/50 !ring-1 !ring-amber-500/20" : ""}`}
            >
              <span
                className={`truncate ${!control.effectiveValue ? "text-light-400 dark:text-dark-500" : ""}`}
              >
                {displayValue}
              </span>
              <span className="flex items-center gap-1 shrink-0">
                <span className="text-[9px] text-light-500 dark:text-dark-400 tabular-nums">
                  {fileValidation.categoryLabel}
                </span>
                {fileValidation.hasInventory && (
                  <span className="text-[9px] text-light-400 dark:text-dark-500 tabular-nums">
                    {filteredOptions.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3 shrink-0 text-light-400 dark:text-dark-500" />
              </span>
            </button>
            {!fileValidation.hasInventory ? null : fileValidation.isValid ? null : (
              <span title="File not found in local inventory">
                <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
              </span>
            )}
          </div>
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
                <div className="py-0.5">
                  {filteredSearchOptions.length === 0 &&
                    fileValidation.hasInventory && (
                      <div className="px-2 py-1.5 text-[11px] text-light-400 dark:text-dark-500 italic">
                        {search
                          ? `No match for "${search}"`
                          : `No ${typeLabel.toLowerCase()} files found`}
                      </div>
                    )}
                  {fileValidation.hasInventory &&
                    filteredSearchOptions.map((opt, idx) => (
                      <button
                        key={opt}
                        onClick={() => handleSelect(opt)}
                        className={`w-full px-2 py-1 text-left text-[11px] hover:bg-splash/10 transition-colors truncate ${
                          idx === highlightIndex ? "bg-splash/5" : ""
                        } ${
                          opt === String(control.effectiveValue ?? "")
                            ? "bg-splash/5 text-splash font-medium"
                            : "text-light-primary dark:text-dark-primary"
                        }`}
                        title={opt}
                      >
                        {opt}
                      </button>
                    ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // Fallback: plain text input when no inventory
  return (
    <div
      className={`flex items-start gap-2 py-1.5 group/file ${control.isOverridden ? "border-l-2 border-splash/40 pl-1.5 -ml-2" : ""}`}
    >
      {/* Override indicator dot + label */}
      <div className="w-28 shrink-0 flex items-center gap-1.5 pt-1">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotColor}`} />
        <span className="text-[11px] font-medium text-light-600 dark:text-dark-300 truncate flex items-center gap-1">
          <FileIcon className="h-3 w-3 shrink-0" />
          {control.label}
        </span>
        {control.isOverridden && (
          <button
            onClick={handleReset}
            className="transition-opacity text-splash/60 hover:text-splash"
            title={`Reset to default: ${String(control.defaultValue ?? "")}`}
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <input
          aria-label={control.label}
          type="text"
          value={String(control.effectiveValue ?? "")}
          onChange={handleStringChange}
          placeholder={`${typeLabel} path…`}
          className={`w-full rounded-lg border bg-light-input px-2.5 py-1.5 text-xs text-light-primary dark:bg-dark-input dark:text-dark-primary outline-none transition-colors ${
            control.isOverridden
              ? "border-splash/40 ring-1 ring-splash/20"
              : "border-light-200 dark:border-dark-700 focus:border-splash/60"
          }`}
        />
        <p className="mt-0.5 text-[10px] text-light-400 dark:text-dark-500">
          {hint}
          {acceptAttr
            ? ` · ${extensions.slice(0, 3).join(" ")}${extensions.length > 3 ? " …" : ""}`
            : ""}
        </p>
      </div>
    </div>
  );
}

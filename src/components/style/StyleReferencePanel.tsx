"use client";

/**
 * UI component for managing style references (SREF).
 *
 * Features:
 * - Add style images via drag-drop or URL
 * - Add style codes (numeric)
 * - Per-item weight sliders
 * - Global style weight (SW) slider
 * - Random style generation
 * - Style code library with favorites
 * - Recent styles quick access
 */

import { useState, useCallback, useRef } from "react";
import {
  X,
  Plus,
  Trash2,
  Dice5,
  Image as ImageIcon,
  Hash,
  Star,
  StarOff,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  Sliders,
  Sparkles,
  History,
  GripVertical,
} from "lucide-react";
import { useStyleStore, selectSREFString } from "@/store/styleStore";
import { STYLE_CODES_ENABLED } from "@/lib/features";
import type { SREFItem } from "@/lib/sref/srefParser";

interface StyleReferencePanelProps {
  onClose?: () => void;
  /** Render inside a host drawer: no own header/border, fill the width. */
  embedded?: boolean;
}

export function StyleReferencePanel({
  onClose,
  embedded = false,
}: StyleReferencePanelProps) {
  const sref = useStyleStore((s) => s.sref);
  const addSREFItem = useStyleStore((s) => s.addSREFItem);
  const removeSREFItem = useStyleStore((s) => s.removeSREFItem);
  const updateSREFItem = useStyleStore((s) => s.updateSREFItem);
  const setStyleWeight = useStyleStore((s) => s.setStyleWeight);
  const addRandomSREF = useStyleStore((s) => s.addRandomSREF);
  const clearSREF = useStyleStore((s) => s.clearSREF);
  const styleCodes = useStyleStore((s) => s.styleCodes);
  const recentStyleCodes = useStyleStore((s) => s.recentStyleCodes);
  const saveStyleCode = useStyleStore((s) => s.saveStyleCode);
  const toggleStyleCodeFavorite = useStyleStore(
    (s) => s.toggleStyleCodeFavorite,
  );
  const incrementStyleCodeUse = useStyleStore((s) => s.incrementStyleCodeUse);

  const [newCodeInput, setNewCodeInput] = useState("");
  const [newUrlInput, setNewUrlInput] = useState("");
  const [showLibrary, setShowLibrary] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const dropZoneRef = useRef<HTMLDivElement>(null);

  const srefString = selectSREFString(useStyleStore.getState());

  const uploadDroppedImage = useCallback(async (file: File) => {
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/moodboards/upload", {
        method: "POST",
        body: formData,
      });
      const data = (await res.json()) as { ok?: boolean; url?: unknown };
      if (res.ok && data.ok && typeof data.url === "string") {
        return data.url;
      }
    } catch (err) {
      console.error("Failed to upload style reference image:", err);
    }
    return null;
  }, []);

  // Handle drag and drop
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      // Check for URLs in text
      const text = e.dataTransfer.getData("text/plain");
      if (text && (text.startsWith("http://") || text.startsWith("https://"))) {
        addSREFItem({ value: text, type: "url", weight: 1.0 });
        return;
      }

      // Check for files (images)
      const files = Array.from(e.dataTransfer.files);
      for (const file of files) {
        if (file.type.startsWith("image/")) {
          const url = await uploadDroppedImage(file);
          if (url) {
            addSREFItem({ value: url, type: "url", weight: 1.0 });
          }
        }
      }
    },
    [addSREFItem, uploadDroppedImage],
  );

  const handleAddCode = useCallback(() => {
    const code = newCodeInput.trim();
    if (code) {
      if (/^\d{6,12}$/.test(code)) {
        addSREFItem({ value: code, type: "code", weight: 1.0 });
        setNewCodeInput("");
      }
    }
  }, [newCodeInput, addSREFItem]);

  const handleAddUrl = useCallback(() => {
    const url = newUrlInput.trim();
    if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
      addSREFItem({ value: url, type: "url", weight: 1.0 });
      setNewUrlInput("");
    }
  }, [newUrlInput, addSREFItem]);

  const handleAddRandom = useCallback(() => {
    const code = addRandomSREF();
    saveStyleCode(code, `Random Style`, ["random", "generated"]);
  }, [addRandomSREF, saveStyleCode]);

  const handleCopyCode = useCallback(async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(null), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, []);

  const handleUseCode = useCallback(
    (code: string) => {
      addSREFItem({ value: code, type: "code", weight: 1.0 });
      incrementStyleCodeUse(code);
    },
    [addSREFItem, incrementStyleCodeUse],
  );

  const items = sref?.items ?? [];
  const styleWeight = sref?.styleWeight ?? 100;

  return (
    <div
      className={
        embedded
          ? "flex w-full flex-col"
          : "w-80 h-full bg-[var(--bg-secondary)] border-l border-[var(--border-primary)] flex flex-col"
      }
    >
      {/* Header */}
      {!embedded && (
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-primary)]">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-[var(--accent-primary)]" />
          <h2 className="font-medium text-[var(--text-primary)]">
            Style Reference
          </h2>
        </div>
        <button aria-label="Close style references" onClick={onClose} className="btn-ghost btn-icon">
          <X className="w-5 h-5" />
        </button>
      </div>
      )}

      <div
        className={
          embedded ? "space-y-4" : "flex-1 overflow-y-auto p-4 space-y-4"
        }
      >
        {/* Drop Zone */}
        <div
          ref={dropZoneRef}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-lg p-4 text-center transition-colors ${
            isDragging
              ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]/10"
              : "border-[var(--border-primary)]"
          }`}
        >
          <ImageIcon className="w-8 h-8 mx-auto mb-2 text-[var(--text-tertiary)]" />
          <p className="text-sm text-[var(--text-secondary)]">
            Drop images or URLs here
          </p>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            or use the inputs below
          </p>
        </div>

        {/* Add Code Input */}
        {STYLE_CODES_ENABLED && (
          <div className="space-y-2">
            <label className="text-sm text-[var(--text-secondary)]">
              Add Style Code
            </label>
            <div className="flex gap-2">
              <input
                aria-label="Style code"
                type="text"
                value={newCodeInput}
                onChange={(e) => setNewCodeInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddCode()}
                placeholder="e.g., 2952812633"
                className="input flex-1 text-sm"
              />
              <button
                aria-label="Add style code"
                onClick={handleAddCode}
                className="btn btn-secondary btn-icon"
              >
                <Hash className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Add URL Input */}
        <div className="space-y-2">
          <label className="text-sm text-[var(--text-secondary)]">
            Add Image URL
          </label>
          <div className="flex gap-2">
            <input
              aria-label="Image URL"
              type="text"
              value={newUrlInput}
              onChange={(e) => setNewUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddUrl()}
              placeholder="https://..."
              className="input flex-1 text-sm"
            />
            <button
              aria-label="Add image URL"
              onClick={handleAddUrl}
              className="btn btn-secondary btn-icon"
            >
              <ImageIcon className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Random Button */}
        {STYLE_CODES_ENABLED && (
          <button
            onClick={handleAddRandom}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[var(--accent-primary)]/20 text-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/30 transition-colors"
          >
            <Dice5 className="w-4 h-4" />
            Random Style
          </button>
        )}

        {/* Active Items */}
        {items.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm text-[var(--text-secondary)]">
                Active Styles ({items.length})
              </label>
              <button
                onClick={clearSREF}
                className="text-xs text-[var(--text-tertiary)] hover:text-[var(--error)]"
              >
                Clear All
              </button>
            </div>

            <div className="space-y-2">
              {items.map((item, index) => (
                <SREFItemCard
                  key={`${item.value}-${index}`}
                  item={item}
                  onUpdate={(update) => updateSREFItem(index, update)}
                  onRemove={() => removeSREFItem(index)}
                  onCopy={() => handleCopyCode(item.resolved ?? item.value)}
                  onSave={() => {
                    const code = item.resolved ?? item.value;
                    saveStyleCode(code);
                  }}
                  copiedCode={copiedCode}
                />
              ))}
            </div>
          </div>
        )}

        {/* Style Weight Slider */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm text-[var(--text-secondary)]">
              Style Weight (SW)
            </label>
            <span className="text-sm text-[var(--text-tertiary)]">
              {styleWeight}
            </span>
          </div>
          <input
            aria-label="Style weight"
            type="range"
            min={0}
            max={1000}
            step={10}
            value={styleWeight}
            onChange={(e) => setStyleWeight(parseInt(e.target.value, 10))}
            className="slider w-full"
          />
          <div className="flex justify-between text-xs text-[var(--text-muted)]">
            <span>Off</span>
            <span>Default</span>
            <span>Max</span>
          </div>
        </div>

        {/* Style Code Library */}
        {STYLE_CODES_ENABLED && (
          <div className="border-t border-[var(--border-primary)] pt-4">
            <button
              onClick={() => setShowLibrary(!showLibrary)}
              className="w-full flex items-center justify-between px-2 py-1 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              <span className="flex items-center gap-2">
                <History className="w-4 h-4" />
                Style Library ({styleCodes.length})
              </span>
              {showLibrary ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </button>

            {showLibrary && (
              <div className="mt-2 space-y-2 max-h-48 overflow-y-auto">
                {/* Recent codes */}
                {recentStyleCodes.length > 0 && (
                  <div className="mb-2">
                    <p className="text-xs text-[var(--text-muted)] mb-1">
                      Recent
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {recentStyleCodes.slice(0, 5).map((code) => (
                        <button
                          key={code}
                          onClick={() => handleUseCode(code)}
                          className="px-2 py-1 text-xs bg-[var(--bg-tertiary)] rounded hover:bg-[var(--bg-hover)]"
                        >
                          {code.slice(0, 6)}...
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Saved codes */}
                {styleCodes.map((entry) => (
                  <div
                    key={entry.code}
                    className="flex items-center gap-2 px-2 py-1.5 rounded bg-[var(--bg-tertiary)]"
                  >
                    <button
                      aria-label={entry.isFavorite ? "Remove from favorites" : "Add to favorites"}
                      onClick={() => toggleStyleCodeFavorite(entry.code)}
                      className="text-[var(--text-tertiary)] hover:text-yellow-400"
                    >
                      {entry.isFavorite ? (
                        <Star className="w-4 h-4 fill-current text-yellow-400" />
                      ) : (
                        <StarOff className="w-4 h-4" />
                      )}
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">
                        {entry.name ?? entry.code}
                      </p>
                      <p className="text-xs text-[var(--text-muted)]">
                        {entry.code.slice(0, 10)}... · {entry.useCount} uses
                      </p>
                    </div>
                    <button
                      onClick={() => handleUseCode(entry.code)}
                      className="btn-ghost btn-icon text-xs"
                      title="Use this style"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                ))}

                {styleCodes.length === 0 && recentStyleCodes.length === 0 && (
                  <p className="text-sm text-[var(--text-muted)] text-center py-4">
                    No saved styles yet
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Current SREF String Preview */}
        {srefString && (
          <div className="border-t border-[var(--border-primary)] pt-4">
            <label className="text-xs text-[var(--text-muted)] mb-1 block">
              Prompt Parameter
            </label>
            <div className="p-2 bg-[var(--bg-tertiary)] rounded text-xs font-mono text-[var(--text-secondary)] break-all">
              {srefString}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Sub-components

interface SREFItemCardProps {
  item: SREFItem;
  onUpdate: (update: Partial<SREFItem>) => void;
  onRemove: () => void;
  onCopy: () => void;
  onSave: () => void;
  copiedCode: string | null;
}

function SREFItemCard({
  item,
  onUpdate,
  onRemove,
  onCopy,
  onSave,
  copiedCode,
}: SREFItemCardProps) {
  const displayValue = item.resolved ?? item.value;
  const isImage = item.type === "url";
  const isCopied = copiedCode === displayValue;

  return (
    <div className="group flex items-center gap-2 p-2 bg-[var(--bg-tertiary)] rounded-lg">
      <GripVertical className="w-4 h-4 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 cursor-grab" />

      {/* Preview/Icon */}
      <div className="w-10 h-10 rounded bg-[var(--bg-secondary)] flex items-center justify-center overflow-hidden flex-shrink-0">
        {isImage ? (
          <img
            src={item.value}
            alt="Style reference"
            className="w-full h-full object-cover"
          />
        ) : item.type === "random" ? (
          <Dice5 className="w-5 h-5 text-[var(--accent-primary)]" />
        ) : (
          <Hash className="w-5 h-5 text-[var(--text-tertiary)]" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm truncate">
          {isImage ? "Image" : item.type === "random" ? "Random" : displayValue}
        </p>

        {/* Weight slider */}
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-[var(--text-muted)]">Weight:</span>
          <input
            aria-label="Weight"
            type="range"
            min={0}
            max={5}
            step={0.1}
            value={item.weight}
            onChange={(e) => onUpdate({ weight: parseFloat(e.target.value) })}
            className="slider flex-1 h-1"
          />
          <span className="text-xs text-[var(--text-tertiary)] w-8">
            {item.weight.toFixed(1)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
        {!isImage && STYLE_CODES_ENABLED && (
          <>
            <button
              onClick={onCopy}
              className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              title="Copy code"
            >
              {isCopied ? (
                <Check className="w-4 h-4 text-[var(--success)]" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
            </button>
            <button
              onClick={onSave}
              className="p-1 text-[var(--text-tertiary)] hover:text-yellow-400"
              title="Save to library"
            >
              <Star className="w-4 h-4" />
            </button>
          </>
        )}
        <button
          onClick={onRemove}
          className="p-1 text-[var(--text-tertiary)] hover:text-[var(--error)]"
          title="Remove"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export default StyleReferencePanel;

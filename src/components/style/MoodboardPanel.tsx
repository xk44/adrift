"use client";

/**
 * UI for managing moodboards — saved collections of style reference images.
 *
 * Features:
 * - List moodboards with image thumbnails
 * - Create / edit / delete moodboards
 * - Add / remove images (drag-drop or URL)
 * - Per-image weight sliders
 * - Mark as default (used by --p)
 * - "Apply" button → loads images into active SREF
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { StateView } from "@/components/ui/StateView";
import {
  X,
  Plus,
  Trash2,
  Image as ImageIcon,
  Star,
  ChevronDown,
  ChevronUp,
  Check,
  Edit2,
  BookImage,
  Sparkles,
  GripVertical,
  AlertCircle,
} from "lucide-react";
import { useStyleStore } from "@/store/styleStore";
import type { Moodboard, MoodboardImage } from "@/types";

interface MoodboardPanelProps {
  onClose?: () => void;
}

export function MoodboardPanel({ onClose }: MoodboardPanelProps) {
  const moodboards = useStyleStore((s) => s.moodboards);
  const moodboardsLoading = useStyleStore((s) => s.moodboardsLoading);
  const moodboardsError = useStyleStore((s) => s.moodboardsError);
  const activeMoodboardId = useStyleStore((s) => s.activeMoodboardId);
  const fetchMoodboards = useStyleStore((s) => s.fetchMoodboards);
  const createMoodboard = useStyleStore((s) => s.createMoodboard);
  const deleteMoodboard = useStyleStore((s) => s.deleteMoodboard);
  const setDefaultMoodboard = useStyleStore((s) => s.setDefaultMoodboard);
  const setActiveMoodboard = useStyleStore((s) => s.setActiveMoodboard);
  const applyMoodboardToSREF = useStyleStore((s) => s.applyMoodboardToSREF);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMoodboards();
  }, [fetchMoodboards]);

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    const mb = await createMoodboard({
      name,
      description: newDesc.trim() || undefined,
      images: [],
      isDefault: moodboards.length === 0, // first one is auto-default
    });
    if (mb) {
      setNewName("");
      setNewDesc("");
      setCreating(false);
      setExpandedId(mb.id);
    } else {
      setError("Failed to create moodboard");
    }
  }, [newName, newDesc, moodboards.length, createMoodboard]);

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteMoodboard(id);
      if (expandedId === id) setExpandedId(null);
    },
    [deleteMoodboard, expandedId],
  );

  const handleApply = useCallback(
    (id: string) => {
      applyMoodboardToSREF(id);
      setActiveMoodboard(id);
    },
    [applyMoodboardToSREF, setActiveMoodboard],
  );

  return (
    <div className="flex h-full w-80 flex-col border-l border-light-100 bg-light-bg dark:border-dark-750 dark:bg-dark-bg">
      <div className="flex items-center justify-between border-b border-light-100 px-4 py-3 dark:border-dark-750">
        <div className="flex items-center gap-2">
          <BookImage className="h-5 w-5 text-splash" />
          <h2 className="text-sm font-semibold text-balance text-light-primary dark:text-dark-primary">
            Moodboards
          </h2>
        </div>
        <button aria-label="Close moodboards" onClick={onClose} className="btn-ghost btn-icon">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="microScrollbar flex-1 space-y-3 overflow-y-auto p-4">
        {error && (
          <div className="flex items-center gap-2 rounded-lg bg-red-50/90 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-200">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Create button / form */}
        {!creating ? (
          <button
            onClick={() => setCreating(true)}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-light-100 px-4 py-2 text-sm font-medium text-light-500 transition-[color,background-color,border-color,transform] duration-150 hover:border-splash/35 hover:text-light-primary active:scale-[0.96] dark:border-dark-700 dark:text-dark-400 dark:hover:border-splash/25 dark:hover:text-dark-primary"
          >
            <Plus className="h-4 w-4" />
            New Moodboard
          </button>
        ) : (
          <div className="space-y-2 rounded-xl border border-light-100 bg-light-input p-3 dark:border-dark-750 dark:bg-dark-input">
            <input
              aria-label="Moodboard name"
              autoFocus
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") setCreating(false);
              }}
              placeholder="Moodboard name"
              className="input w-full text-sm"
            />
            <input
              aria-label="Description"
              type="text"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="Description (optional)"
              className="input w-full text-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={handleCreate}
                disabled={!newName.trim()}
                className="btn btn-primary flex-1 text-sm"
              >
                Create
              </button>
              <button
                onClick={() => setCreating(false)}
                className="btn btn-secondary flex-1 text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Moodboard list */}
        {moodboardsLoading && moodboards.length === 0 && (
          <p className="py-6 text-center text-xs text-light-400 dark:text-dark-500">
            Loading…
          </p>
        )}

        {!moodboardsLoading && moodboardsError && moodboards.length === 0 && (
          <StateView
            status="error"
            compact
            title="Couldn't load moodboards"
            message={moodboardsError}
            onRetry={() => void fetchMoodboards()}
          />
        )}

        {!moodboardsLoading && !moodboardsError && moodboards.length === 0 && (
          <p className="py-6 text-center text-xs text-light-400 dark:text-dark-500">
            No moodboards yet. Create one above.
          </p>
        )}

        {moodboards.map((mb) => (
          <MoodboardCard
            key={mb.id}
            moodboard={mb}
            isActive={activeMoodboardId === mb.id}
            isExpanded={expandedId === mb.id}
            onToggleExpand={() =>
              setExpandedId((prev) => (prev === mb.id ? null : mb.id))
            }
            onApply={() => handleApply(mb.id)}
            onSetDefault={() => setDefaultMoodboard(mb.id)}
            onDelete={() => handleDelete(mb.id)}
          />
        ))}
      </div>
    </div>
  );
}

interface MoodboardCardProps {
  moodboard: Moodboard;
  isActive: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onApply: () => void;
  onSetDefault: () => void;
  onDelete: () => void;
}

function MoodboardCard({
  moodboard,
  isActive,
  isExpanded,
  onToggleExpand,
  onApply,
  onSetDefault,
  onDelete,
}: MoodboardCardProps) {
  const updateMoodboard = useStyleStore((s) => s.updateMoodboard);

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(moodboard.name);
  const [editDesc, setEditDesc] = useState(moodboard.description ?? "");
  const [newUrl, setNewUrl] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  const handleSaveMeta = useCallback(async () => {
    const name = editName.trim();
    if (!name) return;
    await updateMoodboard({
      id: moodboard.id,
      name,
      description: editDesc.trim() || null,
    });
    setEditing(false);
  }, [editName, editDesc, moodboard.id, updateMoodboard]);

  const handleAddUrl = useCallback(async () => {
    const url = newUrl.trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) return;
    const images: MoodboardImage[] = [
      ...moodboard.images,
      { url, weight: 1.0 },
    ];
    await updateMoodboard({ id: moodboard.id, images });
    setNewUrl("");
  }, [newUrl, moodboard.id, moodboard.images, updateMoodboard]);

  const handleRemoveImage = useCallback(
    async (index: number) => {
      const images = moodboard.images.filter((_, i) => i !== index);
      await updateMoodboard({ id: moodboard.id, images });
    },
    [moodboard.id, moodboard.images, updateMoodboard],
  );

  const handleUpdateWeight = useCallback(
    async (index: number, weight: number) => {
      const images = moodboard.images.map((img, i) =>
        i === index ? { ...img, weight } : img,
      );
      await updateMoodboard({ id: moodboard.id, images });
    },
    [moodboard.id, moodboard.images, updateMoodboard],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const text = e.dataTransfer.getData("text/plain");
      if (text && (text.startsWith("http://") || text.startsWith("https://"))) {
        const images: MoodboardImage[] = [
          ...moodboard.images,
          { url: text, weight: 1.0 },
        ];
        await updateMoodboard({ id: moodboard.id, images });
        return;
      }
      const files = Array.from(e.dataTransfer.files);
      const imageFiles = files.filter((f) => f.type.startsWith("image/"));
      if (imageFiles.length > 0) {
        // Persist dropped files through the upload endpoint so saved
        // moodboards keep durable URLs (blob: URLs break on reload).
        const newImages: MoodboardImage[] = [];
        for (const file of imageFiles) {
          const formData = new FormData();
          formData.append("file", file);
          try {
            const res = await fetch("/api/moodboards/upload", {
              method: "POST",
              body: formData,
            });
            const data = await res.json();
            if (data.ok && data.url) {
              newImages.push({ url: data.url, weight: 1.0 });
            }
          } catch {
            // Skip files that fail to upload rather than persisting a
            // broken blob: reference.
          }
        }
        if (newImages.length > 0) {
          await updateMoodboard({
            id: moodboard.id,
            images: [...moodboard.images, ...newImages],
          });
        }
      }
    },
    [moodboard.id, moodboard.images, updateMoodboard],
  );

  const thumbnails = moodboard.images.slice(0, 4);

  return (
    <div
      className={`rounded-xl border transition-[border-color] duration-150 ${
        isActive ? "border-splash/40" : "border-light-100 dark:border-dark-750"
      } bg-light-input dark:bg-dark-input`}
    >
      {/* Card header */}
      <div className="flex items-center gap-2 px-3 py-2">
        {/* Thumbnail strip */}
        <div className="flex gap-0.5 w-14 h-8 flex-shrink-0 rounded overflow-hidden bg-light-input dark:bg-dark-input">
          {thumbnails.length > 0 ? (
            thumbnails.map((img, i) => (
              <img
                key={i}
                src={img.url}
                alt=""
                className="w-full h-full object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
                style={{ width: `${100 / thumbnails.length}%` }}
              />
            ))
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <ImageIcon className="w-4 h-4 text-light-400 dark:text-dark-400" />
            </div>
          )}
        </div>

        {/* Name + meta */}
        <div
          className="flex-1 min-w-0"
          role="button"
          tabIndex={0}
          onClick={onToggleExpand}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggleExpand();
            }
          }}
        >
          <div className="flex items-center gap-1">
            <p className="text-sm font-medium text-light-primary dark:text-dark-primary truncate">
              {moodboard.name}
            </p>
            {moodboard.isDefault && (
              <Star className="w-3 h-3 text-yellow-400 fill-current flex-shrink-0" />
            )}
          </div>
          <p className="text-xs text-light-400 dark:text-dark-400">
            {moodboard.images.length} image
            {moodboard.images.length !== 1 ? "s" : ""}
          </p>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={onApply}
            title="Use as style reference"
            className="p-1 text-light-500 dark:text-dark-500 hover:text-splash transition-[color] duration-150"
          >
            <Sparkles className="w-4 h-4" />
          </button>
          <button
            aria-label={isExpanded ? "Collapse" : "Expand"} aria-expanded={isExpanded}
            onClick={onToggleExpand}
            className="p-1 text-light-500 dark:text-dark-500 hover:text-light-primary dark:hover:text-dark-primary transition-[color] duration-150"
          >
            {isExpanded ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      {/* Expanded body */}
      {isExpanded && (
        <div className="border-t border-light-100 dark:border-dark-750 px-3 py-3 space-y-3">
          {/* Edit name / desc */}
          {editing ? (
            <div className="space-y-2">
              <input
                aria-label="Moodboard name"
                autoFocus
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveMeta();
                  if (e.key === "Escape") setEditing(false);
                }}
                className="input w-full text-sm"
              />
              <input
                aria-label="Description"
                type="text"
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder="Description (optional)"
                className="input w-full text-sm"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleSaveMeta}
                  className="btn btn-primary flex-1 text-xs"
                >
                  <Check className="w-3 h-3 mr-1" /> Save
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="btn btn-secondary flex-1 text-xs"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              {moodboard.description && (
                <p className="text-xs text-light-500 dark:text-dark-400 flex-1 mr-2">
                  {moodboard.description}
                </p>
              )}
              <div className="flex items-center gap-1 ml-auto">
                <button
                  onClick={() => setEditing(true)}
                  title="Edit name / description"
                  className="p-1 text-light-500 dark:text-dark-500 hover:text-light-primary dark:hover:text-dark-primary"
                >
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={onSetDefault}
                  title={
                    moodboard.isDefault
                      ? "Already default"
                      : "Set as default (--p)"
                  }
                  className={`p-1 transition-[color] duration-150 ${
                    moodboard.isDefault
                      ? "text-yellow-400"
                      : "text-light-500 dark:text-dark-500 hover:text-yellow-400"
                  }`}
                >
                  <Star
                    className={`w-3.5 h-3.5 ${moodboard.isDefault ? "fill-current" : ""}`}
                  />
                </button>
                <button
                  onClick={onDelete}
                  title="Delete moodboard"
                  className="p-1 text-light-500 dark:text-dark-500 hover:text-red-500 transition-[color] duration-150"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Image list */}
          {moodboard.images.length > 0 && (
            <div className="microScrollbar space-y-2 max-h-56 overflow-y-auto">
              {moodboard.images.map((img, index) => (
                <MoodboardImageRow
                  key={`${img.url}-${index}`}
                  image={img}
                  onRemove={() => handleRemoveImage(index)}
                  onWeightChange={(w) => handleUpdateWeight(index, w)}
                />
              ))}
            </div>
          )}

          {/* Drop zone */}
          <div
            ref={dropRef}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-xl p-3 text-center transition-[border-color,background-color] duration-150 ${
              isDragging
                ? "border-splash/40 bg-splash/5"
                : "border-light-100 dark:border-dark-750"
            }`}
          >
            <p className="text-xs text-light-400 dark:text-dark-400">
              Drop images or URLs
            </p>
          </div>

          {/* Add URL input */}
          <div className="flex gap-2">
            <input
              aria-label="Image URL"
              type="text"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddUrl()}
              placeholder="https://..."
              className="input flex-1 text-xs"
            />
            <button
              onClick={handleAddUrl}
              disabled={
                !newUrl.trim().startsWith("http://") &&
                !newUrl.trim().startsWith("https://")
              }
              className="btn btn-secondary btn-icon"
              title="Add URL"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>

          <button
            onClick={onApply}
            disabled={moodboard.images.length === 0}
            className="btn btn-primary w-full text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Sparkles className="w-4 h-4" />
            Apply to Style Reference
          </button>
        </div>
      )}
    </div>
  );
}

interface MoodboardImageRowProps {
  image: MoodboardImage;
  onRemove: () => void;
  onWeightChange: (weight: number) => void;
}

function MoodboardImageRow({
  image,
  onRemove,
  onWeightChange,
}: MoodboardImageRowProps) {
  return (
    <div className="group flex items-center gap-2 rounded-lg bg-light-50 p-1.5 dark:bg-dark-750">
      <GripVertical className="w-3.5 h-3.5 text-light-400 dark:text-dark-400 opacity-0 group-hover:opacity-100 cursor-grab flex-shrink-0" />

      <div className="w-9 h-9 rounded overflow-hidden flex-shrink-0 bg-light-50 dark:bg-dark-700">
        <img
          src={image.url}
          alt=""
          className="w-full h-full object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      </div>

      {/* URL truncated */}
      <div className="flex-1 min-w-0">
        <p className="text-xs text-light-500 dark:text-dark-400 truncate">
          {image.url.replace(/^https?:\/\//, "")}
        </p>
        {/* Weight */}
        <div className="flex items-center gap-1 mt-1">
          <input
            aria-label="Weight"
            type="range"
            min={0}
            max={5}
            step={0.1}
            value={image.weight}
            onChange={(e) => onWeightChange(parseFloat(e.target.value))}
            className="slider flex-1 h-1"
          />
          <span className="text-[10px] text-light-400 dark:text-dark-400 w-6 text-right">
            {image.weight.toFixed(1)}
          </span>
        </div>
      </div>

      <button
        aria-label="Remove"
        onClick={onRemove}
        className="p-1 text-light-500 dark:text-dark-500 hover:text-red-500 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity flex-shrink-0"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

export default MoodboardPanel;

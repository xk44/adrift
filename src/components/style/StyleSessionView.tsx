"use client";

import { useCallback, useMemo, useState } from "react";
import { useUIStore, useGenerationStore, useStyleStore } from "@/store";
import type { StyleCodeEntry } from "@/store";
import type { GalleryImage } from "@/types";
import { rankImagesByPrompt, type StyleSession } from "./styleCreatorLogic";
import { generateStyleCodeFromImages } from "./useStyleSessions";
import { STYLE_CODES_ENABLED } from "@/lib/features";
import { mergeIntoMoodboard } from "@/lib/gallerySelection";
import { showToast } from "@/components/Toast";
import {
  Palette,
  Wand2,
  ArrowLeft,
  Clock,
  Image as ImageIcon,
  Check,
  Copy,
  Trash2,
  Star,
  Hash,
  Sparkles,
} from "lucide-react";

/** Same cap the gallery's "Add to moodboard" uses. */
const MOODBOARD_MAX_IMAGES = 20;

export function ImageSelectionGrid({
  images,
  selectedIds,
  onToggle,
  compact = false,
}: {
  images: GalleryImage[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  /** Narrow container (creator side panel): fewer columns. */
  compact?: boolean;
}) {
  if (images.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-light-50 dark:bg-dark-750">
          <ImageIcon className="h-8 w-8 text-light-300 dark:text-dark-500" />
        </div>
        <p className="text-sm font-medium text-light-primary dark:text-dark-primary">
          No generated images yet
        </p>
        <p className="text-xs text-light-400 dark:text-dark-500 text-center max-w-sm">
          Generate some images first, then come back here to select references
          for your style.
        </p>
      </div>
    );
  }

  return (
    <div
      className={`${
        compact
          ? "columns-2 sm:columns-3"
          : "columns-2 md:columns-3 lg:columns-4 xl:columns-5"
      } gap-3`}
    >
      {images.map((img) => {
        const selected = selectedIds.has(img.id);
        return (
          <button
            key={img.id}
            onClick={() => onToggle(img.id)}
            className="relative mb-3 break-inside-avoid block w-full group rounded-lg overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-splash"
          >
            <img
              src={img.url}
              alt={img.prompt}
              className={`w-full h-auto block transition-all duration-150 ${
                selected
                  ? "ring-2 ring-splash ring-offset-2 ring-offset-light-bg dark:ring-offset-dark-bg brightness-100"
                  : "brightness-[0.85] group-hover:brightness-100"
              }`}
              loading="lazy"
            />
            {/* Selection overlay */}
            <div
              className={`absolute inset-0 transition-all duration-150 ${
                selected
                  ? "bg-splash/10"
                  : "bg-transparent group-hover:bg-black/10"
              }`}
            />
            {/* Checkmark */}
            <div
              className={`absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-full transition-all duration-150 ${
                selected
                  ? "bg-splash text-white scale-100"
                  : "bg-black/40 text-white/60 scale-90 opacity-0 group-hover:opacity-100 group-hover:scale-100"
              }`}
            >
              <Check className="h-3.5 w-3.5" />
            </div>
            {/* Seed badge */}
            <div className="absolute bottom-1.5 left-1.5 rounded bg-black/50 px-1.5 py-0.5 text-[9px] font-mono text-white/70 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
              {img.seed}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function StyleCodeCard({
  entry,
  onCopy,
  onDelete,
  onToggleFavorite,
  onApply,
}: {
  entry: StyleCodeEntry;
  onCopy: (code: string) => void;
  onDelete: (code: string) => void;
  onToggleFavorite: (code: string) => void;
  onApply: (code: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-light-100 bg-light-input px-4 py-3 shadow-panel dark:border-dark-750 dark:bg-dark-input dark:shadow-panel-dark">
      {entry.thumbnailUrl ? (
        <img
          src={entry.thumbnailUrl}
          alt={entry.name || entry.code}
          className="h-10 w-10 rounded-lg object-cover flex-shrink-0"
        />
      ) : (
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-splash/10 text-splash flex-shrink-0">
          <Hash className="h-5 w-5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-light-primary dark:text-dark-primary truncate">
            {entry.code}
          </span>
          {entry.name && (
            <span className="text-xs text-light-400 dark:text-dark-500 truncate">
              {entry.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-light-400 dark:text-dark-500">
          <span>
            Used {entry.useCount} time{entry.useCount !== 1 ? "s" : ""}
          </span>
          <span>·</span>
          <span>{new Date(entry.createdAt).toLocaleDateString()}</span>
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          onClick={() => onApply(entry.code)}
          className="rounded-md p-1.5 text-light-400 hover:text-splash hover:bg-splash/10 dark:text-dark-500 dark:hover:text-splash transition-colors duration-150"
          title="Apply to prompt"
        >
          <Wand2 className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => onToggleFavorite(entry.code)}
          className={`rounded-md p-1.5 transition-colors duration-150 ${
            entry.isFavorite
              ? "text-amber-400"
              : "text-light-400 hover:text-amber-400 dark:text-dark-500"
          }`}
          title={entry.isFavorite ? "Unfavorite" : "Favorite"}
        >
          <Star
            className="h-3.5 w-3.5"
            fill={entry.isFavorite ? "currentColor" : "none"}
          />
        </button>
        <button
          onClick={() => onCopy(entry.code)}
          className="rounded-md p-1.5 text-light-400 hover:text-light-primary dark:text-dark-500 dark:hover:text-dark-primary transition-colors duration-150"
          title="Copy code"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => onDelete(entry.code)}
          className="rounded-md p-1.5 text-light-400 hover:text-red-400 dark:text-dark-500 dark:hover:text-red-400 transition-colors duration-150"
          title="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}


const BACK_BUTTON =
  "flex items-center justify-center rounded-lg p-1.5 text-light-500 hover:bg-light-50 dark:text-dark-400 dark:hover:bg-dark-750 transition-[color,background-color] duration-150";
const PRIMARY_BUTTON =
  "flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-splash text-white text-xs font-medium hover:bg-splash/90 transition-[background-color,transform] duration-150 active:scale-[0.96]";
const SECONDARY_BUTTON =
  "flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-light-200 dark:border-dark-700 text-xs font-medium text-light-500 dark:text-dark-400 hover:bg-light-50 dark:hover:bg-dark-800 transition-[background-color] duration-150";

function EmptySessionState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action: { label: string; icon: typeof Wand2; onClick: () => void };
}) {
  const Icon = action.icon;
  return (
    <div className="mx-auto max-w-3xl flex flex-col items-center justify-center py-24 gap-4">
      <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-light-50 dark:bg-dark-750">
        <Palette className="h-10 w-10 text-light-300 dark:text-dark-500" />
      </div>
      <p className="text-sm font-medium text-light-primary dark:text-dark-primary">
        {title}
      </p>
      {body && (
        <p className="text-center text-xs text-light-400 dark:text-dark-500 max-w-sm">
          {body}
        </p>
      )}
      <button
        onClick={action.onClick}
        className="mt-2 flex items-center gap-2 px-4 py-2 rounded-lg bg-splash text-white text-sm font-medium hover:bg-splash/90 transition-[background-color,transform] duration-150 active:scale-[0.96]"
      >
        <Icon className="h-4 w-4" /> {action.label}
      </button>
    </div>
  );
}

/**
 * One creator session: pick reference images, then extract a style code.
 * Used inside the Styles creator panel.
 */
export function StyleSessionView({
  sessionId,
  sessions,
  onBack,
  onCreateSession,
  updateSession,
  deleteSession,
  compact = false,
  backLabel = "Back",
}: {
  /** A session id, or "new" for the empty start state. */
  sessionId: string;
  sessions: readonly StyleSession[];
  onBack: () => void;
  onCreateSession: () => void;
  updateSession: (id: string, update: Partial<StyleSession>) => void;
  deleteSession: (id: string) => void;
  compact?: boolean;
  backLabel?: string;
}) {
  const appendToPrompt = useUIStore((s) => s.appendToPrompt);
  const setPromptValue = useUIStore((s) => s.setPromptValue);
  const gallery = useGenerationStore((s) => s.gallery);
  const saveStyleCode = useStyleStore((s) => s.saveStyleCode);
  const incrementStyleCodeUse = useStyleStore((s) => s.incrementStyleCodeUse);
  const createMoodboard = useStyleStore((s) => s.createMoodboard);
  const [savingBoard, setSavingBoard] = useState(false);

  const [editingName, setEditingName] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const visibleImages = useMemo(
    () => gallery.filter((img) => !img.hidden),
    [gallery],
  );

  const currentSession = useMemo(() => {
    if (!sessionId || sessionId === "new") return null;
    return sessions.find((s) => s.id === sessionId) ?? null;
  }, [sessionId, sessions]);

  const selectedIds = useMemo(
    () => new Set(currentSession?.selectedImageIds ?? []),
    [currentSession],
  );

  const selectedImages = useMemo(
    () => visibleImages.filter((img) => selectedIds.has(img.id)),
    [visibleImages, selectedIds],
  );

  const pickerImages = useMemo(
    () => rankImagesByPrompt(visibleImages, currentSession?.prompt),
    [visibleImages, currentSession?.prompt],
  );

  const toggleImageSelection = useCallback(
    (imageId: string) => {
      if (!currentSession) return;
      const ids = new Set(currentSession.selectedImageIds);
      if (ids.has(imageId)) ids.delete(imageId);
      else ids.add(imageId);
      updateSession(currentSession.id, { selectedImageIds: Array.from(ids) });
    },
    [currentSession, updateSession],
  );

  const handleCreateStyle = useCallback(() => {
    if (!currentSession || selectedImages.length < 3) return;
    const code = generateStyleCodeFromImages(selectedImages);
    saveStyleCode(code, currentSession.name, ["extracted"], selectedImages[0]?.url);
    updateSession(currentSession.id, { status: "done", styleCode: code });
  }, [currentSession, selectedImages, saveStyleCode, updateSession]);

  // Without style codes, a session's picks are saved as a moodboard instead:
  // moodboards work as style reference images (--sv 2).
  const handleSaveMoodboard = useCallback(async () => {
    if (!currentSession || selectedImages.length < 3 || savingBoard) return;
    const merge = mergeIntoMoodboard([], selectedImages, MOODBOARD_MAX_IMAGES);
    setSavingBoard(true);
    try {
      const board = await createMoodboard({
        name: currentSession.name.slice(0, 100),
        images: merge.images,
      });
      if (board) {
        updateSession(currentSession.id, { status: "done" });
        showToast(`Saved "${board.name}" as a moodboard`, "success");
      } else {
        showToast("Couldn't save the moodboard. Try again.", "error");
      }
    } finally {
      setSavingBoard(false);
    }
  }, [currentSession, selectedImages, savingBoard, createMoodboard, updateSession]);

  const handleCopyCode = useCallback((code: string) => {
    navigator.clipboard.writeText(`--sref ${code}`).catch(() => {});
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  }, []);

  const handleApplyCode = useCallback(
    (code: string) => {
      appendToPrompt(`--sref ${code}`);
      incrementStyleCodeUse(code);
    },
    [appendToPrompt, incrementStyleCodeUse],
  );

  const handleFinishRename = useCallback(() => {
    if (editingName && nameInput.trim()) {
      updateSession(editingName, { name: nameInput.trim() });
    }
    setEditingName(null);
  }, [editingName, nameInput, updateSession]);

  const pad = compact ? "px-4" : "px-6";
  const width = compact ? "" : "mx-auto max-w-4xl";

  const header = (title: React.ReactNode, sub?: React.ReactNode, actions?: React.ReactNode) => (
    <header
      className={`flex-shrink-0 shadow-[0_1px_0_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_0_0_rgba(255,255,255,0.08)] ${pad} py-4`}
    >
      <div className="flex items-center gap-3">
        <button onClick={onBack} className={BACK_BUTTON} aria-label={backLabel} title={backLabel}>
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0 flex-1">
          {title}
          {sub}
        </div>
        {actions}
      </div>
    </header>
  );

  if (sessionId === "new") {
    return (
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {header(
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-light-primary dark:text-dark-primary">
              New Style Session
            </h1>
            <span className="rounded-full bg-splash/10 px-2 py-0.5 text-[10px] font-medium text-splash">
              Beta
            </span>
          </div>,
          <p className="mt-0.5 text-xs text-light-500 dark:text-dark-400">
            Select reference images to define your style
          </p>,
        )}
        <div className="microScrollbar flex-1 overflow-y-auto p-6">
          <EmptySessionState
            title="Start a New Style Session"
            body={
              STYLE_CODES_ENABLED
                ? "Select images from your gallery to extract a reusable style code. You need at least 3 reference images."
                : "Select images from your gallery and save them as a moodboard you can use as a style reference. You need at least 3 reference images."
            }
            action={{ label: "Create Session", icon: Wand2, onClick: onCreateSession }}
          />
        </div>
      </div>
    );
  }

  if (!currentSession) {
    return (
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {header(
          <h1 className="text-lg font-semibold text-light-primary dark:text-dark-primary">
            Session not found
          </h1>,
        )}
        <div className="microScrollbar flex-1 overflow-y-auto p-6">
          <EmptySessionState
            title="This session may have been deleted."
            action={{ label: "Back to Sessions", icon: ArrowLeft, onClick: onBack }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {header(
        <div className="flex items-center gap-2">
          {editingName === currentSession.id ? (
            <input
              autoFocus
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onBlur={handleFinishRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleFinishRename();
                if (e.key === "Escape") setEditingName(null);
              }}
              className="text-lg font-semibold text-light-primary dark:text-dark-primary bg-transparent border-b border-splash outline-none w-48"
            />
          ) : (
            <h1
              className="text-lg font-semibold text-light-primary dark:text-dark-primary truncate cursor-pointer hover:text-splash transition-colors duration-150"
              onClick={() => {
                setEditingName(currentSession.id);
                setNameInput(currentSession.name);
              }}
              title="Click to rename"
            >
              {currentSession.name}
            </h1>
          )}
          <span className="rounded-full bg-splash/10 px-2 py-0.5 text-[10px] font-medium text-splash">
            Beta
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${
              currentSession.status === "done"
                ? "bg-green-500/10 text-green-500"
                : "bg-light-50 text-light-500 dark:bg-dark-750 dark:text-dark-400"
            }`}
          >
            {currentSession.status}
          </span>
        </div>,
        <div className="flex items-center gap-3 mt-0.5 text-xs text-light-500 dark:text-dark-400">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {new Date(currentSession.createdAt).toLocaleDateString()}
          </span>
          <span className="flex items-center gap-1">
            <ImageIcon className="h-3 w-3" />
            {selectedIds.size} selected
          </span>
        </div>,
        <div className="flex items-center gap-2 flex-shrink-0">
          {selectedIds.size >= 3 &&
            currentSession.status !== "done" &&
            (STYLE_CODES_ENABLED ? (
              <button onClick={handleCreateStyle} className={PRIMARY_BUTTON}>
                <Sparkles className="h-3.5 w-3.5" /> Create Style
              </button>
            ) : (
              <button
                onClick={() => void handleSaveMoodboard()}
                disabled={savingBoard}
                className={PRIMARY_BUTTON}
              >
                <Sparkles className="h-3.5 w-3.5" /> Save as moodboard
              </button>
            ))}
          <button
            onClick={() => {
              deleteSession(currentSession.id);
              onBack();
            }}
            className={SECONDARY_BUTTON}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
        </div>,
      )}

      <div className="microScrollbar flex-1 overflow-y-auto">
        {STYLE_CODES_ENABLED && currentSession.styleCode && (
          <div className={`${pad} pt-4`}>
            <div className={`${width} rounded-xl border border-splash/20 bg-splash/5 p-4`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-splash/10 text-splash">
                    <Hash className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-xs text-light-400 dark:text-dark-500">
                      Generated Style Code
                    </p>
                    <p className="font-mono text-sm font-medium text-light-primary dark:text-dark-primary">
                      --sref {currentSession.styleCode}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleApplyCode(currentSession.styleCode!)}
                    className={PRIMARY_BUTTON}
                  >
                    <Wand2 className="h-3.5 w-3.5" /> Apply
                  </button>
                  <button
                    onClick={() => handleCopyCode(currentSession.styleCode!)}
                    className={SECONDARY_BUTTON}
                  >
                    {copiedCode === currentSession.styleCode ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-green-500" /> Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" /> Copy
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {currentSession.prompt && (
          <div className={`${pad} pt-4`}>
            <div
              className={`${width} flex items-start gap-2 rounded-xl border border-light-100 bg-light-input px-3 py-2 dark:border-dark-750 dark:bg-dark-input`}
              data-testid="style-session-prompt"
            >
              <Palette className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-light-400 dark:text-dark-500" />
              <p className="min-w-0 flex-1 break-words text-xs text-light-primary dark:text-dark-primary">
                {currentSession.prompt}
              </p>
              <button
                onClick={() => setPromptValue(currentSession.prompt ?? "")}
                className="flex-shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium text-splash transition-colors duration-150 hover:bg-splash/10"
                title="Copy this prompt into the main prompt bar"
              >
                Use prompt
              </button>
            </div>
          </div>
        )}

        {currentSession.status === "draft" && (
          <div className={`${pad} pt-4`}>
            <div className={width}>
              <p className="text-xs text-light-400 dark:text-dark-500">
                {selectedIds.size < 3
                  ? `Select at least ${3 - selectedIds.size} more image${3 - selectedIds.size !== 1 ? "s" : ""} to ${STYLE_CODES_ENABLED ? "create a style" : "save a moodboard"}.`
                  : STYLE_CODES_ENABLED
                    ? `${selectedIds.size} images selected. Ready to create your style.`
                    : `${selectedIds.size} images selected. Ready to save as a moodboard.`}
              </p>
            </div>
          </div>
        )}

        <div className={`${pad} py-4`}>
          <div className={width}>
            <ImageSelectionGrid
              images={pickerImages}
              selectedIds={selectedIds}
              onToggle={toggleImageSelection}
              compact={compact}
            />
          </div>
        </div>
      </div>
    </div>
  );
}


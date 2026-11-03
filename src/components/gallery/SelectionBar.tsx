"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Columns2,
  Download,
  FolderInput,
  Heart,
  LayoutDashboard,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useGenerationStore } from "@/store";
import { useStyleStore } from "@/store/styleStore";
import { useGallerySelectionStore } from "@/store/gallerySelectionStore";
import { showToast } from "@/components/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { CompareSlider } from "@/components/CompareSlider";
import { isComparableImage } from "@/lib/compareSlider";
import {
  downloadTarget,
  isMoodboardEligible,
  mergeIntoMoodboard,
  moveToFolderByIds,
  nextLikedValue,
  selectedInOrder,
  setLikedByIds,
} from "@/lib/gallerySelection";
import type { GalleryImage } from "@/types";

const MOODBOARD_MAX_IMAGES = 20;
const DOWNLOAD_CONFIRM_OVER = 12;
const DOWNLOAD_SPACING_MS = 250;

type Panel = "moodboard" | "folder" | null;

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(
    el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT" ||
      el.isContentEditable),
  );
}

const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/**
 * Create-feed Select mode host: keeps the store's feed order in sync, owns the
 * Esc / Cmd-A shortcuts, and renders the floating action bar. Mount once in
 * the feed with every loaded id in feed order.
 */
export function GallerySelectionLayer({
  orderedIds,
}: {
  orderedIds: readonly string[];
}) {
  const selectMode = useGallerySelectionStore((s) => s.selectMode);
  const setOrderedIds = useGallerySelectionStore((s) => s.setOrderedIds);
  const exit = useGallerySelectionStore((s) => s.exit);
  const [panel, setPanel] = useState<Panel>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    setOrderedIds(orderedIds);
  }, [orderedIds, setOrderedIds]);

  // Leaving the Create page ends the session.
  useEffect(() => () => exit(), [exit]);

  useEffect(() => {
    if (!selectMode) {
      setPanel(null);
      setCompareOpen(false);
    }
  }, [selectMode]);

  useEffect(() => {
    if (!selectMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isTypingTarget(e.target) && panel !== "folder") return;
        e.preventDefault();
        if (compareOpen) setCompareOpen(false);
        else if (panel) setPanel(null);
        else exit();
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        e.key.toLowerCase() === "a" &&
        !isTypingTarget(e.target)
      ) {
        e.preventDefault();
        useGallerySelectionStore.getState().selectAll();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode, panel, compareOpen, exit]);

  if (!mounted || !selectMode) return null;
  return createPortal(
    <SelectionBar
      panel={panel}
      setPanel={setPanel}
      compareOpen={compareOpen}
      setCompareOpen={setCompareOpen}
    />,
    document.body,
  );
}

const BAR_BUTTON =
  "flex h-9 flex-shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-40";
const BAR_LABEL = "hidden md:inline";
const PANEL_ROW =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-50";

function SelectionBar({
  panel,
  setPanel,
  compareOpen,
  setCompareOpen,
}: {
  panel: Panel;
  setPanel: (panel: Panel) => void;
  compareOpen: boolean;
  setCompareOpen: (open: boolean) => void;
}) {
  const selected = useGallerySelectionStore((s) => s.selected);
  const orderedIds = useGallerySelectionStore((s) => s.orderedIds);
  const clear = useGallerySelectionStore((s) => s.clear);
  const selectAll = useGallerySelectionStore((s) => s.selectAll);
  const exit = useGallerySelectionStore((s) => s.exit);
  const gallery = useGenerationStore((s) => s.gallery);
  const removeFromGallery = useGenerationStore((s) => s.removeFromGallery);
  const [busy, setBusy] = useState<"download" | "moodboard" | null>(null);

  const images = useMemo((): GalleryImage[] => {
    if (selected.size === 0) return [];
    const byId = new Map(gallery.map((img) => [img.id, img]));
    return selectedInOrder(selected, orderedIds)
      .map((id) => byId.get(id))
      .filter((img): img is GalleryImage => Boolean(img));
  }, [selected, orderedIds, gallery]);

  const count = images.length;
  const likeTarget = nextLikedValue(images);
  const comparePair =
    count === 2 && images.every(isComparableImage) ? images : null;

  const togglePanel = (next: Exclude<Panel, null>) =>
    setPanel(panel === next ? null : next);

  const [confirm, confirmDialog] = useConfirm();
  const handleDownload = useCallback(async () => {
    const targets = images
      .map(downloadTarget)
      .filter((t): t is NonNullable<typeof t> => t !== null);
    if (targets.length === 0) return;
    if (
      targets.length > DOWNLOAD_CONFIRM_OVER &&
      !(await confirm({
        title: `Download ${targets.length} files?`,
        message: "Your browser may ask to allow multiple downloads.",
        confirmLabel: "Download",
      }))
    ) {
      return;
    }
    setBusy("download");
    try {
      for (const [i, target] of targets.entries()) {
        const link = document.createElement("a");
        link.href = target.href;
        link.download = target.filename;
        link.rel = "noopener";
        document.body.appendChild(link);
        link.click();
        link.remove();
        // Browsers drop rapid back-to-back downloads; space them out.
        if (i < targets.length - 1) await wait(DOWNLOAD_SPACING_MS);
      }
    } finally {
      setBusy(null);
    }
  }, [confirm, images]);

  const handleLike = useCallback(() => {
    if (count === 0) return;
    const ids = new Set(images.map((img) => img.id));
    useGenerationStore.setState((state) => ({
      gallery: setLikedByIds(state.gallery, ids, likeTarget),
    }));
    showToast(
      `${likeTarget ? "Liked" : "Unliked"} ${count} item${count === 1 ? "" : "s"}`,
      "success",
      2000,
    );
  }, [count, images, likeTarget]);

  const handleTrash = useCallback(async () => {
    if (count === 0) return;
    if (
      !(await confirm({
        title: `Remove ${count} item${count === 1 ? "" : "s"} from your feed?`,
        message: "This can't be undone.",
        confirmLabel: "Remove",
        danger: true,
      }))
    ) {
      return;
    }
    for (const img of images) removeFromGallery(img.id);
    clear();
    showToast(`Removed ${count} item${count === 1 ? "" : "s"}`, "info", 2500);
  }, [confirm, count, images, removeFromGallery, clear]);

  return (
    <>
      {confirmDialog}
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-[45] flex flex-col items-center gap-2 px-3 md:bottom-6">
        {panel === "moodboard" && (
          <MoodboardPanel
            images={images}
            busy={busy === "moodboard"}
            setBusy={(b) => setBusy(b ? "moodboard" : null)}
            onDone={() => setPanel(null)}
          />
        )}
        {panel === "folder" && (
          <FolderPanel images={images} onDone={() => setPanel(null)} />
        )}

        <div
          role="toolbar"
          aria-label="Selection actions"
          className="pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-[var(--border-primary)] bg-[var(--bg-secondary)] py-1 pl-3 pr-1 shadow-2xl [scrollbar-width:none] motion-safe:animate-[selectionBarIn_160ms_ease-out]"
        >
          <span
            className="mr-1 whitespace-nowrap text-sm font-medium tabular-nums text-[var(--text-primary)]"
            aria-live="polite"
          >
            {count === 0 ? "Tap to select" : `${count} selected`}
          </span>
          {count < orderedIds.length && (
            <button
              type="button"
              onClick={selectAll}
              className="flex-shrink-0 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              title="Select all loaded (Ctrl/Cmd+A)"
            >
              All
            </button>
          )}
          <span className="mx-0.5 h-5 w-px flex-shrink-0 bg-[var(--border-primary)]" />

          <button
            type="button"
            onClick={() => void handleDownload()}
            disabled={count === 0 || busy === "download"}
            className={BAR_BUTTON}
            title="Download"
            aria-label="Download selected"
          >
            {busy === "download" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            <span className={BAR_LABEL}>Download</span>
          </button>
          <button
            type="button"
            onClick={handleLike}
            disabled={count === 0}
            className={BAR_BUTTON}
            title={likeTarget ? "Like" : "Unlike"}
            aria-label={likeTarget ? "Like selected" : "Unlike selected"}
          >
            <Heart
              className={`h-4 w-4 ${!likeTarget ? "fill-current text-[var(--accent-primary)]" : ""}`}
            />
            <span className={BAR_LABEL}>{likeTarget ? "Like" : "Unlike"}</span>
          </button>
          <button
            type="button"
            onClick={() => togglePanel("moodboard")}
            disabled={count === 0}
            className={`${BAR_BUTTON} ${panel === "moodboard" ? "bg-[var(--bg-hover)] text-[var(--text-primary)]" : ""}`}
            title="Add to moodboard"
            aria-label="Add selected to moodboard"
            aria-expanded={panel === "moodboard"}
          >
            <LayoutDashboard className="h-4 w-4" />
            <span className={BAR_LABEL}>Moodboard</span>
          </button>
          <button
            type="button"
            onClick={() => togglePanel("folder")}
            disabled={count === 0}
            className={`${BAR_BUTTON} ${panel === "folder" ? "bg-[var(--bg-hover)] text-[var(--text-primary)]" : ""}`}
            title="Move to folder"
            aria-label="Move selected to folder"
            aria-expanded={panel === "folder"}
          >
            <FolderInput className="h-4 w-4" />
            <span className={BAR_LABEL}>Folder</span>
          </button>
          {comparePair && (
            <button
              type="button"
              onClick={() => setCompareOpen(true)}
              className={BAR_BUTTON}
              title="Compare the two selected images"
              aria-label="Compare selected"
            >
              <Columns2 className="h-4 w-4" />
              <span className={BAR_LABEL}>Compare</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleTrash()}
            disabled={count === 0}
            className={`${BAR_BUTTON} hover:bg-[var(--error)]/15 hover:text-[var(--error)]`}
            title="Trash"
            aria-label="Trash selected"
          >
            <Trash2 className="h-4 w-4" />
            <span className={BAR_LABEL}>Trash</span>
          </button>

          <span className="mx-0.5 h-5 w-px flex-shrink-0 bg-[var(--border-primary)]" />
          {count > 0 && (
            <button
              type="button"
              onClick={clear}
              className="flex-shrink-0 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              title="Clear selection"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={exit}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            title="Exit select mode (Esc)"
            aria-label="Exit select mode"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {compareOpen && comparePair && (
        <CompareDialog
          left={comparePair[0]}
          right={comparePair[1]}
          onClose={() => setCompareOpen(false)}
        />
      )}

      <style>{`@keyframes selectionBarIn{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}`}</style>
    </>
  );
}

const PANEL_CLASS =
  "pointer-events-auto w-[min(320px,100%)] rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-1.5 shadow-2xl";

function MoodboardPanel({
  images,
  busy,
  setBusy,
  onDone,
}: {
  images: GalleryImage[];
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onDone: () => void;
}) {
  const moodboards = useStyleStore((s) => s.moodboards);
  const loading = useStyleStore((s) => s.moodboardsLoading);
  const fetchMoodboards = useStyleStore((s) => s.fetchMoodboards);
  const updateMoodboard = useStyleStore((s) => s.updateMoodboard);
  const createMoodboard = useStyleStore((s) => s.createMoodboard);
  const eligible = useMemo(() => images.filter(isMoodboardEligible), [images]);
  const skippedMedia = images.length - eligible.length;

  useEffect(() => {
    void fetchMoodboards();
  }, [fetchMoodboards]);

  const addTo = async (boardId: string) => {
    const board = useStyleStore
      .getState()
      .moodboards.find((b) => b.id === boardId);
    if (!board) return;
    const merge = mergeIntoMoodboard(
      board.images,
      eligible,
      MOODBOARD_MAX_IMAGES,
    );
    if (merge.added === 0) {
      showToast(
        merge.overflow > 0
          ? `"${board.name}" is full (${MOODBOARD_MAX_IMAGES} images max)`
          : `Already on "${board.name}"`,
        "info",
      );
      return;
    }
    setBusy(true);
    try {
      await updateMoodboard({ id: boardId, images: merge.images });
      const saved = useStyleStore
        .getState()
        .moodboards.find((b) => b.id === boardId);
      if (saved && saved.images.length >= merge.images.length) {
        const extra =
          merge.overflow > 0 ? ` · ${merge.overflow} didn't fit` : "";
        showToast(`Added ${merge.added} to "${board.name}"${extra}`, "success");
        onDone();
      } else {
        showToast("Couldn't update that moodboard. Try again.", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const createFromSelection = async () => {
    const name = window.prompt("Name the new moodboard", "Create picks");
    const trimmed = name?.trim();
    if (!trimmed) return;
    const merge = mergeIntoMoodboard([], eligible, MOODBOARD_MAX_IMAGES);
    setBusy(true);
    try {
      const board = await createMoodboard({
        name: trimmed.slice(0, 100),
        images: merge.images,
      });
      if (board) {
        const extra =
          merge.overflow > 0 ? ` · ${merge.overflow} didn't fit` : "";
        showToast(
          `Created "${board.name}" with ${merge.added}${extra}`,
          "success",
        );
        onDone();
      } else {
        showToast("Couldn't create the moodboard. Try again.", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={PANEL_CLASS} role="dialog" aria-label="Add to moodboard">
      <div className="flex items-center justify-between px-2 pb-1 pt-1 text-[11px] text-[var(--text-muted)]">
        <span>Add to moodboard</span>
        {(busy || loading) && <Loader2 className="h-3 w-3 animate-spin" />}
      </div>
      {skippedMedia > 0 && (
        <p className="px-2 pb-1 text-xs text-[var(--text-muted)]">
          {skippedMedia} video/audio item{skippedMedia === 1 ? "" : "s"} will be
          skipped.
        </p>
      )}
      <div className="max-h-56 overflow-y-auto">
        {moodboards.length === 0 && !loading && (
          <p className="px-2 py-1.5 text-sm text-[var(--text-muted)]">
            No moodboards yet.
          </p>
        )}
        {moodboards.map((board) => (
          <button
            key={board.id}
            type="button"
            disabled={busy || eligible.length === 0}
            onClick={() => void addTo(board.id)}
            className={PANEL_ROW}
          >
            <LayoutDashboard className="h-4 w-4 flex-shrink-0" />
            <span className="flex-1 truncate">{board.name}</span>
            <span className="text-xs tabular-nums text-[var(--text-muted)]">
              {board.images.length}/{MOODBOARD_MAX_IMAGES}
            </span>
          </button>
        ))}
      </div>
      <div className="mt-1 border-t border-[var(--border-primary)] pt-1">
        <button
          type="button"
          disabled={busy || eligible.length === 0}
          onClick={() => void createFromSelection()}
          className={PANEL_ROW}
        >
          <Plus className="h-4 w-4" /> New moodboard from selection
        </button>
      </div>
    </div>
  );
}

function FolderPanel({
  images,
  onDone,
}: {
  images: GalleryImage[];
  onDone: () => void;
}) {
  const folders = useGenerationStore((s) => s.folders);
  const addFolder = useGenerationStore((s) => s.addFolder);
  const [newName, setNewName] = useState("");

  const moveTo = (folderId: string, folderName: string) => {
    const ids = new Set(images.map((img) => img.id));
    useGenerationStore.setState((state) => ({
      gallery: moveToFolderByIds(state.gallery, ids, folderId),
    }));
    showToast(
      `Moved ${ids.size} item${ids.size === 1 ? "" : "s"} to "${folderName}"`,
      "success",
      2500,
    );
    onDone();
  };

  const createAndMove = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    addFolder(trimmed);
    const created = [...useGenerationStore.getState().folders]
      .reverse()
      .find((f) => f.name === trimmed);
    if (created) moveTo(created.id, created.name);
    setNewName("");
  };

  return (
    <div className={PANEL_CLASS} role="dialog" aria-label="Move to folder">
      <div className="px-2 pb-1 pt-1 text-[11px] text-[var(--text-muted)]">
        Move to folder
      </div>
      <div className="max-h-56 overflow-y-auto">
        {folders.length === 0 && (
          <p className="px-2 py-1.5 text-sm text-[var(--text-muted)]">
            No folders yet. Name one below.
          </p>
        )}
        {folders.map((folder) => (
          <button
            key={folder.id}
            type="button"
            onClick={() => moveTo(folder.id, folder.name)}
            className={PANEL_ROW}
          >
            <FolderInput className="h-4 w-4 flex-shrink-0" />
            <span className="flex-1 truncate">{folder.name}</span>
          </button>
        ))}
      </div>
      <form
        className="mt-1 flex items-center gap-1 border-t border-[var(--border-primary)] px-1 pt-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          createAndMove();
        }}
      >
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New folder"
          aria-label="New folder name"
          maxLength={80}
          className="h-8 min-w-0 flex-1 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent-primary)]"
        />
        <button
          type="submit"
          disabled={!newName.trim()}
          className="h-8 rounded-md px-2.5 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
        >
          Create
        </button>
      </form>
    </div>
  );
}

function CompareDialog({
  left,
  right,
  onClose,
}: {
  left: GalleryImage;
  right: GalleryImage;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col bg-black/90 p-3 md:p-8"
      role="dialog"
      aria-modal="true"
      aria-label="Compare two images"
      onClick={onClose}
    >
      <div className="mb-2 flex items-center justify-between text-sm text-white/80">
        <span>Drag to compare · arrows nudge · double-click resets</span>
        <button
          type="button"
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-full text-white/80 hover:bg-white/10 hover:text-white"
          aria-label="Close compare"
          title="Close (Esc)"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <div
        className="relative min-h-0 flex-1"
        onClick={(e) => e.stopPropagation()}
      >
        <CompareSlider
          leftUrl={left.url}
          rightUrl={right.url}
          leftAlt={left.prompt}
          rightAlt={right.prompt}
          leftLabel="A"
          rightLabel="B"
        />
      </div>
    </div>
  );
}

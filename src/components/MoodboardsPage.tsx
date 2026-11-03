"use client";

import {
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
  type DragEvent,
  type ChangeEvent,
} from "react";
import { useUIStore, useGenerationStore, selectCompletedRuns } from "@/store";
import { shallow } from "zustand/shallow";
import { useStyleStore } from "@/store/styleStore";
import { useNavParams, navigateTo } from "@/hooks";
import type { MoodboardImage } from "@/types";
import {
  BookImage,
  Plus,
  Image as ImageIcon,
  ArrowLeft,
  Wand2,
  Trash2,
  X,
  CheckCircle,
  Loader2,
  Upload,
  Link2,
  Grid3x3,
  Minus,
  Check,
  Search,
  FolderInput,
  MessageSquareText,
  Tags,
  GitMerge,
  SquareCheckBig,
  Sparkles,
  Pencil,
} from "lucide-react";
import {
  COLLECTION_SORT_OPTIONS,
  normalizeRename,
  scopeCollection,
  sortCollection,
  type CollectionScope,
  type CollectionSort,
} from "@/lib/collectionView";
import {
  CollectionToolbar,
  HeroHeader,
  ImageCollage,
  ToolbarButton,
  ToolbarPrimaryButton,
} from "@/components/PageHeader";
import { autosortMoodboards, captionMoodboard } from "@/lib/sref/apiClient";
import { LoraRunPanel } from "@/components/training/LoraRunPanel";
import {
  bulkDeleteMoodboards,
  bulkMergeMoodboards,
  bulkTagMoodboards,
} from "@/lib/sref/moodboardClient";
import { showToast } from "@/components/Toast";
import { StateView } from "@/components/ui/StateView";
import { useConfirm } from "@/components/ui/ConfirmDialog";

// How many boards to render at once in the list view. The Krea import can add
// thousands of boards; rendering them all eagerly (each with an <img> fetch)
// janks the page, so we page in chunks and lazy-load thumbnails.
const LIST_PAGE_SIZE = 60;

type AddImageTab = "upload" | "link" | "gallery";

/**
 * MoodboardsPage — shows moodboard listing or detail view.
 *
 * Detail view includes an "Add Images" section with 3 tabs:
 * - Upload: drag-and-drop / file picker
 * - Link: paste an image URL with weight slider
 * - From Gallery: select from completed generation images
 *
 * Each image card has weight adjuster and remove button.
 */
export function MoodboardsPage() {
  const activeNav = useUIStore((s) => s.activeNav);
  const { id: moodboardId, hasParams } = useNavParams();

  const moodboards = useStyleStore((s) => s.moodboards);
  const moodboardsLoading = useStyleStore((s) => s.moodboardsLoading);
  const moodboardsError = useStyleStore((s) => s.moodboardsError);
  const fetchMoodboards = useStyleStore((s) => s.fetchMoodboards);
  const applyMoodboardToSREF = useStyleStore((s) => s.applyMoodboardToSREF);
  const setSREFPanelOpen = useStyleStore((s) => s.setSREFPanelOpen);
  const createMoodboard = useStyleStore((s) => s.createMoodboard);
  const updateMoodboard = useStyleStore((s) => s.updateMoodboard);
  const deleteMoodboard = useStyleStore((s) => s.deleteMoodboard);

  // selectCompletedRuns filters into a fresh array; without shallow equality
  // every store write (WS progress ticks) re-rendered this whole page and
  // rebuilt galleryImages.
  const completedRuns = useGenerationStore(selectCompletedRuns, shallow);

  // Create moodboard dialog state
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newBoardName, setNewBoardName] = useState("");
  const [newBoardDesc, setNewBoardDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Add-image state
  const [addTab, setAddTab] = useState<AddImageTab>("upload");
  const [showAddPanel, setShowAddPanel] = useState(false);

  // Upload tab state
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Link tab state
  const [linkUrl, setLinkUrl] = useState("");
  const [linkWeight, setLinkWeight] = useState(1);
  const [linkPreviewError, setLinkPreviewError] = useState(false);
  const [addingLink, setAddingLink] = useState(false);

  // Gallery tab state
  const [selectedGalleryUrls, setSelectedGalleryUrls] = useState<Set<string>>(
    new Set(),
  );
  const [addingGallery, setAddingGallery] = useState(false);

  // Image operation state
  const [updatingImages, setUpdatingImages] = useState(false);
  const [captioning, setCaptioning] = useState(false);
  const [captionEditor, setCaptionEditor] = useState<{
    boardId: string;
    imageIndex: number;
  } | null>(null);
  const [captionDraft, setCaptionDraft] = useState("");

  // List view search + incremental paging (handles thousands of imported boards)
  const [listQuery, setListQuery] = useState("");
  const [listLimit, setListLimit] = useState(LIST_PAGE_SIZE);
  const [selectedBoardIds, setSelectedBoardIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedTagFilters, setSelectedTagFilters] = useState<Set<string>>(
    new Set(),
  );
  const longPressTimerRef = useRef<number | null>(null);
  const longPressedRef = useRef(false);
  const [bulkAction, setBulkAction] = useState<
    "delete" | "tag" | "merge" | null
  >(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkSuccess, setBulkSuccess] = useState<string | null>(null);
  const [showBulkTagDialog, setShowBulkTagDialog] = useState(false);
  const [bulkTagInput, setBulkTagInput] = useState("");
  const [bulkTagMode, setBulkTagMode] = useState<"add" | "remove">("add");
  const [showBulkMergeDialog, setShowBulkMergeDialog] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState("");

  // Auto-sort dialog state
  const [showAutosortDialog, setShowAutosortDialog] = useState(false);
  const [autosortDir, setAutosortDir] = useState("");
  const [autosortMinClusterSize, setAutosortMinClusterSize] = useState(4);
  const [autosortModel, setAutosortModel] = useState("color-histogram");
  const [autosortNamePrefix, setAutosortNamePrefix] = useState("Auto");
  const [autosorting, setAutosorting] = useState(false);
  const [autosortError, setAutosortError] = useState<string | null>(null);
  const [autosortSuccess, setAutosortSuccess] = useState<string | null>(null);

  // Toolbar: All/Selected scope + Latest/Oldest/Name sort.
  const [listScope, setListScope] = useState<CollectionScope>("all");
  const [listSort, setListSort] = useState<CollectionSort>("latest");

  // Explicit rename (pencil action) — clicking a board name only opens it.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameTargetRef = useRef<string | null>(null);

  const filteredBoards = useMemo(() => {
    const q = listQuery.trim().toLowerCase();
    const tagFilters = Array.from(selectedTagFilters);
    const matched = moodboards.filter(
      (b) =>
        (!q ||
          b.name.toLowerCase().includes(q) ||
          (b.description?.toLowerCase().includes(q) ?? false)) &&
        tagFilters.every((tag) => b.tags?.includes(tag)),
    );
    return sortCollection(
      scopeCollection(matched, listScope, selectedBoardIds),
      listSort,
    );
  }, [
    moodboards,
    listQuery,
    selectedTagFilters,
    listScope,
    listSort,
    selectedBoardIds,
  ]);

  const visibleBoards = useMemo(
    () => filteredBoards.slice(0, listLimit),
    [filteredBoards, listLimit],
  );
  const allMoodboardTags = useMemo(
    () =>
      Array.from(new Set(moodboards.flatMap((board) => board.tags ?? []))).sort(
        (a, b) => a.localeCompare(b),
      ),
    [moodboards],
  );
  const selectedBoards = useMemo(
    () => moodboards.filter((board) => selectedBoardIds.has(board.id)),
    [moodboards, selectedBoardIds],
  );
  const selectedCount = selectedBoardIds.size;
  const visibleIds = useMemo(
    () => visibleBoards.map((board) => board.id),
    [visibleBoards],
  );
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedBoardIds.has(id));

  // Reset paging whenever the query, sort or scope changes.
  useEffect(() => {
    setListLimit(LIST_PAGE_SIZE);
  }, [listQuery, selectedTagFilters, listSort, listScope]);

  const startRename = useCallback((id: string, currentName: string) => {
    renameTargetRef.current = id;
    setRenameDraft(currentName);
    setRenamingId(id);
  }, []);

  const cancelRename = useCallback(() => {
    renameTargetRef.current = null;
    setRenamingId(null);
  }, []);

  // Enter and blur both land here; the ref makes the second call a no-op so
  // one rename never PATCHes twice.
  const commitRename = useCallback(
    async (id: string, currentName: string, draft: string) => {
      if (renameTargetRef.current !== id) return;
      renameTargetRef.current = null;
      setRenamingId(null);
      const next = normalizeRename(draft, currentName);
      if (!next) return;
      await updateMoodboard({ id, name: next });
    },
    [updateMoodboard],
  );

  const renameInput = (id: string, currentName: string, className: string) => (
    <input
      autoFocus
      value={renameDraft}
      maxLength={100}
      aria-label={`Rename ${currentName}`}
      onChange={(e) => setRenameDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => void commitRename(id, currentName, renameDraft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void commitRename(id, currentName, renameDraft);
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelRename();
        }
      }}
      className={className}
    />
  );

  const toggleBoardSelected = useCallback((id: string) => {
    setSelectedBoardIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearBulkState = useCallback(() => {
    setSelectedBoardIds(new Set());
    setBulkError(null);
  }, []);

  const [confirm, confirmDialog] = useConfirm();
  const handleBulkDelete = useCallback(async () => {
    const ids = Array.from(selectedBoardIds);
    if (ids.length === 0) return;
    const ok = await confirm({
      title: `Delete ${ids.length} moodboard${ids.length === 1 ? "" : "s"}?`,
      message: "This can't be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBulkAction("delete");
    setBulkError(null);
    setBulkSuccess(null);
    try {
      const res = await bulkDeleteMoodboards(ids);
      if (!res.ok) {
        setBulkError(res.error ?? "Bulk delete failed.");
        return;
      }
      clearBulkState();
      setBulkSuccess(
        `Deleted ${res.deleted?.length ?? ids.length} moodboards.`,
      );
      await fetchMoodboards();
    } catch {
      setBulkError("Bulk delete failed. Please try again.");
    } finally {
      setBulkAction(null);
    }
  }, [clearBulkState, confirm, fetchMoodboards, selectedBoardIds]);

  const handleBulkTag = useCallback(async () => {
    const ids = Array.from(selectedBoardIds);
    const tags = bulkTagInput
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (ids.length === 0 || tags.length === 0) return;
    setBulkAction("tag");
    setBulkError(null);
    setBulkSuccess(null);
    try {
      const res = await bulkTagMoodboards({ ids, tags, mode: bulkTagMode });
      if (!res.ok) {
        setBulkError(res.error ?? "Bulk tag update failed.");
        return;
      }
      setShowBulkTagDialog(false);
      setBulkTagInput("");
      clearBulkState();
      setBulkSuccess(
        `Updated tags on ${res.updated?.length ?? ids.length} moodboards.`,
      );
      await fetchMoodboards();
    } catch {
      setBulkError("Bulk tag update failed. Please try again.");
    } finally {
      setBulkAction(null);
    }
  }, [
    bulkTagInput,
    bulkTagMode,
    clearBulkState,
    fetchMoodboards,
    selectedBoardIds,
  ]);

  const handleBulkMerge = useCallback(async () => {
    const ids = Array.from(selectedBoardIds);
    if (ids.length < 2 || !mergeTargetId) return;
    setBulkAction("merge");
    setBulkError(null);
    setBulkSuccess(null);
    try {
      const res = await bulkMergeMoodboards({ ids, targetId: mergeTargetId });
      if (!res.ok) {
        setBulkError(res.error ?? "Bulk merge failed.");
        return;
      }
      setShowBulkMergeDialog(false);
      setMergeTargetId("");
      clearBulkState();
      setBulkSuccess(
        `Merged ${res.deleted?.length ?? ids.length - 1} moodboards.`,
      );
      await fetchMoodboards();
    } catch {
      setBulkError("Bulk merge failed. Please try again.");
    } finally {
      setBulkAction(null);
    }
  }, [clearBulkState, fetchMoodboards, mergeTargetId, selectedBoardIds]);

  const handleCreate = useCallback(async () => {
    if (!newBoardName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const board = await createMoodboard({
        name: newBoardName.trim(),
        description: newBoardDesc.trim() || undefined,
        images: [],
        isDefault: moodboards.length === 0,
      });
      if (board) {
        setShowCreateDialog(false);
        setNewBoardName("");
        setNewBoardDesc("");
        navigateTo("moodboards", { id: board.id });
      } else {
        setCreateError("Failed to create moodboard. Check your connection.");
      }
    } catch {
      setCreateError("Something went wrong. Please try again.");
    } finally {
      setCreating(false);
    }
  }, [newBoardName, newBoardDesc, createMoodboard, moodboards.length]);

  const handleAutosort = useCallback(async () => {
    if (!autosortDir.trim()) return;
    setAutosorting(true);
    setAutosortError(null);
    setAutosortSuccess(null);
    try {
      const res = await autosortMoodboards({
        dir: autosortDir.trim(),
        minClusterSize: autosortMinClusterSize,
        model: autosortModel,
        namePrefix: autosortNamePrefix.trim() || undefined,
      });
      if (!res.ok) {
        setAutosortError(res.error ?? "Auto-sort failed.");
        return;
      }
      setShowAutosortDialog(false);
      setAutosortSuccess(
        `Created ${res.created} moodboards (${res.skipped} images skipped, ${res.noise} noise).`,
      );
      await fetchMoodboards();
    } catch {
      setAutosortError("Auto-sort failed. Please try again.");
    } finally {
      setAutosorting(false);
    }
  }, [
    autosortDir,
    autosortMinClusterSize,
    autosortModel,
    autosortNamePrefix,
    fetchMoodboards,
  ]);

  useEffect(() => {
    if (activeNav === "moodboards") {
      fetchMoodboards();
    }
  }, [activeNav, fetchMoodboards]);

  useEffect(
    () => () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
      }
    },
    [],
  );

  const selectedBoard = useMemo(
    () =>
      moodboardId
        ? (moodboards.find((b) => b.id === moodboardId) ?? null)
        : null,
    [moodboardId, moodboards],
  );

  // Image mutation helpers

  const addImagesToBoard = useCallback(
    async (
      boardId: string,
      currentImages: MoodboardImage[],
      newImages: MoodboardImage[],
    ) => {
      const merged = [...currentImages, ...newImages].slice(0, 20); // API max 20
      await updateMoodboard({ id: boardId, images: merged });
    },
    [updateMoodboard],
  );

  const removeImageFromBoard = useCallback(
    async (boardId: string, currentImages: MoodboardImage[], index: number) => {
      setUpdatingImages(true);
      try {
        const updated = currentImages.filter((_, i) => i !== index);
        await updateMoodboard({ id: boardId, images: updated });
      } finally {
        setUpdatingImages(false);
      }
    },
    [updateMoodboard],
  );

  const updateImageWeight = useCallback(
    async (
      boardId: string,
      currentImages: MoodboardImage[],
      index: number,
      weight: number,
    ) => {
      const updated = currentImages.map((img, i) =>
        i === index ? { ...img, weight: Math.round(weight * 10) / 10 } : img,
      );
      await updateMoodboard({ id: boardId, images: updated });
    },
    [updateMoodboard],
  );

  const openCaptionEditor = useCallback(
    (boardId: string, currentImages: MoodboardImage[], index: number) => {
      setCaptionEditor({ boardId, imageIndex: index });
      setCaptionDraft(currentImages[index]?.caption ?? "");
    },
    [],
  );

  const updateImageCaption = useCallback(
    async (
      boardId: string,
      currentImages: MoodboardImage[],
      index: number,
      draft: string,
    ) => {
      const caption = draft.trim();
      const updated = currentImages.map((img, i) =>
        i === index
          ? caption
            ? { ...img, caption, captionSource: "manual" }
            : { ...img, caption: undefined, captionSource: undefined }
          : img,
      );
      setUpdatingImages(true);
      try {
        await updateMoodboard({ id: boardId, images: updated });
        setCaptionEditor(null);
        setCaptionDraft("");
      } finally {
        setUpdatingImages(false);
      }
    },
    [updateMoodboard],
  );

  const handleAutoCaption = useCallback(
    async (boardId: string) => {
      setCaptioning(true);
      try {
        const res = await captionMoodboard(boardId, { only_missing: true });
        if (!res.ok || !res.images) {
          showToast(res.error ?? "Auto-caption failed.", "error");
          return;
        }
        await fetchMoodboards();
        showToast(
          res.failed > 0
            ? `Captioned ${res.captioned}, failed ${res.failed}`
            : `Captioned ${res.captioned} images`,
          res.failed > 0 ? "error" : "success",
        );
      } catch {
        showToast("Auto-caption failed.", "error");
      } finally {
        setCaptioning(false);
      }
    },
    [fetchMoodboards],
  );

  // Upload handler

  const handleFileUpload = useCallback(
    async (
      files: FileList | File[],
      boardId: string,
      currentImages: MoodboardImage[],
    ) => {
      const imageFiles = Array.from(files).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (imageFiles.length === 0) {
        setUploadError("No valid image files selected.");
        return;
      }
      if (currentImages.length + imageFiles.length > 20) {
        setUploadError(
          `Can add at most ${20 - currentImages.length} more images (max 20).`,
        );
        return;
      }

      setUploading(true);
      setUploadError(null);

      try {
        const newImages: MoodboardImage[] = [];
        for (const file of imageFiles) {
          const formData = new FormData();
          formData.append("file", file);
          const res = await fetch("/api/moodboards/upload", {
            method: "POST",
            body: formData,
          });
          const data = await res.json();
          if (data.ok && data.url) {
            newImages.push({ url: data.url, weight: 1 });
          } else {
            setUploadError(data.error ?? "Upload failed");
            break;
          }
        }
        if (newImages.length > 0) {
          await addImagesToBoard(boardId, currentImages, newImages);
        }
      } catch {
        setUploadError("Upload failed. Please try again.");
      } finally {
        setUploading(false);
      }
    },
    [addImagesToBoard],
  );

  // Link handler

  const handleAddLink = useCallback(
    async (boardId: string, currentImages: MoodboardImage[]) => {
      if (!linkUrl.trim()) return;
      if (currentImages.length >= 20) {
        return;
      }
      setAddingLink(true);
      try {
        await addImagesToBoard(boardId, currentImages, [
          { url: linkUrl.trim(), weight: linkWeight },
        ]);
        setLinkUrl("");
        setLinkWeight(1);
        setLinkPreviewError(false);
      } finally {
        setAddingLink(false);
      }
    },
    [linkUrl, linkWeight, addImagesToBoard],
  );

  // Gallery handler

  const handleAddFromGallery = useCallback(
    async (boardId: string, currentImages: MoodboardImage[]) => {
      if (selectedGalleryUrls.size === 0) return;
      const remaining = 20 - currentImages.length;
      if (remaining <= 0) return;

      setAddingGallery(true);
      try {
        const newImages: MoodboardImage[] = Array.from(selectedGalleryUrls)
          .slice(0, remaining)
          .map((url) => ({ url, weight: 1 }));
        await addImagesToBoard(boardId, currentImages, newImages);
        setSelectedGalleryUrls(new Set());
      } finally {
        setAddingGallery(false);
      }
    },
    [selectedGalleryUrls, addImagesToBoard],
  );

  const galleryImages = useMemo(() => {
    const imgs: { url: string; prompt: string }[] = [];
    for (const run of completedRuns) {
      for (const job of run.jobs) {
        if (job.status === "done" && job.images) {
          for (const url of job.images) {
            imgs.push({ url, prompt: run.prompt });
          }
        }
      }
    }
    return imgs;
  }, [completedRuns]);

  // Drop handlers

  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const onDrop = useCallback(
    (e: DragEvent, boardId: string, currentImages: MoodboardImage[]) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files.length > 0) {
        handleFileUpload(e.dataTransfer.files, boardId, currentImages);
      }
    },
    [handleFileUpload],
  );

  const onFileChange = useCallback(
    (
      e: ChangeEvent<HTMLInputElement>,
      boardId: string,
      currentImages: MoodboardImage[],
    ) => {
      if (e.target.files && e.target.files.length > 0) {
        handleFileUpload(e.target.files, boardId, currentImages);
        e.target.value = "";
      }
    },
    [handleFileUpload],
  );

  if (activeNav !== "moodboards") return null;

  // Create moodboard dialog
  const createDialog = showCreateDialog ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-xl border border-light-100 bg-light-input p-6 shadow-lg dark:border-dark-750 dark:bg-dark-input">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-light-primary dark:text-dark-primary">
            New Moodboard
          </h2>
          <button
            aria-label="Close"
            onClick={() => {
              setShowCreateDialog(false);
              setCreateError(null);
            }}
            className="rounded-lg p-1 text-light-400 hover:text-light-primary dark:text-dark-500 dark:hover:text-dark-primary"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-light-500 dark:text-dark-400 mb-1">
              Name
            </label>
            <input
              aria-label="Moodboard name"
              type="text"
              value={newBoardName}
              onChange={(e) => setNewBoardName(e.target.value)}
              placeholder="My moodboard"
              className="input w-full text-sm"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && newBoardName.trim()) handleCreate();
              }}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-light-500 dark:text-dark-400 mb-1">
              Description{" "}
              <span className="text-light-300 dark:text-dark-600">
                (optional)
              </span>
            </label>
            <textarea
              aria-label="Description"
              value={newBoardDesc}
              onChange={(e) => setNewBoardDesc(e.target.value)}
              placeholder="A collection of style references for..."
              rows={2}
              className="input w-full resize-none text-sm"
            />
          </div>
          {createError && (
            <p className="text-xs text-rose-500">{createError}</p>
          )}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              onClick={() => {
                setShowCreateDialog(false);
                setCreateError(null);
              }}
              className="rounded-xl border border-light-100 bg-light-50 px-4 py-2 text-sm font-medium text-light-600 transition-[color,background-color,border-color] duration-150 hover:bg-light-100 dark:border-dark-750 dark:bg-dark-700 dark:text-dark-300 dark:hover:bg-dark-750"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!newBoardName.trim() || creating}
              className="flex items-center gap-2 rounded-xl bg-[var(--accent-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  const autosortDialog = showAutosortDialog ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-xl border border-light-100 bg-light-input p-6 shadow-lg dark:border-dark-750 dark:bg-dark-input">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-light-primary dark:text-dark-primary">
            Auto-sort Folder
          </h2>
          <button
            onClick={() => {
              setShowAutosortDialog(false);
              setAutosortError(null);
            }}
            disabled={autosorting}
            className="rounded-lg p-1 text-light-400 hover:text-light-primary disabled:opacity-40 dark:text-dark-500 dark:hover:text-dark-primary"
            title="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-light-500 dark:text-dark-400 mb-1">
              Directory path
            </label>
            <input
              aria-label="Directory path"
              type="text"
              value={autosortDir}
              onChange={(e) => setAutosortDir(e.target.value)}
              placeholder="/path/to/images"
              disabled={autosorting}
              className="input w-full text-sm disabled:opacity-60"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && autosortDir.trim()) handleAutosort();
              }}
            />
            <p className="mt-1 text-[10px] text-light-400 dark:text-dark-500">
              Server-local folder of images; must be inside your home dir (or
              MOODBOARD_IMPORT_ROOT).
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-light-500 dark:text-dark-400 mb-1">
              Min cluster size
            </label>
            <input
              aria-label="Min cluster size"
              type="number"
              min={2}
              value={autosortMinClusterSize}
              onChange={(e) =>
                setAutosortMinClusterSize(Number(e.target.value))
              }
              disabled={autosorting}
              className="input w-full text-sm disabled:opacity-60"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-light-500 dark:text-dark-400 mb-1">
              Embedding model
            </label>
            <select
              aria-label="Embedding model"
              value={autosortModel}
              onChange={(e) => setAutosortModel(e.target.value)}
              disabled={autosorting}
              className="input w-full text-sm disabled:opacity-60"
            >
              <option value="color-histogram">
                color-histogram (CPU-fast)
              </option>
              <option value="siglip2">siglip2</option>
            </select>
            <p className="mt-1 text-[10px] text-light-400 dark:text-dark-500">
              siglip2 downloads its model on first use.
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-light-500 dark:text-dark-400 mb-1">
              Name prefix{" "}
              <span className="text-light-300 dark:text-dark-600">
                (optional)
              </span>
            </label>
            <input
              aria-label="Name prefix"
              type="text"
              value={autosortNamePrefix}
              onChange={(e) => setAutosortNamePrefix(e.target.value)}
              placeholder="Auto"
              disabled={autosorting}
              className="input w-full text-sm disabled:opacity-60"
            />
          </div>
          {autosortError && (
            <p className="text-xs text-rose-500">{autosortError}</p>
          )}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              onClick={() => {
                setShowAutosortDialog(false);
                setAutosortError(null);
              }}
              disabled={autosorting}
              className="rounded-xl border border-light-100 bg-light-50 px-4 py-2 text-sm font-medium text-light-600 transition-[color,background-color,border-color] duration-150 hover:bg-light-100 disabled:opacity-40 dark:border-dark-750 dark:bg-dark-700 dark:text-dark-300 dark:hover:bg-dark-750"
            >
              Cancel
            </button>
            <button
              onClick={handleAutosort}
              disabled={!autosortDir.trim() || autosorting}
              className="flex items-center gap-2 rounded-xl bg-[var(--accent-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              {autosorting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FolderInput className="h-4 w-4" />
              )}
              Sort
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  const bulkTagDialog = showBulkTagDialog ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-xl border border-light-100 bg-light-input p-6 shadow-lg dark:border-dark-750 dark:bg-dark-input">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-light-primary dark:text-dark-primary">
            Tags
          </h2>
          <button
            onClick={() => setShowBulkTagDialog(false)}
            disabled={bulkAction === "tag"}
            className="rounded-lg p-1 text-light-400 hover:text-light-primary disabled:opacity-40 dark:text-dark-500 dark:hover:text-dark-primary"
            title="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-3">
          <div className="flex rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-1">
            {(["add", "remove"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setBulkTagMode(mode)}
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  bulkTagMode === mode
                    ? "bg-[var(--accent-primary)] text-white"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
              >
                {mode === "add" ? "Add" : "Remove"}
              </button>
            ))}
          </div>
          <input
            aria-label="Tags"
            type="text"
            value={bulkTagInput}
            onChange={(e) => setBulkTagInput(e.target.value)}
            placeholder="tag-a, tag-b"
            disabled={bulkAction === "tag"}
            className="input w-full text-sm disabled:opacity-60"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") handleBulkTag();
            }}
          />
          {bulkError && <p className="text-xs text-rose-500">{bulkError}</p>}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              onClick={() => setShowBulkTagDialog(false)}
              disabled={bulkAction === "tag"}
              className="rounded-xl border border-light-100 bg-light-50 px-4 py-2 text-sm font-medium text-light-600 transition-[color,background-color,border-color] duration-150 hover:bg-light-100 disabled:opacity-40 dark:border-dark-750 dark:bg-dark-700 dark:text-dark-300 dark:hover:bg-dark-750"
            >
              Cancel
            </button>
            <button
              onClick={handleBulkTag}
              disabled={!bulkTagInput.trim() || bulkAction === "tag"}
              className="flex items-center gap-2 rounded-xl bg-[var(--accent-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              {bulkAction === "tag" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Tags className="h-4 w-4" />
              )}
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  const bulkMergeDialog = showBulkMergeDialog ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-xl border border-light-100 bg-light-input p-6 shadow-lg dark:border-dark-750 dark:bg-dark-input">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-light-primary dark:text-dark-primary">
            Merge
          </h2>
          <button
            onClick={() => setShowBulkMergeDialog(false)}
            disabled={bulkAction === "merge"}
            className="rounded-lg p-1 text-light-400 hover:text-light-primary disabled:opacity-40 dark:text-dark-500 dark:hover:text-dark-primary"
            title="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-3">
          <select
            aria-label="Merge into"
            value={mergeTargetId}
            onChange={(e) => setMergeTargetId(e.target.value)}
            disabled={bulkAction === "merge"}
            className="input w-full text-sm disabled:opacity-60"
            autoFocus
          >
            {selectedBoards.map((board) => (
              <option key={board.id} value={board.id}>
                {board.name}
              </option>
            ))}
          </select>
          {bulkError && <p className="text-xs text-rose-500">{bulkError}</p>}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              onClick={() => setShowBulkMergeDialog(false)}
              disabled={bulkAction === "merge"}
              className="rounded-xl border border-light-100 bg-light-50 px-4 py-2 text-sm font-medium text-light-600 transition-[color,background-color,border-color] duration-150 hover:bg-light-100 disabled:opacity-40 dark:border-dark-750 dark:bg-dark-700 dark:text-dark-300 dark:hover:bg-dark-750"
            >
              Cancel
            </button>
            <button
              onClick={handleBulkMerge}
              disabled={
                !mergeTargetId || selectedCount < 2 || bulkAction === "merge"
              }
              className="flex items-center gap-2 rounded-xl bg-[var(--accent-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              {bulkAction === "merge" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <GitMerge className="h-4 w-4" />
              )}
              Merge
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  // Detail view
  if (hasParams && moodboardId) {
    if (!selectedBoard && !moodboardsLoading) {
      return (
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <header className="flex-shrink-0 px-6 py-4 border-b border-[var(--border-primary)] flex items-center gap-3">
            <button
              onClick={() => navigateTo("moodboards")}
              className="flex items-center gap-1 text-xs text-light-500 hover:text-light-primary dark:text-dark-400 dark:hover:text-dark-primary transition-[color] duration-150"
            >
              <ArrowLeft className="w-4 h-4" /> Moodboards
            </button>
          </header>
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <BookImage className="mx-auto h-10 w-10 text-light-300 dark:text-dark-500" />
              <p className="mt-3 text-sm font-medium text-light-primary dark:text-dark-primary">
                Moodboard not found
              </p>
              <button
                onClick={() => navigateTo("moodboards")}
                className="mt-3 text-xs text-splash hover:underline"
              >
                Back to moodboards
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (moodboardsLoading) {
      return (
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <header className="flex-shrink-0 px-6 py-4 border-b border-[var(--border-primary)] flex items-center gap-3">
            <button
              onClick={() => navigateTo("moodboards")}
              className="flex items-center gap-1 text-xs text-light-500 hover:text-light-primary dark:text-dark-400 dark:hover:text-dark-primary transition-[color] duration-150"
            >
              <ArrowLeft className="w-4 h-4" /> Moodboards
            </button>
            <span className="text-sm text-light-400 dark:text-dark-500">
              Loading...
            </span>
          </header>
        </div>
      );
    }

    const board = selectedBoard!;
    const hasImages = board.images.length > 0;
    const canAddMore = board.images.length < 20;
    const captionDialog =
      captionEditor && captionEditor.boardId === board.id ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-6 shadow-lg">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                Edit caption
              </h2>
              <button
                onClick={() => setCaptionEditor(null)}
                disabled={updatingImages}
                className="rounded-lg p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-40"
                title="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <textarea
              aria-label="Caption"
              value={captionDraft}
              onChange={(e) => setCaptionDraft(e.target.value)}
              rows={5}
              className="input w-full resize-none text-sm"
              autoFocus
            />
            {board.images[captionEditor.imageIndex]?.captionSource && (
              <p className="mt-2 text-xs text-[var(--text-muted)]">
                source: {board.images[captionEditor.imageIndex]?.captionSource}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setCaptionEditor(null)}
                disabled={updatingImages}
                className="rounded-xl border border-[var(--border-primary)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-primary)] disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={() =>
                  updateImageCaption(
                    board.id,
                    board.images,
                    captionEditor.imageIndex,
                    captionDraft,
                  )
                }
                disabled={updatingImages}
                className="flex items-center gap-2 rounded-xl bg-[var(--accent-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
              >
                {updatingImages && <Loader2 className="h-4 w-4 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null;
    // Add images panel
    const addImagesPanel = (
      <div className="border-t border-[var(--border-primary)] bg-[var(--bg-secondary)]">
        <div className="flex items-center border-b border-[var(--border-primary)]">
          {(
            [
              { key: "upload" as AddImageTab, icon: Upload, label: "Upload" },
              { key: "link" as AddImageTab, icon: Link2, label: "Link" },
              {
                key: "gallery" as AddImageTab,
                icon: Grid3x3,
                label: "From Gallery",
              },
            ] as const
          ).map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              onClick={() => setAddTab(key)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors ${
                addTab === key
                  ? "text-[var(--accent-primary)] border-b-2 border-[var(--accent-primary)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
          <div className="flex-1" />
          {hasImages && (
            <button
              aria-label="Close add panel"
              onClick={() => setShowAddPanel(false)}
              className="mr-2 p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="p-4">
          {addTab === "upload" && (
            <div>
              <div
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={(e) => onDrop(e, board.id, board.images)}
                onClick={() => fileInputRef.current?.click()}
                className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 cursor-pointer transition-colors ${
                  dragOver
                    ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]/5"
                    : "border-[var(--border-primary)] hover:border-[var(--text-muted)]"
                }`}
              >
                {uploading ? (
                  <Loader2 className="w-8 h-8 text-[var(--accent-primary)] animate-spin" />
                ) : (
                  <Upload className="w-8 h-8 text-[var(--text-muted)]" />
                )}
                <p className="text-sm text-[var(--text-muted)]">
                  {uploading
                    ? "Uploading..."
                    : "Drop images here or click to browse"}
                </p>
                <p className="text-[10px] text-[var(--text-muted)]">
                  JPG, PNG, WebP, GIF, AVIF (max 10MB each)
                </p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => onFileChange(e, board.id, board.images)}
              />
              {uploadError && (
                <p className="mt-2 text-xs text-rose-500">{uploadError}</p>
              )}
            </div>
          )}

          {addTab === "link" && (
            <div className="space-y-3">
              <div className="flex gap-2">
                <input
                  aria-label="Image URL"
                  type="url"
                  value={linkUrl}
                  onChange={(e) => {
                    setLinkUrl(e.target.value);
                    setLinkPreviewError(false);
                  }}
                  placeholder="https://example.com/image.jpg"
                  className="input flex-1 text-sm"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && linkUrl.trim()) {
                      handleAddLink(board.id, board.images);
                    }
                  }}
                />
                <button
                  onClick={() => handleAddLink(board.id, board.images)}
                  disabled={!linkUrl.trim() || addingLink || !canAddMore}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--accent-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-40"
                >
                  {addingLink ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Plus className="w-4 h-4" />
                  )}
                  Add
                </button>
              </div>

              <div className="flex items-center gap-3">
                <label className="text-xs text-[var(--text-muted)] whitespace-nowrap">
                  Weight
                </label>
                <input
                  aria-label="Weight"
                  type="range"
                  min="0"
                  max="5"
                  step="0.1"
                  value={linkWeight}
                  onChange={(e) => setLinkWeight(parseFloat(e.target.value))}
                  className="flex-1 h-1.5 accent-[var(--accent-primary)]"
                />
                <span className="text-xs font-mono text-[var(--text-primary)] w-8 text-right">
                  {linkWeight.toFixed(1)}
                </span>
              </div>

              {linkUrl.trim() && !linkPreviewError && (
                <div className="mt-2 w-32 h-32 rounded-lg overflow-hidden bg-[var(--bg-primary)] border border-[var(--border-primary)]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={linkUrl.trim()}
                    alt="Preview"
                    className="w-full h-full object-cover"
                    onError={() => setLinkPreviewError(true)}
                  />
                </div>
              )}
              {linkPreviewError && linkUrl.trim() && (
                <p className="text-xs text-[var(--text-muted)]">
                  Could not load preview. The URL will still be saved.
                </p>
              )}
            </div>
          )}

          {addTab === "gallery" && (
            <div>
              {galleryImages.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 gap-2">
                  <ImageIcon className="w-8 h-8 text-[var(--text-muted)]" />
                  <p className="text-sm text-[var(--text-muted)]">
                    No generated images yet
                  </p>
                  <p className="text-[10px] text-[var(--text-muted)]">
                    Generate some images first, then add them here.
                  </p>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-4 md:grid-cols-6 gap-2 max-h-64 overflow-y-auto">
                    {galleryImages.map((img, i) => {
                      const isSelected = selectedGalleryUrls.has(img.url);
                      return (
                        <button
                          key={`${img.url}-${i}`}
                          onClick={() => {
                            setSelectedGalleryUrls((prev) => {
                              const next = new Set(prev);
                              if (isSelected) {
                                next.delete(img.url);
                              } else {
                                next.add(img.url);
                              }
                              return next;
                            });
                          }}
                          className={`relative aspect-square rounded-lg overflow-hidden border-2 transition-colors ${
                            isSelected
                              ? "border-[var(--accent-primary)]"
                              : "border-transparent hover:border-[var(--border-primary)]"
                          }`}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={img.url}
                            alt={img.prompt}
                            className="w-full h-full object-cover"
                          />
                          {isSelected && (
                            <div className="absolute inset-0 bg-[var(--accent-primary)]/20 flex items-center justify-center">
                              <CheckCircle className="w-5 h-5 text-[var(--accent-primary)]" />
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {selectedGalleryUrls.size > 0 && (
                    <div className="flex items-center justify-between mt-3">
                      <span className="text-xs text-[var(--text-muted)]">
                        {selectedGalleryUrls.size} selected
                      </span>
                      <button
                        onClick={() =>
                          handleAddFromGallery(board.id, board.images)
                        }
                        disabled={addingGallery || !canAddMore}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--accent-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-40"
                      >
                        {addingGallery ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Plus className="w-4 h-4" />
                        )}
                        Add to Moodboard
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    );

    return (
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {captionDialog}
        <header className="flex-shrink-0 px-6 py-4 border-b border-[var(--border-primary)] flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              aria-label="Back to moodboards"
              onClick={() => navigateTo("moodboards")}
              className="flex-shrink-0 flex items-center justify-center rounded-lg p-1.5 text-light-500 hover:bg-light-50 dark:text-dark-400 dark:hover:bg-dark-750 transition-[color,background-color] duration-150"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              {renamingId === board.id ? (
                renameInput(
                  board.id,
                  board.name,
                  "w-full min-w-0 rounded-md border border-[var(--accent-primary)] bg-[var(--bg-secondary)] px-2 py-0.5 text-lg font-semibold text-[var(--text-primary)] outline-none",
                )
              ) : (
                <div className="flex min-w-0 items-center gap-1">
                  <h1 className="text-lg font-semibold text-balance text-[var(--text-primary)] truncate">
                    {board.name}
                  </h1>
                  <button
                    type="button"
                    onClick={() => startRename(board.id, board.name)}
                    aria-label={`Rename ${board.name}`}
                    title="Rename"
                    className="flex-shrink-0 rounded-md p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {board.description && (
                <p className="text-xs text-[var(--text-muted)] line-clamp-1">
                  {board.description}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {board.isDefault && (
              <span className="rounded-full bg-[var(--accent-primary)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--accent-primary)]">
                Default
              </span>
            )}
            {hasImages && canAddMore && !showAddPanel && (
              <button
                onClick={() => setShowAddPanel(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border-primary)] text-[var(--text-primary)] text-sm font-medium hover:bg-[var(--bg-secondary)] transition-colors"
              >
                <Plus className="w-4 h-4" /> Add Images
              </button>
            )}
            <button
              onClick={() => handleAutoCaption(board.id)}
              disabled={captioning || !hasImages}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border-primary)] text-[var(--text-primary)] text-sm font-medium hover:bg-[var(--bg-secondary)] transition-colors disabled:opacity-40"
              title="Auto-caption missing image captions"
            >
              {captioning ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4" />
              )}
              Auto-caption
            </button>
            <button
              onClick={() => {
                applyMoodboardToSREF(board.id);
                setSREFPanelOpen(true);
                navigateTo("create");
              }}
              disabled={!hasImages}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--accent-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              <Wand2 className="w-4 h-4" /> Apply to Prompt
            </button>
            <button
              onClick={async () => {
                await deleteMoodboard(board.id);
                navigateTo("moodboards");
              }}
              className="flex items-center justify-center rounded-lg p-1.5 text-[var(--text-muted)] hover:text-rose-500 hover:bg-rose-500/10 transition-colors"
              title="Delete moodboard"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </header>

        <LoraRunPanel
          board={board}
          active={activeNav === "moodboards"}
          className="flex-shrink-0 border-b border-[var(--border-primary)] px-6 py-3"
        />

        {hasImages ? (
          <div className="flex-1 overflow-y-auto p-6">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {board.images.map((img, i) => (
                <div
                  key={`${img.url}-${i}`}
                  className="group relative aspect-square rounded-xl overflow-hidden bg-[var(--bg-secondary)] border border-[var(--border-primary)]"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.url}
                    alt={img.prompt ?? `Moodboard image ${i + 1}`}
                    className="w-full h-full object-cover"
                  />

                  {/* Overlay controls — visible on hover or keyboard focus */}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/30 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex flex-col justify-between p-2">
                    {/* Top row: remove button */}
                    <div className="flex justify-end gap-1">
                      <button
                        onClick={() =>
                          openCaptionEditor(board.id, board.images, i)
                        }
                        disabled={updatingImages}
                        className="rounded-lg p-1 bg-black/40 text-white hover:bg-black/60 transition-colors disabled:opacity-40"
                        title="Edit caption"
                      >
                        <MessageSquareText className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() =>
                          removeImageFromBoard(board.id, board.images, i)
                        }
                        disabled={updatingImages}
                        className="rounded-lg p-1 bg-black/40 text-white hover:bg-rose-500/80 transition-colors"
                        title="Remove image"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Bottom row: weight controls */}
                    <div className="flex items-center gap-1.5 justify-center">
                      <button
                        aria-label="Lower weight"
                        onClick={() =>
                          updateImageWeight(
                            board.id,
                            board.images,
                            i,
                            Math.max(0, img.weight - 0.5),
                          )
                        }
                        disabled={img.weight <= 0}
                        className="rounded p-0.5 bg-black/40 text-white hover:bg-black/60 transition-colors disabled:opacity-30"
                      >
                        <Minus className="w-3 h-3" />
                      </button>
                      <span className="text-xs font-mono text-white bg-black/40 px-1.5 py-0.5 rounded min-w-[2rem] text-center">
                        {img.weight.toFixed(1)}
                      </span>
                      <button
                        aria-label="Raise weight"
                        onClick={() =>
                          updateImageWeight(
                            board.id,
                            board.images,
                            i,
                            Math.min(5, img.weight + 0.5),
                          )
                        }
                        disabled={img.weight >= 5}
                        className="rounded p-0.5 bg-black/40 text-white hover:bg-black/60 transition-colors disabled:opacity-30"
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>
                  </div>

                  {/* Weight badge — always visible when non-default */}
                  {img.weight !== 1 && (
                    <span className="absolute top-2 right-2 px-1.5 py-0.5 text-[10px] font-medium bg-black/50 text-white rounded group-hover:opacity-0 transition-opacity">
                      {img.weight.toFixed(1)}
                    </span>
                  )}
                  {img.caption && (
                    <span
                      className="absolute bottom-2 left-2 flex items-center rounded-md bg-black/55 px-1.5 py-1 text-white"
                      title={img.caption}
                    >
                      <MessageSquareText className="h-3.5 w-3.5" />
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* Empty state — show add-image panel prominently */
          <div className="flex-1 flex flex-col">
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <ImageIcon className="w-10 h-10 text-[var(--text-muted)]" />
              <p className="text-sm text-[var(--text-muted)]">
                No images in this moodboard yet
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                Add images below to build your style reference collection.
              </p>
            </div>
          </div>
        )}

        {/* Add images panel: always shown when empty, toggle when has images */}
        {(!hasImages || showAddPanel) && canAddMore && addImagesPanel}
      </div>
    );
  }

  // List view: hero, sticky toolbar, collage cards
  const tagChip = (tag: string) => {
    const active = selectedTagFilters.has(tag);
    return (
      <button
        key={tag}
        onClick={() =>
          setSelectedTagFilters((current) => {
            const next = new Set(current);
            if (next.has(tag)) next.delete(tag);
            else next.add(tag);
            return next;
          })
        }
        aria-pressed={active}
        className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
          active
            ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]"
            : "border-[var(--border-primary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        }`}
      >
        {tag}
      </button>
    );
  };

  const emptyFilterMessage =
    listScope === "selected" && selectedCount === 0
      ? "Nothing selected yet. Tick a board (or long-press on touch) to pick it."
      : listQuery.trim()
        ? `No moodboards match “${listQuery.trim()}”`
        : "No moodboards match these filters";

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {createDialog}
      {autosortDialog}
      {bulkTagDialog}
      {bulkMergeDialog}
      {confirmDialog}

      <div className="flex-1 overflow-y-auto px-4 pb-6 md:px-6">
        <div className="mx-auto w-full max-w-[1400px]">
          <HeroHeader
            testId="moodboards-hero"
            title="Moodboards"
            lines={[
              "Gather reference images into a board and Adrift reads their shared palette, texture and mood as one style signal.",
              "Keep a board tight for a consistent look, or mix wildly different picks to wander somewhere new.",
            ]}
          />

          <div className="sticky top-0 z-20 -mx-1 bg-[var(--bg-primary)] px-1">
            <CollectionToolbar
              testId="moodboards-toolbar"
              scope={listScope}
              onScopeChange={setListScope}
              selectedCount={selectedCount}
              sort={listSort}
              sortOptions={COLLECTION_SORT_OPTIONS}
              onSortChange={setListSort}
              query={listQuery}
              onQueryChange={setListQuery}
              searchPlaceholder="Search moodboards…"
              searchAriaLabel="Search moodboards"
              extra={
                <ToolbarButton
                  onClick={() => {
                    setAutosortSuccess(null);
                    setAutosortError(null);
                    setShowAutosortDialog(true);
                  }}
                  title="Auto-sort a server-local image folder into moodboards"
                  ariaLabel="Auto-sort folder"
                  icon={<FolderInput className="w-4 h-4" />}
                >
                  <span className="hidden sm:inline">Auto-sort folder</span>
                </ToolbarButton>
              }
              primary={
                <ToolbarPrimaryButton
                  onClick={() => setShowCreateDialog(true)}
                  ariaLabel="New Moodboard"
                  icon={<Plus className="w-4 h-4" />}
                >
                  <span className="hidden sm:inline">New Moodboard</span>
                  <span className="sm:hidden">New</span>
                </ToolbarPrimaryButton>
              }
            />

            {selectedCount > 0 && (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-4 py-2">
                <div className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                  <SquareCheckBig className="h-4 w-4 text-[var(--accent-primary)]" />
                  {selectedCount} selected
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() =>
                      setSelectedBoardIds((current) => {
                        const next = new Set(current);
                        if (allVisibleSelected) {
                          visibleIds.forEach((id) => next.delete(id));
                        } else {
                          visibleIds.forEach((id) => next.add(id));
                        }
                        return next;
                      })
                    }
                    className="rounded-lg border border-[var(--border-primary)] px-3 py-1.5 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-primary)] transition-colors"
                  >
                    {allVisibleSelected ? "Unselect page" : "Select page"}
                  </button>
                  <button
                    onClick={() => {
                      setBulkError(null);
                      setBulkTagMode("add");
                      setShowBulkTagDialog(true);
                    }}
                    disabled={bulkAction !== null}
                    className="flex items-center gap-2 rounded-lg border border-[var(--border-primary)] px-3 py-1.5 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-primary)] disabled:opacity-40 transition-colors"
                  >
                    <Tags className="h-4 w-4" /> Tag
                  </button>
                  <button
                    onClick={() => {
                      setBulkError(null);
                      setMergeTargetId(selectedBoards[0]?.id ?? "");
                      setShowBulkMergeDialog(true);
                    }}
                    disabled={selectedCount < 2 || bulkAction !== null}
                    className="flex items-center gap-2 rounded-lg border border-[var(--border-primary)] px-3 py-1.5 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-primary)] disabled:opacity-40 transition-colors"
                  >
                    <GitMerge className="h-4 w-4" /> Merge
                  </button>
                  <button
                    onClick={handleBulkDelete}
                    disabled={bulkAction !== null}
                    className="flex items-center gap-2 rounded-lg border border-rose-500/30 px-3 py-1.5 text-sm font-medium text-rose-500 hover:bg-rose-500/10 disabled:opacity-40 transition-colors"
                  >
                    {bulkAction === "delete" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    Delete
                  </button>
                  <button
                    onClick={clearBulkState}
                    disabled={bulkAction !== null}
                    className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)] disabled:opacity-40 transition-colors"
                    title="Clear selection"
                    aria-label="Clear selection"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
          {allMoodboardTags.length > 0 && (
            <div className="microScrollbar -mt-1 mb-3 flex items-center gap-1 overflow-x-auto pb-1">
              {allMoodboardTags.slice(0, 16).map(tagChip)}
            </div>
          )}

          {autosortSuccess && (
            <div className="mb-3 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-4 py-2 text-xs text-[var(--text-primary)]">
              {autosortSuccess}
            </div>
          )}
          {bulkSuccess && (
            <div className="mb-3 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-4 py-2 text-xs text-[var(--text-primary)]">
              {bulkSuccess}
            </div>
          )}
          {bulkError && !showBulkTagDialog && !showBulkMergeDialog && (
            <div className="mb-3 rounded-lg border border-rose-500/20 bg-rose-500/10 px-4 py-2 text-xs text-rose-500">
              {bulkError}
            </div>
          )}
          {moodboardsLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-6">
              {[...Array(8)].map((_, i) => (
                <div key={i}>
                  <div className="aspect-[4/3] rounded-xl bg-[var(--bg-secondary)] animate-pulse" />
                  <div className="mt-2 h-3.5 w-2/3 rounded bg-[var(--bg-secondary)] animate-pulse" />
                </div>
              ))}
            </div>
          ) : moodboardsError && moodboards.length === 0 ? (
            <StateView
              status="error"
              title="Couldn't load moodboards"
              message={moodboardsError}
              onRetry={() => void fetchMoodboards()}
            />
          ) : moodboards.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <div className="w-16 h-16 rounded-2xl bg-[var(--bg-secondary)] flex items-center justify-center">
                <BookImage className="w-8 h-8 text-[var(--text-muted)]" />
              </div>
              <p className="text-sm font-medium text-[var(--text-primary)]">
                No moodboards yet
              </p>
              <button
                onClick={() => setShowCreateDialog(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--accent-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
              >
                <Plus className="w-4 h-4" /> Create your first moodboard
              </button>
            </div>
          ) : filteredBoards.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 gap-2 text-center">
              {listScope === "selected" ? (
                <SquareCheckBig className="w-8 h-8 text-[var(--text-muted)]" />
              ) : (
                <Search className="w-8 h-8 text-[var(--text-muted)]" />
              )}
              <p className="text-sm text-[var(--text-muted)]">
                {emptyFilterMessage}
              </p>
              {listScope === "selected" && (
                <button
                  onClick={() => setListScope("all")}
                  className="mt-2 rounded-lg border border-[var(--border-primary)] px-3 py-1.5 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors"
                >
                  Show all boards
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5 gap-x-4 gap-y-6">
                {visibleBoards.map((board) => {
                  const selected = selectedBoardIds.has(board.id);
                  const renaming = renamingId === board.id;
                  const openOrToggle = () => {
                    if (selectedCount > 0) toggleBoardSelected(board.id);
                    else navigateTo("moodboards", { id: board.id });
                  };
                  return (
                    <div
                      key={board.id}
                      className="group/card flex min-w-0 flex-col"
                    >
                      <button
                        type="button"
                        aria-label={`Open ${board.name}`}
                        onPointerDown={() => {
                          if (selectedCount > 0) return;
                          longPressTimerRef.current = window.setTimeout(() => {
                            longPressedRef.current = true;
                            toggleBoardSelected(board.id);
                            longPressTimerRef.current = null;
                          }, 450);
                        }}
                        onPointerUp={() => {
                          if (longPressTimerRef.current !== null) {
                            window.clearTimeout(longPressTimerRef.current);
                            longPressTimerRef.current = null;
                          }
                        }}
                        onPointerLeave={() => {
                          if (longPressTimerRef.current !== null) {
                            window.clearTimeout(longPressTimerRef.current);
                            longPressTimerRef.current = null;
                          }
                        }}
                        onClick={() => {
                          if (longPressedRef.current) {
                            longPressedRef.current = false;
                            return;
                          }
                          openOrToggle();
                        }}
                        className={`group relative aspect-[4/3] overflow-hidden rounded-xl border bg-[var(--bg-secondary)] text-left transition-[border-color,box-shadow] ${
                          selected
                            ? "border-[var(--accent-primary)] ring-2 ring-[var(--accent-primary)]/40"
                            : "border-[var(--border-primary)] hover:border-[var(--accent-primary)]"
                        }`}
                      >
                        <ImageCollage
                          urls={board.images.map((img) => img.url)}
                          max={6}
                          imgClassName="transition-transform duration-300 group-hover:scale-[1.03]"
                          empty={
                            <div className="flex flex-col items-center gap-1.5 px-3 text-center">
                              <ImageIcon className="w-7 h-7 text-[var(--text-muted)]" />
                              <span className="text-[11px] text-[var(--text-muted)]">
                                Empty board — add a few images
                              </span>
                            </div>
                          }
                        />
                        <span
                          className={`absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md border border-white/70 bg-black/45 text-white transition-opacity ${
                            selected || selectedCount > 0
                              ? "opacity-100"
                              : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
                          }`}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleBoardSelected(board.id);
                          }}
                        >
                          {selected && <Check className="h-4 w-4" />}
                        </span>
                        {board.isDefault && (
                          <span className="absolute top-2 right-2 z-10 px-1.5 py-0.5 text-[10px] font-medium bg-[var(--accent-primary)] text-white rounded">
                            Default
                          </span>
                        )}
                      </button>

                      <div className="mt-2 flex min-w-0 items-center gap-1 px-0.5">
                        {renaming ? (
                          renameInput(
                            board.id,
                            board.name,
                            "min-w-0 flex-1 rounded-md border border-[var(--accent-primary)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-sm font-semibold text-[var(--text-primary)] outline-none",
                          )
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={openOrToggle}
                              title={board.name}
                              className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-[var(--text-primary)] hover:underline decoration-[var(--border-secondary)] underline-offset-2"
                            >
                              {board.name}
                            </button>
                            <button
                              type="button"
                              onClick={() => startRename(board.id, board.name)}
                              aria-label={`Rename ${board.name}`}
                              title="Rename"
                              className="flex-shrink-0 rounded-md p-1 text-[var(--text-muted)] opacity-60 transition-[opacity,color,background-color] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover/card:opacity-100"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 px-0.5 text-xs text-[var(--text-muted)]">
                        <span className="flex-shrink-0 tabular-nums">
                          {board.images.length}{" "}
                          {board.images.length === 1 ? "image" : "images"}
                        </span>
                        {board.tags && board.tags.length > 0 && (
                          <span className="truncate">
                            · {board.tags.slice(0, 3).join(", ")}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {visibleBoards.length < filteredBoards.length && (
                <div className="flex flex-col items-center gap-2 pt-8">
                  <p className="text-xs text-[var(--text-muted)]">
                    Showing {visibleBoards.length} of {filteredBoards.length}
                  </p>
                  <button
                    onClick={() => setListLimit((n) => n + LIST_PAGE_SIZE)}
                    className="px-4 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-primary)] text-sm font-medium text-[var(--text-primary)] hover:border-[var(--accent-primary)] transition-colors"
                  >
                    Show more
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default MoodboardsPage;

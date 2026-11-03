"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { useUIStore } from "@/store";
import { STYLE_CODES_ENABLED } from "@/lib/features";
import { useIntegrations } from "@/hooks/useIntegrations";
import type { Moodboard, MoodboardImage } from "@/types";
import {
  createMoodboard,
  deleteMoodboard,
  listMoodboards,
  updateMoodboard,
} from "@/lib/sref/moodboardClient";
import {
  autosortMoodboards,
  captionMoodboard,
  importSvTag,
  listSvSrefGroups,
  type SvSrefGroup,
} from "@/lib/sref/apiClient";
import { LoraRunPanel } from "@/components/training/LoraRunPanel";
import { DatasetCaptionPanel } from "@/components/training/DatasetCaptionPanel";
import { showToast } from "@/components/Toast";
import {
  CollectionToolbar,
  HeroHeader,
  ImageCollage,
  ToolbarButton,
  ToolbarPrimaryButton,
} from "@/components/PageHeader";
import {
  COLLECTION_SORT_OPTIONS,
  sortCollection,
  type CollectionSort,
} from "@/lib/collectionView";
import {
  ArrowLeft,
  FolderInput,
  Image as ImageIcon,
  Library,
  Loader2,
  MessageSquareText,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";

type DatasetKind = "character" | "style";

function kindMeta(kind: DatasetKind, styleVault: boolean) {
  return kind === "character"
    ? {
        nav: "characters" as const,
        title: "Characters",
        singular: "Character",
        empty: "No character datasets yet",
        first: "Create your first character dataset",
        lines: [
          "Build a dataset board for each recurring face or figure, caption it, and train a LoRA that keeps them on-model from scene to scene.",
          "Aim for 10–20 clear shots across angles, outfits and lighting — variety is what lets the model generalize.",
        ],
      }
    : {
        nav: "styles" as const,
        title: "Styles",
        singular: "Style",
        empty: "No style datasets yet",
        first: "Create your first style dataset",
        lines: [
          "Group references that share a look, caption them, and train a LoRA you can call up from any prompt.",
          ...(styleVault
            ? [
                STYLE_CODES_ENABLED
                  ? "Pull a cluster straight from StyleVault or sort a folder automatically, then refine the picks by hand."
                  : "Sort a folder automatically, then refine the picks by hand.",
              ]
            : []),
        ],
      };
}

export function DatasetBoardsPage({
  kind,
  initialBoards = [],
  initialSelectedId = null,
}: {
  kind: DatasetKind;
  initialBoards?: Moodboard[];
  initialSelectedId?: string | null;
}) {
  const activeNav = useUIStore((s) => s.activeNav);
  // Import, auto-sort and auto-caption all call StyleVault (STYLEVAULT_API_URL).
  const styleVault = useIntegrations().styleVault;
  const meta = kindMeta(kind, styleVault);
  const isTabActive = activeNav === meta.nav;

  const [boards, setBoards] = useState<Moodboard[]>(initialBoards);
  const [listQuery, setListQuery] = useState("");
  const [listSort, setListSort] = useState<CollectionSort>("latest"); // toolbar sort
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSelectedId,
  );

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newBoardName, setNewBoardName] = useState("");
  const [newBoardDesc, setNewBoardDesc] = useState("");
  const [creating, setCreating] = useState(false);

  const [showAutosortDialog, setShowAutosortDialog] = useState(false);
  const [autosortDir, setAutosortDir] = useState("");
  const [autosortMinClusterSize, setAutosortMinClusterSize] = useState(4);
  const [autosortNamePrefix, setAutosortNamePrefix] = useState("Style");
  const [autosorting, setAutosorting] = useState(false);

  // StyleVault library import (sref groups)
  const [showSvImportDialog, setShowSvImportDialog] = useState(false);
  const [svGroups, setSvGroups] = useState<SvSrefGroup[] | null>(null);
  const [svImporting, setSvImporting] = useState<string | null>(null);
  const [svFilter, setSvFilter] = useState("");

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [updatingImages, setUpdatingImages] = useState(false);
  const [captioning, setCaptioning] = useState(false);
  const [captionEditor, setCaptionEditor] = useState<{
    boardId: string;
    imageIndex: number;
  } | null>(null);
  const [captionDraft, setCaptionDraft] = useState("");
  // Image indices picked for batch caption edits (detail view).
  const [selectedImages, setSelectedImages] = useState<number[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedBoard = useMemo(
    () => boards.find((board) => board.id === selectedId) ?? null,
    [boards, selectedId],
  );

  // Indices go stale when the board or its image list changes shape.
  const selectedImageCount = selectedBoard?.images.length ?? 0;
  useEffect(() => {
    setSelectedImages([]);
  }, [selectedId, selectedImageCount]);

  const toggleImageSelected = useCallback((index: number) => {
    setSelectedImages((current) =>
      current.includes(index)
        ? current.filter((item) => item !== index)
        : [...current, index].sort((a, b) => a - b),
    );
  }, []);

  const filteredBoards = useMemo(() => {
    const q = listQuery.trim().toLowerCase();
    const matched = q
      ? boards.filter(
          (board) =>
            board.name.toLowerCase().includes(q) ||
            (board.description?.toLowerCase().includes(q) ?? false),
        )
      : boards;
    return sortCollection(matched, listSort);
  }, [boards, listQuery, listSort]);

  const refetchBoards = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listMoodboards(kind);
      if (!res.ok) {
        showToast(
          res.error ?? `Could not load ${meta.title.toLowerCase()}.`,
          "error",
        );
        return;
      }
      setBoards(res.moodboards);
      setSelectedId((current) =>
        current && res.moodboards.some((board) => board.id === current)
          ? current
          : null,
      );
    } catch {
      showToast(`Could not load ${meta.title.toLowerCase()}.`, "error");
    } finally {
      setLoading(false);
    }
  }, [kind, meta.title]);

  useEffect(() => {
    if (isTabActive) void refetchBoards();
  }, [isTabActive, refetchBoards]);

  const replaceBoard = useCallback((board: Moodboard) => {
    setBoards((current) =>
      current.map((item) => (item.id === board.id ? board : item)),
    );
  }, []);

  const handleCreate = useCallback(async () => {
    if (!newBoardName.trim()) return;
    setCreating(true);
    try {
      const res = await createMoodboard({
        name: newBoardName.trim(),
        description: newBoardDesc.trim() || undefined,
        images: [],
        kind,
      });
      if (!res.ok || !res.moodboard) {
        showToast(
          res.error ??
            `Could not create ${meta.singular.toLowerCase()} dataset.`,
          "error",
        );
        return;
      }
      setBoards((current) => [res.moodboard!, ...current]);
      setSelectedId(res.moodboard.id);
      setShowCreateDialog(false);
      setNewBoardName("");
      setNewBoardDesc("");
      showToast(`${meta.singular} dataset created.`, "success");
    } catch {
      showToast(
        `Could not create ${meta.singular.toLowerCase()} dataset.`,
        "error",
      );
    } finally {
      setCreating(false);
    }
  }, [kind, meta.singular, newBoardDesc, newBoardName]);

  const handleDelete = useCallback(async (board: Moodboard) => {
    try {
      const res = await deleteMoodboard(board.id);
      if (!res.ok) {
        showToast(res.error ?? "Delete failed.", "error");
        return;
      }
      setBoards((current) => current.filter((item) => item.id !== board.id));
      setSelectedId((current) => (current === board.id ? null : current));
      showToast("Dataset deleted.", "success");
    } catch {
      showToast("Delete failed.", "error");
    }
  }, []);

  const updateBoardImages = useCallback(
    async (board: Moodboard, images: MoodboardImage[]) => {
      const res = await updateMoodboard({ id: board.id, images });
      if (!res.ok || !res.moodboard) {
        throw new Error(res.error ?? "Update failed.");
      }
      replaceBoard(res.moodboard);
      return res.moodboard;
    },
    [replaceBoard],
  );

  const handleFileUpload = useCallback(
    async (files: FileList | File[], board: Moodboard) => {
      const imageFiles = Array.from(files).filter((file) =>
        file.type.startsWith("image/"),
      );
      if (imageFiles.length === 0) {
        setUploadError("No valid image files selected.");
        return;
      }
      if (board.images.length + imageFiles.length > 20) {
        setUploadError(
          `Can add at most ${20 - board.images.length} more images (max 20).`,
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
          await updateBoardImages(
            board,
            [...board.images, ...newImages].slice(0, 20),
          );
        }
      } catch {
        setUploadError("Upload failed. Please try again.");
      } finally {
        setUploading(false);
      }
    },
    [updateBoardImages],
  );

  const onDrop = useCallback(
    (event: DragEvent, board: Moodboard) => {
      event.preventDefault();
      setDragOver(false);
      if (event.dataTransfer.files.length > 0) {
        void handleFileUpload(event.dataTransfer.files, board);
      }
    },
    [handleFileUpload],
  );

  const onFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>, board: Moodboard) => {
      if (event.target.files && event.target.files.length > 0) {
        void handleFileUpload(event.target.files, board);
        event.target.value = "";
      }
    },
    [handleFileUpload],
  );

  const removeImage = useCallback(
    async (board: Moodboard, index: number) => {
      setUpdatingImages(true);
      try {
        await updateBoardImages(
          board,
          board.images.filter((_, imageIndex) => imageIndex !== index),
        );
      } catch {
        showToast("Could not remove image.", "error");
      } finally {
        setUpdatingImages(false);
      }
    },
    [updateBoardImages],
  );

  const openCaptionEditor = useCallback((board: Moodboard, index: number) => {
    setCaptionEditor({ boardId: board.id, imageIndex: index });
    setCaptionDraft(board.images[index]?.caption ?? "");
  }, []);

  const saveCaptionEdit = useCallback(async () => {
    if (!captionEditor) return;
    const board = boards.find((item) => item.id === captionEditor.boardId);
    const image = board?.images[captionEditor.imageIndex];
    if (!board || !image) return;

    const caption = captionDraft.trim();
    const images = board.images.map((item, index) =>
      index === captionEditor.imageIndex
        ? caption
          ? { ...item, caption, captionSource: "manual" }
          : { ...item, caption: undefined, captionSource: undefined }
        : item,
    );

    setUpdatingImages(true);
    try {
      await updateBoardImages(board, images);
      setCaptionEditor(null);
      setCaptionDraft("");
    } catch {
      showToast("Could not save caption.", "error");
    } finally {
      setUpdatingImages(false);
    }
  }, [boards, captionDraft, captionEditor, updateBoardImages]);

  const handleAutoCaption = useCallback(
    async (board: Moodboard) => {
      setCaptioning(true);
      try {
        const res = await captionMoodboard(board.id, { only_missing: true });
        if (!res.ok || !res.images) {
          showToast(res.error ?? "Auto-caption failed.", "error");
          return;
        }
        replaceBoard({ ...board, images: res.images });
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
    [replaceBoard],
  );

  const moveImage = useCallback(
    async (source: Moodboard, index: number, targetId: string) => {
      const image = source.images[index];
      const target = boards.find((board) => board.id === targetId);
      if (
        !image ||
        !target ||
        target.id === source.id ||
        target.images.length >= 20
      ) {
        return;
      }
      setUpdatingImages(true);
      try {
        const sourceImages = source.images.filter(
          (_, imageIndex) => imageIndex !== index,
        );
        const targetImages = [...target.images, image].slice(0, 20);
        const sourceRes = await updateMoodboard({
          id: source.id,
          images: sourceImages,
        });
        const targetRes = await updateMoodboard({
          id: target.id,
          images: targetImages,
        });
        if (
          !sourceRes.ok ||
          !targetRes.ok ||
          !sourceRes.moodboard ||
          !targetRes.moodboard
        ) {
          throw new Error("Move failed.");
        }
        replaceBoard(sourceRes.moodboard);
        replaceBoard(targetRes.moodboard);
        showToast("Image moved.", "success");
      } catch {
        showToast("Could not move image.", "error");
      } finally {
        setUpdatingImages(false);
      }
    },
    [boards, replaceBoard],
  );

  const openSvImport = useCallback(async () => {
    setShowSvImportDialog(true);
    if (svGroups !== null) return;
    try {
      setSvGroups(await listSvSrefGroups(4));
    } catch {
      setSvGroups([]);
      showToast("Could not load StyleVault library — is it running?", "error");
    }
  }, [svGroups]);

  const handleSvImport = useCallback(
    async (group: SvSrefGroup) => {
      setSvImporting(group.tag);
      try {
        const res = await importSvTag({
          tag: group.tag,
          kind,
        });
        if (!res.ok || !res.moodboard) {
          showToast(res.error ?? "Import failed.", "error");
          return;
        }
        showToast(
          `Imported ${res.imported}/${res.libraryCount} images as "${res.moodboard.name}"`,
          "success",
        );
        setShowSvImportDialog(false);
        await refetchBoards();
        setSelectedId(res.moodboard.id);
      } catch {
        showToast("Import failed.", "error");
      } finally {
        setSvImporting(null);
      }
    },
    [kind, refetchBoards],
  );

  const handleAutosort = useCallback(async () => {
    if (!autosortDir.trim() || kind !== "style") return;
    setAutosorting(true);
    try {
      const res = await autosortMoodboards({
        dir: autosortDir.trim(),
        minClusterSize: autosortMinClusterSize,
        namePrefix: autosortNamePrefix.trim() || "Style",
        kind: "style",
      });
      if (!res.ok) {
        showToast(res.error ?? "Auto-sort failed.", "error");
        return;
      }
      setShowAutosortDialog(false);
      showToast(`Created ${res.created} style datasets.`, "success");
      await refetchBoards();
    } catch {
      showToast("Auto-sort failed.", "error");
    } finally {
      setAutosorting(false);
    }
  }, [
    autosortDir,
    autosortMinClusterSize,
    autosortNamePrefix,
    kind,
    refetchBoards,
  ]);

  if (!isTabActive) return null;

  const createDialog = showCreateDialog ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">
            New {meta.singular} dataset
          </h2>
          <button
            type="button"
            onClick={() => setShowCreateDialog(false)}
            className="rounded-lg p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            title="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-3">
          <input
            aria-label="Board name"
            type="text"
            value={newBoardName}
            onChange={(event) => setNewBoardName(event.target.value)}
            placeholder={`${meta.singular} name`}
            className="input w-full text-sm"
            autoFocus
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleCreate();
            }}
          />
          <textarea
            aria-label="Description"
            value={newBoardDesc}
            onChange={(event) => setNewBoardDesc(event.target.value)}
            placeholder="Description (optional)"
            rows={2}
            className="input w-full resize-none text-sm"
          />
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setShowCreateDialog(false)}
              className="rounded-xl border border-[var(--border-primary)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-primary)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={!newBoardName.trim() || creating}
              className="flex items-center gap-2 rounded-xl bg-[var(--accent-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
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

  const svImportDialog = STYLE_CODES_ENABLED && showSvImportDialog ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">
            Import from StyleVault
          </h2>
          <button
            type="button"
            onClick={() => setShowSvImportDialog(false)}
            className="rounded-lg p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            title="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <input
          aria-label="Filter sref codes"
          type="text"
          value={svFilter}
          onChange={(event) => setSvFilter(event.target.value)}
          placeholder="Filter sref codes..."
          className="input mb-3 w-full text-sm"
        />
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {svGroups === null ? (
            <div className="flex items-center gap-2 py-6 text-sm text-[var(--text-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading library…
            </div>
          ) : svGroups.length === 0 ? (
            <p className="py-6 text-sm text-[var(--text-muted)]">
              No sref groups in the library yet — run a StyleVault import on
              a collection first.
            </p>
          ) : (
            svGroups
              .filter((group) => group.sref.includes(svFilter.trim()))
              .slice(0, 100)
              .map((group) => (
                <div
                  key={group.tag}
                  className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border-primary)] px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                      sref {group.sref}
                    </p>
                    <p className="text-xs text-[var(--text-muted)]">
                      {group.count} images
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleSvImport(group)}
                    disabled={svImporting !== null}
                    className="flex items-center gap-1.5 rounded-lg bg-[var(--accent-primary)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
                  >
                    {svImporting === group.tag ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}
                    Import
                  </button>
                </div>
              ))
          )}
        </div>
      </div>
    </div>
  ) : null;

  const autosortDialog =
    kind === "style" && showAutosortDialog ? (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="w-full max-w-md rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-6 shadow-lg">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">
              Auto-sort styles
            </h2>
            <button
              type="button"
              onClick={() => setShowAutosortDialog(false)}
              className="rounded-lg p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              title="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="space-y-3">
            <input
              aria-label="Directory path"
              type="text"
              value={autosortDir}
              onChange={(event) => setAutosortDir(event.target.value)}
              placeholder="/path/to/images"
              className="input w-full text-sm"
              autoFocus
            />
            <input
              type="number"
              min={2}
              value={autosortMinClusterSize}
              onChange={(event) =>
                setAutosortMinClusterSize(Number(event.target.value))
              }
              className="input w-full text-sm"
              aria-label="Min cluster size"
            />
            <input
              aria-label="Name prefix"
              type="text"
              value={autosortNamePrefix}
              onChange={(event) => setAutosortNamePrefix(event.target.value)}
              placeholder="Style"
              className="input w-full text-sm"
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowAutosortDialog(false)}
                className="rounded-xl border border-[var(--border-primary)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-primary)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleAutosort()}
                disabled={!autosortDir.trim() || autosorting}
                className="flex items-center gap-2 rounded-xl bg-[var(--accent-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
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

  const captionDialog =
    captionEditor && selectedBoard?.id === captionEditor.boardId ? (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="w-full max-w-md rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-6 shadow-lg">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">
              Edit caption
            </h2>
            <button
              type="button"
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
            onChange={(event) => setCaptionDraft(event.target.value)}
            rows={5}
            className="input w-full resize-none text-sm"
            autoFocus
          />
          {selectedBoard.images[captionEditor.imageIndex]?.captionSource && (
            <p className="mt-2 text-xs text-[var(--text-muted)]">
              source:{" "}
              {selectedBoard.images[captionEditor.imageIndex]?.captionSource}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setCaptionEditor(null)}
              disabled={updatingImages}
              className="rounded-xl border border-[var(--border-primary)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-primary)] disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void saveCaptionEdit()}
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

  if (selectedBoard) {
    const otherBoards = boards.filter((board) => board.id !== selectedBoard.id);
    const canAddMore = selectedBoard.images.length < 20;
    return (
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {captionDialog}
        <header className="flex-shrink-0 border-b border-[var(--border-primary)] px-6 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="flex-shrink-0 rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
                title={`Back to ${meta.title}`}
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold text-[var(--text-primary)]">
                  {selectedBoard.name}
                </h1>
                <p className="text-xs text-[var(--text-muted)]">
                  {selectedBoard.images.length}/20 images
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {styleVault && (
                <button
                  type="button"
                  onClick={() => void handleAutoCaption(selectedBoard)}
                  disabled={captioning || selectedBoard.images.length === 0}
                  className="flex items-center gap-2 rounded-lg border border-[var(--border-primary)] px-3 py-1.5 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-secondary)] disabled:opacity-40"
                  title="Auto-caption missing image captions"
                >
                  {captioning ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  Auto-caption
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleDelete(selectedBoard)}
                className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-rose-500/10 hover:text-rose-500"
                title="Delete dataset"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        </header>

        <div className="flex-shrink-0 border-b border-[var(--border-primary)] px-6 py-3">
          <LoraRunPanel
            board={selectedBoard}
            active={isTabActive}
            className="px-0"
          />
        </div>

        <div className="flex-shrink-0 border-b border-[var(--border-primary)] px-6 py-3">
          <DatasetCaptionPanel
            board={selectedBoard}
            selected={selectedImages}
            onSelectionChange={setSelectedImages}
            onBoardUpdated={replaceBoard}
          />
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {selectedBoard.images.length > 0 && (
            <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
              {selectedBoard.images.map((image, index) => (
                <div
                  key={`${image.url}-${index}`}
                  className="group relative aspect-square overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)]"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={image.url}
                    alt={
                      image.prompt ?? `${selectedBoard.name} image ${index + 1}`
                    }
                    className="h-full w-full object-cover"
                  />
                  <label
                    className={`absolute left-2 top-2 z-10 flex rounded-md bg-black/45 p-1 transition-opacity ${
                      selectedImages.includes(index)
                        ? "opacity-100"
                        : "opacity-0 focus-within:opacity-100 group-hover:opacity-100"
                    }`}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Select image ${index + 1} for caption edits`}
                      checked={selectedImages.includes(index)}
                      onChange={() => toggleImageSelected(index)}
                      className="h-3.5 w-3.5"
                    />
                  </label>
                  <div className="absolute inset-0 flex flex-col justify-between bg-gradient-to-t from-black/65 via-transparent to-black/35 p-2 opacity-0 transition-opacity group-hover:opacity-100">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => openCaptionEditor(selectedBoard, index)}
                        disabled={updatingImages}
                        className="rounded-lg bg-black/40 p-1 text-white transition-colors hover:bg-black/60 disabled:opacity-40"
                        title="Edit caption"
                      >
                        <MessageSquareText className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeImage(selectedBoard, index)}
                        disabled={updatingImages}
                        className="rounded-lg bg-black/40 p-1 text-white transition-colors hover:bg-rose-500/80 disabled:opacity-40"
                        title="Remove image"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    {otherBoards.length > 0 && (
                      <select
                        value=""
                        onChange={(event) => {
                          if (event.target.value) {
                            void moveImage(
                              selectedBoard,
                              index,
                              event.target.value,
                            );
                          }
                        }}
                        disabled={updatingImages}
                        className="rounded-lg border border-white/20 bg-black/60 px-2 py-1 text-xs text-white"
                        aria-label="Move image to another board"
                      >
                        <option value="">Move to...</option>
                        {otherBoards.map((board) => (
                          <option key={board.id} value={board.id}>
                            {board.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  {image.caption && (
                    <span
                      className="absolute bottom-2 left-2 flex items-center rounded-md bg-black/55 px-1.5 py-1 text-white"
                      title={image.caption}
                    >
                      <MessageSquareText className="h-3.5 w-3.5" />
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {canAddMore ? (
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={(event) => {
                event.preventDefault();
                setDragOver(false);
              }}
              onDrop={(event) => onDrop(event, selectedBoard)}
              onClick={() => fileInputRef.current?.click()}
              className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 transition-colors ${
                dragOver
                  ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]/5"
                  : "border-[var(--border-primary)] hover:border-[var(--text-muted)]"
              }`}
            >
              {uploading ? (
                <Loader2 className="h-8 w-8 animate-spin text-[var(--accent-primary)]" />
              ) : (
                <Upload className="h-8 w-8 text-[var(--text-muted)]" />
              )}
              <p className="text-sm text-[var(--text-muted)]">
                {uploading
                  ? "Uploading..."
                  : "Drop images here or click to browse"}
              </p>
              <p className="text-[10px] text-[var(--text-muted)]">
                JPG, PNG, WebP, GIF, AVIF (max 10MB each)
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => onFileChange(event, selectedBoard)}
              />
              {uploadError && (
                <p className="mt-2 text-xs text-rose-500">{uploadError}</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">
              This dataset has the maximum 20 images.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      {createDialog}
      {autosortDialog}
      {svImportDialog}

      <div className="flex-1 overflow-y-auto px-4 pb-6 md:px-6">
        <div className="mx-auto w-full max-w-[1400px]">
          <HeroHeader
            testId={`${meta.nav}-hero`}
            eyebrow="Dataset boards for LoRA training"
            title={meta.title}
            lines={meta.lines}
          />

          <CollectionToolbar
            testId={`${meta.nav}-toolbar`}
            sticky
            sort={listSort}
            sortOptions={COLLECTION_SORT_OPTIONS}
            onSortChange={setListSort}
            query={listQuery}
            onQueryChange={setListQuery}
            searchPlaceholder={`Search ${meta.title.toLowerCase()}…`}
            searchAriaLabel={`Search ${meta.title.toLowerCase()}`}
            extra={
              kind === "style" ? (
                <>
                  {STYLE_CODES_ENABLED && styleVault && (
                    <ToolbarButton
                      onClick={() => void openSvImport()}
                      ariaLabel="Import from StyleVault"
                      icon={<Library className="h-4 w-4" />}
                    >
                      <span className="hidden sm:inline">
                        Import from StyleVault
                      </span>
                    </ToolbarButton>
                  )}
                  {styleVault && (
                    <ToolbarButton
                      onClick={() => setShowAutosortDialog(true)}
                      ariaLabel="Auto-sort"
                      icon={<FolderInput className="h-4 w-4" />}
                    >
                      <span className="hidden sm:inline">Auto-sort</span>
                    </ToolbarButton>
                  )}
                </>
              ) : undefined
            }
            primary={
              // Empty list: the big "Create your first..." button is the one CTA.
              !loading && boards.length === 0 ? undefined : (
                <ToolbarPrimaryButton
                  onClick={() => setShowCreateDialog(true)}
                  ariaLabel={`New ${meta.singular} dataset`}
                  icon={<Plus className="h-4 w-4" />}
                >
                  <span className="hidden sm:inline">
                    New {meta.singular} dataset
                  </span>
                  <span className="sm:hidden">New</span>
                </ToolbarPrimaryButton>
              )
            }
          />

          {loading ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-6 md:grid-cols-3 lg:grid-cols-4">
              {[...Array(8)].map((_, index) => (
                <div key={index}>
                  <div className="aspect-[4/3] animate-pulse rounded-xl bg-[var(--bg-secondary)]" />
                  <div className="mt-2 h-3.5 w-2/3 animate-pulse rounded bg-[var(--bg-secondary)]" />
                </div>
              ))}
            </div>
          ) : boards.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-4 py-20">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--bg-secondary)]">
                <Users className="h-8 w-8 text-[var(--text-muted)]" />
              </div>
              <p className="text-sm font-medium text-[var(--text-primary)]">
                {meta.empty}
              </p>
              <button
                type="button"
                onClick={() => setShowCreateDialog(true)}
                className="flex items-center gap-2 rounded-xl bg-[var(--accent-primary)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                <Plus className="h-4 w-4" /> {meta.first}
              </button>
            </div>
          ) : filteredBoards.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
              <Search className="h-8 w-8 text-[var(--text-muted)]" />
              <p className="text-sm text-[var(--text-muted)]">
                No {meta.title.toLowerCase()} match “{listQuery.trim()}”
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-6 md:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
              {filteredBoards.map((board) => (
                <div
                  key={board.id}
                  className="group/card flex min-w-0 flex-col"
                >
                  <div className="relative">
                    <button
                      type="button"
                      aria-label={`Open ${board.name}`}
                      onClick={() => setSelectedId(board.id)}
                      className="group relative block aspect-[4/3] w-full overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] text-left transition-colors hover:border-[var(--accent-primary)]"
                    >
                      <ImageCollage
                        urls={board.images.map((img) => img.url)}
                        max={6}
                        imgClassName="transition-transform duration-300 group-hover:scale-[1.03]"
                        empty={
                          <div className="flex flex-col items-center gap-1.5 px-3 text-center">
                            <ImageIcon className="h-7 w-7 text-[var(--text-muted)]" />
                            <span className="text-[11px] text-[var(--text-muted)]">
                              No images yet
                            </span>
                          </div>
                        }
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(board)}
                      aria-label={`Delete ${board.name}`}
                      title="Delete dataset"
                      className="absolute right-2 top-2 rounded-lg bg-black/45 p-1 text-white opacity-0 transition-opacity hover:bg-rose-500/80 focus-visible:opacity-100 group-hover/card:opacity-100"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedId(board.id)}
                    title={board.name}
                    className="mt-2 truncate px-0.5 text-left text-sm font-semibold text-[var(--text-primary)] decoration-[var(--border-secondary)] underline-offset-2 hover:underline"
                  >
                    {board.name}
                  </button>
                  <p className="mt-0.5 px-0.5 text-xs tabular-nums text-[var(--text-muted)]">
                    {board.images.length}{" "}
                    {board.images.length === 1 ? "image" : "images"}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

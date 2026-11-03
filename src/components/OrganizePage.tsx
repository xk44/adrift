"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useUIStore, useGenerationStore } from "@/store";
import {
  FolderPlus,
  Grid,
  List,
  Search,
  Image as ImageIcon,
  Folder,
  Trash2,
  X,
  CheckSquare,
  Wand2,
  Heart,
  Check,
} from "lucide-react";
import { MobileOrganizeSheet } from "@/components/MobileOrganizeSheet";
import { MediaThumb } from "@/components/organize/MediaThumb";
import { dayGroupLabel, nextSelection } from "@/lib/organize/organizeView";
import { createGalleryImageFilter } from "@/lib/galleryFilters";
import {
  ASPECT_OPTIONS,
  DATE_OPTIONS,
  EMPTY_ORGANIZE_FILTERS,
  MEDIA_OPTIONS,
  SORT_OPTIONS,
  STATUS_OPTIONS,
  countActiveFilters,
  createOrganizeFilter,
  filtersKey,
  toggleFacet,
  type OrganizeFilters,
  type SortOption,
} from "@/lib/organize/organizeFilters";
import { filterParamChips } from "@/lib/ui/displayParams";

interface FolderItem {
  id: string;
  name: string;
  count: number;
}

// Built-in folders that always exist
const BUILTIN_FOLDERS: FolderItem[] = [
  { id: "all", name: "All Images", count: 0 },
  { id: "favorites", name: "Favorites", count: 0 },
  { id: "uncategorized", name: "Uncategorized", count: 0 },
];

// View Options — tile width per size step
const TILE_PX = { small: 110, medium: 150, large: 210 } as const;
// Phone widths: the reference archive packs ~5 columns at 430px.
const TILE_PX_MOBILE = { small: 64, medium: 76, large: 120 } as const;
const INITIAL_RENDER_COUNT = 80;
const RENDER_CHUNK_SIZE = 80;

export function getDragSelection(
  imageId: string,
  currentSelection: Set<string>,
): Set<string> {
  return currentSelection.has(imageId)
    ? new Set(currentSelection)
    : new Set([imageId]);
}

export function addLikedToGalleryByIds<
  T extends { id: string; liked?: boolean },
>(gallery: T[], imageIds: string[]): T[] {
  const ids = new Set(imageIds.filter(Boolean));
  return gallery.map((img) =>
    ids.has(img.id) && !img.liked ? { ...img, liked: true } : img,
  );
}

function normalizePromptParamChip(param: string): string {
  const match = param.match(/^(--?\w+)\s*(.*)$/);
  if (!match) return param;
  const [, flag, value] = match;
  const normalizedFlag = `--${flag.replace(/^-+/, "")}`;
  return value ? `${normalizedFlag} ${value}` : normalizedFlag;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replacePromptParamText(prompt: string, param: string): string {
  const normalized = normalizePromptParamChip(param);
  const match = normalized.match(/^(--\w+)\s*(.*)$/);
  if (!match) return `${prompt.trim()} ${normalized}`.trim();

  const [, flag] = match;
  const withoutSameFlag = prompt
    .replace(new RegExp(`\\s*${escapeRegExp(flag)}\\s+[^-]*`, "g"), " ")
    .trim();
  return `${withoutSameFlag} ${normalized}`.trim();
}

export function OrganizePage() {
  const activeNav = useUIStore((s) => s.activeNav);
  const setActiveNav = useUIStore((s) => s.setActiveNav);
  const setPromptValue = useUIStore((s) => s.setPromptValue);
  const gallery = useGenerationStore((s) => s.gallery);
  const folders = useGenerationStore((s) => s.folders);
  const addFolder = useGenerationStore((s) => s.addFolder);
  const removeFolder = useGenerationStore((s) => s.removeFolder);
  const renameFolder = useGenerationStore((s) => s.renameFolder);
  const addImageToFolder = useGenerationStore((s) => s.addImageToFolder);
  const removeImageFromFolder = useGenerationStore(
    (s) => s.removeImageFromFolder,
  );
  const toggleLiked = useGenerationStore((s) => s.toggleLiked);
  const removeFromGallery = useGenerationStore((s) => s.removeFromGallery);

  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selectedFolder, setSelectedFolder] = useState("all");
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());
  // Touch select-mode: plain taps toggle (no Cmd/Shift on a phone).
  const [selectMode, setSelectMode] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const selectedImagesRef = useRef(selectedImages);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [autoFillCount, setAutoFillCount] = useState<number | null>(null);
  const [renderCount, setRenderCount] = useState(INITIAL_RENDER_COUNT);
  const renderScopeKeyRef = useRef("");
  const renderMoreRef = useRef<HTMLDivElement | null>(null);

  const [filters, setFilters] = useState<OrganizeFilters>(
    EMPTY_ORGANIZE_FILTERS,
  );
  const [sortOption, setSortOption] = useState<SortOption>("newest");

  // View options (reference layout): square crops vs natural aspect, tile size
  const [layoutMode, setLayoutMode] = useState<"square" | "full">("square");
  const [tileSize, setTileSize] = useState<"small" | "medium" | "large">(
    "medium",
  );

  const setSelectedImagesState = useCallback((selection: Set<string>) => {
    selectedImagesRef.current = selection;
    setSelectedImages(selection);
  }, []);

  if (activeNav !== "organize") return null;

  const activeFilterCount = countActiveFilters(filters, sortOption);

  const clearFilters = () => {
    setFilters(EMPTY_ORGANIZE_FILTERS);
    setSortOption("newest");
  };

  // Build folder list with counts — memoized to avoid O(folders*gallery) per render
  const userFolders: FolderItem[] = useMemo(
    () =>
      folders.map((f) => ({
        id: f.id,
        name: f.name,
        count: gallery.filter((img) => img.folderIds?.includes(f.id)).length,
      })),
    [folders, gallery],
  );

  const allFolders = useMemo(
    () => [...BUILTIN_FOLDERS, ...userFolders],
    [userFolders],
  );

  // Pre-compute built-in folder counts to avoid gallery.filter() in JSX per render
  const builtinFolderCounts = useMemo(
    () => ({
      all: gallery.length,
      favorites: gallery.filter((img) => img.liked).length,
      uncategorized: gallery.filter((img) => !img.folderIds?.length).length,
    }),
    [gallery],
  );

  // Filter and sort images — memoized to avoid re-computation on unrelated state changes
  const filteredImages = useMemo(() => {
    const facetFilter = createOrganizeFilter(filters);
    const baseGalleryFilter = createGalleryImageFilter({
      query: searchQuery,
      likedOnly: selectedFolder === "favorites",
    });

    return gallery
      .filter((img) => {
        if (!baseGalleryFilter(img)) return false;

        if (selectedFolder === "uncategorized" && img.folderIds?.length)
          return false;
        if (
          selectedFolder !== "all" &&
          selectedFolder !== "favorites" &&
          selectedFolder !== "uncategorized"
        ) {
          if (!img.folderIds?.includes(selectedFolder)) return false;
        }

        // Status / media / aspect / created facets
        return facetFilter(img);
      })
      .sort((a, b) => {
        if (sortOption === "newest") {
          return (
            new Date(b.createdAt || 0).getTime() -
            new Date(a.createdAt || 0).getTime()
          );
        }
        if (sortOption === "oldest") {
          return (
            new Date(a.createdAt || 0).getTime() -
            new Date(b.createdAt || 0).getTime()
          );
        }
        if (sortOption === "name-az") return a.prompt.localeCompare(b.prompt);
        if (sortOption === "name-za") return b.prompt.localeCompare(a.prompt);
        return 0;
      });
  }, [
    gallery,
    searchQuery,
    selectedFolder,
    filters,
    sortOption,
  ]);
  const renderScopeKey = `${gallery.length}:${searchQuery}:${selectedFolder}:${filtersKey(filters)}:${sortOption}`;
  const effectiveRenderCount =
    renderScopeKeyRef.current === renderScopeKey
      ? renderCount
      : INITIAL_RENDER_COUNT;

  // Group by day when sorted chronologically; single group otherwise
  const groupedImages = useMemo((): Array<[string, typeof filteredImages]> => {
    if (sortOption !== "newest" && sortOption !== "oldest") {
      return [["", filteredImages]];
    }
    const now = new Date();
    const groups = new Map<string, typeof filteredImages>();
    for (const img of filteredImages) {
      const key = dayGroupLabel(img.createdAt, now);
      const bucket = groups.get(key);
      if (bucket) bucket.push(img);
      else groups.set(key, [img]);
    }
    return Array.from(groups.entries());
  }, [filteredImages, sortOption]);

  const visibleGroupedImages = useMemo((): Array<
    [string, typeof filteredImages]
  > => {
    let remaining = effectiveRenderCount;
    const visible: Array<[string, typeof filteredImages]> = [];
    for (const [day, images] of groupedImages) {
      if (remaining <= 0) break;
      const slice = images.slice(0, remaining);
      if (slice.length > 0) visible.push([day, slice]);
      remaining -= slice.length;
    }
    return visible;
  }, [groupedImages, effectiveRenderCount]);

  useEffect(() => {
    selectedImagesRef.current = selectedImages;
  }, [selectedImages]);

  useEffect(() => {
    if (renderScopeKeyRef.current === renderScopeKey) return;
    renderScopeKeyRef.current = renderScopeKey;
    setRenderCount(INITIAL_RENDER_COUNT);
  }, [renderScopeKey]);

  useEffect(() => {
    if (effectiveRenderCount >= filteredImages.length) return;
    const node = renderMoreRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setRenderCount((count) =>
          Math.min(count + RENDER_CHUNK_SIZE, filteredImages.length),
        );
      },
      { rootMargin: "600px" },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [filteredImages.length, effectiveRenderCount]);

  // Auto-fill: count gallery images whose prompt matches the folder name keyword
  const handleAutoFill = useCallback(() => {
    const keyword = newFolderName.trim().toLowerCase();
    if (!keyword) return;
    const matches = gallery.filter((img) =>
      img.prompt.toLowerCase().includes(keyword),
    );
    setAutoFillCount(matches.length);
  }, [newFolderName, gallery]);

  const handleUseParam = useCallback(
    (
      img: { prompt: string; fullPrompt?: string; params?: string[] },
      param: string,
      event: React.MouseEvent,
    ) => {
      event.stopPropagation();
      setPromptValue(
        replacePromptParamText(img.fullPrompt || img.prompt, param),
      );
      setActiveNav("create");
    },
    [setActiveNav, setPromptValue],
  );

  // Selection handlers
  const handleImageClick = useCallback(
    (imageId: string, event: React.MouseEvent) => {
      setSelectedImagesState(
        nextSelection(
          selectedImagesRef.current,
          imageId,
          filteredImages.map((img) => img.id),
          {
            additive: selectMode || event.metaKey || event.ctrlKey,
            range: event.shiftKey,
          },
        ),
      );
    },
    [filteredImages, selectMode, setSelectedImagesState],
  );

  const clearSelection = useCallback(() => {
    setSelectedImagesState(new Set());
    setSelectMode(false);
  }, [setSelectedImagesState]);

  const handleFavoriteSelected = useCallback(() => {
    const ids = Array.from(selectedImagesRef.current);
    if (ids.length === 0) return;
    useGenerationStore.setState((state) => ({
      gallery: addLikedToGalleryByIds(state.gallery, ids),
    }));
  }, []);

  const handleAddSelectedToFolder = useCallback(
    (folderId: string) => {
      if (!folderId) return;
      selectedImagesRef.current.forEach((id) => addImageToFolder(id, folderId));
      clearSelection();
    },
    [addImageToFolder, clearSelection],
  );

  // Esc clears the selection (not while typing).
  const hasSelection = selectedImages.size > 0 || selectMode;
  useEffect(() => {
    if (!hasSelection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasSelection, clearSelection]);

  const handleSelectAll = useCallback(() => {
    const allIds = new Set(filteredImages.map((img) => img.id));
    setSelectedImagesState(allIds);
  }, [filteredImages, setSelectedImagesState]);

  const handleDeleteSelected = useCallback(() => {
    if (selectedImages.size === 0) return;
    Array.from(selectedImages).forEach((imageId) => removeFromGallery(imageId));
    clearSelection();
  }, [selectedImages, removeFromGallery, clearSelection]);

  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent, imageId: string) => {
    const dragSelection = getDragSelection(imageId, selectedImagesRef.current);
    if (!selectedImagesRef.current.has(imageId)) {
      setSelectedImagesState(dragSelection);
    }
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", Array.from(dragSelection).join(","));
  };

  const handleDragOver = (e: React.DragEvent, folderId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverFolder(folderId);
  };

  const handleDragLeave = () => {
    setDragOverFolder(null);
  };

  const handleDrop = (e: React.DragEvent, folderId: string) => {
    e.preventDefault();
    setDragOverFolder(null);

    const imageIds = e.dataTransfer.getData("text/plain").split(",");

    if (folderId === "uncategorized") {
      imageIds.forEach((id) => {
        folders.forEach((f) => removeImageFromFolder(id, f.id));
      });
    } else if (folderId === "favorites") {
      useGenerationStore.setState((state) => ({
        gallery: addLikedToGalleryByIds(state.gallery, imageIds),
      }));
    } else {
      imageIds.forEach((id) => addImageToFolder(id, folderId));
    }

    setSelectedImagesState(new Set());
  };

  // Create folder — optionally auto-fill with keyword-matched images
  const handleCreateFolder = () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    addFolder(trimmed);
    // Auto-fill: find the just-created folder by name, then assign matching images
    if (autoFillCount !== null && autoFillCount > 0) {
      const keyword = trimmed.toLowerCase();
      const newFolder = useGenerationStore
        .getState()
        .folders.find((f) => f.name === trimmed);
      if (newFolder) {
        gallery
          .filter((img) => img.prompt.toLowerCase().includes(keyword))
          .forEach((img) => addImageToFolder(img.id, newFolder.id));
      }
    }
    setNewFolderName("");
    setIsCreatingFolder(false);
    setAutoFillCount(null);
  };

  return (
    // Organize: content grid left, filter panel on the RIGHT
    <div className="flex-1 flex flex-row-reverse min-w-0 overflow-hidden">
      {/* Right panel — folders, filters, view options */}
      <aside className="hidden md:block w-60 flex-shrink-0 overflow-y-auto">
        <div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-medium text-[var(--text-primary)]">Folders</h2>
            <button
              onClick={() => {
                setIsCreatingFolder(true);
                setAutoFillCount(null);
              }}
              className="btn btn-secondary btn-sm btn-icon"
              title="New Folder"
            >
              <FolderPlus className="w-4 h-4" />
            </button>
          </div>

          {isCreatingFolder && (
            <div className="mb-3 p-2 bg-[var(--bg-secondary)] rounded-lg">
              <input
                aria-label="Folder name"
                type="text"
                value={newFolderName}
                onChange={(e) => {
                  setNewFolderName(e.target.value);
                  setAutoFillCount(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateFolder();
                  if (e.key === "Escape") {
                    setIsCreatingFolder(false);
                    setNewFolderName("");
                    setAutoFillCount(null);
                  }
                }}
                placeholder="Folder name..."
                className="input input-sm w-full mb-2"
                autoFocus
              />
              {/* Auto-fill hint */}
              {autoFillCount !== null && (
                <p className="text-xs text-[var(--text-muted)] mb-2">
                  {autoFillCount === 0
                    ? "No matching images found"
                    : `${autoFillCount} image${autoFillCount !== 1 ? "s" : ""} will be added`}
                </p>
              )}
              <div className="flex gap-1.5">
                <button
                  onClick={handleCreateFolder}
                  className="btn btn-primary btn-sm flex-1"
                >
                  Create
                </button>
                <button
                  onClick={handleAutoFill}
                  className={`btn btn-sm btn-icon ${
                    autoFillCount !== null && autoFillCount > 0
                      ? "bg-[var(--accent-primary)]/20 text-[var(--accent-primary)]"
                      : "btn-secondary"
                  }`}
                  title="Auto-fill with matching images"
                  disabled={!newFolderName.trim()}
                >
                  <Wand2 className="w-4 h-4" />
                </button>
                <button
                  aria-label="Cancel new folder"
                  onClick={() => {
                    setIsCreatingFolder(false);
                    setNewFolderName("");
                    setAutoFillCount(null);
                  }}
                  className="btn btn-secondary btn-sm btn-icon"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          <div className="space-y-1">
            {allFolders.map((folder) => (
              <div
                key={folder.id}
                onDragOver={(e) => handleDragOver(e, folder.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, folder.id)}
                className={`group relative ${
                  dragOverFolder === folder.id
                    ? "bg-[var(--accent-primary)]/20"
                    : ""
                }`}
              >
                <button
                  onClick={() => setSelectedFolder(folder.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors ${
                    selectedFolder === folder.id
                      ? "bg-[var(--accent-primary)]/20 text-[var(--accent-primary)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <Folder className="w-4 h-4" />
                  <span className="flex-1 truncate">{folder.name}</span>
                  <span className="text-xs text-[var(--text-muted)]">
                    {folder.id === "all"
                      ? builtinFolderCounts.all
                      : folder.id === "favorites"
                        ? builtinFolderCounts.favorites
                        : folder.id === "uncategorized"
                          ? builtinFolderCounts.uncategorized
                          : folder.count}
                  </span>
                </button>

                {!BUILTIN_FOLDERS.some((f) => f.id === folder.id) && (
                  <button
                    onClick={() => removeFolder(folder.id)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 hover:bg-[var(--error)]/20 rounded text-[var(--error)]"
                    title="Delete folder"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Selection actions live in the floating bar; the panel keeps
              the bulk entry point plus the multi-select hint. */}
          <div className="mt-4">
            <button
              onClick={handleSelectAll}
              className="btn btn-secondary btn-sm w-full"
              disabled={filteredImages.length === 0}
            >
              <CheckSquare className="w-4 h-4 mr-1" />
              Select all ({filteredImages.length})
            </button>
            <p className="mt-1.5 px-0.5 text-[11px] leading-snug text-[var(--text-muted)]">
              ⌘/Ctrl-click to add, Shift-click for a range, drag onto a folder
              to file.
            </p>
          </div>

          {/* Filters (panel sections) */}
          <div className="mt-5">
            <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
              Filters
            </h2>
            <FilterCheckboxGroup
              label="Status"
              selected={filters.status}
              options={STATUS_OPTIONS}
              onToggle={(v) =>
                setFilters((f) => ({
                  ...f,
                  status: toggleFacet(f.status, v, STATUS_OPTIONS),
                }))
              }
            />
            <FilterCheckboxGroup
              label="Media Type"
              selected={filters.media}
              options={MEDIA_OPTIONS}
              onToggle={(v) =>
                setFilters((f) => ({
                  ...f,
                  media: toggleFacet(f.media, v, MEDIA_OPTIONS),
                }))
              }
            />
            <FilterCheckboxGroup
              label="Aspect Ratio"
              selected={filters.aspect}
              options={ASPECT_OPTIONS}
              onToggle={(v) =>
                setFilters((f) => ({
                  ...f,
                  aspect: toggleFacet(f.aspect, v, ASPECT_OPTIONS),
                }))
              }
            />
            <FilterRadioGroup
              label="Created"
              value={filters.date}
              onChange={(v) =>
                setFilters((f) => ({
                  ...f,
                  date: v as OrganizeFilters["date"],
                }))
              }
              options={DATE_OPTIONS}
            />
            {activeFilterCount > 0 && (
              <button
                onClick={clearFilters}
                className="mt-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              >
                Clear filters ({activeFilterCount})
              </button>
            )}
          </div>

          {/* View options */}
          <div className="mt-5">
            <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
              View Options
            </h2>
            <FilterRadioGroup
              label="Layout"
              value={layoutMode}
              onChange={(v) => setLayoutMode(v as "square" | "full")}
              options={[
                { value: "square", label: "Square" },
                { value: "full", label: "Full" },
              ]}
            />
            <FilterRadioGroup
              label="Image Size"
              value={tileSize}
              onChange={(v) => setTileSize(v as "small" | "medium" | "large")}
              options={[
                { value: "small", label: "Small" },
                { value: "medium", label: "Medium" },
                { value: "large", label: "Large" },
              ]}
            />
            <FilterRadioGroup
              label="Sort"
              value={sortOption}
              onChange={(v) => setSortOption(v as SortOption)}
              options={SORT_OPTIONS}
            />
          </div>
        </div>
      </aside>

      <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="flex-shrink-0 px-4 pt-3 pb-2 md:px-6 md:py-4 border-b border-[var(--border-primary)]">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-lg md:text-xl font-semibold tracking-tight text-[var(--text-primary)]">
              Organize
            </h1>
            <div className="flex min-w-0 items-center gap-1.5 md:gap-2">
              <div className="relative hidden md:block min-w-[200px]">
                <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                <input
                  aria-label="Search your images"
                  type="text"
                  placeholder="Search your images..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="input pl-9 w-full"
                />
              </div>
              <button
                onClick={() => setSearchOpen((v) => !v)}
                className={`md:hidden btn btn-icon ${searchOpen || searchQuery ? "btn-secondary text-[var(--text-primary)]" : "bg-transparent text-[var(--text-secondary)]"}`}
                title="Search"
                aria-label="Search your images"
                aria-expanded={searchOpen}
              >
                <Search className="w-4 h-4" />
              </button>
              <button
                onClick={() =>
                  selectMode ? clearSelection() : setSelectMode(true)
                }
                className={`md:hidden btn btn-sm h-9 px-3 transition-colors ${
                  selectMode
                    ? "bg-[var(--accent-primary)]/15 text-[var(--accent-primary)]"
                    : "bg-transparent text-[var(--text-secondary)]"
                }`}
                aria-pressed={selectMode}
              >
                {selectMode ? "Done" : "Select"}
              </button>
              <button
                onClick={() =>
                  setViewMode(viewMode === "grid" ? "list" : "grid")
                }
                className="btn btn-secondary btn-icon"
                title={viewMode === "grid" ? "List view" : "Grid view"}
                aria-label={viewMode === "grid" ? "List view" : "Grid view"}
              >
                {viewMode === "grid" ? (
                  <List className="w-4 h-4" />
                ) : (
                  <Grid className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>

          {(searchOpen || searchQuery) && (
            <div className="relative mt-2 md:hidden">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
              <input
                aria-label="Search your images"
                type="search"
                placeholder="Search your images..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="input pl-9 w-full"
                autoFocus={searchOpen && !searchQuery}
              />
            </div>
          )}

          {/* Mobile filter trigger — visible only on small screens */}
          <div className="flex md:hidden items-center gap-2 mt-2">
            <MobileOrganizeSheet
              filters={filters}
              setFilters={setFilters}
              sortOption={sortOption}
              setSortOption={setSortOption}
              activeFilterCount={activeFilterCount}
              clearFilters={clearFilters}
              resultCount={filteredImages.length}
              folders={allFolders.map((f) => ({
                id: f.id,
                name: f.name,
                count:
                  f.id === "all"
                    ? builtinFolderCounts.all
                    : f.id === "favorites"
                      ? builtinFolderCounts.favorites
                      : f.id === "uncategorized"
                        ? builtinFolderCounts.uncategorized
                        : f.count,
              }))}
              selectedFolder={selectedFolder}
              onSelectFolder={setSelectedFolder}
            />
            <span className="ml-auto text-xs text-[var(--text-muted)] tabular-nums">
              {filteredImages.length} item
              {filteredImages.length !== 1 ? "s" : ""}
            </span>
          </div>

          {/* Desktop: filters live in the right panel; show count only */}
          <div className="hidden md:flex items-center mt-2">
            <span className="ml-auto text-xs text-[var(--text-muted)] tabular-nums">
              {filteredImages.length} item
              {filteredImages.length !== 1 ? "s" : ""}
            </span>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-3 pt-3 pb-24 md:p-6 md:pb-24">
          {filteredImages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-[var(--text-muted)]">
              <ImageIcon className="w-12 h-12 mb-4" />
              <p>No images found</p>
              <p className="text-sm mt-1">
                {selectedFolder === "all" &&
                activeFilterCount === 0 &&
                !searchQuery
                  ? "Generate some images first!"
                  : activeFilterCount > 0 || searchQuery
                    ? "Try adjusting your filters"
                    : "Drag images here to organize"}
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              {visibleGroupedImages.map(([day, dayImages]) => (
                <section key={day || "all"}>
                  {day && (
                    <h2 className="mb-2 px-0.5 text-[13px] font-medium tracking-tight text-[var(--text-secondary)] md:text-sm">
                      {day}
                    </h2>
                  )}
                  <div
                    className={
                      viewMode !== "grid"
                        ? "space-y-2"
                        : layoutMode === "square"
                          ? "grid gap-0.5 [grid-template-columns:repeat(auto-fill,minmax(var(--tile-m),1fr))] md:[grid-template-columns:repeat(auto-fill,minmax(var(--tile),1fr))]"
                          : "gap-0.5 [column-width:var(--tile-m)] md:[column-width:var(--tile)]"
                    }
                    style={
                      viewMode !== "grid"
                        ? undefined
                        : ({
                            "--tile": `${TILE_PX[tileSize]}px`,
                            "--tile-m": `${TILE_PX_MOBILE[tileSize]}px`,
                          } as React.CSSProperties)
                    }
                  >
                    {dayImages.map((img) => (
                      <div
                        key={img.id}
                        draggable
                        onDragStart={(e) => handleDragStart(e, img.id)}
                        onClick={(e) => handleImageClick(img.id, e)}
                        aria-selected={selectedImages.has(img.id)}
                        className={`group relative bg-[var(--bg-secondary)] rounded-[2px] overflow-hidden cursor-pointer select-none transition-[box-shadow,transform] duration-150 ease-out active:scale-[0.98] ${
                          viewMode === "grid" && layoutMode === "full"
                            ? "break-inside-avoid mb-0.5"
                            : ""
                        } ${
                          selectedImages.has(img.id)
                            ? "ring-2 ring-inset ring-[var(--accent-primary)]"
                            : ""
                        }`}
                      >
                        {viewMode === "grid" ? (
                          <>
                            <div
                              className={`relative bg-[var(--bg-tertiary)] ${
                                layoutMode === "square" ||
                                !(img.width && img.height)
                                  ? "aspect-square"
                                  : ""
                              }`}
                              style={
                                layoutMode === "full" && img.width && img.height
                                  ? {
                                      aspectRatio: `${img.width} / ${img.height}`,
                                    }
                                  : undefined
                              }
                              title={img.prompt}
                            >
                              <MediaThumb
                                item={img}
                                className={`transition-[filter] duration-150 ${selectedImages.has(img.id) ? "brightness-75" : ""}`}
                              />
                              {img.liked && (
                                <div className="absolute top-1.5 right-1.5 text-[var(--accent-primary)] drop-shadow">
                                  <svg
                                    className="w-5 h-5 fill-current"
                                    viewBox="0 0 24 24"
                                  >
                                    <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                                  </svg>
                                </div>
                              )}
                              {(selectMode || selectedImages.size > 0) && (
                                <div
                                  className={`absolute top-1.5 left-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full border transition-[background-color,border-color,transform] duration-150 ${
                                    selectedImages.has(img.id)
                                      ? "scale-100 border-transparent bg-[var(--accent-primary)]"
                                      : "scale-90 border-white/80 bg-black/25"
                                  }`}
                                  aria-hidden="true"
                                >
                                  {selectedImages.has(img.id) && (
                                    <Check
                                      className="h-3 w-3 text-white"
                                      strokeWidth={3}
                                    />
                                  )}
                                </div>
                              )}
                            </div>
                            <div
                              className={`absolute inset-0 hidden bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 transition-opacity md:block ${selectedImages.size > 0 ? "" : "group-hover:opacity-100"}`}
                            >
                              <div className="absolute bottom-0 left-0 right-0 p-3">
                                <p className="text-sm text-white line-clamp-2">
                                  {img.prompt}
                                </p>
                                <div className="flex items-center justify-between mt-1 gap-2">
                                  <div className="flex min-w-0 flex-wrap gap-1">
                                    {filterParamChips(img.params).map(
                                      (param, i) => (
                                        <button
                                          key={`${img.id}-grid-param-${i}`}
                                          onClick={(e) =>
                                            handleUseParam(img, param, e)
                                          }
                                          className="rounded-full bg-white/15 px-1.5 py-0.5 text-[10px] text-white/80 hover:bg-white/25"
                                          title={`Use ${param}`}
                                        >
                                          {param}
                                        </button>
                                      ),
                                    )}
                                  </div>
                                  <button
                                    aria-label={img.liked ? "Unlike" : "Like"}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleLiked(img.id);
                                    }}
                                    className="p-1 hover:bg-white/20 rounded"
                                  >
                                    <svg
                                      className={`w-4 h-4 ${img.liked ? "text-red-400 fill-current" : "text-white"}`}
                                      viewBox="0 0 24 24"
                                    >
                                      <path
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        fill="none"
                                        d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
                                      />
                                    </svg>
                                  </button>
                                </div>
                              </div>
                            </div>
                          </>
                        ) : (
                          <div className="flex items-center gap-4 p-3 hover:bg-[var(--bg-hover)]">
                            <div className="relative w-14 h-14 md:w-16 md:h-16 bg-[var(--bg-tertiary)] rounded overflow-hidden flex-shrink-0">
                              <MediaThumb item={img} compact badge={false} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-[var(--text-primary)] truncate">
                                {img.prompt}
                              </p>
                              <div className="mt-1 flex flex-wrap gap-1">
                                {filterParamChips(img.params).map(
                                  (param, i) => (
                                    <button
                                      key={`${img.id}-list-param-${i}`}
                                      onClick={(e) =>
                                        handleUseParam(img, param, e)
                                      }
                                      className="chip text-xs hover:bg-[var(--accent-primary)]/20 hover:border-[var(--accent-primary)]/50 hover:text-[var(--accent-primary)]"
                                      title={`Use ${param}`}
                                    >
                                      {param}
                                    </button>
                                  ),
                                )}
                              </div>
                            </div>
                            <button
                              aria-label={img.liked ? "Unlike" : "Like"}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleLiked(img.id);
                              }}
                              className="btn btn-secondary btn-icon"
                            >
                              <svg
                                className={`w-4 h-4 ${img.liked ? "text-red-400 fill-current" : ""}`}
                                viewBox="0 0 24 24"
                              >
                                <path
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  fill={img.liked ? "currentColor" : "none"}
                                  d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
                                />
                              </svg>
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              ))}
              {effectiveRenderCount < filteredImages.length && (
                <div ref={renderMoreRef} className="h-8" aria-hidden="true" />
              )}
            </div>
          )}
        </div>

        {/* Floating selection bar — the only multi-select actions on touch,
            where the right panel is hidden and drag-to-folder is unavailable. */}
        {selectedImages.size > 0 && (
          <div className="pointer-events-none fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.75rem)] z-20 flex justify-center px-3 md:bottom-6 md:pl-56">
            <div
              role="toolbar"
              aria-label="Selection actions"
              className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-full border border-[var(--border-primary)] bg-[var(--bg-secondary)]/95 p-1 pl-3.5 shadow-[0_8px_30px_rgba(0,0,0,0.35)] backdrop-blur-md animate-[organizeBarIn_160ms_ease-out]"
            >
              <span className="mr-1 whitespace-nowrap text-sm font-medium tabular-nums text-[var(--text-primary)]">
                {selectedImages.size} selected
              </span>
              {selectedImages.size < filteredImages.length && (
                <button
                  onClick={handleSelectAll}
                  className="whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  Select all
                </button>
              )}
              <button
                onClick={handleFavoriteSelected}
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--accent-primary)]"
                title="Add to Favorites"
                aria-label="Add selected to Favorites"
              >
                <Heart className="h-4 w-4" />
              </button>
              {folders.length > 0 && (
                <label className="relative flex h-8 flex-shrink-0 items-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                  <span className="sr-only">Add selected to folder</span>
                  <Folder className="pointer-events-none absolute left-2 h-4 w-4" />
                  <select
                    value=""
                    onChange={(e) => handleAddSelectedToFolder(e.target.value)}
                    className="h-8 cursor-pointer appearance-none rounded-full bg-transparent pl-8 pr-2.5 text-xs outline-none"
                  >
                    <option value="" disabled>
                      Folder
                    </option>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                onClick={handleDeleteSelected}
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--error)]/15 hover:text-[var(--error)]"
                title="Delete"
                aria-label="Delete selected"
              >
                <Trash2 className="h-4 w-4" />
              </button>
              <span className="mx-0.5 h-5 w-px flex-shrink-0 bg-[var(--border-primary)]" />
              <button
                onClick={clearSelection}
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                title="Clear selection (Esc)"
                aria-label="Clear selection"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
      <style>{`@keyframes organizeBarIn{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}@media (prefers-reduced-motion:reduce){[role=toolbar][aria-label="Selection actions"]{animation:none!important}}`}</style>
    </div>
  );
}

// Filter radio group (right panel)

interface FilterRadioGroupProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}

function FilterRadioGroup({
  label,
  value,
  onChange,
  options,
}: FilterRadioGroupProps) {
  return (
    <div className="mb-3">
      <div className="text-xs font-medium text-[var(--text-muted)] mb-1.5">
        {label}
      </div>
      <div className="space-y-0.5">
        {options.map((opt) => {
          const active = value === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              role="radio"
              aria-checked={active}
              className={`flex w-full items-center gap-2 px-1.5 py-1 rounded-md text-sm text-left transition-colors ${
                active
                  ? "text-[var(--text-primary)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              }`}
            >
              <span
                className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center shrink-0 ${
                  active
                    ? "border-[var(--accent-primary)]"
                    : "border-[var(--border-secondary)]"
                }`}
              >
                {active && (
                  <span className="w-2 h-2 rounded-full bg-[var(--accent-primary)]" />
                )}
              </span>
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Filter checkbox group (multi-select, right panel)

function FilterCheckboxGroup<T extends string>({
  label,
  selected,
  options,
  onToggle,
}: {
  label: string;
  selected: readonly T[];
  options: ReadonlyArray<{ value: T; label: string }>;
  onToggle: (value: T) => void;
}) {
  return (
    <div className="mb-3" role="group" aria-label={label}>
      <div className="text-xs font-medium text-[var(--text-muted)] mb-1.5">
        {label}
      </div>
      <div className="space-y-0.5">
        {options.map((opt) => {
          const active = selected.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onToggle(opt.value)}
              role="checkbox"
              aria-checked={active}
              className={`flex w-full items-center gap-2 px-1.5 py-1 rounded-md text-sm text-left transition-colors ${
                active
                  ? "text-[var(--text-primary)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              }`}
            >
              <span
                className={`w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center shrink-0 transition-colors ${
                  active
                    ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white"
                    : "border-[var(--border-secondary)]"
                }`}
              >
                {active && <Check className="w-2.5 h-2.5" strokeWidth={3} />}
              </span>
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default OrganizePage;

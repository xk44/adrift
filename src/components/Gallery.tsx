"use client";

import {
  memo,
  useMemo,
  useCallback,
  useState,
  useRef,
  useEffect,
  useDeferredValue,
  type CSSProperties,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import {
  useGenerationStore,
  useUIStore,
  selectGeneratingRowRuns,
} from "@/store";
import { shallow } from "zustand/shallow";
import type { ImagineRun, ImagineJob, GalleryImage } from "@/types";
import { useDraftUpscale } from "@/hooks/useDraftUpscale";
import { showToast, toastNodeWarnings } from "@/components/Toast";
import { ExtraOutputs } from "@/components/ExtraOutputs";
import { ComfyHistoryImport } from "@/components/ComfyHistoryImport";
import {
  GroupSelectCheckbox,
  SelectCheckbox,
  SelectModeButton,
  useTileSelect,
} from "@/components/gallery/SelectCheckbox";
import { GallerySelectionLayer } from "@/components/gallery/SelectionBar";
import { ProvenanceChip } from "@/components/gallery/ProvenanceChip";
import {
  madeWithLabelFilter,
  madeWithOptions,
  matchesMadeWith,
  runProvenance,
  type MadeWithFilter,
  type MadeWithOption,
  type RunProvenance,
  sourceRunLinkTarget,
  withActiveMadeWithChoice,
} from "@/lib/runProvenance";
import {
  naturalSizeOverride,
  pendingTileAspect,
  previewBlur,
} from "@/lib/pendingTileAspect";
import { fetchRunImages } from "@/lib/sourceRun";
import { useCreateFeedStore } from "@/store/createFeedStore";
import { stabilizeRunGroups } from "@/lib/galleryRunGroups";
import {
  chunkRuns,
  nextCollapsedKeys,
  sameCollapsed,
  windowOverscan,
  type WindowRect,
  type WindowUnit,
} from "@/lib/galleryWindowing";
import {
  buildSelectionIndex,
  downloadTarget,
  idsOf,
} from "@/lib/gallerySelection";
import { useLivePreview } from "@/lib/comfy/livePreview";
import { formatParamsForDisplay } from "@/lib/oj/engine";
import {
  resolveWorkflowForAction,
  mergeActionAndSlotAssignments,
} from "@/lib/workflowAssignments";
import { buildRemixComposition, stripSeedFromPrompt } from "@/lib/remixCompose";
import {
  buildParamChips,
  stripChipFlagsFromPrompt,
  type ParamChip,
} from "@/lib/paramChips";
import {
  GALLERY_MEDIA_FILTERS,
  GALLERY_VIEW_MODES,
  activeFilterCount,
  formatPromptPreview,
  isWallViewMode,
  localDayKey,
  matchesMediaFilter,
  moreImagesLabel,
  parseGalleryViewMode,
  relativeDateLabel,
  runTrashToggle,
  stripPromptFlags,
  type GalleryMediaFilter,
  type GalleryViewMode,
} from "@/lib/galleryView";
import { usePromptPreviewStore } from "@/store/promptPreviewStore";
import { audioExt } from "@/lib/galleryMedia";
import { blenderBundleHref } from "@/lib/mesh/blenderLinks";
import { FirstRunChecklist } from "@/components/setup/FirstRunChecklist";
import { UpscaleModelPicker } from "@/components/upscale/UpscaleModelPicker";
import {
  selectCreatorActionShown,
  useCreatorActionsStore,
} from "@/store/creatorActionsStore";
import { creatorIcon } from "@/components/creatorActionIcons";
import { specOf, type CreatorActionId } from "@/lib/ui/creatorActions";
import { upscaleActionParams } from "@/lib/upscale/upscalePrefs";
import { imageUpscaleContent } from "@/lib/upscale/upscalerPref";
import { StateView } from "@/components/ui/StateView";
import { SkeletonGrid } from "@/components/Skeleton";
import { friendlyLoadError } from "@/lib/ui/viewState";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { QcBadge } from "@/components/videoQc/QcBadge";
import { SafetyFilterOverlay } from "@/components/videoQc/SafetyFilterOverlay";
import {
  filterGalleryImages,
  matchesGalleryPromptQuery,
} from "@/lib/galleryFilters";
import {
  Loader2,
  RefreshCw,
  Download,
  Package,
  MoreHorizontal,
  Maximize,
  Copy,
  Play,
  Music,
  Box,
  ImageIcon,
  Search,
  Heart,
  X,
  EyeOff,
  Eye,
  ArrowUp,
  Check,
  ChevronDown,
  LayoutGrid,
  Rows3,
  Grid3x3,
  SlidersHorizontal,
  Trash2,
  Type,
} from "lucide-react";

const INITIAL_RENDER_ROWS = 40;
const RENDER_ROW_CHUNK_SIZE = 40;
const HISTORY_PAGE_SIZE = 60;

/**
 * Thumbnail <img> that degrades to a quiet placeholder tile when the image
 * fails to load (e.g. ComfyUI offline, so /view URLs 502). Resets if the
 * src changes — a later reconnect with a fresh URL gets a clean retry.
 */
// Run-row tile grid (List view + generating rows): 2-up on phones, the
// measured per-run column count (4-across portrait/square, 2-up landscape)
// from md up. The prompt column sits right beside the tiles.
const RUN_GRID_CLASS =
  "flex-1 min-w-0 grid gap-1 md:gap-2 max-w-[1180px] grid-cols-2 md:[grid-template-columns:var(--run-cols)]";
function runGridStyle(columns: string): CSSProperties {
  return { "--run-cols": columns } as CSSProperties;
}
// Run-row meta column: under the tiles on phones, beside them from lg up.
const RUN_META_CLASS =
  "w-full lg:w-[230px] shrink-0 lg:ml-0 flex flex-col pt-0.5";

/** Tile box: square crops in Thumbnails, true aspect elsewhere; Grid tiles
 * also get justified-row flex sizing (see GRID_WALL_CLASS). */
function tileStyle(
  variant: GalleryViewMode,
  width?: number,
  height?: number,
): CSSProperties {
  if (variant === "thumbs") return { aspectRatio: "1 / 1" };
  const ar = width && height ? width / height : 1;
  if (variant === "list") return { aspectRatio: `${ar}` };
  return {
    aspectRatio: `${ar}`,
    flexGrow: ar,
    flexBasis: `calc(var(--wall-h) * ${ar})`,
  };
}

function ThumbImage({
  src,
  alt,
  onNaturalSize,
}: {
  src: string;
  alt: string;
  onNaturalSize?: (width: number, height: number) => void;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [src]);
  if (failed) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-[var(--bg-tertiary)]">
        <ImageIcon className="w-8 h-8 text-[var(--text-tertiary)]" />
        <span className="text-xs text-[var(--text-tertiary)] mt-1">
          Preview unavailable
        </span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className="w-full h-full object-cover"
      loading="lazy"
      decoding="async"
      onLoad={
        onNaturalSize
          ? (e) =>
              onNaturalSize(
                e.currentTarget.naturalWidth,
                e.currentTarget.naturalHeight,
              )
          : undefined
      }
      onError={() => setFailed(true)}
    />
  );
}

const VIEW_MODE_STORAGE_KEY = "adrift.create.viewMode";
// Wall views: every run's tiles flatten into one continuous wall.
// Grid = justified rows: each tile keeps its real aspect ratio, grows in
// proportion to it, so every row comes out the same height and fills the
// width (the trailing filler keeps the last row from stretching).
// Thumbnails = dense ~9-across wall of square crops.
const GRID_WALL_CLASS =
  "flex flex-wrap gap-1 md:gap-2 [--wall-h:140px] md:[--wall-h:200px] lg:[--wall-h:240px] after:content-[''] after:grow-[999999]";
const THUMBS_GRID_CLASS =
  "grid gap-1 grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-9";

function readStoredViewMode(): GalleryViewMode {
  try {
    return parseGalleryViewMode(
      window.localStorage.getItem(VIEW_MODE_STORAGE_KEY),
    );
  } catch {
    return "grid";
  }
}

/** Nearest scrolling ancestor (the app shell's overflow-y-auto column). */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const { overflowY } = window.getComputedStyle(node);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

export function Gallery() {
  // Auto-fire upscale for completed --draft runs
  useDraftUpscale();

  const activeRuns = useGenerationStore(selectGeneratingRowRuns, shallow);
  const gallery = useGenerationStore((s) => s.gallery);
  const hydrateRecentHistory = useGenerationStore(
    (s) => s.hydrateRecentHistory,
  );
  const openLightbox = useUIStore((s) => s.openLightbox);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const [searchQuery, setSearchQuery] = useState("");
  // Typing stays snappy: the (large) feed filters against a deferred copy.
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [likedOnly, setLikedOnly] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [mediaFilter, setMediaFilter] = useState<GalleryMediaFilter>("all");
  // "Made with" survives reloads / page switches (adrift.create-feed).
  const madeWith = useCreateFeedStore((s) => s.madeWith);
  const setMadeWith = useCreateFeedStore((s) => s.setMadeWith);
  const [viewMode, setViewModeState] = useState<GalleryViewMode>("grid");
  const [renderCount, setRenderCount] = useState(INITIAL_RENDER_ROWS);
  const renderScopeKeyRef = useRef("");
  const sentinelRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [showToTop, setShowToTop] = useState(false);
  const [nextHistoryOffset, setNextHistoryOffset] = useState<number | null>(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  // First server load finished (until then an empty gallery is "loading").
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // Restore the remembered density after mount (SSR renders grid).
  useEffect(() => {
    setViewModeState(readStoredViewMode());
  }, []);

  const setViewMode = useCallback((mode: GalleryViewMode) => {
    setViewModeState(mode);
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      // Storage blocked (private mode) — the choice just won't persist.
    }
  }, []);

  const loadHistory = useCallback(
    async (offset: number) => {
      setHistoryLoading(true);
      try {
        const response = await fetch(
          `/api/jobs/recent?limit=${HISTORY_PAGE_SIZE}&offset=${offset}`,
        );
        if (!response.ok) {
          setHistoryError(`The server answered ${response.status}.`);
          return;
        }
        setHistoryError(null);
        const payload: unknown = await response.json();
        if (!payload || typeof payload !== "object") return;
        const data = payload as {
          ok?: boolean;
          runs?: unknown;
          nextOffset?: unknown;
        };
        if (!data.ok || !Array.isArray(data.runs)) {
          setHistoryError("The server sent an unexpected reply.");
          return;
        }
        hydrateRecentHistory(
          data.runs as Parameters<typeof hydrateRecentHistory>[0],
        );
        setNextHistoryOffset(
          typeof data.nextOffset === "number" ? data.nextOffset : null,
        );
      } catch (err) {
        // Persisted local gallery remains available as the offline fallback.
        setHistoryError(friendlyLoadError(err));
      } finally {
        setHistoryLoading(false);
        setHistoryLoaded(true);
      }
    },
    [hydrateRecentHistory],
  );

  useEffect(() => {
    void loadHistory(0);
  }, [loadHistory]);

  const filteredGallery = useMemo(
    () =>
      filterGalleryImages(gallery, {
        query: deferredSearchQuery,
        likedOnly,
        excludeHidden: !showHidden,
      }).filter(
        (img) =>
          matchesMediaFilter(img, mediaFilter) &&
          matchesMadeWith(img.paramsMap, madeWith),
      ),
    [
      gallery,
      deferredSearchQuery,
      likedOnly,
      showHidden,
      mediaFilter,
      madeWith,
    ],
  );

  const filteredActiveRuns = useMemo(() => {
    if (likedOnly || mediaFilter !== "all") return [];
    return activeRuns.filter(
      (run) =>
        matchesGalleryPromptQuery(
          { prompt: run.prompt },
          deferredSearchQuery,
        ) && matchesMadeWith(run.params, madeWith),
    );
  }, [activeRuns, deferredSearchQuery, likedOnly, mediaFilter, madeWith]);

  // "Made with" filter: per-tool choices from every loaded run.
  // A remembered tool filter stays visible (and clearable) even when no
  // loaded run carries that label yet.
  const madeWithChoices = useMemo(
    () => withActiveMadeWithChoice(madeWithOptions(gallery), madeWith),
    [gallery, madeWith],
  );
  // Tool runs link back to their source run: opened straight from the feed
  // when loaded, otherwise fetched by id (it may be pages back in history).
  const imagesByRunId = useMemo(() => {
    const byRun = new Map<string, GalleryImage[]>();
    for (const img of gallery) {
      const list = byRun.get(img.runId);
      if (list) list.push(img);
      else byRun.set(img.runId, [img]);
    }
    return byRun;
  }, [gallery]);
  const imagesByRunIdRef = useRef(imagesByRunId);
  useEffect(() => {
    imagesByRunIdRef.current = imagesByRunId;
  }, [imagesByRunId]);
  // Stable identity so memoized rows don't re-render on every gallery change.
  const openSourceRun = useCallback(
    async (sourceRunId: string) => {
      const loaded = imagesByRunIdRef.current.get(sourceRunId);
      if (loaded?.length) {
        openLightbox({ images: loaded, index: 0, origin: "create" });
        return;
      }
      try {
        const images = await fetchRunImages(sourceRunId);
        if (images.length) {
          openLightbox({ images, index: 0, origin: "create" });
        } else {
          showToast("Source run is no longer in history", "info");
        }
      } catch {
        showToast("Couldn't load the source run", "error");
      }
    },
    [openLightbox],
  );

  // Run groups whose images are unchanged keep their identity, so memoized
  // ImageRows skip re-rendering when one image is liked or a new run lands.
  const runGroupCacheRef = useRef<Map<string, ImageGroup>>(new Map());
  const groupedGalleryRows = useMemo((): DateImageGroup[] => {
    const now = new Date();
    const groups = new Map<
      string,
      { date: string; label: string; all: GalleryImage[] }
    >();
    for (const img of filteredGallery) {
      const date = new Date(img.createdAt);
      const key = Number.isNaN(date.getTime()) ? "unknown" : localDayKey(date);
      let group = groups.get(key);
      if (!group) {
        group = { date: key, label: relativeDateLabel(date, now), all: [] };
        groups.set(key, group);
      }
      group.all.push(img);
    }
    const prevRuns = runGroupCacheRef.current;
    const nextRuns = new Map<string, ImageGroup>();
    const result = [...groups.values()].map(({ date, label, all }) => {
      const { items, cache } = stabilizeRunGroups(
        date,
        groupImagesByRun(all),
        prevRuns,
      );
      for (const [k, v] of cache) nextRuns.set(k, v);
      return { date, label, rows: items };
    });
    runGroupCacheRef.current = nextRuns;
    return result;
  }, [filteredGallery]);

  // Select mode walks the whole loaded feed (not just rendered rows).
  const selectionIndex = useMemo(
    () => buildSelectionIndex(groupedGalleryRows),
    [groupedGalleryRows],
  );

  const totalRowCount = useMemo(
    () => groupedGalleryRows.reduce((sum, group) => sum + group.rows.length, 0),
    [groupedGalleryRows],
  );

  const renderScopeKey = `${filteredGallery.length}:${filteredGallery[0]?.id ?? ""}:${
    filteredGallery[filteredGallery.length - 1]?.id ?? ""
  }:${deferredSearchQuery}:${likedOnly}:${showHidden}:${mediaFilter}:${madeWith}`;
  const effectiveRenderCount =
    renderScopeKeyRef.current === renderScopeKey
      ? renderCount
      : INITIAL_RENDER_ROWS;

  const visibleGroupedGalleryRows = useMemo((): DateImageGroup[] => {
    let remaining = effectiveRenderCount;
    const visible: DateImageGroup[] = [];
    for (const group of groupedGalleryRows) {
      if (remaining <= 0) break;
      const rows = group.rows.slice(0, remaining);
      if (rows.length > 0) {
        visible.push({ date: group.date, label: group.label, rows });
      }
      remaining -= rows.length;
    }
    return visible;
  }, [groupedGalleryRows, effectiveRenderCount]);

  // Row windowing: rendered runs split into content-defined chunks; chunks far
  // outside the viewport collapse to spacers and remount on approach.
  const chunkedVisibleRows = useMemo(
    () =>
      visibleGroupedGalleryRows.map(({ date, label, rows }) => ({
        date,
        label,
        chunks: chunkRuns(rows, (row) => row.runId).map((chunk) => ({
          key: feedChunkKey(viewMode, date, chunk),
          rows: chunk,
        })),
      })),
    [visibleGroupedGalleryRows, viewMode],
  );
  // key → spacer height (px) for collapsed chunks.
  const [collapsedChunks, setCollapsedChunks] = useState<
    ReadonlyMap<string, number>
  >(() => new Map());
  const collapsedChunksRef = useRef(collapsedChunks);
  collapsedChunksRef.current = collapsedChunks;
  const chunkElsRef = useRef(new Map<string, HTMLElement>());
  const registerChunk = useCallback((key: string, el: HTMLElement | null) => {
    if (el) chunkElsRef.current.set(key, el);
    else chunkElsRef.current.delete(key);
  }, []);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const windowFrameRef = useRef(0);
  const runWindowPass = useCallback(() => {
    windowFrameRef.current = 0;
    const root = rootRef.current;
    if (!root || !root.isConnected) return;
    if (!scrollerRef.current?.isConnected) {
      scrollerRef.current = findScrollParent(root);
    }
    const scroller = scrollerRef.current;
    const viewport: WindowRect = scroller
      ? scroller.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight };
    const overscan = windowOverscan(viewport.bottom - viewport.top);
    const active = document.activeElement;
    const prev = collapsedChunksRef.current;
    const rects = new Map<string, WindowRect | null>();
    const units: WindowUnit[] = [];
    for (const [key, el] of chunkElsRef.current) {
      const rect = measureChunk(el);
      rects.set(key, rect);
      units.push({
        key,
        rect,
        collapsed: prev.has(key),
        pinned: active instanceof Node && el.contains(active),
      });
    }
    const next = new Map<string, number>();
    for (const key of nextCollapsedKeys(units, viewport, overscan)) {
      const rect = rects.get(key);
      // Measured right before unmounting; collapsed spacers keep theirs.
      next.set(key, prev.get(key) ?? (rect ? rect.bottom - rect.top : 0));
    }
    if (!sameCollapsed(prev, next)) setCollapsedChunks(next);
  }, []);
  const scheduleWindowPass = useCallback(() => {
    if (windowFrameRef.current) return;
    windowFrameRef.current = window.requestAnimationFrame(runWindowPass);
  }, [runWindowPass]);
  // Re-check after every chunk-set / collapse change (new rows, view switch).
  useEffect(() => {
    scheduleWindowPass();
  }, [chunkedVisibleRows, collapsedChunks, scheduleWindowPass]);
  useEffect(() => {
    let lastWidth = window.innerWidth;
    const onResize = () => {
      scrollerRef.current = null;
      // Width changes reflow rows: measured spacer heights go stale, so
      // remount everything and let the next pass re-measure.
      if (window.innerWidth !== lastWidth) {
        lastWidth = window.innerWidth;
        setCollapsedChunks((prev) => (prev.size ? new Map() : prev));
      }
      scheduleWindowPass();
    };
    // Capture: the feed scrolls inside the app shell, not the window.
    window.addEventListener("scroll", scheduleWindowPass, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", onResize, { passive: true });
    return () => {
      window.removeEventListener("scroll", scheduleWindowPass, {
        capture: true,
      });
      window.removeEventListener("resize", onResize);
      if (windowFrameRef.current) {
        window.cancelAnimationFrame(windowFrameRef.current);
        windowFrameRef.current = 0;
      }
    };
  }, [scheduleWindowPass]);

  useEffect(() => {
    if (renderScopeKeyRef.current === renderScopeKey) return;
    renderScopeKeyRef.current = renderScopeKey;
    setRenderCount(INITIAL_RENDER_ROWS);
  }, [renderScopeKey]);

  useEffect(() => {
    if (effectiveRenderCount >= totalRowCount) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setRenderCount((prev) =>
            Math.min(prev + RENDER_ROW_CHUNK_SIZE, totalRowCount),
          );
        }
      },
      { rootMargin: "600px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [totalRowCount, effectiveRenderCount]);

  // Floating "To top" pill once the feed has scrolled a screen or so.
  const hasFeed = activeRuns.length > 0 || gallery.length > 0;
  useEffect(() => {
    if (!hasFeed) return;
    let scroller: HTMLElement | Window | null = null;
    const read = () => {
      const top =
        scroller instanceof HTMLElement ? scroller.scrollTop : window.scrollY;
      setShowToTop(top > 900);
    };
    // Resolve lazily: the shell only becomes scrollable once rows render.
    const attach = () => {
      const next: HTMLElement | Window =
        findScrollParent(rootRef.current) ?? window;
      if (next === scroller) return;
      scroller?.removeEventListener("scroll", read);
      scroller = next;
      scroller.addEventListener("scroll", read, { passive: true });
      read();
    };
    attach();
    // Poll only until the shell's scroll container shows up (each attach walks
    // computed styles); after that a resize re-resolves it (breakpoint swap).
    const attachedToElement = () => scroller instanceof HTMLElement;
    const retry = attachedToElement()
      ? 0
      : window.setInterval(() => {
          attach();
          if (attachedToElement()) window.clearInterval(retry);
        }, 2000);
    window.addEventListener("resize", attach, { passive: true });
    return () => {
      window.clearInterval(retry);
      window.removeEventListener("resize", attach);
      scroller?.removeEventListener("scroll", read);
    };
  }, [hasFeed]);

  const scrollToTop = useCallback(() => {
    const scroller = findScrollParent(rootRef.current);
    if (scroller) scroller.scrollTo({ top: 0, behavior: "smooth" });
    else window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const handleImageClick = useCallback(
    (images: GalleryImage[], index: number) => {
      openLightbox({ images, index, origin: "create" });
    },
    [openLightbox],
  );

  if (activeRuns.length === 0 && gallery.length === 0) {
    // Errors never read as the empty-gallery message; the first load shows a skeleton.
    if (!historyLoaded || historyLoading)
      return (
        <StateView
          status="loading"
          title="Loading your images…"
          className="p-4 sm:p-6"
          skeleton={<SkeletonGrid count={8} />}
        />
      );
    if (historyError)
      return (
        <StateView
          status="error"
          title="Couldn't load your images"
          message={historyError}
          onRetry={() => void loadHistory(0)}
        />
      );
  }
  if (activeRuns.length === 0 && gallery.length === 0 && !historyLoading) {
    return (
      <>
        <EmptyState />
        <div className="pb-6">
          <ComfyHistoryImport onImported={() => loadHistory(0)} />
        </div>
      </>
    );
  }

  return (
    // Feed shares the same centered ~1600px column as the prompt bar —
    // px-6 + 1648 cap = 1600 content, identical edges to the header at any
    // width. With the settings panel open the column left-aligns with the bar.
    <div
      ref={rootRef}
      className={`px-6 py-3 space-y-4 max-w-[1648px] ${settingsOpen ? "mr-auto" : "mx-auto"}`}
    >
      {hasFeed && (
        <CreateToolbar
          itemCount={filteredGallery.length}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          likedOnly={likedOnly}
          onLikedOnlyChange={setLikedOnly}
          showHidden={showHidden}
          onShowHiddenChange={setShowHidden}
          mediaFilter={mediaFilter}
          onMediaFilterChange={setMediaFilter}
          madeWith={madeWith}
          onMadeWithChange={setMadeWith}
          madeWithChoices={madeWithChoices}
        />
      )}
      <GallerySelectionLayer orderedIds={selectionIndex.orderedIds} />

      {/* Active runs render as feed rows at the top */}
      {filteredActiveRuns.length > 0 && (
        <section className="flex flex-col gap-2">
          {filteredActiveRuns.map((run) => (
            <GeneratingRow key={run.run_id} run={run} />
          ))}
        </section>
      )}

      {hasFeed &&
        filteredActiveRuns.length === 0 &&
        filteredGallery.length === 0 && (
          <div className="flex h-40 flex-col items-center justify-center text-[var(--text-muted)]">
            <ImageIcon className="mb-3 h-8 w-8" />
            <p className="text-sm">No images found</p>
          </div>
        )}

      {chunkedVisibleRows.map(({ date, label, chunks }) => (
        <section key={date}>
          <h2 className="text-sm font-medium text-[var(--text-secondary)] mb-3 flex items-center gap-2">
            <GroupSelectCheckbox
              ids={selectionIndex.byDay.get(date) ?? []}
              label={`Select all from ${label}`}
            />
            {label}
          </h2>
          {/* Grid / Thumbnails: every run's tiles flow into one wall (chunks
              and rows render with display:contents, so the run handlers
              still apply). List: one full-width row per run. */}
          <div
            className={
              isWallViewMode(viewMode)
                ? viewMode === "thumbs"
                  ? THUMBS_GRID_CLASS
                  : GRID_WALL_CLASS
                : "flex flex-col gap-2"
            }
          >
            {chunks.map((chunk) => (
              <FeedChunk
                key={chunk.key}
                chunkKey={chunk.key}
                rows={chunk.rows}
                viewMode={viewMode}
                collapsedHeight={collapsedChunks.get(chunk.key)}
                registerChunk={registerChunk}
                onImageClick={handleImageClick}
                onOpenSourceRun={openSourceRun}
              />
            ))}
          </div>
        </section>
      ))}

      {effectiveRenderCount < totalRowCount && (
        <div ref={sentinelRef} className="h-4" />
      )}

      {nextHistoryOffset !== null && (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            onClick={() => void loadHistory(nextHistoryOffset)}
            disabled={historyLoading}
            className="h-8 rounded-md border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-wait disabled:opacity-60"
          >
            {historyLoading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}

      <div className="pt-2 pb-4">
        <ComfyHistoryImport onImported={() => loadHistory(0)} />
      </div>

      {/* Floating "To top" pill — sticky to the scrollport's bottom edge so it
          centers on the feed column and clears the mobile tab bar. */}
      <div className="pointer-events-none sticky bottom-[calc(4.25rem+env(safe-area-inset-bottom))] md:bottom-6 z-30 h-0 flex justify-center">
        <button
          type="button"
          onClick={scrollToTop}
          aria-label="Scroll to top"
          tabIndex={showToTop ? 0 : -1}
          aria-hidden={!showToTop}
          className={`absolute bottom-0 flex items-center gap-1.5 h-8 px-3.5 rounded-full border border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[13px] font-medium text-[var(--text-primary)] shadow-lg transition-all duration-200 hover:bg-[var(--bg-hover)] ${
            showToTop
              ? "pointer-events-auto opacity-100 translate-y-0"
              : "opacity-0 translate-y-2"
          }`}
        >
          <ArrowUp className="w-3.5 h-3.5" />
          To top
        </button>
      </div>
    </div>
  );
}

// Feed windowing chunk ------------------------------------------------------

/** Content-addressed: a chunk whose runs change gets a fresh key (and mounts). */
function feedChunkKey(
  viewMode: GalleryViewMode,
  date: string,
  rows: readonly ImageGroup[],
): string {
  let images = 0;
  for (const row of rows) images += row.images.length;
  return `${viewMode}:${date}:${rows[0]?.runId ?? ""}:${
    rows[rows.length - 1]?.runId ?? ""
  }:${rows.length}:${images}`;
}

/** Client rect of a chunk; display:contents chunks span first→last tile. */
function measureChunk(el: Element): WindowRect | null {
  if (el.getClientRects().length > 0) {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  }
  let first = el.firstElementChild;
  while (first && first.getClientRects().length === 0) {
    first = first.firstElementChild;
  }
  let last = el.lastElementChild;
  while (last && last.getClientRects().length === 0) {
    last = last.lastElementChild;
  }
  if (!first || !last) return null;
  return {
    top: first.getBoundingClientRect().top,
    bottom: last.getBoundingClientRect().bottom,
  };
}

interface FeedChunkProps {
  chunkKey: string;
  rows: ImageGroup[];
  viewMode: GalleryViewMode;
  /** Set when collapsed: the spacer height measured before unmounting. */
  collapsedHeight: number | undefined;
  registerChunk: (key: string, el: HTMLElement | null) => void;
  onImageClick: (images: GalleryImage[], index: number) => void;
  onOpenSourceRun: (sourceRunId: string) => void;
}

/**
 * One window chunk of finished runs. Collapsed in List view it is a single
 * measured fixed-height spacer; in the wall views it keeps one empty box per
 * tile with the tile's own sizing, so the justified/thumb wall lays out
 * identically (a single spacer would re-break every line after it).
 */
const FeedChunk = memo(function FeedChunk({
  chunkKey,
  rows,
  viewMode,
  collapsedHeight,
  registerChunk,
  onImageClick,
  onOpenSourceRun,
}: FeedChunkProps) {
  const ref = useCallback(
    (el: HTMLDivElement | null) => registerChunk(chunkKey, el),
    [registerChunk, chunkKey],
  );
  const collapsed = collapsedHeight !== undefined;
  const wall = isWallViewMode(viewMode);

  if (collapsed && !wall) {
    return (
      <div
        ref={ref}
        aria-hidden
        data-feed-chunk="collapsed"
        style={{ height: collapsedHeight }}
      />
    );
  }

  return (
    <div
      ref={ref}
      className={wall ? "contents" : "flex flex-col gap-2"}
      data-feed-chunk={collapsed ? "collapsed" : "mounted"}
    >
      {rows.map((group) =>
        collapsed ? (
          <div key={group.runId} className="contents" aria-hidden>
            {group.images.map((img) => (
              <div
                key={img.id}
                className="rounded-[4px] bg-[var(--bg-tertiary)]"
                style={tileStyle(viewMode, img.width, img.height)}
              />
            ))}
          </div>
        ) : (
          <ImageRow
            key={group.runId}
            images={group.images}
            prompt={group.prompt}
            fullPrompt={group.fullPrompt}
            params={group.params}
            onImageClick={onImageClick}
            viewMode={viewMode}
            onOpenSourceRun={onOpenSourceRun}
          />
        ),
      )}
    </div>
  );
});

// Create toolbar: View · Filters · expanding search

interface CreateToolbarProps {
  itemCount: number;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  viewMode: GalleryViewMode;
  onViewModeChange: (mode: GalleryViewMode) => void;
  likedOnly: boolean;
  onLikedOnlyChange: Dispatch<SetStateAction<boolean>>;
  showHidden: boolean;
  onShowHiddenChange: Dispatch<SetStateAction<boolean>>;
  mediaFilter: GalleryMediaFilter;
  onMediaFilterChange: (filter: GalleryMediaFilter) => void;
  madeWith: MadeWithFilter;
  onMadeWithChange: (filter: MadeWithFilter) => void;
  madeWithChoices: readonly MadeWithOption[];
}

const MADE_WITH_FILTERS: ReadonlyArray<{ id: MadeWithFilter; label: string }> =
  [
    { id: "all", label: "All" },
    { id: "prompts", label: "Prompts" },
    { id: "tools", label: "Tools" },
  ];

function filterPillClass(active: boolean): string {
  return `h-7 px-2.5 rounded-full border text-xs transition-colors ${
    active
      ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]/15 text-[var(--accent-primary)]"
      : "border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
  }`;
}

const VIEW_ICONS: Record<GalleryViewMode, typeof LayoutGrid> = {
  grid: LayoutGrid,
  list: Rows3,
  thumbs: Grid3x3,
};

const TOOLBAR_BUTTON =
  "h-8 [@media(pointer:coarse)]:h-10 rounded-md px-2.5 text-[13px] flex items-center gap-1.5 transition-colors";
const TOOLBAR_IDLE =
  "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]";
const TOOLBAR_ACTIVE = "bg-[var(--bg-hover)] text-[var(--text-primary)]";
const POPOVER_CLASS =
  "absolute right-0 top-full mt-1 z-50 max-w-[calc(100vw-2rem)] py-1 bg-[var(--bg-secondary)] border border-[var(--border-primary)] rounded-lg shadow-xl";
const POPOVER_ROW =
  "w-full px-2 py-1.5 rounded-md text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] flex items-center gap-2";

function CreateToolbar({
  itemCount,
  searchQuery,
  onSearchChange,
  viewMode,
  onViewModeChange,
  likedOnly,
  onLikedOnlyChange,
  showHidden,
  onShowHiddenChange,
  mediaFilter,
  onMediaFilterChange,
  madeWith,
  onMadeWithChange,
  madeWithChoices,
}: CreateToolbarProps) {
  const [openMenu, setOpenMenu] = useState<"view" | "filters" | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const filterCount =
    activeFilterCount({ likedOnly, media: mediaFilter }) +
    (showHidden ? 1 : 0) +
    (madeWith !== "all" ? 1 : 0);
  const searchExpanded = searchFocused || searchQuery.length > 0;
  const ViewIcon = VIEW_ICONS[viewMode];

  useEffect(() => {
    if (!openMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openMenu]);

  return (
    <div
      className="flex items-center gap-1 min-h-8"
      role="toolbar"
      aria-label="Create feed tools"
    >
      <span className="mr-auto text-xs text-[var(--text-muted)] tabular-nums whitespace-nowrap">
        {itemCount} item
        {itemCount !== 1 ? "s" : ""}
      </span>

      {openMenu && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setOpenMenu(null)}
          aria-hidden="true"
        />
      )}

      <SelectModeButton compact={searchExpanded} />

      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenMenu(openMenu === "view" ? null : "view")}
          aria-haspopup="menu"
          aria-expanded={openMenu === "view"}
          title="Change view"
          className={`${TOOLBAR_BUTTON} ${openMenu === "view" ? TOOLBAR_ACTIVE : TOOLBAR_IDLE}`}
        >
          <ViewIcon className="w-3.5 h-3.5" />
          <span className={searchExpanded ? "hidden sm:inline" : ""}>View</span>
          <ChevronDown className="w-3 h-3 opacity-60" />
        </button>
        {openMenu === "view" && (
          <div
            className={`${POPOVER_CLASS} w-[250px] px-1`}
            role="menu"
            aria-label="View"
          >
            {GALLERY_VIEW_MODES.map((mode) => {
              const Icon = VIEW_ICONS[mode.id];
              const active = mode.id === viewMode;
              return (
                <button
                  key={mode.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => {
                    onViewModeChange(mode.id);
                    setOpenMenu(null);
                  }}
                  className={`${POPOVER_ROW} items-start`}
                >
                  <Icon className="w-4 h-4 mt-0.5 shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span
                      className={`block ${active ? "text-[var(--text-primary)] font-medium" : ""}`}
                    >
                      {mode.label}
                    </span>
                    <span className="block text-xs text-[var(--text-muted)]">
                      {mode.hint}
                    </span>
                  </span>
                  {active && (
                    <Check className="w-4 h-4 mt-0.5 shrink-0 text-[var(--accent-primary)]" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenMenu(openMenu === "filters" ? null : "filters")}
          aria-haspopup="dialog"
          aria-expanded={openMenu === "filters"}
          title="Filters"
          className={`${TOOLBAR_BUTTON} ${
            filterCount > 0
              ? "text-[var(--accent-primary)] hover:bg-[var(--bg-hover)]"
              : openMenu === "filters"
                ? TOOLBAR_ACTIVE
                : TOOLBAR_IDLE
          }`}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          <span className={searchExpanded ? "hidden sm:inline" : ""}>
            Filters
          </span>
          {filterCount > 0 && (
            <span className="min-w-4 h-4 px-1 rounded-full bg-[var(--accent-primary)] text-white text-[10px] leading-4 text-center tabular-nums">
              {filterCount}
            </span>
          )}
        </button>
        {openMenu === "filters" && (
          <div
            className={`${POPOVER_CLASS} w-[240px] px-1`}
            role="dialog"
            aria-label="Filters"
          >
            <div className="px-2 pt-1.5 pb-1 text-[11px] text-[var(--text-muted)]">
              Show
            </div>
            <button
              type="button"
              onClick={() => onLikedOnlyChange((value) => !value)}
              aria-pressed={likedOnly}
              title="Liked only"
              className={POPOVER_ROW}
            >
              <Heart
                className={`h-3.5 w-3.5 ${likedOnly ? "fill-current text-[var(--accent-primary)]" : ""}`}
              />
              <span className="flex-1">Liked only</span>
              {likedOnly && (
                <Check className="w-4 h-4 text-[var(--accent-primary)]" />
              )}
            </button>
            <button
              type="button"
              onClick={() => onShowHiddenChange((value) => !value)}
              aria-pressed={showHidden}
              title="Include hidden images"
              className={POPOVER_ROW}
            >
              <Eye className="h-3.5 w-3.5" />
              <span className="flex-1">Include hidden</span>
              {showHidden && (
                <Check className="w-4 h-4 text-[var(--accent-primary)]" />
              )}
            </button>
            <div className="px-2 pt-2.5 pb-1 text-[11px] text-[var(--text-muted)]">
              Media
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-2">
              {GALLERY_MEDIA_FILTERS.map((option) => {
                const active = option.id === mediaFilter;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => onMediaFilterChange(option.id)}
                    aria-pressed={active}
                    className={`h-7 px-2.5 rounded-full border text-xs transition-colors ${
                      active
                        ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]/15 text-[var(--accent-primary)]"
                        : "border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <div className="px-2 pt-1.5 pb-1 text-[11px] text-[var(--text-muted)]">
              Made with
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-2">
              {MADE_WITH_FILTERS.map((option) => {
                const active = option.id === madeWith;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => onMadeWithChange(option.id)}
                    aria-pressed={active}
                    className={filterPillClass(active)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            {madeWithChoices.length > 0 && (
              <div
                className="flex flex-wrap gap-1 px-2 pb-2 max-h-28 overflow-y-auto"
                role="group"
                aria-label="Made with tool"
              >
                {madeWithChoices.map(({ label, count }) => {
                  const id = madeWithLabelFilter(label);
                  const active = id === madeWith;
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => onMadeWithChange(active ? "tools" : id)}
                      aria-pressed={active}
                      title={`${count} run${count === 1 ? "" : "s"}`}
                      className={filterPillClass(active)}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
            {filterCount > 0 && (
              <div className="border-t border-[var(--border-primary)] mt-1 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    onLikedOnlyChange(false);
                    onShowHiddenChange(false);
                    onMediaFilterChange("all");
                    onMadeWithChange("all");
                  }}
                  className={POPOVER_ROW}
                >
                  Clear filters
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Search: an icon-width field that widens while focused or filled */}
      <div
        className={`relative transition-[width] duration-200 ${
          searchExpanded ? "w-40 sm:w-[260px]" : "w-8"
        }`}
      >
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]"
          aria-hidden="true"
        />
        <input
          ref={searchRef}
          type="text"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onSearchChange("");
              searchRef.current?.blur();
            }
          }}
          placeholder={searchExpanded ? "Search prompts..." : ""}
          aria-label="Search prompts"
          title="Search prompts"
          className={`h-8 w-full rounded-md border pl-8 pr-6 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors ${
            searchExpanded
              ? "border-[var(--border-primary)] bg-[var(--bg-secondary)] focus:border-[var(--accent-primary)]"
              : "border-transparent bg-transparent cursor-pointer hover:bg-[var(--bg-hover)]"
          }`}
        />
        {searchQuery && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSearchChange("")}
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
// Generating row: placeholder tiles + right meta column

interface GeneratingRowProps {
  run: ImagineRun;
}

const GeneratingRow = memo(function GeneratingRow({ run }: GeneratingRowProps) {
  const { cancelJob, addError } = useGenerationStore(
    (s) => ({
      cancelJob: s.cancelJob,
      addError: s.addError,
    }),
    shallow,
  );
  const [cancellingPromptIds, setCancellingPromptIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Tile aspect: the job's real size (submit response / model defaults),
  // then the --ar param, then square.
  const { ar, aspectRatio } = pendingTileAspect(run);
  const gridCols = ar >= 1.3 ? 2 : 4;

  const chips = useMemo(
    () =>
      buildParamChips(
        formatParamsForDisplay(run.params),
        typeof run.params?.seed === "number" ? [run.params.seed] : [],
      ),
    [run.params],
  );
  const displayPrompt = useMemo(
    () =>
      stripChipFlagsFromPrompt(
        run.prompt,
        chips.map((chip) => chip.key),
      ),
    [run.prompt, chips],
  );

  const completedCount = run.jobs.filter((j) => j.status === "done").length;
  const errorCount = run.jobs.filter((j) => j.status === "error").length;
  const runningCount = run.jobs.filter((j) => j.status === "running").length;
  const avgProgress =
    run.jobs.length > 0
      ? Math.round(
          run.jobs.reduce((sum, j) => sum + j.progress, 0) / run.jobs.length,
        )
      : 0;

  const statusText =
    errorCount > 0
      ? `${errorCount} failed`
      : runningCount > 0
        ? `Generating ${completedCount}/${run.jobs.length} · ${avgProgress}%`
        : run.jobs.some((j) => j.status === "queued")
          ? "Queued"
          : `${completedCount}/${run.jobs.length}`;

  const [confirm, confirmDialog] = useConfirm();
  const handleCancelJob = useCallback(
    async (job: ImagineJob) => {
      if (!job.prompt_id || cancellingPromptIds.has(job.prompt_id)) return;
      const promptId = job.prompt_id;
      setCancellingPromptIds((prev) => new Set(prev).add(promptId));
      try {
        const post = async (confirmGlobal: boolean) => {
          const res = await fetch("/api/jobs/cancel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt_id: promptId,
              ...(confirmGlobal ? { confirm_global: true } : {}),
            }),
          });
          const data = (await res.json().catch(() => null)) as {
            ok?: boolean;
            action?: string;
            error?: string;
            comfyui_version?: string | null;
          } | null;
          if (!res.ok || !data?.ok) {
            throw new Error(data?.error ?? `Cancel failed (${res.status})`);
          }
          return data;
        };
        let data = await post(false);
        if (data.action === "confirm-global-interrupt") {
          // Pre-0.3.57 ComfyUI can't target one prompt: /interrupt stops
          // whatever is running, possibly another client's job.
          const ok = await confirm({
            title: "Interrupt the running job?",
            message:
              `ComfyUI ${data.comfyui_version ?? "(unknown version)"} can't cancel a single job; ` +
              "this stops whatever is running now, which may be someone else's job.",
            confirmLabel: "Interrupt",
            danger: true,
          });
          if (!ok) return;
          data = await post(true);
        }
        if (data.action === "queue-delete" || data.action === "interrupt") {
          cancelJob(promptId);
        }
      } catch (error) {
        addError({
          message:
            error instanceof Error ? error.message : "Failed to cancel job",
          category: "network",
        });
      } finally {
        setCancellingPromptIds((prev) => {
          const next = new Set(prev);
          next.delete(promptId);
          return next;
        });
      }
    },
    [addError, cancelJob, cancellingPromptIds, confirm],
  );

  return (
    <div className="group relative flex flex-col lg:flex-row gap-3">
      {confirmDialog}
      {/* Job tiles — same grid contract as finished rows */}
      <div
        className={RUN_GRID_CLASS}
        style={runGridStyle(`repeat(${gridCols}, 1fr)`)}
      >
        {run.jobs.map((job) => (
          <div
            key={job.index}
            className="relative rounded-[4px] overflow-hidden bg-[var(--bg-tertiary)]"
            style={{ aspectRatio }}
            data-testid="pending-tile"
            data-status={job.status}
          >
            <JobPreview
              job={job}
              runId={run.run_id}
              blankCheck={run.params?._blankCheck === "ideogram"}
            />
            {job.backend && (
              <span
                className="absolute top-2 left-2 z-10 max-w-[60%] px-1.5 py-0.5 rounded bg-black/55 text-white text-[10px] truncate pointer-events-none"
                title={`Ran on ${job.backend.name}`}
                data-testid="job-machine"
              >
                {job.backend.name}
              </span>
            )}
            {(job.status === "queued" || job.status === "running") &&
              job.prompt_id && (
                <button
                  type="button"
                  onClick={() => void handleCancelJob(job)}
                  disabled={cancellingPromptIds.has(job.prompt_id)}
                  className="absolute top-2 right-2 z-10 w-7 h-7 rounded-full bg-black/55 hover:bg-black/75 disabled:opacity-50 text-white flex items-center justify-center transition-colors"
                  aria-label="Cancel job"
                  title="Cancel job"
                >
                  {cancellingPromptIds.has(job.prompt_id) ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <X className="w-4 h-4" />
                  )}
                </button>
              )}
            {job.status === "running" && (
              <div className="absolute bottom-0 left-0 right-0 z-10 h-1 bg-black/40">
                <div
                  className="h-full bg-[var(--accent-primary)] transition-[width] duration-300"
                  style={{ width: `${job.progress}%` }}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Meta column — prompt, params, status (flush right like the feed) */}
      <div className={RUN_META_CLASS}>
        <p
          className="text-sm text-[var(--text-primary)] line-clamp-4 leading-relaxed"
          title={run.prompt}
        >
          {displayPrompt}
        </p>
        <div className="flex flex-wrap gap-1 mt-2">
          {chips.slice(0, 7).map((chip) => (
            <span
              key={`${chip.key}:${chip.value}`}
              className="chip text-xs max-w-full truncate"
            >
              {chip.label}
            </span>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span
            className={`w-2 h-2 rounded-full ${
              errorCount > 0
                ? "bg-[var(--error)]"
                : "bg-[var(--accent-primary)] animate-pulse"
            }`}
          />
          <span
            className={
              errorCount > 0
                ? "text-[var(--error)]"
                : "text-[var(--text-secondary)] tabular-nums"
            }
          >
            {statusText}
          </span>
        </div>
        {errorCount > 0 && (
          <p
            className="mt-1.5 text-xs text-[var(--error)] line-clamp-3"
            title={run.jobs.find((j) => j.status === "error")?.error}
          >
            {run.jobs.find((j) => j.status === "error")?.error?.slice(0, 200) ||
              "Generation failed"}
          </p>
        )}
        {run.status === "error" && <FailedRunActions run={run} />}
      </div>
    </div>
  );
});

/**
 * Retry / Dismiss for a failed Create run. Retry resubmits the plain Create
 * prompt for the failed slots only; tool/action runs (upscale, vary, edit
 * tools) need their source inputs, so they only offer Dismiss.
 */
function FailedRunActions({ run }: { run: ImagineRun }) {
  const {
    selectedWorkflowPath,
    selectedWorkflowName,
    defaultWorkflowPath,
    defaultWorkflowName,
    actionWorkflowMap,
    workflowControlOverrides,
  } = useUIStore(
    (s) => ({
      selectedWorkflowPath: s.selectedWorkflowPath,
      selectedWorkflowName: s.selectedWorkflowName,
      defaultWorkflowPath: s.defaultWorkflowPath,
      defaultWorkflowName: s.defaultWorkflowName,
      actionWorkflowMap: s.actionWorkflowMap,
      workflowControlOverrides: s.workflowControlOverrides,
    }),
    shallow,
  );
  const { addRun, removeRun, clientId, setError } = useGenerationStore(
    (s) => ({
      addRun: s.addRun,
      removeRun: s.removeRun,
      clientId: s.clientId,
      setError: s.setError,
    }),
    shallow,
  );
  const [retrying, setRetrying] = useState(false);
  const failedCount = run.jobs.filter((j) => j.status === "error").length;
  const canRetry =
    failedCount > 0 &&
    !run.action &&
    !run.sourceImage &&
    !(run.sourceImages && run.sourceImages.length > 0) &&
    runProvenance(run.params) === null &&
    stripSeedFromPrompt(run.prompt).trim().length > 0;

  const handleRetry = useCallback(async () => {
    const prompt = stripSeedFromPrompt(run.prompt).trim();
    if (!prompt) return;
    const workflowPath = resolveWorkflowForAction("promptbar.imagine", {
      assignments: mergeActionAndSlotAssignments(actionWorkflowMap),
      selectedWorkflowPath,
      selectedWorkflowName,
      defaultWorkflowPath,
      defaultWorkflowName,
    })?.workflowPath;
    setRetrying(true);
    try {
      const response = await fetch("/api/jobs/imagine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          client_id: clientId,
          batch_size: failedCount,
          workflow_path: workflowPath,
          ...(Object.keys(workflowControlOverrides).length > 0
            ? { workflow_control_overrides: workflowControlOverrides }
            : {}),
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error ?? `Retry failed (${response.status})`);
      }
      for (const next of data.runs ?? []) addRun(next);
      removeRun(run.run_id);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Retry failed");
    } finally {
      setRetrying(false);
    }
  }, [
    run.prompt,
    run.run_id,
    failedCount,
    actionWorkflowMap,
    selectedWorkflowPath,
    selectedWorkflowName,
    defaultWorkflowPath,
    defaultWorkflowName,
    workflowControlOverrides,
    clientId,
    addRun,
    removeRun,
    setError,
  ]);

  return (
    <div className="mt-2 flex items-center gap-1" data-testid="failed-run-actions">
      {canRetry && (
        <button
          type="button"
          className={RUN_ACTION_BUTTON}
          onClick={() => void handleRetry()}
          disabled={retrying}
        >
          {retrying ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          Retry{failedCount > 1 ? ` ${failedCount}` : ""}
        </button>
      )}
      <button
        type="button"
        className={RUN_ACTION_BUTTON}
        onClick={() => removeRun(run.run_id)}
      >
        <X className="w-3.5 h-3.5" />
        Dismiss
      </button>
    </div>
  );
}

/** Final image fades in over the held last preview frame. */
function FinalImageFade({
  src,
  alt,
  previewUrl,
}: {
  src: string;
  alt: string;
  previewUrl?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [src]);
  if (failed) return <ThumbImage src={src} alt={alt} />;
  return (
    <>
      {previewUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={previewUrl}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 w-full h-full object-cover"
          draggable={false}
        />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className={`relative w-full h-full object-cover transition-opacity duration-500 ease-out ${
          loaded ? "opacity-100" : "opacity-0"
        }`}
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </>
  );
}

interface JobPreviewProps {
  job: ImagineJob;
  runId: string;
  /** Ideogram run: watch for a safety-filter blank canvas. */
  blankCheck?: boolean;
}

const JobPreview = memo(function JobPreview({
  job,
  runId,
  blankCheck = false,
}: JobPreviewProps) {
  // Live latent preview (ComfyUI --preview-method), object URL owned by the
  // livePreviews registry; it is revoked once the real outputs load.
  const livePreviewUrl = useLivePreview(job.prompt_id);
  // Remember the last preview frame so the final image can cross-fade over
  // it even after the registry revokes the URL (an already-decoded <img>
  // keeps painting after revokeObjectURL).
  const lastPreviewRef = useRef<string | undefined>(undefined);
  if (livePreviewUrl) lastPreviewRef.current = livePreviewUrl;
  const heldPreview = livePreviewUrl ?? lastPreviewRef.current;
  if (job.status === "done") {
    if (job.videos && job.videos.length > 0) {
      return (
        <div className="relative w-full h-full">
          <video
            src={job.videos[0]}
            className="w-full h-full object-cover"
            muted
            loop
            autoPlay
            playsInline
          />
          <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-[var(--success)] flex items-center justify-center">
            <svg
              className="w-3 h-3 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={3}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
          <div className="absolute bottom-2 left-2 px-1.5 py-0.5 rounded bg-black/60 text-white text-[10px]">
            VIDEO
          </div>
          <div className="absolute bottom-2 right-2">
            <QcBadge jobId={`${runId}:${job.index}`} videoUrl={job.videos[0]} />
          </div>
        </div>
      );
    }
    if (job.audios && job.audios.length > 0) {
      return (
        <div className="relative w-full h-full flex flex-col items-center justify-center bg-[var(--bg-tertiary)]">
          <Music className="w-8 h-8 text-[var(--accent-primary)]" />
          <span className="text-xs text-[var(--text-secondary)] mt-2">
            Audio
          </span>
          <audio src={job.audios[0]} controls className="w-[90%] mt-2 h-6" />
          <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-[var(--success)] flex items-center justify-center">
            <svg
              className="w-3 h-3 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={3}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
        </div>
      );
    }
    if (job.meshes && job.meshes.length > 0) {
      return (
        <div className="relative w-full h-full flex flex-col items-center justify-center bg-[var(--bg-tertiary)]">
          <Box className="w-8 h-8 text-[var(--accent-primary)]" />
          <span className="text-xs text-[var(--text-secondary)] mt-2">
            3D Model
          </span>
          <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-[var(--success)] flex items-center justify-center">
            <svg
              className="w-3 h-3 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={3}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
        </div>
      );
    }
    if (job.images.length > 0) {
      return (
        <div className="relative w-full h-full">
          <FinalImageFade
            src={job.images[0]}
            alt={`Generated image ${job.index + 1}`}
            previewUrl={heldPreview}
          />
          {blankCheck && (
            <SafetyFilterOverlay
              jobId={`${runId}:${job.index}`}
              imageUrl={job.images[0]}
            />
          )}
          <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-[var(--success)] flex items-center justify-center">
            <svg
              className="w-3 h-3 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={3}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
        </div>
      );
    }
    // Finished but outputs not loaded yet: hold the last preview frame
    // instead of flashing the empty-output view.
    if (livePreviewUrl) {
      return (
        <div className="relative w-full h-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={livePreviewUrl}
            alt=""
            aria-hidden="true"
            className="w-full h-full object-cover"
            draggable={false}
          />
        </div>
      );
    }
    // Done with no image/video/audio/mesh: text-only (PreviewAny/ShowText)
    // or latent/custom outputs. Show them instead of falling through to
    // the "Queued" placeholder.
    return (
      <div className="relative w-full h-full flex flex-col bg-[var(--bg-tertiary)]">
        <ExtraOutputs promptId={job.prompt_id} compact />
        <span className="absolute bottom-1 right-2 text-[10px] text-[var(--text-tertiary)] pointer-events-none">
          Done
        </span>
      </div>
    );
  }
  if (job.status === "running" && livePreviewUrl) {
    return (
      <div className="relative w-full h-full overflow-hidden bg-[var(--bg-tertiary)]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={livePreviewUrl}
          alt={`Live preview ${job.index + 1}`}
          className="w-full h-full object-cover transition-[filter] duration-500 ease-out"
          style={{ filter: previewBlur(job.progress), transform: "scale(1.04)" }}
          draggable={false}
          data-testid="live-preview"
        />
        <div className="absolute bottom-2 left-2 max-w-[calc(100%-1rem)] px-1.5 py-0.5 rounded bg-black/60 text-white text-[10px] tabular-nums truncate">
          {job.currentNodeLabel ? `${job.currentNodeLabel} · ` : ""}
          {job.nodeProgress
            ? `${job.nodeProgress.current}/${job.nodeProgress.total} · `
            : ""}
          {job.progress}%
        </div>
      </div>
    );
  }
  if (job.status === "running") {
    return (
      <div className="relative w-full h-full flex flex-col items-center justify-center bg-[var(--bg-tertiary)]">
        <Loader2 className="w-8 h-8 text-[var(--accent-primary)] animate-spin" />
        <span className="text-xs text-[var(--text-tertiary)] mt-2 tabular-nums">
          {job.progress}%
        </span>
        {job.currentNodeLabel && (
          <span className="text-[10px] text-[var(--text-muted)] mt-0.5 max-w-[85%] truncate">
            {job.currentNodeLabel}
          </span>
        )}
        <div className="absolute inset-4 flex items-center justify-center">
          <svg className="w-full h-full -rotate-90">
            <circle
              cx="50%"
              cy="50%"
              r="30%"
              stroke="currentColor"
              strokeWidth="2"
              fill="none"
              className="text-[var(--bg-primary)]"
              strokeDasharray={`${job.progress * 1.88} 188`}
            />
          </svg>
        </div>
      </div>
    );
  }
  if (job.status === "error") {
    return (
      <div className="relative w-full h-full flex flex-col items-center justify-center bg-[var(--error)]/10">
        <svg
          className="w-8 h-8 text-[var(--error)]"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
        <span className="text-xs text-[var(--error)] mt-2">Error</span>
      </div>
    );
  }
  return (
    <div className="relative w-full h-full flex flex-col items-center justify-center bg-[var(--bg-tertiary)]">
      <div className="w-4 h-4 rounded-full border-2 border-[var(--text-muted)] animate-pulse-soft" />
      <span className="text-xs text-[var(--text-tertiary)] mt-2">
        {job.prompt_id ? "Queued" : "Submitting"}
      </span>
    </div>
  );
});

const RUN_ACTION_BUTTON =
  "h-7 px-2 rounded-md text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-50 flex items-center gap-1.5 transition-colors";
// Per-image actions tucked into the List row's More menu.
// Names and icons match the lightbox rows (lib/ui/creatorActions.ts), and
// actions hidden there are hidden here too.
const VaryIcon = creatorIcon(specOf("vary_subtle").icon);
const UpscaleIcon = creatorIcon(specOf("upscale_faithful").icon);
const AnimateIcon = creatorIcon(specOf("animate_low").icon);
const RUN_MORE_ACTIONS: readonly { action: string; id: CreatorActionId }[] = [
  { action: "vary_subtle", id: "vary_subtle" },
  { action: "vary_strong", id: "vary_strong" },
  { action: "upscale_subtle", id: "upscale_faithful" },
  { action: "upscale_creative", id: "upscale_creative" },
];

interface ImageRowProps {
  images: GalleryImage[];
  prompt: string;
  fullPrompt: string;
  params: string[];
  onImageClick: (images: GalleryImage[], index: number) => void;
  viewMode?: GalleryViewMode;
  /** Open the run this one was made from (tool provenance), loaded or not. */
  onOpenSourceRun?: (sourceRunId: string) => void;
}

const ImageRow = memo(function ImageRow({
  images,
  prompt,
  fullPrompt,
  params,
  onImageClick,
  viewMode = "grid",
  onOpenSourceRun,
}: ImageRowProps) {
  const [showCopyMenu, setShowCopyMenu] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const shownActions = useCreatorActionsStore(
    selectCreatorActionShown,
    shallow,
  );
  const runMoreActions = RUN_MORE_ACTIONS.filter(({ id }) => shownActions[id]);
  const [touchActionIndex, setTouchActionIndex] = useState<number | null>(null);
  const touchedImageIndexRef = useRef<number | null>(null);
  const {
    setPromptValue,
    addImageAttachment,
    appendToPrompt,
    replacePromptParam,
    selectedWorkflowPath,
    selectedWorkflowName,
    defaultWorkflowPath,
    defaultWorkflowName,
    actionWorkflowMap,
    workflowControlOverrides,
  } = useUIStore(
    (s) => ({
      setPromptValue: s.setPromptValue,
      addImageAttachment: s.addImageAttachment,
      appendToPrompt: s.appendToPrompt,
      replacePromptParam: s.replacePromptParam,
      selectedWorkflowPath: s.selectedWorkflowPath,
      selectedWorkflowName: s.selectedWorkflowName,
      defaultWorkflowPath: s.defaultWorkflowPath,
      defaultWorkflowName: s.defaultWorkflowName,
      actionWorkflowMap: s.actionWorkflowMap,
      workflowControlOverrides: s.workflowControlOverrides,
    }),
    shallow,
  );
  const { addRun, clientId, setError } = useGenerationStore(
    (s) => ({
      addRun: s.addRun,
      clientId: s.clientId,
      setError: s.setError,
    }),
    shallow,
  );
  const toggleHidden = useGenerationStore((s) => s.toggleHidden);
  const activeImage = images[activeImageIndex] ?? images[0];
  const runImageIds = useMemo(() => idsOf(images), [images]);
  // One humanized chip per param plus a single seed chip for the whole run;
  // the shown prompt drops the trailing flags those chips already cover
  // (Copy / Use text still use the full prompt).
  const chips = useMemo(
    () =>
      buildParamChips(
        params,
        images.map((img) => img.seed),
      ),
    [params, images],
  );
  const displayPrompt = useMemo(
    () =>
      stripChipFlagsFromPrompt(
        prompt,
        chips.map((chip) => chip.key),
      ),
    [prompt, chips],
  );
  // Wall-view hover caption: prompt without any --flags, plus a few chips.
  const caption = useMemo(() => stripPromptFlags(prompt), [prompt]);
  const captionChips = useMemo(
    () => chips.slice(0, 3).map((chip) => chip.label),
    [chips],
  );
  // Tool/action that made this run, plus a jump to its source run.
  const provenance = useMemo(
    () => runProvenance(images[0]?.paramsMap),
    [images],
  );
  const sourceRunId = sourceRunLinkTarget(provenance, images[0]?.runId);
  const openSource = useMemo(
    () =>
      sourceRunId && onOpenSourceRun
        ? () => onOpenSourceRun(sourceRunId)
        : undefined,
    [sourceRunId, onOpenSourceRun],
  );

  /** Resolve the effective workflow path for a given action using assignment slots */
  const resolveActionWorkflow = useCallback(
    (action: string): string | undefined => {
      const assignments = mergeActionAndSlotAssignments(actionWorkflowMap);
      const resolved = resolveWorkflowForAction(action, {
        assignments,
        selectedWorkflowPath,
        selectedWorkflowName,
        defaultWorkflowPath,
        defaultWorkflowName,
      });
      return resolved?.workflowPath;
    },
    [
      actionWorkflowMap,
      selectedWorkflowPath,
      selectedWorkflowName,
      defaultWorkflowPath,
      defaultWorkflowName,
    ],
  );

  const handleRerun = useCallback(async () => {
    const source = activeImage;
    const promptWithoutSeed = stripSeedFromPrompt(
      source?.fullPrompt || fullPrompt,
    );
    if (!promptWithoutSeed) return;

    const workflowPath = resolveActionWorkflow("promptbar.imagine");
    try {
      setActionLoading("rerun");
      const response = await fetch("/api/jobs/imagine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: promptWithoutSeed,
          client_id: clientId,
          batch_size: 1,
          workflow_path: workflowPath,
          ...(Object.keys(workflowControlOverrides).length > 0
            ? { workflow_control_overrides: workflowControlOverrides }
            : {}),
        }),
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error ?? "Generation failed");
      for (const run of data.runs ?? []) addRun(run);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Generation failed");
    } finally {
      setActionLoading(null);
    }
  }, [
    activeImage,
    fullPrompt,
    resolveActionWorkflow,
    clientId,
    workflowControlOverrides,
    addRun,
    setError,
  ]);

  const handleUse = useCallback(() => {
    setPromptValue(fullPrompt);
  }, [fullPrompt, setPromptValue]);

  // Trash = the recoverable hide flag (Filters → Include hidden restores).
  const handleTrashRun = useCallback(() => {
    const { restoring, ids } = runTrashToggle(images);
    for (const id of ids) toggleHidden(id);
    if (!restoring && ids.length > 0) {
      showToast(
        `Moved ${ids.length} image${ids.length === 1 ? "" : "s"} to trash. Filters → Include hidden brings them back.`,
        "info",
      );
    }
  }, [images, toggleHidden]);
  const runTrashed = useMemo(() => runTrashToggle(images).restoring, [images]);

  const handleCopyPrompt = useCallback(() => {
    navigator.clipboard.writeText(fullPrompt);
    setShowCopyMenu(false);
  }, [fullPrompt]);

  const handleCopySeed = useCallback(() => {
    const seed = activeImage?.seed;
    if (seed != null) navigator.clipboard.writeText(String(seed));
    setShowCopyMenu(false);
  }, [activeImage]);

  const handleParamClick = useCallback(
    (param: string) => {
      // Chips render with or without leading dashes ("steps 16", "--seed 42").
      // Normalize to --flag so every click routes through replace-in-place:
      // same flag with a different value replaces, identical click is a no-op.
      const match = param.trim().match(/^(?:--?)?([A-Za-z][\w-]*)\s*(.*)$/);
      if (!match) return;
      const flag = `--${match[1]}`;
      const value = match[2].trim();
      if (flag === "--lora") {
        // Multiple different LoRAs may coexist; the same one is added once
        const current = useUIStore.getState().promptValue;
        if (!current.includes(`--lora ${value}`)) {
          appendToPrompt(`--lora ${value}`);
        }
      } else {
        replacePromptParam(flag, value);
      }
    },
    [appendToPrompt, replacePromptParam],
  );

  const handlePromptClick = useCallback(() => {
    setPromptValue(prompt);
  }, [prompt, setPromptValue]);

  const useImageAsAttachment = useCallback((image: GalleryImage) => {
    if (!image.url) return;

    window.dispatchEvent(
      new CustomEvent("use-start-frame", {
        detail: {
          url: image.url,
          filename: `adrift-${image.seed}.png`,
          runId: image.runId,
          jobIndex: image.jobIndex,
          mode: "image_prompt",
        },
      }),
    );
  }, []);

  const handleRemix = useCallback(
    (image: GalleryImage, variant: "subtle" | "strong" = "subtle") => {
      const composition = buildRemixComposition(image, variant);
      setPromptValue(composition.prompt);
      for (const attachment of composition.attachments) {
        addImageAttachment(attachment);
      }
    },
    [addImageAttachment, setPromptValue],
  );

  const handleOpenImage = useCallback(
    (index: number) => {
      onImageClick(images, index);
    },
    [images, onImageClick],
  );

  const handleAction = useCallback(
    async (action: string, source: GalleryImage) => {
      const workflowPath = resolveActionWorkflow(action);
      try {
        setActionLoading(action);
        const response = await fetch("/api/jobs/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            run_id: source.runId,
            job_index: source.jobIndex,
            action,
            client_id: clientId,
            workflow_path: workflowPath,
            params: upscaleActionParams(action),
            ...(Object.keys(workflowControlOverrides).length > 0
              ? { workflow_control_overrides: workflowControlOverrides }
              : {}),
          }),
        });
        const data = await response.json();
        if (!data.ok) {
          throw new Error(data.error ?? `Failed: ${action}`);
        }
        if (data.run) {
          addRun(data.run);
        }
        toastNodeWarnings(data);
      } catch (error) {
        setError(error instanceof Error ? error.message : `Failed: ${action}`);
      } finally {
        setActionLoading(null);
      }
    },
    [
      resolveActionWorkflow,
      clientId,
      addRun,
      setError,
      workflowControlOverrides,
    ],
  );
  // Run-row: portrait/square runs lay out 4-across, landscape 2x2
  // (measured from the reference site's create feed).
  const firstAr =
    images[0]?.width && images[0]?.height
      ? images[0].width / images[0].height
      : 1;
  const gridCols = firstAr >= 1.3 ? 2 : 4;

  const tiles = images.map((img, i) => (
    <ImageTile
      key={img.id}
      img={img}
      i={i}
      prompt={prompt}
      variant={viewMode}
      caption={caption}
      captionChips={captionChips}
      provenance={provenance}
      onOpenSource={openSource}
      runImageCount={images.length}
      onRerun={handleRerun}
      rerunState={
        actionLoading === "rerun"
          ? "loading"
          : actionLoading !== null
            ? "busy"
            : "idle"
      }
      touchActionIndex={touchActionIndex}
      touchedImageIndexRef={touchedImageIndexRef}
      setActiveImageIndex={setActiveImageIndex}
      setTouchActionIndex={setTouchActionIndex}
      onImageClick={handleOpenImage}
      handleAction={handleAction}
      handleRemix={handleRemix}
      useImageAsAttachment={useImageAsAttachment}
    />
  ));

  // Grid / Thumbnails: tiles join the section's wall directly.
  if (isWallViewMode(viewMode)) {
    return <div className="contents">{tiles}</div>;
  }

  const chipClass =
    "chip text-xs tabular-nums hover:bg-[var(--accent-primary)]/20 hover:border-[var(--accent-primary)]/50 hover:text-[var(--accent-primary)] transition-colors cursor-pointer";

  return (
    <div className="group relative flex flex-col lg:flex-row gap-3">
      {/* Image tiles — uniform-height row grid, capped at ~1180px like the reference */}
      <div
        className={RUN_GRID_CLASS}
        style={runGridStyle(`repeat(${gridCols}, 1fr)`)}
      >
        {tiles}
      </div>

      {/* Meta column — flush with the prompt bar's right edge (lg:ml-auto) */}
      <div className={RUN_META_CLASS}>
        <GroupSelectCheckbox
          ids={runImageIds}
          label="Select run"
          showLabel
          className="mb-1.5 self-start"
        />
        <button
          onClick={handlePromptClick}
          className="text-sm text-[var(--text-primary)] text-left hover:text-[var(--accent-primary)] transition-colors line-clamp-4"
          title="Click to use this prompt"
        >
          {displayPrompt}
        </button>

        {/* Clickable param chips — short typeable flags, one seed chip */}
        <div className="flex flex-wrap gap-1 mt-2">
          {provenance && (
            <ProvenanceChip
              provenance={provenance}
              tone="meta"
              onOpenSource={openSource}
            />
          )}
          {chips.map((chip: ParamChip) => {
            const isSeed = chip.key === "seed";
            // Seed chip inserts the hovered/active image's seed.
            const value = isSeed
              ? String(activeImage?.seed ?? chip.value)
              : chip.value;
            const insert = `${chip.flag}${value ? ` ${value}` : ""}`;
            return (
              <button
                key={`${chip.key}:${chip.value}`}
                onClick={() => handleParamClick(insert)}
                className={chipClass}
                title={
                  isSeed
                    ? `Use seed ${value}`
                    : `Click to add ${insert} to prompt`
                }
              >
                {chip.label}
              </button>
            );
          })}
        </div>

        {/* Run actions (Rerun · Use · Trash · More) — on row hover or
            keyboard focus from lg up, always visible on touch layouts */}
        <div className="flex flex-wrap items-center gap-0.5 mt-2 -ml-2 lg:opacity-0 lg:group-hover:opacity-100 lg:focus-within:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={() => void handleRerun()}
            disabled={actionLoading !== null}
            className={RUN_ACTION_BUTTON}
            title="Rerun with a new seed"
          >
            {actionLoading === "rerun" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Rerun
          </button>

          <button
            type="button"
            onClick={handleUse}
            className={RUN_ACTION_BUTTON}
            title="Load this prompt and its settings into the prompt bar"
          >
            <Type className="w-3.5 h-3.5" />
            Use
          </button>

          <button
            type="button"
            onClick={handleTrashRun}
            className={RUN_ACTION_BUTTON}
            title={runTrashed ? "Restore this run" : "Move this run to trash"}
          >
            {runTrashed ? (
              <Eye className="w-3.5 h-3.5" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
            {runTrashed ? "Restore" : "Trash"}
          </button>

          {/* More menu: image actions, copy, download */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowCopyMenu(!showCopyMenu)}
              className={RUN_ACTION_BUTTON}
              title="More"
              aria-haspopup="menu"
              aria-expanded={showCopyMenu}
            >
              {actionLoading !== null && actionLoading !== "rerun" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <MoreHorizontal className="w-3.5 h-3.5" />
              )}
              More
            </button>

            {showCopyMenu && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setShowCopyMenu(false)}
                />
                <div className="absolute left-0 lg:left-auto lg:right-0 top-full mt-1 z-50 w-48 py-1 bg-[var(--bg-secondary)] border border-[var(--border-primary)] rounded-lg shadow-xl">
                  {runMoreActions.map(({ action, id }) => {
                    const { name: label, icon } = specOf(id);
                    const Icon = creatorIcon(icon);
                    return (
                      <button
                        key={action}
                        type="button"
                        onClick={() => {
                          setShowCopyMenu(false);
                          if (activeImage)
                            void handleAction(action, activeImage);
                        }}
                        disabled={actionLoading !== null || !activeImage}
                        className="w-full px-3 py-2 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50 flex items-center gap-2"
                        title={label}
                      >
                        <Icon className="w-4 h-4" /> {label}
                      </button>
                    );
                  })}
                  {(shownActions.upscale_faithful ||
                    shownActions.upscale_creative) && (
                    <div className="px-3 py-1.5">
                      <UpscaleModelPicker
                        compact
                        content={
                          activeImage
                            ? imageUpscaleContent(activeImage)
                            : "photo"
                        }
                      />
                    </div>
                  )}
                  <div className="border-t border-[var(--border-primary)] my-1" />
                  <div className="px-3 py-1.5 text-xs text-[var(--text-muted)] font-medium">
                    Copy
                  </div>
                  <button
                    onClick={handleCopyPrompt}
                    className="w-full px-3 py-2 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] flex items-center gap-2"
                  >
                    <Copy className="w-4 h-4" /> Prompt
                  </button>
                  <button
                    onClick={() => {
                      const jobId = activeImage?.runId;
                      if (jobId) navigator.clipboard.writeText(jobId);
                      setShowCopyMenu(false);
                    }}
                    className="w-full px-3 py-2 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] flex items-center gap-2"
                  >
                    <Copy className="w-4 h-4" /> Job ID
                  </button>
                  <button
                    onClick={handleCopySeed}
                    className="w-full px-3 py-2 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] flex items-center gap-2"
                  >
                    <Copy className="w-4 h-4" /> Seed
                  </button>
                  <div className="border-t border-[var(--border-primary)] my-1" />
                  <button
                    onClick={() => {
                      const img = activeImage;
                      const target = img ? downloadTarget(img) : null;
                      if (!target) return;
                      const link = document.createElement("a");
                      link.href = target.href;
                      link.download = target.filename;
                      link.click();
                      setShowCopyMenu(false);
                    }}
                    className="w-full px-3 py-2 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] flex items-center gap-2"
                  >
                    <Download className="w-4 h-4" /> Download Image
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

interface ImageTileProps {
  img: GalleryImage;
  i: number;
  prompt: string;
  /**
   * Which feed view the tile renders in. List keeps the labeled quick-action
   * chips; Grid/Thumbnails show a prompt caption and keep actions in the menu.
   */
  variant: GalleryViewMode;
  /** Run prompt with --flags stripped, for the wall-view hover caption. */
  caption: string;
  /** A few compact param chip labels for the Grid caption. */
  captionChips: readonly string[];
  /** Tool/action that made the run (null for plain prompt runs). */
  provenance: RunProvenance | null;
  /** Opens the source run; unset when it isn't loaded in the feed. */
  onOpenSource?: () => void;
  /** Images in the tile's run (Thumbnails shows "+N more"). */
  runImageCount: number;
  onRerun: () => Promise<void>;
  rerunState: "idle" | "busy" | "loading";
  touchActionIndex: number | null;
  touchedImageIndexRef: MutableRefObject<number | null>;
  setActiveImageIndex: Dispatch<SetStateAction<number>>;
  setTouchActionIndex: Dispatch<SetStateAction<number | null>>;
  onImageClick: (index: number) => void;
  handleAction: (action: string, source: GalleryImage) => Promise<void>;
  handleRemix: (image: GalleryImage, variant?: "subtle" | "strong") => void;
  useImageAsAttachment: (image: GalleryImage) => void;
}

const TILE_ICON_BUTTON =
  "w-7 h-7 [@media(pointer:coarse)]:w-10 [@media(pointer:coarse)]:h-10 rounded-md bg-black/50 text-white hover:bg-black/70 flex items-center justify-center transition-colors";
const TILE_ICON_BUTTON_SM =
  "w-6 h-6 [@media(pointer:coarse)]:w-8 [@media(pointer:coarse)]:h-8 rounded-md bg-black/50 text-white hover:bg-black/70 flex items-center justify-center transition-colors";
const TILE_CHIP =
  "h-7 [@media(pointer:coarse)]:h-10 px-2 rounded-md bg-black/55 text-white text-[11px] font-medium hover:bg-black/75 flex items-center gap-1 whitespace-nowrap transition-colors backdrop-blur-sm";
const TILE_MENU_ROW =
  "w-full px-3 py-1.5 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] flex items-center gap-2";
const TILE_MENU_WIDTH = 192;

const ImageTile = memo(function ImageTile({
  img,
  i,
  prompt,
  variant,
  caption,
  captionChips,
  provenance,
  onOpenSource,
  runImageCount,
  onRerun,
  rerunState,
  touchActionIndex,
  touchedImageIndexRef,
  setActiveImageIndex,
  setTouchActionIndex,
  onImageClick,
  handleAction,
  handleRemix,
  useImageAsAttachment,
}: ImageTileProps) {
  const toggleLiked = useGenerationStore((s) => s.toggleLiked);
  const shownActions = useCreatorActionsStore(
    selectCreatorActionShown,
    shallow,
  );
  const selectTileProps = useTileSelect(img.id);
  // Tiles size from the stored width/height; correct to the real image
  // aspect once it loads if those disagree.
  const [naturalSize, setNaturalSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const handleNaturalSize = useCallback(
    (w: number, h: number) =>
      setNaturalSize(naturalSizeOverride(w, h, img.width, img.height)),
    [img.width, img.height],
  );
  const toggleHidden = useGenerationStore((s) => s.toggleHidden);
  const setPromptPreview = usePromptPreviewStore((s) => s.setPreview);
  const clearPromptPreview = usePromptPreviewStore((s) => s.clearPreview);
  // Wall views (Grid/Thumbnails): no labeled action chips.
  const compact = variant !== "list";
  const moreLabel =
    variant === "thumbs" ? moreImagesLabel(runImageCount) : null;

  // Drop this tile's prompt-bar preview if it unmounts while hovered.
  useEffect(
    () => () => clearPromptPreview(img.id),
    [clearPromptPreview, img.id],
  );
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<CSSProperties | null>(null);
  const menuOpen = menuPos !== null;
  // Animate works from a still frame; skip it for video/audio/mesh-only.
  const canAnimate =
    shownActions.animate_low &&
    !img.videoUrl &&
    !img.audioUrl &&
    Boolean(img.url);
  const showVarySubtle = shownActions.vary_subtle;
  const showVaryStrong = shownActions.vary_strong;
  const showVary = showVarySubtle || showVaryStrong;
  const showWallActions = compact && (showVary || canAnimate);

  const closeMenu = useCallback(() => setMenuPos(null), []);
  const openMenu = useCallback(() => {
    const rect = menuButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(
      8,
      Math.min(
        rect.right - TILE_MENU_WIDTH,
        window.innerWidth - TILE_MENU_WIDTH - 8,
      ),
    );
    // Open downward unless the tile sits near the bottom of the viewport.
    setMenuPos(
      rect.bottom + 300 > window.innerHeight
        ? { left, bottom: window.innerHeight - rect.top + 4 }
        : { left, top: rect.bottom + 4 },
    );
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", closeMenu);
    // Capture scrolls of the feed's scroll container too.
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [menuOpen, closeMenu]);

  const revealed = touchActionIndex === i || menuOpen;
  const revealClass = revealed
    ? "opacity-100 pointer-events-auto"
    : "opacity-0 pointer-events-none group-hover/img:opacity-100 group-hover/img:pointer-events-auto group-focus-within/img:opacity-100 group-focus-within/img:pointer-events-auto";

  const runMenuItem = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    closeMenu();
    fn();
  };

  // Trash = the recoverable hide flag.
  const handleHide = () => {
    const hiding = !img.hidden;
    toggleHidden(img.id);
    if (hiding) {
      showToast(
        "Moved to trash. Filters → Include hidden brings it back.",
        "info",
      );
    }
  };

  const overlayClass = revealed
    ? "opacity-100"
    : "opacity-0 group-hover/img:opacity-100 group-focus-within/img:opacity-100";
  const iconButtonClass =
    variant === "thumbs" ? TILE_ICON_BUTTON_SM : TILE_ICON_BUTTON;
  const iconClass = variant === "thumbs" ? "w-3 h-3" : "w-3.5 h-3.5";
  const likeButton = (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        toggleLiked(img.id);
      }}
      className={`${iconButtonClass} transition-opacity ${img.liked ? "opacity-100 pointer-events-auto" : revealClass}`}
      title={img.liked ? "Unlike" : "Like"}
      aria-label={img.liked ? "Unlike" : "Like"}
      aria-pressed={Boolean(img.liked)}
    >
      <Heart className={`${iconClass} ${img.liked ? "fill-white" : ""}`} />
    </button>
  );

  const handleDownload = () => {
    const target = downloadTarget(img);
    if (!target) return;
    const link = document.createElement("a");
    link.href = target.href;
    link.download = target.filename;
    link.click();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      data-tour="gallery-tile"
      className={`group/img relative rounded-[4px] overflow-hidden cursor-pointer hover:ring-2 hover:ring-[var(--accent-primary)] transition-shadow focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:outline-none ${
        menuOpen ? "ring-2 ring-[var(--accent-primary)]" : ""
      }`}
      style={tileStyle(
        variant,
        naturalSize?.width ?? img.width,
        naturalSize?.height ?? img.height,
      )}
      onClick={() => {
        if (touchedImageIndexRef.current === i) {
          touchedImageIndexRef.current = null;
          return;
        }
        onImageClick(i);
      }}
      onMouseEnter={() => {
        setActiveImageIndex(i);
        if (variant === "thumbs") {
          setPromptPreview(img.id, formatPromptPreview(caption, captionChips));
        }
      }}
      onMouseLeave={() => {
        if (variant === "thumbs") clearPromptPreview(img.id);
      }}
      onFocus={() => setActiveImageIndex(i)}
      onTouchStart={() => {
        setActiveImageIndex(i);
        setTouchActionIndex(i);
        touchedImageIndexRef.current = i;
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onImageClick(i);
        }
      }}
      aria-label={`Open image: ${prompt} - ${i + 1}`}
      {...selectTileProps}
    >
      <div className={`w-full h-full ${img.hidden ? "opacity-40" : ""}`}>
        {img.videoUrl ? (
          <>
            <video
              src={img.videoUrl}
              className="w-full h-full object-cover"
              muted
              playsInline
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <Play
                className="w-8 h-8 text-white drop-shadow-lg"
                fill="white"
              />
            </div>
            {img.runId && (
              <div className="absolute bottom-1.5 left-1.5">
                <QcBadge
                  jobId={`${img.runId}:${img.jobIndex ?? 0}`}
                  videoUrl={img.videoUrl}
                  kick={false}
                />
              </div>
            )}
          </>
        ) : img.audioUrl ? (
          <div className="w-full h-full flex flex-col items-center justify-center bg-[var(--bg-tertiary)]">
            <Music className="w-8 h-8 text-[var(--accent-primary)]" />
            <span className="text-xs text-[var(--text-secondary)] mt-1">
              Audio
            </span>
          </div>
        ) : img.meshUrl && img.url ? (
          <>
            <ThumbImage
            src={img.url}
            alt={`${prompt} - ${i + 1}`}
            onNaturalSize={handleNaturalSize}
          />
            <div className="absolute top-2 left-2 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-white transition-opacity group-hover/img:opacity-0">
              <Box className="w-3 h-3" /> 3D
            </div>
          </>
        ) : img.meshUrl ? (
          <div className="w-full h-full flex flex-col items-center justify-center bg-[var(--bg-tertiary)]">
            <Box className="w-8 h-8 text-[var(--accent-primary)]" />
            <span className="text-xs text-[var(--text-secondary)] mt-1">
              3D
            </span>
          </div>
        ) : (
          <>
            <ThumbImage
              src={img.url}
              alt={`${prompt} - ${i + 1}`}
              onNaturalSize={handleNaturalSize}
            />
            {img.runId && img.paramsMap?._blankCheck === "ideogram" && (
              <SafetyFilterOverlay
                jobId={`${img.runId}:${img.jobIndex ?? 0}`}
                imageUrl={img.url}
                kick={false}
              />
            )}
          </>
        )}
      </div>

      {img.hidden && (
        <div
          className={`absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-white transition-opacity ${
            revealed
              ? "opacity-0"
              : "group-hover/img:opacity-0 group-focus-within/img:opacity-0"
          }`}
        >
          <EyeOff className="w-3 h-3" /> In trash
        </div>
      )}

      {/* Hover scrim — heavier at the bottom in wall views for the caption */}
      <div
        className={`absolute inset-0 bg-gradient-to-t ${
          compact
            ? "from-black/80 via-black/10 to-black/30"
            : "from-black/60 via-transparent to-black/30"
        } ${overlayClass} transition-opacity pointer-events-none`}
      />

      {/* Top-left: (Grid: like ·) trash */}
      <div
        className="absolute top-1.5 left-1.5 flex items-center gap-1"
        onTouchStart={(e) => e.stopPropagation()}
      >
        {variant === "grid" && likeButton}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleHide();
          }}
          className={`${iconButtonClass} transition-opacity ${revealClass}`}
          title={img.hidden ? "Restore from trash" : "Move to trash"}
          aria-label={img.hidden ? "Restore image" : "Move image to trash"}
        >
          {img.hidden ? (
            <Eye className={iconClass} />
          ) : (
            <Trash2 className={iconClass} />
          )}
        </button>
      </div>

      {variant === "grid" ? (
        /* Top-right: Rerun with a chevron that opens the actions menu */
        <div
          className={`absolute top-1.5 right-1.5 flex items-center h-7 rounded-md bg-black/55 text-white backdrop-blur-sm transition-opacity ${revealClass}`}
          onTouchStart={(e) => e.stopPropagation()}
        >
          {shownActions.rerun && (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void onRerun();
                }}
                disabled={rerunState !== "idle"}
                className="h-full pl-2.5 pr-2 rounded-l-md text-[11px] font-medium hover:bg-black/40 disabled:opacity-60 flex items-center gap-1"
                title="Rerun with a new seed"
              >
                {rerunState === "loading" && (
                  <Loader2 className="w-3 h-3 animate-spin" />
                )}
                Rerun
              </button>
              <span className="w-px h-3.5 bg-white/25" aria-hidden="true" />
            </>
          )}
          <button
            ref={menuButtonRef}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (menuOpen) closeMenu();
              else openMenu();
            }}
            className={`h-full px-1.5 hover:bg-black/40 flex items-center ${shownActions.rerun ? "rounded-r-md" : "rounded-md"}`}
            title="More actions"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        /* Top-right: like · more */
        <div
          className="absolute top-1.5 right-1.5 flex items-center gap-1"
          onTouchStart={(e) => e.stopPropagation()}
        >
          {likeButton}
          <button
            ref={menuButtonRef}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (menuOpen) closeMenu();
              else openMenu();
            }}
            className={`${iconButtonClass} transition-opacity ${revealClass}`}
            title="More actions"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <MoreHorizontal className={iconClass} />
          </button>
        </div>
      )}

      {/* Wall views: prompt caption (+ chips in Grid, "+N more" in Thumbnails) */}
      {compact && (
        <div
          className={`pointer-events-none absolute inset-x-0 bottom-0 p-2 transition-opacity ${overlayClass}`}
        >
          {variant === "thumbs" && provenance && (
            <div className="mb-1 flex items-center gap-1 min-w-0">
              <ProvenanceChip
                provenance={provenance}
                tone="overlay"
                onOpenSource={onOpenSource}
                compact
                linkClassName={revealClass}
              />
            </div>
          )}
          <p
            className={`text-white text-xs leading-snug drop-shadow ${
              variant === "grid" ? "line-clamp-2" : "truncate"
            }`}
          >
            {caption}
          </p>
          {variant === "grid" && (captionChips.length > 0 || provenance) && (
            <div className="mt-1.5 flex flex-wrap gap-1 overflow-hidden max-h-5">
              {provenance && (
                <ProvenanceChip
                  provenance={provenance}
                  tone="overlay"
                  onOpenSource={onOpenSource}
                  linkClassName={revealClass}
                />
              )}
              {captionChips.map((label) => (
                <span
                  key={label}
                  className="h-5 px-1.5 rounded bg-white/15 text-white text-[10px] leading-5 whitespace-nowrap backdrop-blur-sm"
                >
                  {label}
                </span>
              ))}
            </div>
          )}
          {moreLabel && (
            <span className="mt-1 inline-block h-5 px-2 rounded-full bg-black/55 text-white text-[10px] leading-5 backdrop-blur-sm">
              {moreLabel}
            </span>
          )}
        </div>
      )}

      {/* Bottom-left: labeled quick actions */}
      {!compact && (
        <div
          className={`absolute bottom-1.5 left-1.5 right-1.5 flex flex-wrap items-center gap-1 transition-opacity ${revealClass}`}
          onTouchStart={(e) => e.stopPropagation()}
        >
          {showVarySubtle && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void handleAction("vary_subtle", img);
              }}
              className={TILE_CHIP}
              title="Vary subtle"
              aria-label="Vary subtle"
            >
              <VaryIcon className="hidden sm:block w-3 h-3" />
              <span>
                <span className="hidden 2xl:inline">Vary </span>Subtle
              </span>
            </button>
          )}
          {showVaryStrong && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void handleAction("vary_strong", img);
              }}
              className={TILE_CHIP}
              title="Vary strong"
              aria-label="Vary strong"
            >
              <VaryIcon className="hidden sm:block w-3 h-3" />
              <span>
                <span className="hidden 2xl:inline">Vary </span>Strong
              </span>
            </button>
          )}
          {canAnimate && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void handleAction("animate_low", img);
              }}
              className={TILE_CHIP}
              title="Animate"
              aria-label="Animate"
            >
              <AnimateIcon className="hidden sm:block w-3 h-3" />
              <span>Animate</span>
            </button>
          )}
        </div>
      )}

      {/* "…" menu — portaled so the tile's overflow-hidden can't clip it.
          Portal events still bubble through the React tree, so the wrapper
          stops them before they reach the tile's open-lightbox handlers. */}
      {menuPos &&
        createPortal(
          <div
            onClick={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <div
              className="fixed inset-0 z-[60]"
              onClick={closeMenu}
              aria-hidden="true"
            />
            <div
              role="menu"
              aria-label="Image actions"
              className="fixed z-[61] py-1 bg-[var(--bg-secondary)] border border-[var(--border-primary)] rounded-lg shadow-xl"
              style={{ ...menuPos, width: TILE_MENU_WIDTH }}
            >
              {showWallActions && (
                <>
                  {showVarySubtle && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={runMenuItem(
                        () => void handleAction("vary_subtle", img),
                      )}
                      className={TILE_MENU_ROW}
                      title="Vary subtle"
                    >
                      <VaryIcon className="w-4 h-4" /> Vary subtle
                    </button>
                  )}
                  {showVaryStrong && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={runMenuItem(
                        () => void handleAction("vary_strong", img),
                      )}
                      className={TILE_MENU_ROW}
                      title="Vary strong"
                    >
                      <VaryIcon className="w-4 h-4" /> Vary strong
                    </button>
                  )}
                  {canAnimate && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={runMenuItem(
                        () => void handleAction("animate_low", img),
                      )}
                      className={TILE_MENU_ROW}
                      title="Animate"
                    >
                      <AnimateIcon className="w-4 h-4" /> Animate
                    </button>
                  )}
                  <div className="border-t border-[var(--border-primary)] my-1" />
                </>
              )}
              {shownActions.upscale_faithful && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={runMenuItem(
                    () => void handleAction("upscale_subtle", img),
                  )}
                  className={TILE_MENU_ROW}
                  title="Upscale faithful"
                >
                  <UpscaleIcon className="w-4 h-4" /> Upscale faithful
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={runMenuItem(() => handleRemix(img, "subtle"))}
                className={TILE_MENU_ROW}
                title="Remix"
              >
                <RefreshCw className="w-4 h-4" /> Remix
              </button>
              {shownActions.use_image && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={runMenuItem(() => useImageAsAttachment(img))}
                  className={TILE_MENU_ROW}
                  title="Use image"
                >
                  <ImageIcon className="w-4 h-4" /> Use image
                </button>
              )}
              <div className="border-t border-[var(--border-primary)] my-1" />
              <button
                type="button"
                role="menuitem"
                onClick={runMenuItem(
                  () =>
                    void navigator.clipboard.writeText(
                      img.fullPrompt || img.prompt,
                    ),
                )}
                className={TILE_MENU_ROW}
                title="Copy prompt"
              >
                <Copy className="w-4 h-4" /> Copy prompt
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={runMenuItem(handleDownload)}
                className={TILE_MENU_ROW}
                title="Download"
              >
                <Download className="w-4 h-4" /> Download
              </button>
              {img.meshUrl &&
                blenderBundleHref(img.meshUrls ?? [img.meshUrl]) && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={runMenuItem(() => {
                      const href = blenderBundleHref(
                        img.meshUrls ?? [img.meshUrl],
                      );
                      if (!href) return;
                      const link = document.createElement("a");
                      link.href = href;
                      link.download = "";
                      link.click();
                    })}
                    className={TILE_MENU_ROW}
                    title="Download a zip with the model, an import script and a readme"
                  >
                    <Package className="w-4 h-4" /> Export for Blender
                  </button>
                )}
              <button
                type="button"
                role="menuitem"
                onClick={runMenuItem(() => {
                  if (touchedImageIndexRef.current === i) {
                    touchedImageIndexRef.current = null;
                  }
                  onImageClick(i);
                })}
                className={TILE_MENU_ROW}
                title="Open in Lightbox"
              >
                <Maximize className="w-4 h-4" /> Open in Lightbox
              </button>
            </div>
          </div>,
          document.body,
        )}
      <SelectCheckbox id={img.id} />
    </div>
  );
});
// Create's empty state is the first-run checklist: offline or missing a
// model never reads as an empty gallery.
function EmptyState() {
  return <FirstRunChecklist />;
}

interface ImageGroup {
  runId: string;
  images: GalleryImage[];
  prompt: string;
  fullPrompt: string;
  params: string[];
  paramsMap: Record<string, unknown>;
}

interface DateImageGroup {
  /** Local day key (YYYY-MM-DD) — stable React key. */
  date: string;
  /** "Today" / "Yesterday" / "October 20". */
  label: string;
  rows: ImageGroup[];
}

function groupImagesByRun(images: GalleryImage[]): ImageGroup[] {
  const groups: Record<string, ImageGroup> = {};
  for (const img of images) {
    if (!groups[img.runId]) {
      groups[img.runId] = {
        runId: img.runId,
        images: [],
        prompt: img.prompt,
        fullPrompt: img.fullPrompt || img.prompt,
        params: img.params,
        paramsMap: img.paramsMap || {},
      };
    }
    groups[img.runId].images.push(img);
  }
  return Object.values(groups);
}

export default Gallery;

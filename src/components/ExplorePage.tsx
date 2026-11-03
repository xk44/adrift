"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUIStore, useGenerationStore } from "@/store";
import { shallow } from "zustand/shallow";
import { useLikesStore, type LikedImage } from "@/store/likesStore";
import type { GalleryImage } from "@/types";
import { useDownloadStore } from "@/store/downloadStore";
import type { ModelScope } from "@/lib/modelFilters";
import {
  useExploreStore,
  PRIMARY_TABS,
  CIVITAI_TOP_PERIOD,
} from "@/store/exploreStore";
import { ExploreControls } from "@/components/ExploreControls";
import { ModelFilterBar } from "@/components/models/ModelFilterBar";
import { ModelFeedResults } from "@/components/models/ModelFeedResults";
import { useModelFeed } from "@/components/models/useModelFeed";
import { Krea2StyleLoraBrowser } from "@/components/style/Krea2StyleLoraBrowser";
import { Skeleton } from "@/components/Skeleton";
import { FeedErrorState } from "@/components/models/FeedErrorState";
import {
  appendCapped,
  buildExploreImageQuery,
  civitaiThumbUrl,
  exploreOpenLabel,
  MAX_FEED_ITEMS,
  shouldBlurMedia,
} from "@/lib/explore/imageFeed";
import {
  ExploreCardOverlay,
  exploreCardAuthor,
} from "@/components/ExploreCardOverlay";
import {
  Image as ImageIcon,
  Wand2,
  Loader2,
  Heart,
  Film,
  Search,
  RefreshCw,
} from "lucide-react";

// Types

interface CivitaiImage {
  id: number;
  url: string;
  thumbnailUrl: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  createdAt: string;
  models: Array<{ name: string; type: string }>;
  tags: string[];
  /** "video" items carry .mp4 urls */
  type?: "image" | "video";
  username?: string;
  /** Civitai rating; mature media starts blurred until clicked */
  nsfw?: boolean;
  nsfwLevel?: number | string;
  stats?: { likeCount?: number; heartCount?: number; reactionCount?: number };
}

// Seed video prompt entries (local-generation-run based)

const SEED_VIDEO_PROMPTS = [
  {
    id: "v1",
    title: "Zoom Into Landscape",
    prompt: "cinematic zoom landscape --ar 16:9 --video",
  },
  {
    id: "v2",
    title: "Character Motion Loop",
    prompt: "character walk cycle --ar 9:16 --video",
  },
  {
    id: "v3",
    title: "Abstract Particle Flow",
    prompt: "abstract particles flowing --ar 1:1 --video",
  },
  {
    id: "v4",
    title: "Time-Lapse Cityscape",
    prompt: "time lapse city dusk to dawn --ar 16:9 --video",
  },
  {
    id: "v5",
    title: "Nature Sway Loop",
    prompt: "trees swaying wind loop --ar 16:9 --video",
  },
  {
    id: "v6",
    title: "Fire & Water Blend",
    prompt: "fire water blend abstract --ar 1:1 --video",
  },
];

// Helpers
// Tab definitions live in @/store/exploreStore (shared with ExploreControls,
// which renders the sort/search row inline with the prompt bar).

type GenerationStoreState = ReturnType<typeof useGenerationStore.getState>;

function selectRunsWithVideos(s: GenerationStoreState) {
  return s.runs.filter((run) =>
    run.jobs.some((j) => j.videos && j.videos.length > 0),
  );
}

function likeCount(img: CivitaiImage): number {
  if (!img.stats) return 0;
  return (
    img.stats.likeCount ?? img.stats.heartCount ?? img.stats.reactionCount ?? 0
  );
}

// Component

export function ExplorePage() {
  const activeNav = useUIStore((s) => s.activeNav);
  const setPromptValue = useUIStore((s) => s.setPromptValue);
  const setActiveNav = useUIStore((s) => s.setActiveNav);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const openLightbox = useUIStore((s) => s.openLightbox);
  const likes = useLikesStore((s) => s.likes);
  const toggleLike = useLikesStore((s) => s.toggleLike);
  const likedIds = useMemo(
    () => new Set(likes.map((l) => l.civitaiId)),
    [likes],
  );
  const toggleCivitaiLike = useCallback(
    (img: CivitaiImage) =>
      toggleLike({
        civitaiId: img.id,
        url: img.url,
        thumbnailUrl: img.thumbnailUrl || img.url,
        prompt: img.prompt,
        negativePrompt: img.negativePrompt,
        width: img.width,
        height: img.height,
        models: img.models,
        username: img.username,
        likedAt: new Date().toISOString(),
      }),
    [toggleLike],
  );

  // Only runs that already carry videos, compared shallowly: subscribing to
  // s.runs re-rendered the entire Explore grid on every WS progress tick
  // while a generation was running.
  const generationRuns = useGenerationStore(selectRunsWithVideos, shallow);
  const downloads = useDownloadStore((s) => s.downloads);
  const hideDownloaded = useDownloadStore((s) => s.hideDownloaded);

  // Pre-compute video items from generation runs to avoid chained
  // filter/flatMap/concat on every render of the Videos tab
  const videoFallback = useMemo(() => {
    const realVideos = generationRuns
      .filter((run) => run.jobs.some((j) => j.videos && j.videos.length > 0))
      .flatMap((run) =>
        run.jobs
          .filter((j) => j.videos && j.videos.length > 0)
          .map((job, i) => ({
            id: `${run.run_id}-${i}`,
            title: run.prompt || "Video output",
            thumbnailUrl: job.images?.[0] || "",
            videoUrl: job.videos![0],
            prompt: run.prompt || "",
          })),
      );

    if (realVideos.length > 0) return { items: realVideos, local: true };

    return {
      items: SEED_VIDEO_PROMPTS.map((v) => ({
        id: v.id,
        title: v.title,
        thumbnailUrl: "",
        videoUrl: "",
        prompt: v.prompt,
      })),
      local: false,
    };
  }, [generationRuns]);
  const videoItems = videoFallback.items;
  const hasLocalVideos = videoFallback.local;

  // Tab/sort/search state lives in exploreStore (URL-synced); the controls
  // render in the prompt-bar row via ExploreControls.
  const primaryTab = useExploreStore((s) => s.primaryTab);
  const secondaryTab = useExploreStore((s) => s.secondaryTab);
  const topPeriod = useExploreStore((s) => s.topPeriod);
  const searchQuery = useExploreStore((s) => s.searchQuery);
  const viewMode = useExploreStore((s) => s.viewMode);
  const modelFilters = useExploreStore((s) => s.modelFilters);
  const setModelFilters = useExploreStore((s) => s.setModelFilters);
  const refreshNonce = useExploreStore((s) => s.refreshNonce);
  const setSearchQuery = useExploreStore((s) => s.setSearchQuery);
  const requestRefresh = useExploreStore((s) => s.requestRefresh);
  const initFromUrl = useExploreStore((s) => s.initFromUrl);

  // Re-hydrate tab state from the URL on mount (deep links / refresh)
  useEffect(() => {
    initFromUrl();
  }, [initFromUrl]);

  // Back/forward between filter states (filters push history entries)
  useEffect(() => {
    const onPop = () => initFromUrl();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [initFromUrl]);

  // Debounce search so we don't hit the Civitai API on every keystroke
  const [debouncedQuery, setDebouncedQuery] = useState(searchQuery);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 350);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const [images, setImages] = useState<CivitaiImage[]>([]);
  const imagesRef = useRef<CivitaiImage[]>([]);
  imagesRef.current = images;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<string | null>(null);
  errorRef.current = error;
  // Mature thumbnails start blurred; a click reveals them for this session
  const [revealedIds, setRevealedIds] = useState<Set<number>>(
    () => new Set(),
  );
  // Only the hovered/focused video tile mounts a playing <video>
  const [activeVideoId, setActiveVideoId] = useState<number | null>(null);
  const revealImage = useCallback((id: number) => {
    setRevealedIds((prev) => new Set(prev).add(id));
  }, []);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [likedTouchActionIndex, setLikedTouchActionIndex] = useState<
    number | null
  >(null);
  const [civitaiTouchActionIndex, setCivitaiTouchActionIndex] = useState<
    number | null
  >(null);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Prevent duplicate inflight fetches
  const loadingRef = useRef(false);
  const cursorRef = useRef<string | undefined>(undefined);
  // Monotonic request id — reset fetches supersede in-flight ones instead of
  // being dropped.
  const requestSeq = useRef(0);
  const imageAbortRef = useRef<AbortController | null>(null);
  const touchedLikedIndexRef = useRef<number | null>(null);
  const touchedCivitaiIndexRef = useRef<number | null>(null);

  const activeTabDef = PRIMARY_TABS.find((t) => t.id === primaryTab)!;

  const shouldFetchCivitai =
    (secondaryTab === "images" || secondaryTab === "videos") &&
    primaryTab !== "likes";
  const isModelTab = secondaryTab === "models" || secondaryTab === "loras";
  const modelScope: ModelScope = secondaryTab === "loras" ? "loras" : "models";
  // Models/LoRAs: one cursor-paginated feed for Civitai / Civitai Red /
  // Hugging Face, driven by the shared URL-synced ModelFilters.
  const modelFeed = useModelFeed({
    filters: modelFilters,
    query: debouncedQuery,
    scope: modelScope,
    enabled: activeNav === "explore" && isModelTab,
    refreshNonce,
  });

  // Fetch

  const fetchImages = useCallback(
    async (reset = false) => {
      // Pagination fetches dedupe against in-flight requests; reset fetches
      // (tab/search change) supersede them via requestSeq instead
      if (!reset && loadingRef.current) return;
      // Likes tab uses local liked images, not Civitai
      if (
        primaryTab === "likes" ||
        (secondaryTab !== "images" && secondaryTab !== "videos")
      )
        return;

      const seq = ++requestSeq.current;
      imageAbortRef.current?.abort();
      const controller = new AbortController();
      imageAbortRef.current = controller;
      loadingRef.current = true;
      setLoading(true);
      setError(null);

      try {
        // Always the SFW civitai.com feed (explicit nsfw=false&source=com):
        // the image feed has no Red picker, so it must never fall back to
        // the account-level NSFW toggle on a shared screen.
        const params = buildExploreImageQuery({
          query: debouncedQuery,
          limit: 24,
          cursor: reset ? undefined : cursorRef.current,
          sort: activeTabDef.sort,
          period:
            primaryTab === "top" ? CIVITAI_TOP_PERIOD[topPeriod] : undefined,
          video: secondaryTab === "videos",
        });

        const res = await fetch(`/api/civitai/images?${params.toString()}`, {
          signal: controller.signal,
        });
        const json = await res.json();
        // A newer reset fetch superseded this one — discard the response
        if (seq !== requestSeq.current) return;
        if (!json.ok) throw new Error(json.error ?? "Failed to load");

        const page = (json.items ?? []) as CivitaiImage[];
        // Pagination is serialized (loadingRef), so the rendered list is
        // the base for this page
        const next = appendCapped(reset ? [] : imagesRef.current, page);
        imagesRef.current = next;
        setImages(next);
        // At the cap, stop paginating (the grid isn't virtualized)
        const nextCursor =
          next.length >= MAX_FEED_ITEMS ? undefined : json.nextCursor;
        cursorRef.current = nextCursor;
        setCursor(nextCursor);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (seq === requestSeq.current) {
          setError(e instanceof Error ? e.message : "Failed to load images");
        }
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          loadingRef.current = false;
          if (imageAbortRef.current === controller) {
            imageAbortRef.current = null;
          }
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debouncedQuery, primaryTab, secondaryTab, topPeriod],
  );

  useEffect(() => {
    return () => {
      requestSeq.current += 1;
      imageAbortRef.current?.abort();
    };
  }, []);

  // Reset + fetch when tab/search changes
  useEffect(() => {
    if (activeNav !== "explore") {
      requestSeq.current += 1;
      imageAbortRef.current?.abort();
      loadingRef.current = false;
      setLoading(false);
      return;
    }

    if (shouldFetchCivitai) {
      cursorRef.current = undefined;
      setCursor(undefined);
      setImages([]);
      fetchImages(true);
    } else {
      requestSeq.current += 1;
      imageAbortRef.current?.abort();
      loadingRef.current = false;
      setLoading(false);
      setImages([]);
      cursorRef.current = undefined;
      setCursor(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeNav,
    debouncedQuery,
    primaryTab,
    secondaryTab,
    topPeriod,
    refreshNonce,
  ]);

  // IntersectionObserver

  useEffect(() => {
    if (!shouldFetchCivitai) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries[0].isIntersecting &&
          cursorRef.current &&
          !loadingRef.current &&
          !errorRef.current
        ) {
          fetchImages(false);
        }
      },
      { rootMargin: "200px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
    // images.length: re-observe after each page so a sentinel that never
    // left the viewport still fires; error: stop paging until Retry.
  }, [fetchImages, shouldFetchCivitai, images.length, error]);

  // Guard

  if (activeNav !== "explore") return null;

  const handleUsePrompt = (prompt: string) => {
    setPromptValue(prompt);
    setActiveNav("create");
  };

  // Map Civitai images into the lightbox's GalleryImage shape
  const civitaiToGalleryImage = (img: CivitaiImage): GalleryImage => ({
    id: `civitai-${img.id}`,
    url: img.type === "video" ? img.thumbnailUrl || img.url : img.url,
    videoUrl: img.type === "video" ? img.url : undefined,
    prompt: img.prompt || "",
    fullPrompt: img.prompt || "",
    params: [],
    paramsMap: {},
    seed: 0,
    createdAt: img.createdAt,
    runId: "",
    jobIndex: 0,
    width: img.width,
    height: img.height,
    external: {
      source: "civitai",
      id: img.id,
      thumbnailUrl: img.thumbnailUrl,
      models: img.models,
    },
  });

  const openCivitaiLightbox = (list: CivitaiImage[], index: number) => {
    openLightbox({
      images: list.map(civitaiToGalleryImage),
      index,
      origin: "explore",
    });
  };

  const likedToGalleryImage = (img: LikedImage): GalleryImage => ({
    id: `civitai-${img.civitaiId}`,
    url: img.url,
    prompt: img.prompt || "",
    fullPrompt: img.prompt || "",
    params: [],
    paramsMap: {},
    seed: 0,
    createdAt: img.likedAt,
    runId: "",
    jobIndex: 0,
    width: img.width,
    height: img.height,
    external: {
      source: "civitai",
      id: img.civitaiId,
      thumbnailUrl: img.thumbnailUrl,
      models: img.models,
    },
  });

  // Render helpers

  const renderVideosGrid = () => (
    <section aria-labelledby="explore-video-fallback-title">
      <div className="mb-3 mt-1">
        <h2
          id="explore-video-fallback-title"
          className="text-sm font-medium text-[var(--text-primary)]"
        >
          {hasLocalVideos ? "Your videos" : "Video prompts to try"}
        </h2>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">
          {hasLocalVideos
            ? "Nothing came back from Civitai, so here are videos you made."
            : "Nothing came back from Civitai. Start from one of these prompts."}
        </p>
      </div>
      <div className="columns-1 md:columns-2 lg:columns-3 gap-0.5">
        {videoItems.map((video) => (
          <div
            key={video.id}
            className="relative overflow-hidden rounded-sm break-inside-avoid mb-2 border border-[var(--border-primary)] bg-[var(--bg-secondary)] hover:border-[var(--border-secondary)] transition-colors"
          >
            <div
              className="w-full bg-[var(--bg-tertiary)] flex items-center justify-center relative"
              style={{ aspectRatio: "16 / 9" }}
            >
              {video.thumbnailUrl ? (
                <img
                  src={video.thumbnailUrl}
                  alt={video.title}
                  className="w-full h-full object-cover"
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <Film className="w-10 h-10 text-[var(--text-muted)]" />
              )}
            </div>
            <div className="p-3">
              <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                {video.title}
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-1 truncate">
                {video.prompt}
              </p>
              <button
                onClick={() => handleUsePrompt(video.prompt)}
                className="mt-2 w-full flex items-center justify-center gap-1.5 py-1.5 rounded-full bg-white text-black text-xs font-semibold hover:opacity-80 transition-opacity"
              >
                <Wand2 className="w-3 h-3" />
                Use Prompt
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );

  const renderLikedImages = () => {
    if (likes.length === 0) {
      return (
        <ExploreEmptyState
          icon={<Heart className="h-5 w-5" />}
          title="No liked images yet"
          body="Tap the heart on any image to keep it here."
        />
      );
    }

    return (
      <div className="columns-2 md:columns-3 lg:columns-4 xl:columns-5 gap-0.5 rounded-xl overflow-hidden">
        {likes.map((img, idx) => {
          const imgSrc = img.thumbnailUrl || img.url;
          return (
            <article
              key={img.civitaiId}
              onTouchStart={() => {
                setLikedTouchActionIndex(idx);
                touchedLikedIndexRef.current = idx;
              }}
              className="group/exploreCard relative overflow-hidden border-transparent rounded-sm break-inside-avoid mb-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_320px]"
            >
              <div
                className="block w-full bg-[var(--bg-tertiary)] overflow-hidden"
                style={{
                  borderRadius: 2,
                  aspectRatio:
                    img.width && img.height
                      ? `${img.width} / ${img.height}`
                      : "1 / 1",
                }}
              >
                {imgSrc ? (
                  <img
                    src={civitaiThumbUrl(imgSrc)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    className="block h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex items-center justify-center w-full h-full">
                    <ImageIcon className="w-8 h-8 text-[var(--text-muted)]" />
                  </div>
                )}
              </div>
              <button
                type="button"
                aria-label={exploreOpenLabel(
                  "liked image",
                  img.username,
                  img.prompt,
                )}
                onClick={() => {
                  if (touchedLikedIndexRef.current === idx) {
                    touchedLikedIndexRef.current = null;
                    return;
                  }
                  openLightbox({
                    images: likes.map(likedToGalleryImage),
                    index: idx,
                    origin: "explore",
                  });
                }}
                className="absolute inset-0 cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent-primary)]"
              />
              <ExploreCardOverlay
                revealed={likedTouchActionIndex === idx}
                author={exploreCardAuthor(img.username)}
                prompt={img.prompt || undefined}
                liked
                onToggleLike={() => toggleLike(img)}
                onUsePrompt={
                  img.prompt ? () => handleUsePrompt(img.prompt) : undefined
                }
              />
            </article>
          );
        })}
      </div>
    );
  };

  const renderModelsGrid = () => (
    <>
      <div data-tour="explore-models">
        <ModelFilterBar
          filters={modelFilters}
          onChange={setModelFilters}
          scope={modelScope}
        />
      </div>
      <ModelFeedResults
        feed={modelFeed}
        filters={modelFilters}
        downloads={downloads}
        hideDownloaded={hideDownloaded}
        variant="explore"
      />
    </>
  );

  // Render

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Sort/search controls render in the prompt-bar row (ExploreControls);
          on small screens they fall back to a row above the grid */}
      {/* ── Content — same centered ~1600px column as the prompt bar (reference site) ── */}
      <div
        className={`flex-1 overflow-y-auto px-4 md:px-6 pt-1 pb-3 md:py-3 w-full max-w-[1648px] ${settingsOpen ? "mr-auto" : "mx-auto"}`}
      >
        <ExploreControls variant="mobile" />
        {/* ── Likes tab ── */}
        {primaryTab === "likes" &&
          secondaryTab === "images" &&
          renderLikedImages()}

        {/* ── Styles secondary tab: fal Krea 2 style LoRAs ── */}
        {secondaryTab === "styles" && <Krea2StyleLoraBrowser />}

        {/* ── Models + LoRAs: Civitai model browser ── */}
        {isModelTab && renderModelsGrid()}

        {/* ── Images + Videos: Civitai-fetchable primary tabs ── */}
        {(secondaryTab === "images" || secondaryTab === "videos") &&
          primaryTab !== "likes" && (
            <>
              {loading && images.length === 0 && (
                <div
                  className="columns-2 md:columns-3 lg:columns-4 xl:columns-5 gap-0.5 rounded-xl overflow-hidden"
                  aria-busy="true"
                  aria-label="Loading images"
                >
                  {Array.from({ length: 20 }).map((_, i) => (
                    <Skeleton
                      key={i}
                      className={`mb-0.5 ${["h-[180px]", "h-[240px]", "h-[320px]", "h-[400px]", "h-[480px]"][i % 5]}`}
                      rounded="sm"
                    />
                  ))}
                </div>
              )}

              {/* Error (first page; load-more errors render by the sentinel) */}
              {error && images.length === 0 && (
                <FeedErrorState
                  error={error}
                  compact={secondaryTab === "videos"}
                  lead=""
                  onRetry={() => {
                    cursorRef.current = undefined;
                    setCursor(undefined);
                    setImages([]);
                    fetchImages(true);
                  }}
                />
              )}

              {/* Empty state (videos show the local fallback grid instead) */}
              {!loading &&
                !error &&
                images.length === 0 &&
                secondaryTab === "images" && (
                  <ExploreEmptyState
                    icon={
                      searchQuery ? (
                        <Search className="h-5 w-5" />
                      ) : (
                        <ImageIcon className="h-5 w-5" />
                      )
                    }
                    title={
                      searchQuery
                        ? `No results for “${searchQuery.trim()}”`
                        : "No images found"
                    }
                    body={
                      searchQuery
                        ? "Try fewer or broader words."
                        : "The feed came back empty. Try another sort or refresh."
                    }
                    action={
                      searchQuery ? (
                        <button
                          type="button"
                          onClick={() => setSearchQuery("")}
                          className="h-9 rounded-full bg-[var(--bg-secondary)] px-4 text-sm text-[var(--text-primary)] shadow-[inset_0_0_0_1px_var(--border-primary)] transition-[transform,background-color] hover:bg-[var(--bg-hover)] active:scale-[0.96]"
                        >
                          Clear search
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={requestRefresh}
                          className="flex h-9 items-center gap-1.5 rounded-full bg-[var(--bg-secondary)] px-4 text-sm text-[var(--text-primary)] shadow-[inset_0_0_0_1px_var(--border-primary)] transition-[transform,background-color] hover:bg-[var(--bg-hover)] active:scale-[0.96]"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          Refresh
                        </button>
                      )
                    }
                  />
                )}

              {/* Videos fallback (local runs / seed prompts) when the
                  Civitai video feed comes back empty or errors */}
              {secondaryTab === "videos" &&
                !loading &&
                images.length === 0 &&
                renderVideosGrid()}

              {images.length > 0 && (
                <div
                  className={
                    viewMode === "grid"
                      ? "columns-2 md:columns-3 lg:columns-4 xl:columns-5 gap-0.5 rounded-xl overflow-hidden"
                      : "space-y-4"
                  }
                >
                  {images.map((img, idx) => {
                    const likes = likeCount(img);
                    const imgSrc = img.thumbnailUrl || img.url;
                    const blurred =
                      shouldBlurMedia(img) && !revealedIds.has(img.id);
                    const isVideo = img.type === "video";
                    return (
                      <article
                        key={img.id}
                        {...(isVideo
                          ? {
                              onMouseEnter: () => setActiveVideoId(img.id),
                              onMouseLeave: () =>
                                setActiveVideoId((cur) =>
                                  cur === img.id ? null : cur,
                                ),
                              onFocus: () => setActiveVideoId(img.id),
                              onBlur: () =>
                                setActiveVideoId((cur) =>
                                  cur === img.id ? null : cur,
                                ),
                            }
                          : {})}
                        onTouchStart={() => {
                          setCivitaiTouchActionIndex(idx);
                          touchedCivitaiIndexRef.current = idx;
                        }}
                        className="group/exploreCard relative overflow-hidden border-transparent rounded-sm break-inside-avoid mb-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_320px]"
                      >
                        {/* Image / video — lazy, CDN-resized thumbnail */}
                        {isVideo ? (
                          <ExploreVideoTile
                            url={img.url}
                            poster={
                              img.thumbnailUrl && img.thumbnailUrl !== img.url
                                ? civitaiThumbUrl(img.thumbnailUrl)
                                : undefined
                            }
                            width={img.width}
                            height={img.height}
                            blurred={blurred}
                            active={activeVideoId === img.id}
                          />
                        ) : (
                          <div
                            className="block w-full bg-[var(--bg-tertiary)] overflow-hidden shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
                            style={{
                              borderRadius: 2,
                              aspectRatio:
                                img.width && img.height
                                  ? `${img.width} / ${img.height}`
                                  : "1 / 1",
                            }}
                          >
                            {imgSrc ? (
                              <img
                                src={civitaiThumbUrl(imgSrc)}
                                alt=""
                                loading="lazy"
                                decoding="async"
                                draggable={false}
                                className={`block h-full w-full object-cover ${blurred ? "scale-110 blur-2xl" : ""}`}
                              />
                            ) : (
                              <div className="flex items-center justify-center w-full h-full">
                                <ImageIcon className="w-8 h-8 text-[var(--text-muted)]" />
                              </div>
                            )}
                          </div>
                        )}

                        {/* Full-card Open button (overlay actions sit above it) */}
                        <button
                          type="button"
                          aria-label={
                            blurred
                              ? "Reveal mature content"
                              : exploreOpenLabel(
                                  isVideo ? "video" : "image",
                                  img.username,
                                  img.prompt,
                                )
                          }
                          onClick={() => {
                            if (touchedCivitaiIndexRef.current === idx) {
                              touchedCivitaiIndexRef.current = null;
                              if (!blurred) return;
                            }
                            if (blurred) {
                              revealImage(img.id);
                              return;
                            }
                            openCivitaiLightbox(images, idx);
                          }}
                          className="absolute inset-0 cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent-primary)]"
                        >
                          {blurred && (
                            <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-white">
                              <span className="rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-semibold">
                                18+
                              </span>
                              <span className="text-xs text-white/85">
                                Click to reveal
                              </span>
                            </span>
                          )}
                        </button>

                        <ExploreCardOverlay
                          revealed={civitaiTouchActionIndex === idx}
                          author={exploreCardAuthor(img.username)}
                          prompt={img.prompt || undefined}
                          liked={likedIds.has(img.id)}
                          onToggleLike={() => toggleCivitaiLike(img)}
                          onUsePrompt={
                            img.prompt
                              ? () => handleUsePrompt(img.prompt)
                              : undefined
                          }
                        />

                        {likes > 0 && (
                          <div
                            className={`absolute top-2 right-2 flex items-center gap-1 px-2 py-1 rounded-full bg-black/50 backdrop-blur-sm text-white text-xs ${
                              civitaiTouchActionIndex === idx
                                ? "opacity-100"
                                : "opacity-0 group-hover/exploreCard:opacity-100"
                            } transition-opacity pointer-events-none`}
                          >
                            <Heart className="w-3 h-3 fill-rose-400 text-rose-400" />
                            <span className="tabular-nums">
                              {likes.toLocaleString()}
                            </span>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}

              <div ref={sentinelRef} className="h-4 mt-4" />

              {/* Load-more error: next to where the next page would appear */}
              {error && images.length > 0 && (
                <FeedErrorState
                  error={error}
                  onRetry={() => fetchImages(false)}
                  compact
                />
              )}

              {loading && images.length > 0 && (
                <div
                  className="flex items-center justify-center gap-2 py-6 text-xs text-[var(--text-muted)]"
                  role="status"
                >
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading more
                </div>
              )}

              {!cursor && !loading && !error && images.length > 0 && (
                <p className="py-6 text-center text-xs text-[var(--text-muted)]">
                  {images.length >= MAX_FEED_ITEMS
                    ? "That’s a lot of scrolling — refresh or narrow your search for more."
                    : "You’ve reached the end"}
                </p>
              )}
            </>
          )}
      </div>
    </div>
  );
}

export default ExplorePage;

/** Centered empty state: icon chip, balanced title, one hint, optional action. */
function ExploreEmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--bg-secondary)] text-[var(--text-muted)] shadow-[inset_0_0_0_1px_var(--border-primary)]">
        {icon}
      </div>
      <p className="max-w-xs text-[15px] font-medium text-[var(--text-primary)] [text-wrap:balance]">
        {title}
      </p>
      <p className="mt-1 max-w-xs text-sm text-[var(--text-muted)] [text-wrap:pretty]">
        {body}
      </p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * Civitai video tile: a still poster until the card is hovered/focused
 * (`active`, tracked by the parent card), then a muted looping <video>. Without a poster it falls back to a metadata-only <video> (first
 * frame), still paused until hover. Keeps dozens of tiles from all holding
 * live decoders.
 */
function ExploreVideoTile({
  url,
  poster,
  width,
  height,
  blurred,
  active,
}: {
  active: boolean;
  url: string;
  poster?: string;
  width?: number;
  height?: number;
  blurred: boolean;
}) {
  const style: React.CSSProperties = {
    borderRadius: 2,
    aspectRatio: width && height ? `${width} / ${height}` : "1 / 1",
  };
  const blurClass = blurred ? "scale-110 blur-2xl" : "";
  const live = active && !blurred;
  return (
    <div
      className="block w-full overflow-hidden bg-[var(--bg-tertiary)]"
      style={style}
    >
      {poster && !live ? (
        <img
          src={poster}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className={`block h-full w-full object-cover ${blurClass}`}
        />
      ) : (
        <video
          src={url}
          poster={poster}
          muted
          loop
          playsInline
          autoPlay={live}
          preload={live ? "auto" : "metadata"}
          className={`block h-full w-full object-cover ${blurClass}`}
          ref={(el) => {
            if (!el) return;
            if (live) void el.play().catch(() => {});
            else el.pause();
          }}
        />
      )}
    </div>
  );
}

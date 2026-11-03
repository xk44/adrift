"use client";

import { useEffect, useMemo, useRef } from "react";
import { Boxes, Loader2 } from "lucide-react";
import { ModelCard } from "@/components/civitai/ModelCard";
import { HfModelCard } from "@/components/models/HfModelCard";
import { Skeleton } from "@/components/Skeleton";
import { FeedErrorState } from "@/components/models/FeedErrorState";
import { filterDownloadedCivitaiModels } from "@/lib/civitaiDownloadedStatus";
import {
  activeFilterChips,
  civitaiApiSource,
  isCivitaiSourceKind,
  type ModelFilters,
} from "@/lib/modelFilters";
import type { DownloadedModel } from "@/store/downloadStore";
import { useFitsFilterStore } from "@/store/fitsFilterStore";
import {
  civitaiModelCompat,
  hfModelCompat,
  hiddenByFitsFilter,
  unsizedCount,
} from "@/lib/models/exploreCompat";
import { shouldAutoPage, shouldOfferLoadMore } from "@/lib/explore/feedPaging";
import { useBackendProfile } from "./useBackendProfile";
import type { ModelFeed } from "./useModelFeed";

/**
 * Grid + loading/empty/error states + infinite-scroll sentinel for a
 * useModelFeed() result. Civitai rows render as ModelCard (download
 * controls), Hugging Face rows as the typographic HfModelCard.
 */
export function ModelFeedResults({
  feed,
  filters,
  downloads,
  hideDownloaded,
  variant = "explore",
}: {
  feed: ModelFeed;
  filters: ModelFilters;
  downloads: DownloadedModel[];
  hideDownloaded: boolean;
  variant?: "explore" | "browser";
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const isCivitai = isCivitaiSourceKind(filters.source);
  const source = civitaiApiSource(filters.source);
  const nsfw = filters.source === "civitai-red" && filters.nsfw;

  const { profile } = useBackendProfile();
  const fitsOnly = useFitsFilterStore((s) => s.fitsOnly) && profile !== null;

  const visibleCivitai = useMemo(() => {
    const list = filterDownloadedCivitaiModels(
      feed.civitai,
      downloads,
      hideDownloaded,
    );
    return fitsOnly && profile
      ? list.filter((m) => !hiddenByFitsFilter(civitaiModelCompat(m, profile)))
      : list;
  }, [feed.civitai, downloads, hideDownloaded, fitsOnly, profile]);
  const visibleHf = useMemo(
    () =>
      fitsOnly && profile
        ? feed.hf.filter((m) => !hiddenByFitsFilter(hfModelCompat(m, profile)))
        : feed.hf,
    [feed.hf, fitsOnly, profile],
  );
  const visibleCount = isCivitai ? visibleCivitai.length : visibleHf.length;
  // Hugging Face list results carry no file sizes: say so instead of letting
  // an active "Fits my GPU" look like it vetted these cards.
  const unsizedHf = useMemo(
    () =>
      fitsOnly && profile && !isCivitai
        ? unsizedCount(visibleHf.map((m) => hfModelCompat(m, profile)))
        : 0,
    [fitsOnly, profile, isCivitai, visibleHf],
  );

  // Any narrowing filter set (type, base model, creator, task…)?
  const narrowed = activeFilterChips(filters, "models").length > 0;
  const { loadMore, count } = feed;
  const paging = {
    hasMore: feed.hasMore,
    loading: feed.loading,
    error: feed.error,
    visibleCount,
  };
  const autoPage = shouldAutoPage(paging);
  const offerLoadMore = shouldOfferLoadMore(paging);
  // Read loading through a ref so the observer isn't torn down and re-armed
  // on every loading flip (that re-fire is what hot-looped after a 429).
  const loadingRef = useRef(feed.loading);
  loadingRef.current = feed.loading;
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !autoPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadingRef.current) loadMore();
      },
      { rootMargin: "400px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // count: re-observe once per landed page so a sentinel that never left
    // the viewport still fires.
  }, [autoPage, count, loadMore]);

  const gridClass =
    variant === "explore"
      ? "grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      : "grid gap-0.5 sm:grid-cols-2 xl:grid-cols-3";

  return (
    <>
      {feed.loading && feed.count === 0 && (
        <div className={gridClass}>
          {Array.from({ length: variant === "explore" ? 12 : 6 }).map(
            (_, i) => (
              <Skeleton
                key={i}
                className={variant === "explore" ? "h-72" : "h-44"}
                rounded="sm"
              />
            ),
          )}
        </div>
      )}

      {/* First-page error; a load-more error renders by the sentinel */}
      {feed.error && feed.count === 0 && (
        <FeedErrorState
          error={feed.error}
          source={isCivitai ? "civitai" : "hf"}
          onRetry={feed.reload}
        />
      )}

      {!feed.loading && !feed.error && visibleCount === 0 && (
        <div
          data-testid="model-feed-empty"
          className="flex h-64 flex-col items-center justify-center px-6 text-center text-[var(--text-muted)]"
        >
          <Boxes className="mb-4 h-12 w-12" />
          <p className="max-w-sm [text-wrap:balance]">
            {fitsOnly && feed.count > 0
              ? "None of the loaded models fit your GPU. Turn off \u201cFits my GPU\u201d to see them all."
              : isCivitai && hideDownloaded && feed.civitai.length > 0
                ? "All matching models are already downloaded"
                : narrowed
                  ? "No models match these filters. Remove a filter or try a broader search."
                  : "No models found. Try a broader search."}
          </p>
          {offerLoadMore && (
            <button
              type="button"
              onClick={loadMore}
              className="btn btn-secondary mt-4"
            >
              Load more
            </button>
          )}
        </div>
      )}

      {unsizedHf > 0 && (
        <p
          data-testid="fits-unsized-hint"
          className="mb-2 text-xs text-[var(--text-muted)]"
        >
          Hugging Face doesn&rsquo;t list file sizes here, so &ldquo;Fits my
          GPU&rdquo; can&rsquo;t check {unsizedHf === 1 ? "1 repo" : `${unsizedHf} repos`}{" "}
          marked &ldquo;Size unknown&rdquo;.
        </p>
      )}

      {visibleCount > 0 && (
        <div className={gridClass}>
          {isCivitai
            ? visibleCivitai.map((model) => (
                <ModelCard
                  key={model.id}
                  model={model}
                  source={source}
                  nsfw={nsfw}
                  downloads={downloads}
                  variant={variant}
                  profile={profile}
                />
              ))
            : visibleHf.map((model) => (
                <HfModelCard key={model.id} model={model} profile={profile} />
              ))}
        </div>
      )}

      <div ref={sentinelRef} className="mt-4 h-4" />

      {feed.error && feed.count > 0 && (
        <FeedErrorState
          error={feed.error}
          source={isCivitai ? "civitai" : "hf"}
          onRetry={loadMore}
          compact
        />
      )}

      {feed.loading && feed.count > 0 && (
        <div className="flex justify-center py-6">
          <Loader2 className="h-6 w-6 animate-spin text-[var(--text-muted)]" />
        </div>
      )}

      {!feed.hasMore && !feed.loading && !feed.error && feed.count > 0 && (
        <p className="py-4 text-center text-xs text-[var(--text-muted)]">
          No more models
        </p>
      )}
    </>
  );
}

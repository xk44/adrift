"use client";

import { useCallback, useEffect, useState } from "react";
import { Database, Loader2, Search } from "lucide-react";
import { SkeletonImage } from "@/components/Skeleton";
import { normalizeAssetSearch } from "@/lib/sref/vaultShapes";
import { ServiceOffline } from "./LibraryStatus";
import {
  DATASET_PAGE_SIZE,
  svFetch,
  thumbUrl,
  useLatestRequest,
  type SVAsset,
} from "./shared";

export function ImagesView() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SVAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [offline, setOffline] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const req = useLatestRequest();

  // No query lists everything (`/assets`); `/search` requires a query.
  const fetchAssetPage = useCallback(async (q: string, offset: number) => {
    const page = `limit=${DATASET_PAGE_SIZE}&offset=${offset}`;
    const data = await svFetch<unknown>(
      q.trim() ? `search?query=${encodeURIComponent(q)}&${page}` : `assets?${page}`,
    );
    return normalizeAssetSearch(data) as { items: SVAsset[]; total: number | null };
  }, []);

  const loadFirstPage = useCallback(async (q: string) => {
    const g = req.next(); // also invalidates an in-flight loadMore
    setLoading(true);
    setOffline(false);
    try {
      const { items: data, total } = await fetchAssetPage(q, 0);
      if (!req.isCurrent(g)) return;
      setResults(data);
      setNextOffset(data.length);
      setHasMore(data.length === DATASET_PAGE_SIZE && (total == null || data.length < total));
      setHasSearched(true);
    } catch {
      if (!req.isCurrent(g)) return;
      try {
        await svFetch("health");
        if (!req.isCurrent(g)) return;
        setResults([]);
        setNextOffset(0);
        setHasMore(false);
        // A bad search shows "no match"; a failed list has nothing to say that.
        setHasSearched(!!q.trim());
      } catch {
        if (req.isCurrent(g)) setOffline(true);
      }
    } finally {
      if (req.isCurrent(g)) setLoading(false);
    }
  }, [fetchAssetPage, req]);

  const loadInitial = useCallback(async () => {
    await loadFirstPage("");
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore || loading) return;
    const g = req.current();
    setLoadingMore(true);
    try {
      const { items: data, total } = await fetchAssetPage(query, nextOffset);
      // A new search started while this page was in flight: its offset and
      // query belong to the old result set.
      if (!req.isCurrent(g)) return;
      const seen = new Set(results.map((item) => item.asset_id));
      const newItems = data.filter((item) => !seen.has(item.asset_id));
      setResults([...results, ...newItems]);
      setNextOffset((offset) => offset + data.length);
      setHasMore(
        data.length === DATASET_PAGE_SIZE &&
          newItems.length > 0 &&
          (total == null || nextOffset + data.length < total),
      );
    } catch {
      if (req.isCurrent(g)) setOffline(true);
    } finally {
      setLoadingMore(false);
    }
  }, [fetchAssetPage, hasMore, loading, loadingMore, nextOffset, query, req, results]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  const handleSearch = useCallback((q: string) => {
    setQuery(q);
    req.debounce(() => {
      void loadFirstPage(q);
    }, 350);
  }, [loadFirstPage, req]);

  if (offline) return <ServiceOffline onRetry={loadInitial} />;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-light-400 dark:text-dark-500" />
        <input
          type="text"
          aria-label="Search images"
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Search by file name, caption or tag…"
          className="w-full rounded-xl border border-light-100 bg-light-input py-2 pl-8 pr-3 text-sm text-light-primary placeholder:text-light-400 transition-[border-color] duration-150 focus:border-splash/40 focus:outline-none dark:border-dark-750 dark:bg-dark-input dark:text-dark-primary dark:placeholder:text-dark-500"
        />
        {loading && (
          <Loader2 className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-light-400" />
        )}
      </div>

      {hasSearched && !loading && (
        <p className="text-[11px] font-medium text-light-400 dark:text-dark-500">
          {results.length} image{results.length !== 1 ? "s" : ""}
          {query ? ` matching "${query}"` : ""}
          {hasMore ? "+" : ""}
        </p>
      )}

      {loading && !hasSearched ? (
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-5 lg:grid-cols-6">
          {[...Array(18)].map((_, i) => (
            <SkeletonImage key={i} />
          ))}
        </div>
      ) : !hasSearched && !loading ? (
        <div className="flex flex-col items-center justify-center py-16">
          <Database className="h-8 w-8 text-light-300 dark:text-dark-500" />
          <p className="mt-3 text-xs text-light-400 dark:text-dark-500">
            Search file names, captions and tags. prefix* and &quot;phrases&quot; work.
          </p>
        </div>
      ) : results.length === 0 && hasSearched ? (
        <div className="flex flex-col items-center justify-center py-16">
          <Database className="h-8 w-8 text-light-300 dark:text-dark-500" />
          <p className="mt-3 text-xs text-light-400 dark:text-dark-500">
            No images matched your search
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-5 lg:grid-cols-6">
          {results.map((asset) => (
            <div
              key={asset.asset_id}
              className="group relative aspect-square overflow-hidden rounded-xl bg-light-50 dark:bg-dark-750"
              title={asset.source_path}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={thumbUrl(asset.asset_id)}
                alt=""
                className="h-full w-full object-cover transition-[transform] duration-150 group-hover:scale-[1.03]"
                loading="lazy"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            </div>
          ))}
        </div>
      )}
      {hasMore && results.length > 0 && (
        <div className="flex justify-center pt-1">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="flex items-center gap-1.5 rounded-lg bg-light-50 px-3 py-1.5 text-xs font-medium text-light-600 transition-[background-color,transform] duration-150 hover:bg-light-100 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-dark-750 dark:text-dark-400 dark:hover:bg-dark-700"
          >
            {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Load more
          </button>
        </div>
      )}
    </div>
  );
}


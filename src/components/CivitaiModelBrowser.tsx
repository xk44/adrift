"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { ModelFilterBar } from "@/components/models/ModelFilterBar";
import { ModelFeedResults } from "@/components/models/ModelFeedResults";
import { useModelFeed } from "@/components/models/useModelFeed";
import { isCivitaiSourceKind, type ModelFilters } from "@/lib/modelFilters";
import { updateUrlQuery } from "@/lib/urlQuery";
import {
  workflowsCivitaiFiltersToUrl,
  workflowsCivitaiFromUrl,
  workflowsCivitaiQueryToUrl,
} from "@/lib/workflowsUrl";
import { useDownloadStore } from "@/store/downloadStore";

// CivitaiModelBrowser — Setup › Models › Download.
//
// Same filter model, filter bar, feed hook and result grid as Explore →
// Models (Civitai · Civitai Red · Hugging Face). Filters and search are
// URL-backed on /setup (same keys as Explore, see lib/workflowsUrl.ts):
// shareable, kept on reload, filter picks are Back-able.

export function CivitaiModelBrowser() {
  const downloads = useDownloadStore((s) => s.downloads);
  const hideDownloaded = useDownloadStore((s) => s.hideDownloaded);
  const setHideDownloaded = useDownloadStore((s) => s.setHideDownloaded);
  // Client-only page (dynamic, ssr: false): the URL is readable at init.
  const [initial] = useState(() =>
    workflowsCivitaiFromUrl(new URLSearchParams(window.location.search)),
  );
  const [filters, setFiltersState] = useState<ModelFilters>(initial.filters);
  const [query, setQueryState] = useState(initial.query);
  const [debouncedQuery, setDebouncedQuery] = useState(initial.query);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const setFilters = useCallback((next: ModelFilters) => {
    updateUrlQuery(workflowsCivitaiFiltersToUrl(next), "push");
    setFiltersState(next);
  }, []);
  const setQuery = useCallback((next: string) => {
    updateUrlQuery(workflowsCivitaiQueryToUrl(next));
    setQueryState(next);
  }, []);

  // Back/forward between filter states.
  useEffect(() => {
    const onPop = () => {
      const next = workflowsCivitaiFromUrl(
        new URLSearchParams(window.location.search),
      );
      setFiltersState(next.filters);
      setQueryState(next.query);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 350);
    return () => clearTimeout(t);
  }, [query]);

  const feed = useModelFeed({
    filters,
    query: debouncedQuery,
    scope: "models",
    refreshNonce,
  });
  const isCivitai = isCivitaiSourceKind(filters.source);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-xl border border-light-100 bg-light-input p-4 shadow-panel dark:border-dark-750 dark:bg-dark-input">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-medium text-light-primary dark:text-dark-primary">
              Model Browser
            </h2>
            <p className="text-sm text-light-500 dark:text-dark-400">
              Search Civitai, Civitai Red or Hugging Face, then hide fully
              downloaded model/version sets.
            </p>
          </div>
          <button
            onClick={() => setRefreshNonce((n) => n + 1)}
            disabled={feed.loading}
            className="btn btn-secondary flex items-center gap-2"
          >
            <RefreshCw
              className={`h-4 w-4 ${feed.loading ? "animate-spin" : ""}`}
            />{" "}
            Refresh
          </button>
        </div>

        <ModelFilterBar
          filters={filters}
          onChange={setFilters}
          scope="models"
          query={query}
          onQueryChange={setQuery}
        />

        {isCivitai && (
          <label className="flex items-center gap-3 rounded-xl border border-light-100 bg-light-bg/70 px-3 py-2 text-sm text-light-primary dark:border-dark-750 dark:bg-dark-900/70 dark:text-dark-primary">
            <input
              type="checkbox"
              checked={hideDownloaded}
              onChange={(event) => setHideDownloaded(event.target.checked)}
              className="h-4 w-4 accent-splash"
            />
            <span className="font-medium">Hide fully downloaded models</span>
            <span className="text-light-500 dark:text-dark-400">
              Hides a card only when every known version and file variant is
              already local.
            </span>
          </label>
        )}
      </div>

      <div className="flex items-center justify-between text-xs text-light-500 dark:text-dark-400">
        <span>{feed.count} loaded</span>
        {isCivitai ? (
          <span className="inline-flex items-center gap-1">
            <ShieldCheck className="h-3.5 w-3.5" /> Click a card to expand
            versions
          </span>
        ) : (
          <span>Cards open the repo on huggingface.co</span>
        )}
      </div>

      <ModelFeedResults
        feed={feed}
        filters={filters}
        downloads={downloads}
        hideDownloaded={hideDownloaded}
        variant="browser"
      />
    </div>
  );
}

export default CivitaiModelBrowser;

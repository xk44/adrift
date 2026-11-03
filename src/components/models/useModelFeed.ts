"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CivitaiModel } from "@/lib/civitai";
import type { HfModelSummary } from "@/lib/hfModels";
import {
  buildCivitaiModelQuery,
  buildHfModelQuery,
  isCivitaiSourceKind,
  type ModelFilters,
  type ModelScope,
} from "@/lib/modelFilters";
import {
  createRequestSequence,
  isAbortError,
} from "@/lib/util/requestSequence";

/**
 * Cursor-paginated model feed for all three sources (Civitai, Civitai Red,
 * Hugging Face). Shared by Explore → Models/LoRAs and Workflows → Civitai so
 * both surfaces fetch through the same filter → query mapping.
 */
export interface ModelFeed {
  civitai: CivitaiModel[];
  hf: HfModelSummary[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  /** Number of items currently loaded for the active source */
  count: number;
  loadMore: () => void;
  reload: () => void;
}

interface FeedResponse {
  ok?: boolean;
  error?: string;
  items?: unknown[];
  nextCursor?: string | null;
}

export function useModelFeed({
  filters,
  query,
  scope,
  enabled = true,
  refreshNonce = 0,
  limit = 24,
}: {
  filters: ModelFilters;
  query: string;
  scope: ModelScope;
  enabled?: boolean;
  refreshNonce?: number;
  limit?: number;
}): ModelFeed {
  const [civitai, setCivitai] = useState<CivitaiModel[]>([]);
  const [hf, setHf] = useState<HfModelSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  const requestSequenceRef = useRef(createRequestSequence());
  const cursorRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const hasMoreRef = useRef(false);

  const isCivitai = isCivitaiSourceKind(filters.source);
  // Serialized request identity: any change resets the feed.
  const feedKey = useMemo(
    () =>
      (isCivitai
        ? buildCivitaiModelQuery(filters, { query, scope, limit })
        : buildHfModelQuery(filters, { query, scope, limit })
      ).toString(),
    [filters, isCivitai, limit, query, scope],
  );

  const fetchPage = useCallback(
    async (reset: boolean) => {
      if (!reset && (loadingRef.current || !hasMoreRef.current)) return;
      const request = requestSequenceRef.current.begin();
      loadingRef.current = true;
      setLoading(true);
      setError(null);
      if (reset) {
        cursorRef.current = null;
        hasMoreRef.current = false;
        setHasMore(false);
        setCivitai([]);
        setHf([]);
      }

      const params = new URLSearchParams(feedKey);
      const cursor = reset ? null : cursorRef.current;
      if (cursor) params.set("cursor", cursor);
      const endpoint = isCivitai ? "/api/civitai/models" : "/api/hf/models";

      try {
        const response = await fetch(`${endpoint}?${params.toString()}`, {
          cache: "no-store",
          signal: request.signal,
        });
        const data = (await response.json()) as FeedResponse;
        if (!request.isCurrent()) return;
        if (!response.ok || data.ok === false) {
          throw new Error(
            data.error ?? `Model search failed (${response.status})`,
          );
        }
        const items = data.items ?? [];
        const next = data.nextCursor ?? null;
        cursorRef.current = next;
        hasMoreRef.current = Boolean(next) && items.length > 0;
        setHasMore(hasMoreRef.current);
        if (isCivitai) {
          const page = items as CivitaiModel[];
          setCivitai((prev) => {
            if (reset) return page;
            const seen = new Set(prev.map((m) => m.id));
            return [...prev, ...page.filter((m) => !seen.has(m.id))];
          });
        } else {
          const page = items as HfModelSummary[];
          setHf((prev) => {
            if (reset) return page;
            const seen = new Set(prev.map((m) => m.id));
            return [...prev, ...page.filter((m) => !seen.has(m.id))];
          });
        }
      } catch (err) {
        if (!request.isCurrent() || isAbortError(err)) return;
        setError(err instanceof Error ? err.message : "Failed to load models");
      } finally {
        if (request.isCurrent()) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [feedKey, isCivitai],
  );

  useEffect(() => {
    const sequence = requestSequenceRef.current;
    return () => sequence.cancel();
  }, []);

  useEffect(() => {
    if (!enabled) {
      requestSequenceRef.current.cancel();
      loadingRef.current = false;
      setLoading(false);
      return;
    }
    void fetchPage(true);
  }, [enabled, fetchPage, refreshNonce, reloadNonce]);

  const loadMore = useCallback(() => {
    if (enabled) void fetchPage(false);
  }, [enabled, fetchPage]);
  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  return {
    civitai,
    hf,
    loading,
    error,
    hasMore,
    count: isCivitai ? civitai.length : hf.length,
    loadMore,
    reload,
  };
}

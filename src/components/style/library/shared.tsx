"use client";

import { useEffect, useMemo, useRef } from "react";
import { CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { vaultErrorMessage } from "@/lib/sref/vaultShapes";

// Shapes and helpers shared by the Styles library views (Map, Clusters,
// Images, Train). They talk to the library service through /api/vault.

export interface SVClusterNode {
  id: number;
  /** Real API field; `label` is the legacy name kept for old test data. */
  name?: string | null;
  label?: string | null;
  level?: number;
  parent_id: number | null;
  children: SVClusterNode[];
  member_count?: number;
}

export interface SVClusterMember {
  asset_id: number;
  sha256: string;
  source_path: string;
  score?: number | null;
  user_rating?: number | null;
}

export interface SVStyle {
  id: number;
  style_name: string | null;
  source_cluster_id: number | null;
  codes?: string[];
}

export interface SVMixResult {
  style_node_id: number;
  style_code: string;
  style_name?: string | null;
  cluster_id?: number | null;
}

export interface SVUmapRun {
  id: number;
  created_at: string;
  models?: { name?: string; version?: string | null }[] | null;
  n_neighbors?: number | null;
  min_dist?: number | null;
  metric?: string | null;
  /** Legacy fields; the real runs list has neither. */
  point_count?: number;
  embedding_model?: string | null;
}

export interface SVAsset {
  asset_id: number;
  sha256: string;
  source_path: string;
  score?: number | null;
}

export interface PagedCache<T> {
  items: T[];
  nextOffset: number;
  hasMore: boolean;
}

export const CLUSTER_MEMBER_PAGE_SIZE = 30;
export const DATASET_PAGE_SIZE = 60;

/**
 * Latest-request guard + debounce timer for search-as-you-type panels.
 * Each keystroke/select bumps the generation; an async result applies only if
 * its generation is still current, so a slow response for an older query (or
 * one that lands after the box was cleared / the panel unmounted) is dropped
 * instead of overwriting newer results. Pending debounce timers are cleared
 * on unmount.
 */
export function useLatestRequest() {
  const gen = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      gen.current++;
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return useMemo(
    () => ({
      /** Invalidate in-flight work and return the new generation. */
      next: () => ++gen.current,
      isCurrent: (g: number) => g === gen.current,
      current: () => gen.current,
      debounce: (fn: () => void, ms: number) => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(fn, ms);
      },
      cancelDebounce: () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
      },
    }),
    [],
  );
}

export async function svFetch<T>(path: string): Promise<T> {
  const res = await fetch(`/api/vault/${path}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(vaultErrorMessage(err, res.status));
  }
  return res.json() as Promise<T>;
}

export async function svPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/vault/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(vaultErrorMessage(err, res.status));
  }
  return res.json() as Promise<T>;
}

export function thumbUrl(assetId: number) {
  return `/api/vault/assets/${assetId}/thumb`;
}

export function statusColor(status: string) {
  switch (status) {
    case "done":
      return "text-emerald-500";
    case "running":
    case "queued":
      return "text-amber-500";
    case "error":
      return "text-red-500";
    default:
      return "text-light-400 dark:text-dark-500";
  }
}

export function formatLoss(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return value < 0.01 ? value.toExponential(2) : value.toFixed(4);
}

export function StatusIcon({
  status,
  className = "h-3.5 w-3.5",
}: {
  status: string;
  className?: string;
}) {
  switch (status) {
    case "done":
      return <CheckCircle2 className={`${className} text-emerald-500`} />;
    case "running":
      return <Loader2 className={`${className} text-amber-500 animate-spin`} />;
    case "queued":
      return <Clock className={`${className} text-amber-500`} />;
    case "error":
      return <XCircle className={`${className} text-red-500`} />;
    default:
      return (
        <Clock className={`${className} text-light-400 dark:text-dark-500`} />
      );
  }
}

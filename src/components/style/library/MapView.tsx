"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Map as MapIcon,
} from "lucide-react";
import { Skeleton } from "@/components/Skeleton";
import {
  normalizeUmapPoints,
  umapRunModelLabel,
} from "@/lib/sref/vaultShapes";
import { ServiceOffline } from "./LibraryStatus";
import { svFetch, useLatestRequest, type SVUmapRun } from "./shared";

interface SVUmapPoint {
  asset_id: number;
  x: number;
  y: number;
  cluster_id?: number | null;
  label?: string | null;
}

const UNCLUSTERED_COLOR = "#6b7280";
const MAX_MAP_POINTS = 2000;

function UmapScatter({ points }: { points: SVUmapPoint[] }) {
  const W = 480;
  const H = 360;
  const PAD = 20;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  const scale = (v: number, lo: number, hi: number, outLo: number, outHi: number) => {
    const denom = hi - lo || 1;
    return outLo + ((v - lo) / denom) * (outHi - outLo);
  };

  // Build cluster colour map (up to 8 distinct colours)
  const clusterColors: Record<number, string> = {};
  const palette = [
    "var(--color-splash, #7c68ff)",
    "#3b82f6",
    "#10b981",
    "#f59e0b",
    "#ef4444",
    "#8b5cf6",
    "#06b6d4",
    "#f97316",
  ];
  let ci = 0;
  for (const p of points) {
    // Unclustered points stay grey instead of borrowing the first colour.
    if (p.cluster_id == null) continue;
    const c = p.cluster_id;
    if (!(c in clusterColors)) {
      clusterColors[c] = palette[ci % palette.length];
      ci++;
    }
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-auto max-h-[60vh] rounded-xl border border-light-100 dark:border-dark-750 bg-light-50 dark:bg-dark-900"
    >
      {points.map((p, i) => {
        const cx = scale(p.x, minX - rangeX * 0.05, maxX + rangeX * 0.05, PAD, W - PAD);
        const cy = scale(p.y, maxY + rangeY * 0.05, minY - rangeY * 0.05, PAD, H - PAD); // invert Y
        const color =
          p.cluster_id == null ? UNCLUSTERED_COLOR : (clusterColors[p.cluster_id] ?? palette[0]);
        return (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={Math.max(2.5, 5 - points.length / 500)}
            fill={color}
            opacity={0.72}
          >
            <title>
              {p.label ??
                `Asset ${p.asset_id}${p.cluster_id != null ? ` · cluster ${p.cluster_id}` : ""}`}
            </title>
          </circle>
        );
      })}
    </svg>
  );
}

export function MapView() {
  const [runs, setRuns] = useState<SVUmapRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [expandedRun, setExpandedRun] = useState<number | null>(null);
  const [points, setPoints] = useState<SVUmapPoint[]>([]);
  const [loadingPoints, setLoadingPoints] = useState(false);
  const [pointsError, setPointsError] = useState<string | null>(null);
  const [pointsCapped, setPointsCapped] = useState(false);
  const pointsReq = useLatestRequest();

  const load = useCallback(async () => {
    setLoading(true);
    setOffline(false);
    try {
      const data = await svFetch<SVUmapRun[]>("umap/runs");
      setRuns(data);
    } catch {
      setOffline(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleRun = useCallback(
    async (runId: number) => {
      if (expandedRun === runId) {
        pointsReq.next(); // a slow response must not refill a closed run
        setExpandedRun(null);
        setPoints([]);
        setPointsCapped(false);
        setPointsError(null);
        setLoadingPoints(false);
        return;
      }
      const g = pointsReq.next();
      setExpandedRun(runId);
      setPoints([]);
      setPointsCapped(false);
      setPointsError(null);
      setLoadingPoints(true);
      try {
        // One extra point shows whether the run has more than the map draws.
        const data = await svFetch<unknown>(
          `umap/runs/${runId}/points?limit=${MAX_MAP_POINTS + 1}`,
        );
        if (!pointsReq.isCurrent(g)) return;
        const all = normalizeUmapPoints(data);
        setPoints(all.slice(0, MAX_MAP_POINTS));
        setPointsCapped(all.length > MAX_MAP_POINTS);
      } catch (e) {
        if (!pointsReq.isCurrent(g)) return;
        setPointsError(String(e));
        setPoints([]);
      } finally {
        if (pointsReq.isCurrent(g)) setLoadingPoints(false);
      }
    },
    [expandedRun, pointsReq],
  );

  // Open the newest map on arrival; older runs stay one click away.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || runs.length === 0) return;
    autoOpened.current = true;
    void toggleRun(Math.max(...runs.map((run) => run.id)));
  }, [runs, toggleRun]);

  if (loading) {
    return (
      <div className="space-y-2 py-4">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 w-full" rounded="xl" />
        ))}
      </div>
    );
  }

  if (offline) return <ServiceOffline onRetry={load} />;

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24">
        <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-light-50 dark:bg-dark-750">
          <MapIcon className="h-10 w-10 text-light-300 dark:text-dark-500" />
        </div>
        <p className="mt-4 text-sm font-medium text-light-primary dark:text-dark-primary">
          No map yet
        </p>
        <p className="mt-1 max-w-xs text-center text-xs text-light-400 dark:text-dark-500">
          Add a folder of images to build a map of your styles.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] font-medium text-light-400 dark:text-dark-500">
        Maps
      </p>
      {runs.map((run) => {
        const isExpanded = expandedRun === run.id;
        return (
          <div
            key={run.id}
            className="rounded-xl border border-light-100 bg-light-input shadow-panel dark:border-dark-750 dark:bg-dark-input dark:shadow-panel-dark"
          >
            <button
              onClick={() => toggleRun(run.id)}
              className="flex w-full items-center justify-between px-4 py-3 text-left transition-[background-color] duration-150 hover:bg-light-50 dark:hover:bg-dark-800 rounded-xl"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-light-primary dark:text-dark-primary">
                  Run #{run.id}
                  {umapRunModelLabel(run) && (
                    <span className="ml-2 text-[11px] font-normal text-light-400 dark:text-dark-500">
                      {umapRunModelLabel(run)}
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-light-500 dark:text-dark-400">
                  {run.point_count != null
                    ? `${run.point_count.toLocaleString()} points · `
                    : ""}
                  {run.n_neighbors != null ? `n=${run.n_neighbors} · ` : ""}
                  {run.min_dist != null ? `d=${run.min_dist.toFixed(2)} · ` : ""}
                  {run.metric ? `${run.metric} · ` : ""}
                  {new Date(run.created_at).toLocaleDateString()}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-splash/10 px-2.5 py-1 text-[11px] font-medium text-splash">
                  {isExpanded ? "Hide map" : "View map"}
                </span>
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 text-light-400 dark:text-dark-500" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-light-400 dark:text-dark-500" />
                )}
              </div>
            </button>
            {isExpanded && (
              <div className="border-t border-light-100 px-4 pb-4 pt-3 dark:border-dark-750">
                {loadingPoints ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-6 w-6 animate-spin text-splash" />
                    <span className="ml-2 text-xs text-light-400 dark:text-dark-500">
                      Loading projection data…
                    </span>
                  </div>
                ) : pointsError ? (
                  <div className="flex items-start gap-1.5 rounded-xl bg-red-500/8 px-3 py-2.5 text-xs text-red-600 dark:text-red-400">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                    {pointsError}
                  </div>
                ) : points.length === 0 ? (
                  <p className="py-8 text-center text-xs text-light-400 dark:text-dark-500">
                    No point data available for this projection
                  </p>
                ) : (
                  <div className="space-y-2">
                    <UmapScatter points={points} />
                    <p className="text-[10px] text-light-400 dark:text-dark-500">
                      Showing {points.length.toLocaleString()}
                      {run.point_count != null
                        ? ` of ${run.point_count.toLocaleString()}`
                        : ""}{" "}
                      points · hover a point for its asset
                    </p>
                    {pointsCapped && (
                      <p className="text-[10px] text-light-400 dark:text-dark-500">
                        Showing the first {MAX_MAP_POINTS.toLocaleString()} points; this run has more.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}


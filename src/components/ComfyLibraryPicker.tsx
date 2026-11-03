"use client";

/**
 * "From ComfyUI library" picker: lists workflows saved in ComfyUI's own
 * user library (read-only GET /api/userdata via /api/comfy/library) and
 * loads one as the custom (overlay) workflow — the same path a dropped
 * JSON file takes. Conversion errors (missing subgraph, cycle, dangling
 * link, …) are shown verbatim instead of loading a wrong graph.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Library,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import { useUIStore } from "@/store";
import { useOverlayStore } from "@/store/overlayStore";
import { showToast } from "@/components/Toast";
import type { ComfyLibraryEntry } from "@/lib/comfy/comfyLibrary";

interface LoadResponse {
  ok: boolean;
  error?: string;
  details?: { code?: string };
  workflow?: unknown;
  name?: string;
  nodeCount?: number;
  subgraphCount?: number;
  warnings?: string[];
}

interface ComfyLibraryPickerProps {
  /** Controlled open state (e.g. opened from a menu item). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Render only the popover; the caller provides its own trigger. */
  hideTrigger?: boolean;
}

export function ComfyLibraryPicker({
  open: openProp,
  onOpenChange,
  hideTrigger = false,
}: ComfyLibraryPickerProps = {}) {
  const setSelectedWorkflow = useUIStore((s) => s.setSelectedWorkflow);
  const setOverlayWorkflow = useOverlayStore((s) => s.setOverlayWorkflow);

  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const onOpenChangeRef = useRef(onOpenChange);
  const openRef = useRef(open);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
    openRef.current = open;
  });
  const setOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      const value = typeof next === "function" ? next(openRef.current) : next;
      setOpenState(value);
      onOpenChangeRef.current?.(value);
    },
    [],
  );
  const [entries, setEntries] = useState<ComfyLibraryEntry[] | null>(null);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<{
    path: string;
    message: string;
  } | null>(null);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setListing(true);
    setListError(null);
    try {
      const res = await fetch("/api/comfy/library", { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        entries?: ComfyLibraryEntry[];
        error?: string;
      } | null;
      if (!res.ok || !data?.ok)
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      setEntries(data.entries ?? []);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setListing(false);
    }
  }, []);

  useEffect(() => {
    if (open && entries === null && !listing) void refresh();
  }, [open, entries, listing, refresh]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = entries ?? [];
    return q ? list.filter((e) => e.path.toLowerCase().includes(q)) : list;
  }, [entries, query]);

  const load = useCallback(
    async (entry: ComfyLibraryEntry) => {
      setLoadingPath(entry.path);
      setLoadError(null);
      try {
        const res = await fetch(
          `/api/comfy/library?file=${encodeURIComponent(entry.path)}`,
          { cache: "no-store" },
        );
        const data = (await res
          .json()
          .catch(() => null)) as LoadResponse | null;
        if (!res.ok || !data?.ok || !data.workflow) {
          const code = data?.details?.code ? ` [${data.details.code}]` : "";
          throw new Error(`${data?.error ?? `HTTP ${res.status}`}${code}`);
        }
        const name = data.name ?? entry.name;
        setOverlayWorkflow(data.workflow, name);
        // useImagine reads this before the overlay store; keep it in step so
        // an older overlay JSON can't shadow the one just picked.
        try {
          sessionStorage.setItem(
            "cj_overlay_workflow_json",
            JSON.stringify(data.workflow),
          );
        } catch {
          /* quota: overlay store still has it */
        }
        setSelectedWorkflow(`__overlay__/${name}`, name);
        const warnCount = data.warnings?.length ?? 0;
        showToast(
          `Loaded "${name}" from ComfyUI library (${data.nodeCount ?? "?"} nodes` +
            (data.subgraphCount
              ? `, ${data.subgraphCount} subgraph${data.subgraphCount === 1 ? "" : "s"} flattened`
              : "") +
            (warnCount
              ? `, ${warnCount} warning${warnCount === 1 ? "" : "s"}`
              : "") +
            ")",
          warnCount ? "info" : "success",
          warnCount ? 8000 : 4000,
        );
        if (warnCount)
          console.warn("[ComfyLibrary] import warnings", data.warnings);
        setOpen(false);
      } catch (err) {
        setLoadError({
          path: entry.path,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setLoadingPath(null);
      }
    },
    [setOpen, setOverlayWorkflow, setSelectedWorkflow],
  );

  return (
    <div ref={rootRef} className="relative">
      {!hideTrigger && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex size-8 items-center justify-center rounded-lg transition-colors text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          title="From ComfyUI library"
          aria-label="Load workflow from ComfyUI library"
          aria-expanded={open}
        >
          <Library className="w-4 h-4" />
        </button>
      )}
      {open && (
        <div
          role="dialog"
          aria-label="ComfyUI library workflows"
          className="absolute right-0 top-full z-50 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-2 shadow-xl"
        >
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="text-xs font-medium text-[var(--text-primary)]">
              From ComfyUI library
            </span>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={listing}
              className="btn-ghost btn-icon ml-auto !p-0.5"
              title="Refresh"
              aria-label="Refresh library"
            >
              {listing ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <RefreshCw className="w-3 h-3" />
              )}
            </button>
          </div>
          <div className="mb-1.5 flex items-center gap-1 rounded border border-[var(--border-primary)] px-1.5">
            <Search className="w-3 h-3 text-[var(--text-muted)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter…"
              className="w-full bg-transparent py-1 text-xs outline-none"
              autoFocus
            />
          </div>
          {listError && (
            <p className="text-xs text-[var(--error)]">
              Couldn&apos;t list library: {listError}
            </p>
          )}
          {loadError && (
            <div className="mb-1.5 flex gap-1 rounded border border-[var(--error)]/30 bg-[var(--error)]/10 p-1.5 text-xs text-[var(--error)]">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="break-words">{loadError.message}</span>
            </div>
          )}
          {entries !== null && filtered.length === 0 && !listError && (
            <p className="py-2 text-center text-xs text-[var(--text-muted)]">
              {entries.length === 0
                ? "No workflows saved in ComfyUI"
                : "No matches"}
            </p>
          )}
          <ul className="max-h-72 overflow-y-auto">
            {filtered.map((e) => (
              <li key={e.path}>
                <button
                  type="button"
                  onClick={() => void load(e)}
                  disabled={loadingPath !== null}
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-[var(--bg-tertiary,rgba(127,127,127,0.12))] disabled:opacity-60"
                  title={e.path}
                >
                  {loadingPath === e.path && (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                  )}
                  <span className="truncate text-[var(--text-primary)]">
                    {e.name}
                  </span>
                  {e.folder && (
                    <span className="ml-auto shrink-0 text-[10px] text-[var(--text-muted)]">
                      {e.folder}/
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default ComfyLibraryPicker;

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ImageIcon, RefreshCw, Search, Wand2 } from "lucide-react";
import { useUIStore } from "@/store";
import { useOverlayToolsStore } from "@/store/overlayToolsStore";
import { useOverlayToolsBridge } from "@/hooks/useOverlayToolsBridge";
import {
  graphImageProxyUrl,
  type GraphImagePayload,
} from "@/lib/overlay/protocol";
import { requestGraphImage } from "@/lib/overlay/toolsBridge";
import type { CatalogTool } from "@/lib/tools/toolsPage";

const MAX_LISTED = 80;

/** Catalog tools matching a query, ready ones first. Exported for tests. */
export function filterLauncherTools(
  tools: CatalogTool[],
  query: string,
): CatalogTool[] {
  const q = query.trim().toLowerCase();
  const hits = q
    ? tools.filter((t) =>
        `${t.label} ${t.category} ${t.baseLabel}`.toLowerCase().includes(q),
      )
    : tools;
  return [...hits].sort(
    (a, b) =>
      Number(b.available) - Number(a.available) ||
      a.category.localeCompare(b.category) ||
      a.label.localeCompare(b.label),
  );
}

/** One-line description of the graph pick for the launcher header. */
export function describeGraphImage(img: GraphImagePayload | null): string {
  if (!img) return "Waiting for ComfyUI...";
  if (img.source === "none" || img.images.length === 0) {
    return "Select a Load Image, Save Image or Preview Image node";
  }
  const name = img.nodeTitle || img.nodeType;
  const extra = img.images.length > 1 ? ` (+${img.images.length - 1})` : "";
  return `${name}: ${img.images[0].filename}${extra}`;
}

/**
 * Overlay top-bar Tools launcher: shows the image picked in the ComfyUI
 * graph and opens a tool on it (the Tools page consumes the hand-off from
 * useOverlayToolsStore).
 */
export function OverlayToolsLauncher({ connected }: { connected: boolean }) {
  useOverlayToolsBridge(true);
  const graphImage = useOverlayToolsStore((s) => s.graphImage);
  const openToolFromLauncher = useOverlayToolsStore(
    (s) => s.openToolFromLauncher,
  );
  const setActiveNav = useUIStore((s) => s.setActiveNav);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tools, setTools] = useState<CatalogTool[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Load the catalog the first time the popover opens.
  useEffect(() => {
    if (!open || tools) return;
    let cancelled = false;
    // Each open retries a failed load; clear the old error so the list
    // shows "Loading" (and then the tools) instead of a stale failure.
    setLoadError(false);
    fetch("/api/tools")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { ok?: boolean; tools?: CatalogTool[] } | null) => {
        if (cancelled) return;
        if (d?.ok && Array.isArray(d.tools)) setTools(d.tools);
        else setLoadError(true);
      })
      .catch(() => !cancelled && setLoadError(true));
    return () => {
      cancelled = true;
    };
  }, [open, tools]);

  // Refresh the graph pick whenever the popover opens.
  useEffect(() => {
    if (open && connected) requestGraphImage();
  }, [open, connected]);

  const listed = useMemo(
    () => filterLauncherTools(tools ?? [], query).slice(0, MAX_LISTED),
    [tools, query],
  );
  const hasImage = !!graphImage && graphImage.images.length > 0;
  const thumb = hasImage ? graphImageProxyUrl(graphImage.images[0]) : null;

  const launch = (key: string | null) => {
    if (key) openToolFromLauncher(key, hasImage);
    setActiveNav("tools");
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 pl-2 pr-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
          open
            ? "text-[var(--accent-primary)] bg-[var(--accent-primary)]/10"
            : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
        }`}
        title="Run a tool on the image selected in ComfyUI"
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Wand2 className="w-3.5 h-3.5" />
        Tools
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Tools"
          className="absolute top-full left-0 mt-2 w-80 max-w-[calc(100vw-32px)] rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] shadow-xl z-50 overflow-hidden"
        >
          {/* Graph pick */}
          <div className="flex items-center gap-2.5 p-3 border-b border-[var(--border-primary)]">
            <div className="w-12 h-12 shrink-0 rounded-lg overflow-hidden bg-[var(--bg-tertiary)] border border-[var(--border-primary)] flex items-center justify-center">
              {thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={thumb}
                  alt=""
                  className="w-full h-full object-cover"
                />
              ) : (
                <ImageIcon className="w-4 h-4 text-[var(--text-muted)]" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] text-[var(--text-muted)]">
                ComfyUI selection
              </div>
              <div
                className="text-xs text-[var(--text-secondary)] truncate"
                title={describeGraphImage(graphImage)}
              >
                {describeGraphImage(graphImage)}
              </div>
            </div>
            <button
              onClick={() => requestGraphImage()}
              disabled={!connected}
              className="p-1.5 rounded-full text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors"
              title="Refresh from the graph"
              aria-label="Refresh graph selection"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="px-3 pt-3">
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-primary)]">
              <Search className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a tool"
                className="flex-1 min-w-0 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
                aria-label="Find a tool"
              />
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto noScrollbar p-1.5">
            {!tools && !loadError && (
              <div className="px-2 py-3 text-xs text-[var(--text-muted)]">
                Loading tools...
              </div>
            )}
            {loadError && (
              <div className="px-2 py-3 text-xs text-[var(--text-muted)]">
                Could not load the tool catalog.
              </div>
            )}
            {tools && listed.length === 0 && (
              <div className="px-2 py-3 text-xs text-[var(--text-muted)]">
                No tools match.
              </div>
            )}
            {listed.map((t) => (
              <button
                key={t.id}
                onClick={() => launch(`catalog:${t.id}`)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-[var(--bg-hover)] transition-colors"
                title={t.description}
              >
                <span className="min-w-0 flex-1">
                  <span
                    className={`block text-xs truncate ${t.available ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`}
                  >
                    {t.label}
                  </span>
                  <span className="block text-[10px] text-[var(--text-muted)] truncate">
                    {t.category} · {t.baseLabel}
                    {t.available ? "" : " · not installed"}
                  </span>
                </span>
                {t.license?.commercial === false && (
                  <span
                    className="shrink-0 px-1 rounded text-[9px] font-medium text-amber-500 border border-amber-500/40"
                    title={`Non-commercial license (${t.license.name})`}
                  >
                    NC
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="p-2 border-t border-[var(--border-primary)]">
            <button
              onClick={() => launch(null)}
              className="w-full px-2.5 py-1.5 rounded-lg text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              All tools
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

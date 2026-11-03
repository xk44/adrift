"use client";

/**
 * Lightbox "Tools" panel: an inline accordion in the side panel (reads the
 * same on desktop and phone). Searchable, grouped, filtered to what the open
 * item can feed. Inline tools run the lightbox's own handlers; the rest open
 * on the Tools page with the item preloaded (lib/tools/toolHandoff.ts).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Box,
  Brush,
  Camera,
  Film,
  Image as ImageIcon,
  Loader2,
  Move,
  Play,
  RefreshCw,
  ScanFace,
  ScrollText,
  Search,
  Sparkles,
  Wand2,
  Wrench,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import { useIntegrations } from "@/hooks/useIntegrations";
import {
  buildLightboxTools,
  filterLightboxTools,
  groupLightboxTools,
  type InlineRun,
  type LightboxMediaKind,
  type LightboxTool,
} from "@/lib/ui/lightboxTools";
import type { CatalogTool } from "@/lib/tools/toolsPage";
import { resolveToolPreview } from "@/lib/tools/toolPreviews";
import { TOOL_ICONS } from "@/components/tools/ToolCover";
import { CREATOR_ICONS } from "@/components/creatorActionIcons";
import { userToolLightboxEntries } from "@/lib/userTools/registry";
import { useUserTools } from "@/store/userToolsStore";

const INLINE_ICONS: Record<string, LucideIcon> = {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Box,
  Brush,
  Camera,
  Film,
  Image: ImageIcon,
  Move,
  Play,
  RefreshCw,
  ScanFace,
  ScrollText,
  Sparkles,
  Wand2,
  ZoomIn,
  ZoomOut,
};

function iconFor(name: string | undefined): LucideIcon {
  if (!name) return Wrench;
  return (
    INLINE_ICONS[name] ?? CREATOR_ICONS[name] ?? TOOL_ICONS[name] ?? Wrench
  );
}

export interface LightboxToolsPanelProps {
  media: LightboxMediaKind;
  external: boolean;
  /** Rows listed ahead of the catalog (the creator actions the user hid). */
  extraTools?: LightboxTool[];
  onRun: (run: InlineRun) => void;
  isRunning: (run: InlineRun) => boolean;
  onOpenTool: (toolKey: string) => void;
}

const BUTTON =
  "flex h-8 min-w-0 flex-1 basis-0 items-center justify-center gap-1.5 rounded-lg px-1.5 text-xs bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-[color,background-color,transform] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50";

export function ToolThumb({ tool }: { tool: LightboxTool }) {
  const preview =
    tool.target.kind === "open"
      ? resolveToolPreview(tool.key, { size: "sm" })
      : ({ kind: "none" } as const);
  const Icon = iconFor(tool.icon);
  return (
    <span className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
      {preview.kind === "still" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview.src}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <Icon className="h-4 w-4" />
      )}
    </span>
  );
}

export function InlineToolRow({
  tool,
  onRun,
  isRunning,
}: {
  tool: LightboxTool;
  onRun: (run: InlineRun) => void;
  isRunning: (run: InlineRun) => boolean;
}) {
  if (tool.target.kind !== "inline") return null;
  return (
    <li
      className="space-y-1.5 rounded-xl px-2 py-2"
      data-lightbox-tool={tool.key}
    >
      <div className="flex items-center gap-2.5">
        <ToolThumb tool={tool} />
        <div className="min-w-0">
          <div className="truncate text-sm text-[var(--text-primary)]">
            {tool.title}
          </div>
          <div className="truncate text-xs text-[var(--text-muted)]">
            {tool.subtitle}
          </div>
        </div>
      </div>
      <div
        className="flex min-w-0 gap-1.5"
        role="group"
        aria-label={tool.title}
      >
        {tool.target.variants.map((v) => {
          const Icon = v.icon ? iconFor(v.icon) : null;
          const running = isRunning(v.run);
          return (
            <button
              key={v.ariaLabel}
              type="button"
              className={BUTTON}
              aria-label={v.ariaLabel}
              title={v.ariaLabel}
              disabled={running}
              onClick={() => onRun(v.run)}
            >
              {running ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : Icon ? (
                <Icon className="h-3.5 w-3.5 shrink-0" />
              ) : null}
              {v.label && <span className="truncate">{v.label}</span>}
            </button>
          );
        })}
      </div>
    </li>
  );
}

export function OpenToolRow({
  tool,
  onOpenTool,
  note,
  openTitle,
}: {
  tool: LightboxTool;
  onOpenTool: (toolKey: string) => void;
  /** Small trailing tag (e.g. "Selection" when the tool uses the mask). */
  note?: string;
  /** Button tooltip (default: open in Tools with this item). */
  openTitle?: string;
}) {
  if (tool.target.kind !== "open") return null;
  const toolKey = tool.target.toolKey;
  return (
    <li data-lightbox-tool={tool.key}>
      <button
        type="button"
        onClick={() => onOpenTool(toolKey)}
        title={openTitle ?? `Open ${tool.title} in Tools with this item`}
        aria-label={openTitle ?? `Open ${tool.title} in Tools with this item`}
        className="group flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] transition-colors"
      >
        <ToolThumb tool={tool} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-[var(--text-primary)]">
            {tool.title}
          </span>
          <span className="block truncate text-xs text-[var(--text-muted)]">
            {tool.subtitle}
          </span>
        </span>
        {note && (
          <span className="shrink-0 rounded-md bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
            {note}
          </span>
        )}
        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] opacity-60 group-hover:opacity-100" />
      </button>
    </li>
  );
}

/**
 * GET /api/tools, shared across panel opens. Only a successful response is
 * cached; an HTTP error, a bad body or a network failure rejects and clears
 * the cache so the next open (or Retry) fetches again.
 */
let catalogPromise: Promise<CatalogTool[]> | null = null;
export function fetchToolCatalog(): Promise<CatalogTool[]> {
  catalogPromise ??= fetch("/api/tools")
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<{ ok?: boolean; tools?: CatalogTool[] } | null>;
    })
    .then((j) => {
      if (!j?.ok || !Array.isArray(j.tools))
        throw new Error("Unexpected tool list response");
      return j.tools;
    })
    .catch((err: unknown) => {
      catalogPromise = null;
      throw err;
    });
  return catalogPromise;
}

/** Same as fetchToolCatalog but resolves [] on failure (still uncached). */
export function loadToolCatalog(): Promise<CatalogTool[]> {
  return fetchToolCatalog().catch(() => []);
}

/** Test hook: forget the cached catalog. */
export function resetToolCatalogCache(): void {
  catalogPromise = null;
}

/** True on devices with a fine pointer (mouse/trackpad), false on touch. */
export function searchFocusOnOpen(
  matchMedia: ((q: string) => { matches: boolean }) | undefined = typeof window !==
  "undefined"
    ? window.matchMedia?.bind(window)
    : undefined,
): boolean {
  if (!matchMedia) return true;
  return matchMedia("(pointer: fine)").matches;
}

export function LightboxToolsPanel({
  media,
  external,
  extraTools,
  onRun,
  isRunning,
  onOpenTool,
}: LightboxToolsPanelProps) {
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<CatalogTool[] | null>(null);
  const [catalogState, setCatalogState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setCatalogState("loading");
    fetchToolCatalog().then(
      (tools) => {
        if (!live) return;
        setCatalog(tools);
        setCatalogState("ready");
      },
      () => {
        if (live) setCatalogState("error");
      },
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  const userTools = useUserTools();
  const describeAvailable = useIntegrations().styleVault;
  const all = useMemo(
    () =>
      [
        ...(extraTools ?? []),
        ...buildLightboxTools(catalog),
        ...userToolLightboxEntries(userTools),
      ].filter(
        // Describe needs StyleVault (STYLEVAULT_API_URL).
        (t) => describeAvailable || t.key !== "action:describe",
      ),
    [extraTools, catalog, userTools, describeAvailable],
  );
  const groups = useMemo(
    () =>
      groupLightboxTools(filterLightboxTools(all, { media, external, query })),
    [all, media, external, query],
  );
  const empty = groups.length === 0 && catalogState === "ready";

  // Opening from the bottom of the action list would leave the panel below
  // the fold; bring it into view once on mount.
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    rootRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    // Focus search for keyboard/mouse users only: on touch screens focusing
    // pops the keyboard over the list the user just opened.
    if (searchFocusOnOpen()) searchRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      ref={rootRef}
      id="lightbox-tools-panel"
      data-lightbox-tools
      className="space-y-2 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2"
    >
      <label className="flex h-8 items-center gap-2 rounded-lg bg-[var(--bg-secondary)] px-2.5 focus-within:ring-1 focus-within:ring-[var(--border-secondary)]">
        <Search className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            media === "video" ? "Search video tools" : "Search tools"
          }
          aria-label="Search tools"
          className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus-visible:outline-none"
        />
        <kbd className="hidden md:inline text-[10px] text-[var(--text-muted)]">
          Esc
        </kbd>
      </label>

      <div className="max-h-[min(26rem,60dvh)] space-y-3 overflow-y-auto overscroll-contain pr-0.5">
        {empty && (
          <p className="px-2 py-3 text-xs text-[var(--text-muted)]">
            {media === "mesh"
              ? "No tools take this kind of file yet."
              : query
                ? `Nothing matches "${query}".`
                : "No tools for this item."}
          </p>
        )}
        {catalogState === "error" && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-lg bg-[var(--bg-secondary)] px-2.5 py-2 text-xs text-[var(--text-secondary)]"
          >
            <span className="min-w-0 flex-1">
              Couldn&rsquo;t load the full tool list.
            </span>
            <button
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
              title="Try loading the tool list again"
              aria-label="Retry loading tools"
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
            >
              <RefreshCw className="h-3 w-3" /> Retry
            </button>
          </div>
        )}
        {groups.map(({ group, tools }) => (
          <section key={group} aria-label={group}>
            <h4 className="px-2 pb-1 text-[10px] font-medium text-[var(--text-muted)]">
              {group}
            </h4>
            <ul className="space-y-0.5">
              {tools.map((t) =>
                t.target.kind === "inline" ? (
                  <InlineToolRow
                    key={t.key}
                    tool={t}
                    onRun={onRun}
                    isRunning={isRunning}
                  />
                ) : (
                  <OpenToolRow key={t.key} tool={t} onOpenTool={onOpenTool} />
                ),
              )}
            </ul>
          </section>
        ))}
        {catalogState === "loading" && (
          <div role="status" aria-label="Loading tools" className="space-y-1.5 px-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-2.5 py-1">
                <span className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-[var(--bg-secondary)]" />
                <span className="h-3 flex-1 animate-pulse rounded bg-[var(--bg-secondary)]" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default LightboxToolsPanel;

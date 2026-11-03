"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Blend,
  Bookmark,
  BookmarkCheck,
  Copy,
  Heart,
  Layers,
  Loader2,
  Palette,
  Plus,
  Search,
  Star,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { navigateTo } from "@/hooks";
import { useGenerationStore, useStyleStore, useUIStore } from "@/store";
import type { StyleCodeEntry } from "@/store";
import type { GalleryImage } from "@/types";
import { showToast } from "@/components/Toast";
import { Skeleton } from "@/components/Skeleton";
import { StyleLibraryPage } from "@/components/StyleLibraryPage";
import { STYLE_CODES_ENABLED } from "@/lib/features";
import { Krea2StyleLoraBrowser } from "./Krea2StyleLoraBrowser";
import { MjStyleDetail, type MjStyleRecord } from "./MjStyleDetail";
import {
  CATALOG_COLLAGE_SUBJECTS,
  catalogStyleImageUrl,
  savedStyleCollage,
  type StyleSession,
} from "./styleCreatorLogic";
import {
  CATALOG_FEEDS,
  STYLES_FILTERS,
  catalogQuery,
  filterSavedCodes,
  matchesName,
  sectionVisible,
  styleCardTitle,
  toggleBlend,
  withSrefCodes,
  type CatalogFeed,
  type StylesFilter,
} from "@/lib/stylesHub";

const CATALOG_PAGE = 24;

// Without style codes there are no saved codes or code catalog to filter by.
const FILTERS = STYLE_CODES_ENABLED
  ? STYLES_FILTERS
  : STYLES_FILTERS.filter((item) => item.key !== "catalog");
const STRIP_SUBJECTS = ["portrait", "landscape", "still_life"] as const;

const CHIP =
  "rounded-full border px-3 py-1 text-xs font-medium transition-colors [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:px-4";
const CHIP_ON =
  "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white";
const CHIP_OFF =
  "border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--text-primary)]";
const ICON_BTN =
  "rounded-md p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] [@media(pointer:coarse)]:p-2.5";
/** Off-screen cards skip layout/paint until scrolled near. */
const CARD_VIS = "[content-visibility:auto] [contain-intrinsic-size:auto_220px]";
const DETAIL_BTN =
  "inline-flex h-9 items-center gap-2 rounded-full border border-[var(--border-primary)] px-3 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]";

// Catalog paging

function useCatalog(feed: CatalogFeed, query: string, enabled: boolean) {
  const [items, setItems] = useState<MjStyleRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(0);
  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(
    async (offset: number, reset: boolean) => {
      const seq = ++seqRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/style-catalog/index?${catalogQuery(feed, query, offset, CATALOG_PAGE)}`,
          { signal: controller.signal },
        );
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          items?: MjStyleRecord[];
          nextOffset?: number | null;
          error?: string;
        };
        if (seq !== seqRef.current) return;
        if (!res.ok || !json.ok) {
          throw new Error(json.error ?? "Style catalog unavailable");
        }
        const page = json.items ?? [];
        setItems((prev) => (reset ? page : [...prev, ...page]));
        setNextOffset(json.nextOffset ?? null);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") {
          return;
        }
        if (seq !== seqRef.current) return;
        if (reset) setItems([]);
        setError(
          caught instanceof Error
            ? caught.message
            : "Style catalog unavailable",
        );
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [feed, query],
  );

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => void load(0, true), query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [enabled, load, query]);

  useEffect(
    () => () => {
      seqRef.current += 1;
      abortRef.current?.abort();
    },
    [],
  );

  const loadMore = useCallback(() => {
    if (nextOffset !== null && !loading) void load(nextOffset, false);
  }, [load, loading, nextOffset]);

  return { items, loading, error, hasMore: nextOffset !== null, loadMore };
}

// Small pieces

function Collage({ images, label }: { images: string[]; label: string }) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const shown = images.filter((src) => !failed.has(src)).slice(0, 4);
  if (shown.length === 0) {
    return (
      <div className="flex aspect-square items-center justify-center bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
        <Palette className="h-6 w-6" />
      </div>
    );
  }
  const cells = [0, 1, 2, 3].map((i) => shown[i] ?? shown[0]);
  return (
    <div className="grid aspect-square grid-cols-2 grid-rows-2 gap-px overflow-hidden bg-[var(--bg-tertiary)]">
      {cells.map((src, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={`${src}-${i}`}
          src={src}
          alt={i === 0 ? label : ""}
          loading="lazy"
          decoding="async"
          onError={() =>
            setFailed((prev) => (prev.has(src) ? prev : new Set(prev).add(src)))
          }
          className="h-full w-full object-cover"
        />
      ))}
    </div>
  );
}

function SectionHeader({
  title,
  count,
  children,
}: {
  title: string;
  count?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">
          {title}
        </h2>
        {count && (
          <span className="text-xs text-[var(--text-muted)]">{count}</span>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * Icon-only card action with a visible label on hover/focus (the title
 * attribute alone is slow to appear and invisible on touch).
 */
function IconAction({
  label,
  onClick,
  className = "",
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`group/ia relative ${ICON_BTN} ${className}`}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {children}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-primary)] opacity-0 shadow ring-1 ring-[var(--border-primary)] transition-opacity group-hover/ia:opacity-100 group-focus-visible/ia:opacity-100"
      >
        {label}
      </span>
    </button>
  );
}

/**
 * Mounts its children once they scroll near the viewport (or immediately
 * when `eager`, or where IntersectionObserver is missing). Keeps heavy,
 * fetch-on-mount sections off the first paint of the "All" view.
 */
function LazySection({
  eager,
  minHeight,
  children,
}: {
  eager: boolean;
  minHeight: number;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (eager || seen) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [eager, seen]);
  if (eager || seen) return <>{children}</>;
  return <div ref={ref} style={{ minHeight }} aria-hidden="true" />;
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-[var(--border-primary)] px-4 py-6 text-sm text-[var(--text-muted)]">
      {children}
    </p>
  );
}

// Detail target

type DetailTarget =
  | { kind: "saved"; entry: StyleCodeEntry; images: string[] }
  | { kind: "catalog"; record: MjStyleRecord };

function recordForSaved(entry: StyleCodeEntry): MjStyleRecord {
  return {
    code: entry.code,
    width: null,
    height: null,
    prompt: "",
    liked: false,
    feeds: entry.tags ?? [],
    previewUrl: entry.thumbnailUrl ?? "",
  };
}

export interface StylesBrowseProps {
  sessions: readonly StyleSession[];
  /** Open the creator panel seeded with these style codes (or empty). */
  onCreate: (codes: readonly string[]) => void;
  /** Open the creator panel seeded with a style LoRA. */
  onCreateFromLora: (loraId: string) => void;
  onOpenSession: (id: string) => void;
}

/**
 * One browse surface for every style: your saved codes and creator sessions,
 * the local sref catalog, Krea 2 style LoRAs, and imported collections.
 * Every card can be used, remixed in the creator, or added to a blend.
 */
export function StylesBrowse({
  sessions,
  onCreate,
  onCreateFromLora,
  onOpenSession,
}: StylesBrowseProps) {
  const setPromptValue = useUIStore((s) => s.setPromptValue);
  const gallery = useGenerationStore((s) => s.gallery);
  const styleCodes = useStyleStore((s) => s.styleCodes);
  const saveStyleCode = useStyleStore((s) => s.saveStyleCode);
  const removeStyleCode = useStyleStore((s) => s.removeStyleCode);
  const toggleFavorite = useStyleStore((s) => s.toggleStyleCodeFavorite);
  const incrementUse = useStyleStore((s) => s.incrementStyleCodeUse);

  const [filter, setFilter] = useState<StylesFilter>("all");
  const [query, setQuery] = useState("");
  const [feed, setFeed] = useState<CatalogFeed>("styles_top_week");
  const [blend, setBlend] = useState<string[]>([]);
  const [detail, setDetail] = useState<DetailTarget | null>(null);

  const galleryById = useMemo(() => {
    const map = new Map<string, GalleryImage>();
    for (const img of gallery) map.set(img.id, img);
    return map;
  }, [gallery]);

  const savedCodes = useMemo(
    () => filterSavedCodes(styleCodes, query),
    [styleCodes, query],
  );
  const savedSet = useMemo(
    () => new Set(styleCodes.map((entry) => entry.code)),
    [styleCodes],
  );
  const savedNames = useMemo(
    () => new Map(styleCodes.map((entry) => [entry.code, entry.name])),
    [styleCodes],
  );
  const visibleSessions = useMemo(
    () => sessions.filter((s) => matchesName(s.name, query)),
    [sessions, query],
  );

  const catalog = useCatalog(
    feed,
    query,
    STYLE_CODES_ENABLED && sectionVisible(filter, "catalog"),
  );

  const savedImages = useCallback(
    (entry: StyleCodeEntry) => {
      const local = savedStyleCollage(
        entry.code,
        entry.thumbnailUrl,
        sessions,
        galleryById,
      );
      return local.length > 0
        ? local
        : CATALOG_COLLAGE_SUBJECTS.map((s) =>
            catalogStyleImageUrl(entry.code, s),
          );
    },
    [sessions, galleryById],
  );

  // Actions shared by cards and the detail view
  // Merge into the prompt's one --sref flag instead of appending a second.
  const addCodesToPrompt = useCallback(
    (codes: readonly string[]) => {
      setPromptValue(
        withSrefCodes(useUIStore.getState().promptValue, codes),
      );
      for (const code of codes) if (savedSet.has(code)) incrementUse(code);
    },
    [setPromptValue, incrementUse, savedSet],
  );
  const useHere = useCallback(
    (code: string) => {
      addCodesToPrompt([code]);
      showToast(`Added --sref ${code} to the prompt`, "success");
    },
    [addCodesToPrompt],
  );
  const copyCode = useCallback((code: string) => {
    navigator.clipboard?.writeText(`--sref ${code}`).catch(() => {});
    showToast("Copied", "success", 1500);
  }, []);
  const toggleSaved = useCallback(
    (code: string, name?: string, thumb?: string) => {
      if (savedSet.has(code)) {
        removeStyleCode(code);
        showToast(`Removed ${code} from your styles`, "info");
      } else {
        saveStyleCode(code, name, ["catalog"], thumb);
        showToast(`Saved ${code} to your styles`, "success");
      }
    },
    [removeStyleCode, saveStyleCode, savedSet],
  );
  const toggleBlendCode = useCallback(
    (code: string) => setBlend((prev) => toggleBlend(prev, code)),
    [],
  );

  const detailActions = (code: string, saved?: StyleCodeEntry) => (
    <>
      <button
        type="button"
        onClick={() => useHere(code)}
        className={DETAIL_BTN}
      >
        <Wand2 className="h-4 w-4" /> Add to prompt
      </button>
      <button
        type="button"
        onClick={() => {
          setDetail(null);
          onCreate([code]);
        }}
        className={DETAIL_BTN}
      >
        <Palette className="h-4 w-4" /> Remix
      </button>
      <button
        type="button"
        onClick={() => toggleBlendCode(code)}
        className={DETAIL_BTN}
        aria-pressed={blend.includes(code)}
      >
        <Blend className="h-4 w-4" />
        {blend.includes(code) ? "In blend" : "Blend"}
      </button>
      <button
        type="button"
        onClick={() => toggleSaved(code)}
        className={DETAIL_BTN}
      >
        {savedSet.has(code) ? (
          <BookmarkCheck className="h-4 w-4" />
        ) : (
          <Bookmark className="h-4 w-4" />
        )}
        {savedSet.has(code) ? "Saved" : "Save"}
      </button>
      {saved && (
        <button
          type="button"
          onClick={() => toggleFavorite(code)}
          className={DETAIL_BTN}
        >
          <Star
            className={`h-4 w-4 ${saved.isFavorite ? "fill-amber-400 text-amber-400" : ""}`}
          />
          Favorite
        </button>
      )}
    </>
  );

  const showSaved = sectionVisible(filter, "saved");
  const showCatalog = STYLE_CODES_ENABLED && sectionVisible(filter, "catalog");
  const showLoras = sectionVisible(filter, "loras");
  const showCollections = sectionVisible(filter, "collections");

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex-shrink-0 border-b border-[var(--border-primary)] px-4 py-4 sm:px-6">
        <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-semibold text-[var(--text-primary)]">
              Styles
            </h1>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              {STYLE_CODES_ENABLED
                ? "Every style in one place. Use one, remix it, or blend a few into a new one."
                : "Every style in one place: your creator sessions, Krea 2 style LoRAs and collections."}
            </p>
          </div>
          <div className="flex w-full items-center gap-2 md:w-auto">
            <label className="relative min-w-0 flex-1 md:w-72 md:flex-none">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={
                  STYLE_CODES_ENABLED
                    ? "Search codes, names, tags…"
                    : "Search names, tags…"
                }
                aria-label="Search styles"
                data-testid="styles-search"
                className="input w-full pl-9 text-sm"
              />
            </label>
            <button
              type="button"
              onClick={() => onCreate([])}
              data-testid="styles-new-style"
              className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-[var(--accent-primary)] px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90"
            >
              <Plus className="h-3.5 w-3.5" /> New style
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setFilter(item.key)}
              aria-pressed={filter === item.key}
              className={`${CHIP} ${filter === item.key ? CHIP_ON : CHIP_OFF}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      <div className="microScrollbar min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="space-y-10">
          {showSaved && (
            <section data-testid="styles-section-saved">
              <SectionHeader
                title="Your styles"
                count={
                  STYLE_CODES_ENABLED
                    ? `${savedCodes.length} saved · ${visibleSessions.length} sessions`
                    : `${visibleSessions.length} sessions`
                }
              />
              {!STYLE_CODES_ENABLED ? (
                visibleSessions.length === 0 && (
                  <Note>
                    {query
                      ? "No creator sessions match."
                      : "No creator sessions yet. Press New style to start one."}
                  </Note>
                )
              ) : savedCodes.length > 0 ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                  {savedCodes.map((entry) => {
                    const images = savedImages(entry);
                    return (
                      <div
                        key={entry.code}
                        className={`overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] ${CARD_VIS}`}
                      >
                        <button
                          type="button"
                          className="block w-full text-left"
                          onClick={() =>
                            setDetail({ kind: "saved", entry, images })
                          }
                        >
                          <Collage
                            images={images}
                            label={styleCardTitle(entry.code, entry.name)}
                          />
                          <div className="px-2.5 pt-2">
                            <p className="truncate text-xs font-medium text-[var(--text-primary)]">
                              {styleCardTitle(entry.code, entry.name)}
                            </p>
                            <p className="truncate text-[11px] text-[var(--text-muted)]">
                              <span className="font-mono">{entry.code}</span> ·
                              used {entry.useCount}×
                            </p>
                          </div>
                        </button>
                        <div className="flex items-center justify-between px-1.5 pb-1.5 pt-1">
                          <IconAction
                            label="Add to prompt"
                            onClick={() => useHere(entry.code)}
                          >
                            <Wand2 className="h-3.5 w-3.5" />
                          </IconAction>
                          <IconAction
                            label="Remix"
                            onClick={() => onCreate([entry.code])}
                          >
                            <Palette className="h-3.5 w-3.5" />
                          </IconAction>
                          <IconAction
                            className={
                              blend.includes(entry.code)
                                ? "text-[var(--accent-primary)]"
                                : ""
                            }
                            label={
                              blend.includes(entry.code)
                                ? "Remove from blend"
                                : "Add to blend"
                            }
                            pressed={blend.includes(entry.code)}
                            onClick={() => toggleBlendCode(entry.code)}
                          >
                            <Blend className="h-3.5 w-3.5" />
                          </IconAction>
                          <IconAction
                            className={entry.isFavorite ? "text-amber-400" : ""}
                            label={entry.isFavorite ? "Unfavorite" : "Favorite"}
                            onClick={() => toggleFavorite(entry.code)}
                          >
                            <Star
                              className="h-3.5 w-3.5"
                              fill={entry.isFavorite ? "currentColor" : "none"}
                            />
                          </IconAction>
                          <IconAction
                            label="Copy code"
                            onClick={() => copyCode(entry.code)}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </IconAction>
                          <IconAction
                            className="hover:text-red-400"
                            label="Delete"
                            onClick={() => removeStyleCode(entry.code)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </IconAction>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <Note>
                  {query
                    ? "No saved styles match."
                    : "No saved styles yet. Save one from the catalog, or press New style to make your own."}
                </Note>
              )}

              {visibleSessions.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-[11px] font-medium text-[var(--text-muted)]">
                    Creator sessions
                  </p>
                  <div className="microScrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
                    {visibleSessions.map((session) => (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => onOpenSession(session.id)}
                        data-testid="styles-session-chip"
                        className="flex flex-shrink-0 items-center gap-2 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2 text-left transition-colors hover:border-[var(--accent-primary)]"
                      >
                        <Layers className="h-4 w-4 text-[var(--text-muted)]" />
                        <span className="max-w-[12rem] truncate text-xs text-[var(--text-primary)]">
                          {session.name}
                        </span>
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[10px] capitalize ${
                            session.status === "done"
                              ? "bg-green-500/10 text-green-500"
                              : "bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
                          }`}
                        >
                          {session.status}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {showCatalog && (
            <section data-testid="styles-section-catalog">
              <SectionHeader
                title="Catalog"
                count={
                  catalog.items.length
                    ? `${catalog.items.length} shown`
                    : undefined
                }
              >
                <select
                  value={feed}
                  onChange={(e) => setFeed(e.target.value as CatalogFeed)}
                  aria-label="Catalog feed"
                  className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs text-[var(--text-primary)]"
                >
                  {CATALOG_FEEDS.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </SectionHeader>
              {catalog.loading && catalog.items.length === 0 ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <Skeleton key={i} className="h-40" rounded="xl" />
                  ))}
                </div>
              ) : catalog.error ? (
                <Note>
                  The style catalog isn&apos;t available right now. Your saved
                  styles and Style LoRAs still work.
                </Note>
              ) : catalog.items.length === 0 ? (
                <Note>
                  {query
                    ? "No catalog styles match."
                    : "No styles in this feed yet."}
                </Note>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {catalog.items.map((record) => {
                      const saved = savedSet.has(record.code);
                      const inBlend = blend.includes(record.code);
                      const title = styleCardTitle(
                        record.code,
                        savedNames.get(record.code),
                      );
                      return (
                        <div
                          key={record.code}
                          className={`overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] ${CARD_VIS}`}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              setDetail({ kind: "catalog", record })
                            }
                            aria-label={`Open ${title}`}
                            className="grid aspect-[3/1] w-full grid-cols-3 bg-[var(--bg-tertiary)]"
                          >
                            {STRIP_SUBJECTS.map((subject) => (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                key={subject}
                                src={catalogStyleImageUrl(record.code, subject)}
                                alt={`${title}, ${subject.replace("_", " ")}`}
                                className="h-full w-full object-cover"
                                loading="lazy"
                                decoding="async"
                              />
                            ))}
                          </button>
                          <div className="flex items-center gap-1 px-2.5 py-1.5">
                            <p
                              className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--text-primary)]"
                              title={`--sref ${record.code}`}
                            >
                              {title}
                            </p>
                            {(record.liked ||
                              record.feeds.includes("styles_likes")) && (
                              <Heart className="h-3.5 w-3.5 flex-shrink-0 fill-rose-500 text-rose-500" />
                            )}
                            <IconAction
                              label="Add to prompt"
                              onClick={() => useHere(record.code)}
                            >
                              <Wand2 className="h-3.5 w-3.5" />
                            </IconAction>
                            <IconAction
                              label="Remix"
                              onClick={() => onCreate([record.code])}
                            >
                              <Palette className="h-3.5 w-3.5" />
                            </IconAction>
                            <IconAction
                              className={
                                inBlend ? "text-[var(--accent-primary)]" : ""
                              }
                              label={inBlend ? "Remove from blend" : "Blend"}
                              pressed={inBlend}
                              onClick={() => toggleBlendCode(record.code)}
                            >
                              <Blend className="h-3.5 w-3.5" />
                            </IconAction>
                            <IconAction
                              className={
                                saved ? "text-[var(--accent-primary)]" : ""
                              }
                              label={saved ? "Unsave" : "Save"}
                              onClick={() =>
                                toggleSaved(
                                  record.code,
                                  undefined,
                                  catalogStyleImageUrl(record.code, "portrait"),
                                )
                              }
                            >
                              {saved ? (
                                <BookmarkCheck className="h-3.5 w-3.5" />
                              ) : (
                                <Bookmark className="h-3.5 w-3.5" />
                              )}
                            </IconAction>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {catalog.hasMore && (
                    <div className="mt-4 flex justify-center">
                      <button
                        type="button"
                        onClick={catalog.loadMore}
                        disabled={catalog.loading}
                        className="flex items-center gap-2 rounded-lg border border-[var(--border-primary)] px-4 py-2 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-50"
                      >
                        {catalog.loading && (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        )}
                        Load more
                      </button>
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {showLoras && (
            <section
              data-testid="styles-section-loras"
              className="-mx-4 overflow-hidden rounded-xl sm:mx-0 sm:border sm:border-[var(--border-primary)]"
            >
              <LazySection eager={filter === "loras"} minHeight={320}>
                <Krea2StyleLoraBrowser
                  query={query}
                  onRemix={(item) => onCreateFromLora(item.id)}
                />
              </LazySection>
            </section>
          )}

          {showCollections && (
            <section data-testid="styles-section-collections">
              <SectionHeader title="Collections" />
              <LazySection eager={filter === "collections"} minHeight={480}>
                <StyleLibraryPage embedded query={query} />
              </LazySection>
            </section>
          )}
        </div>
      </div>

      {blend.length > 0 && (
        <div
          className="flex flex-shrink-0 flex-wrap items-center gap-2 border-t border-[var(--border-primary)] bg-[var(--bg-secondary)] px-4 py-2.5 sm:px-6"
          data-testid="styles-blend-tray"
        >
          <Blend className="h-4 w-4 text-[var(--text-muted)]" />
          <span className="text-xs font-medium text-[var(--text-secondary)]">
            Blend
          </span>
          {blend.map((code) => (
            <span
              key={code}
              className="flex items-center gap-1 rounded-full bg-[var(--bg-tertiary)] py-0.5 pl-2 pr-1 font-mono text-[11px] text-[var(--text-primary)]"
            >
              {code}
              <button
                type="button"
                onClick={() => toggleBlendCode(code)}
                aria-label={`Remove ${code} from blend`}
                className="rounded-full p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setBlend([])}
              className="rounded-lg px-2.5 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => {
                addCodesToPrompt(blend);
                navigateTo("create");
              }}
              className="rounded-lg border border-[var(--border-primary)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              Use in Create
            </button>
            <button
              type="button"
              onClick={() => onCreate(blend)}
              className="rounded-lg bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
            >
              Blend in creator
            </button>
          </div>
        </div>
      )}

      {detail && (
        <MjStyleDetail
          record={
            detail.kind === "saved"
              ? recordForSaved(detail.entry)
              : detail.record
          }
          subtitle={detail.kind === "saved" ? detail.entry.name : undefined}
          images={
            detail.kind === "saved"
              ? detail.images.map((src, i) => ({
                  src,
                  label: `Reference ${i + 1}`,
                }))
              : undefined
          }
          onClose={() => setDetail(null)}
          onSearch={(code) => {
            setQuery(code);
            setFilter("all");
            setDetail(null);
          }}
          actions={
            <>
              {detailActions(
                detail.kind === "saved"
                  ? detail.entry.code
                  : detail.record.code,
                detail.kind === "saved"
                  ? styleCodes.find((e) => e.code === detail.entry.code)
                  : styleCodes.find((e) => e.code === detail.record.code),
              )}
              {detail.kind === "saved" && (
                <button
                  type="button"
                  onClick={() => {
                    removeStyleCode(detail.entry.code);
                    setDetail(null);
                  }}
                  className={`${DETAIL_BTN} hover:text-red-400`}
                >
                  <Trash2 className="h-4 w-4" /> Delete
                </button>
              )}
            </>
          }
        />
      )}
    </div>
  );
}

export default StylesBrowse;

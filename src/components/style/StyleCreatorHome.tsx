"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Hash,
  Image as ImageIcon,
  Palette,
  Search,
  X,
} from "lucide-react";
import { navigateTo } from "@/hooks";
import { STYLE_CODES_ENABLED } from "@/lib/features";
import { useGenerationStore, useStyleStore } from "@/store";
import type { GalleryImage } from "@/types";
import {
  CATALOG_COLLAGE_SUBJECTS,
  catalogStyleImageUrl,
  promptSrefCodes,
  recentPromptCards,
  savedStyleCollage,
  togglePromptSref,
  type StyleSession,
} from "./styleCreatorLogic";

type TileSource = "saved" | "liked" | "top";

const TILE_SOURCES: { key: TileSource; label: string }[] = [
  { key: "saved", label: "Saved" },
  { key: "liked", label: "Liked" },
  { key: "top", label: "Top this week" },
];

interface StyleTile {
  code: string;
  label?: string;
  images: string[];
}

interface CatalogRecord {
  code: string;
}

const CATALOG_LIMIT = 24;

function useCatalogTiles(source: TileSource, query: string) {
  const [tiles, setTiles] = useState<StyleTile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (source === "saved") return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      async () => {
        setLoading(true);
        setError(null);
        try {
          const params = new URLSearchParams({ limit: String(CATALOG_LIMIT) });
          if (source === "liked") params.set("liked", "true");
          else params.set("feed", "styles_top_week");
          if (query.trim()) params.set("q", query.trim());
          const res = await fetch(`/api/style-catalog/index?${params.toString()}`, {
            signal: controller.signal,
          });
          const json = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            items?: CatalogRecord[];
            error?: string;
          };
          if (!res.ok || !json.ok) {
            throw new Error(json.error ?? "Style catalog unavailable");
          }
          setTiles(
            (json.items ?? []).map((item) => ({
              code: item.code,
              images: CATALOG_COLLAGE_SUBJECTS.map((subject) =>
                catalogStyleImageUrl(item.code, subject),
              ),
            })),
          );
        } catch (caught) {
          if (caught instanceof DOMException && caught.name === "AbortError") {
            return;
          }
          setTiles([]);
          setError(
            caught instanceof Error
              ? caught.message
              : "Style catalog unavailable",
          );
        } finally {
          if (!controller.signal.aborted) setLoading(false);
        }
      },
      query ? 250 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [source, query]);

  return { tiles, loading, error };
}

function CollageCell({
  src,
  onFail,
}: {
  src?: string;
  onFail: (src: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return <div className="bg-light-50 dark:bg-dark-750" />;
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => {
        setFailed(true);
        onFail(src);
      }}
      className="h-full w-full object-cover"
    />
  );
}

function StyleTileButton({
  tile,
  active,
  onPick,
}: {
  tile: StyleTile;
  active: boolean;
  onPick: (code: string) => void;
}) {
  const cells = [0, 1, 2, 3].map((i) => tile.images[i] ?? tile.images[0]);
  const [failedUrls, setFailedUrls] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const markFailed = (src: string) =>
    setFailedUrls((prev) => (prev.has(src) ? prev : new Set(prev).add(src)));
  // Catalog codes without local renders would be blank tiles: hide them.
  if (
    tile.images.length > 0 &&
    tile.images.every((src) => failedUrls.has(src))
  ) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={() => onPick(tile.code)}
      aria-pressed={active}
      title={active ? "Remove this style" : `Use style ${tile.code}`}
      data-testid="style-creator-style-tile"
      className="group w-28 flex-shrink-0 snap-start text-left focus:outline-none sm:w-32"
    >
      <div
        className={`grid aspect-square grid-cols-2 grid-rows-2 gap-px overflow-hidden rounded-xl bg-light-100 transition-[box-shadow,transform] duration-150 group-hover:-translate-y-0.5 group-focus-visible:ring-2 group-focus-visible:ring-splash dark:bg-dark-800 ${
          active
            ? "ring-2 ring-splash ring-offset-2 ring-offset-light-bg dark:ring-offset-dark-bg"
            : ""
        }`}
      >
        {tile.images.length === 0 ? (
          <div className="col-span-2 row-span-2 flex items-center justify-center bg-splash/10 text-splash">
            <Hash className="h-6 w-6" />
          </div>
        ) : (
          cells.map((src, i) => (
            <CollageCell key={i} src={src} onFail={markFailed} />
          ))
        )}
      </div>
      <p className="mt-1.5 truncate font-mono text-[11px] font-medium text-light-primary dark:text-dark-primary">
        {tile.code}
      </p>
      {tile.label && (
        <p className="truncate text-[10px] text-light-400 dark:text-dark-500">
          {tile.label}
        </p>
      )}
    </button>
  );
}

function TileSkeletonRow() {
  return (
    <div className="flex gap-3 overflow-hidden" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="w-28 flex-shrink-0 sm:w-32">
          <div className="aspect-square animate-pulse rounded-xl bg-light-50 dark:bg-dark-750" />
          <div className="mt-1.5 h-3 w-16 animate-pulse rounded bg-light-50 dark:bg-dark-750" />
        </div>
      ))}
    </div>
  );
}

function EmptyNote({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: typeof Palette;
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl border border-dashed border-light-200 px-4 py-6 text-center dark:border-dark-700 sm:flex-row sm:gap-3 sm:text-left">
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-light-50 text-light-400 dark:bg-dark-750 dark:text-dark-500">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-light-primary dark:text-dark-primary">
          {title}
        </p>
        <p className="mt-0.5 text-[11px] text-light-400 dark:text-dark-500">
          {body}
        </p>
      </div>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-2 rounded-lg px-3 py-1.5 text-xs font-medium text-splash transition-colors duration-150 hover:bg-splash/10 sm:mt-0"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

/**
 * Style Creator start screen: prompt + Start, a "start from a style" tile
 * row, and recent prompts to continue from. Start hands off to the existing
 * session flow via `onStart`.
 */
export function StyleCreatorHome({
  sessions,
  onStart,
  seed,
  variant = "page",
  extra,
}: {
  sessions: readonly StyleSession[];
  onStart: (prompt: string) => void;
  /** Prompt to pre-fill (e.g. `--sref a b` from a card); re-applied per nonce. */
  seed?: { prompt: string; nonce: number };
  /** "panel" = narrow creator side panel on the Styles page. */
  variant?: "page" | "panel";
  /** Extra content under the prompt form (e.g. "start from selected images"). */
  extra?: React.ReactNode;
}) {
  const isPanel = variant === "panel";
  const gallery = useGenerationStore((s) => s.gallery);
  const styleCodes = useStyleStore((s) => s.styleCodes);

  const [prompt, setPrompt] = useState(seed?.prompt ?? "");
  const seedNonce = seed?.nonce;
  const seedPrompt = seed?.prompt;
  useEffect(() => {
    if (seedNonce === undefined) return;
    setPrompt(seedPrompt ?? "");
  }, [seedNonce, seedPrompt]);
  const [source, setSource] = useState<TileSource>(() =>
    styleCodes.length > 0 ? "saved" : "liked",
  );
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const galleryById = useMemo(() => {
    const map = new Map<string, GalleryImage>();
    for (const img of gallery) map.set(img.id, img);
    return map;
  }, [gallery]);

  const savedTiles = useMemo<StyleTile[]>(() => {
    const q = query.trim().toLowerCase();
    return [...styleCodes]
      .sort(
        (a, b) =>
          Number(b.isFavorite) - Number(a.isFavorite) ||
          b.createdAt - a.createdAt,
      )
      .filter(
        (entry) =>
          !q ||
          entry.code.toLowerCase().includes(q) ||
          entry.name?.toLowerCase().includes(q) ||
          entry.tags?.some((tag) => tag.toLowerCase().includes(q)),
      )
      .map((entry) => ({
        code: entry.code,
        label: entry.name,
        images: savedStyleCollage(
          entry.code,
          entry.thumbnailUrl,
          sessions,
          galleryById,
        ),
      }));
  }, [styleCodes, query, sessions, galleryById]);

  // "saved" never fetches; without style codes there is no catalog to load.
  const catalog = useCatalogTiles(STYLE_CODES_ENABLED ? source : "saved", query);
  const tiles = source === "saved" ? savedTiles : catalog.tiles;
  const activeCodes = useMemo(() => new Set(promptSrefCodes(prompt)), [prompt]);

  const recent = useMemo(() => recentPromptCards(gallery, 6), [gallery]);

  const pickStyle = (code: string) => {
    setPrompt((current) => togglePromptSref(current, code));
    inputRef.current?.focus();
  };

  const submit = () => onStart(prompt.trim());

  return (
    <section
      className={
        isPanel
          ? "w-full pb-2 pt-2"
          : "mx-auto w-full max-w-4xl pb-2 pt-6 sm:pt-12"
      }
      data-testid="style-creator-home"
    >
      <div className={isPanel ? "text-left" : "text-center"}>
        <div className="inline-flex items-center gap-2">
          <h1
            className={
              isPanel
                ? "text-lg font-semibold text-light-primary dark:text-dark-primary"
                : "text-3xl font-semibold tracking-tight text-light-primary dark:text-dark-primary sm:text-4xl"
            }
          >
            Style Creator
          </h1>
          <span className="rounded-full bg-splash/10 px-2 py-0.5 text-[10px] font-medium text-splash">
            Beta
          </span>
        </div>
        <p
          className={
            isPanel
              ? "mt-1 text-xs text-light-500 dark:text-dark-400"
              : "mx-auto mt-3 max-w-xl text-sm text-light-500 dark:text-dark-400"
          }
        >
          {STYLE_CODES_ENABLED
            ? "Describe a scene and press Start, then keep the images that feel right. Every pick sharpens a style code you can reuse anywhere."
            : "Describe a scene and press Start, then keep the images that feel right. Save your picks as a moodboard to use as a style reference anywhere."}
        </p>
      </div>

      <form
        className={`${isPanel ? "mt-4" : "mt-8"} flex items-center gap-2 rounded-xl border border-light-100 bg-light-input py-1.5 pl-3 pr-1.5 shadow-panel transition-[border-color,box-shadow] duration-150 focus-within:border-splash/60 focus-within:ring-1 focus-within:ring-splash/30 dark:border-dark-750 dark:bg-dark-input dark:shadow-panel-dark`}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Palette className="h-4 w-4 flex-shrink-0 text-light-400 dark:text-dark-500" />
        <input
          ref={inputRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe a scene…"
          aria-label="Style prompt"
          data-testid="style-creator-prompt"
          className="min-w-0 flex-1 bg-transparent py-1.5 text-sm text-light-primary outline-none focus-visible:outline-none placeholder:text-light-400 dark:text-dark-primary dark:placeholder:text-dark-500"
        />
        {prompt && (
          <button
            type="button"
            onClick={() => {
              setPrompt("");
              inputRef.current?.focus();
            }}
            aria-label="Clear prompt"
            className="rounded-md p-1 text-light-400 transition-colors duration-150 hover:text-light-primary dark:text-dark-500 dark:hover:text-dark-primary"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="submit"
          data-testid="style-creator-start"
          className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-splash px-3.5 py-2 text-xs font-semibold text-white transition-[background-color,transform] duration-150 hover:bg-splash/90 active:scale-[0.96]"
        >
          Start <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </form>

      {extra}

      {/* Start from a style */}
      {STYLE_CODES_ENABLED && (
        <div className={isPanel ? "mt-6" : "mt-10"}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xs font-medium text-light-500 dark:text-dark-400">
              Start from a style
            </h2>
            <div className="flex min-w-0 items-center gap-2">
              <select
                value={source}
                onChange={(e) => setSource(e.target.value as TileSource)}
                aria-label="Style source"
                className="rounded-lg border border-light-100 bg-light-input px-2 py-1.5 text-xs text-light-primary outline-none dark:border-dark-750 dark:bg-dark-input dark:text-dark-primary"
              >
                {TILE_SOURCES.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
              <label className="flex w-36 min-w-0 items-center gap-1.5 rounded-lg border border-light-100 bg-light-input px-2 py-1.5 transition-[border-color] duration-150 focus-within:border-splash/60 dark:border-dark-750 dark:bg-dark-input sm:w-44">
                <Search className="h-3.5 w-3.5 flex-shrink-0 text-light-400 dark:text-dark-500" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search styles"
                  aria-label="Search styles"
                  className="min-w-0 flex-1 bg-transparent text-xs text-light-primary outline-none focus-visible:outline-none placeholder:text-light-400 dark:text-dark-primary dark:placeholder:text-dark-500"
                />
              </label>
            </div>
          </div>

          {source !== "saved" && catalog.loading && tiles.length === 0 ? (
            <TileSkeletonRow />
          ) : tiles.length > 0 ? (
            <div className="microScrollbar -mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2 pt-1">
              {tiles.map((tile) => (
                <StyleTileButton
                  key={tile.code}
                  tile={tile}
                  active={activeCodes.has(tile.code)}
                  onPick={pickStyle}
                />
              ))}
            </div>
          ) : source === "saved" ? (
            <EmptyNote
              icon={Hash}
              title={query ? "No saved styles match" : "No saved styles yet"}
              body={
                query
                  ? "Try a different code, name, or tag."
                  : "Finish a session to save your first style code, or borrow one from the catalog."
              }
              action={{
                label: "Browse top styles",
                onClick: () => setSource("top"),
              }}
            />
          ) : (
            <EmptyNote
              icon={Palette}
              title={
                catalog.error ? "Style catalog unavailable" : "No styles found"
              }
              body={
                catalog.error
                  ? "The style catalog isn't available right now. Your saved styles still work."
                  : query
                    ? "Nothing matches that search yet."
                    : "Nothing here yet. Like a few styles in Explore and they will show up."
              }
              action={{ label: "Show saved", onClick: () => setSource("saved") }}
            />
          )}
        </div>
      )}

      {/* Continue from a recent prompt */}
      <div className="mt-8">
        <h2 className="mb-3 text-xs font-medium text-light-500 dark:text-dark-400">
          {STYLE_CODES_ENABLED
            ? "Or continue from a recent prompt"
            : "Continue from a recent prompt"}
        </h2>
        {recent.length > 0 ? (
          <div
            className={`grid grid-cols-1 gap-2 sm:grid-cols-2 ${isPanel ? "" : "lg:grid-cols-3"}`}
          >
            {recent.map((card) => (
              <button
                key={card.id}
                type="button"
                onClick={() => {
                  setPrompt(card.fullPrompt);
                  inputRef.current?.focus();
                }}
                title={card.fullPrompt}
                data-testid="style-creator-recent-prompt"
                className="flex min-w-0 items-center gap-3 rounded-xl border border-light-100 bg-light-input p-2 text-left shadow-panel transition-[background-color,border-color] duration-150 hover:border-light-200 hover:bg-light-50 dark:border-dark-750 dark:bg-dark-input dark:shadow-panel-dark dark:hover:border-dark-700 dark:hover:bg-dark-800"
              >
                <img
                  src={card.thumbUrl}
                  alt=""
                  loading="lazy"
                  className="h-14 w-14 flex-shrink-0 rounded-lg bg-light-50 object-cover dark:bg-dark-750"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-light-primary dark:text-dark-primary">
                    {card.text}
                  </p>
                  {card.chips.length > 0 && (
                    <div className="mt-1 flex gap-1 overflow-hidden">
                      {card.chips.map((chip) => (
                        <span
                          key={chip}
                          className="flex-shrink-0 whitespace-nowrap rounded bg-light-50 px-1.5 py-0.5 font-mono text-[10px] text-light-500 dark:bg-dark-750 dark:text-dark-400"
                        >
                          {chip}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <EmptyNote
            icon={ImageIcon}
            title="No recent prompts yet"
            body="Prompts you generate on Create will appear here, ready to reuse."
            action={{
              label: "Go to Create",
              onClick: () => navigateTo("create"),
            }}
          />
        )}
      </div>
    </section>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { navigateTo } from "@/hooks";
import { STYLE_CODES_ENABLED } from "@/lib/features";
import { createMoodboard, listMoodboards } from "@/lib/sref/moodboardClient";
import {
  importSvTag,
  listSvSrefGroups,
  type SvSrefGroup,
} from "@/lib/sref/apiClient";
import { showToast } from "@/components/Toast";
import { Skeleton } from "@/components/Skeleton";
import type { Moodboard, MoodboardImage, MoodboardKind } from "@/types";
import {
  FolderInput,
  Image as ImageIcon,
  Loader2,
  Search,
  Sparkles,
} from "lucide-react";

/** Cards per list before "Show more"; libraries can hold thousands. */
export const LIBRARY_PAGE = 24;

/** Off-screen cards skip layout/paint until scrolled near. */
const CARD_VIS = "[content-visibility:auto] [contain-intrinsic-size:auto_260px]";

type FilterKey = "all" | "moodboards" | "characters" | "styles" | "krea" | "mj";

type KreaSourceBoard = {
  id: string;
  name: string;
  description?: string;
  images: MoodboardImage[];
};

const FILTERS = (
  [
    { key: "all", label: "All" },
    { key: "moodboards", label: "Moodboards" },
    { key: "characters", label: "Characters" },
    { key: "styles", label: "Datasets" },
    { key: "krea", label: "Krea" },
    { key: "mj", label: "Styles" },
  ] as { key: FilterKey; label: string }[]
).filter((item) => STYLE_CODES_ENABLED || item.key !== "mj");

export function moodboardKind(board: Moodboard): MoodboardKind {
  return board.kind ?? "moodboard";
}

export function kindBadgeLabel(kind: MoodboardKind): string {
  if (kind === "character") return "Character";
  if (kind === "style") return "Style";
  return "Moodboard";
}

function isKreaImported(board: Moodboard): boolean {
  return board.images.some((image) => image.url.includes("/api/moodboards/krea"));
}

function normalizeImage(input: unknown, boardId?: string): MoodboardImage | null {
  if (typeof input === "string") return { url: input, weight: 1 };
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  if (typeof record.url === "string") {
    return {
      url: record.url,
      weight: typeof record.weight === "number" ? record.weight : 1,
      caption: typeof record.caption === "string" ? record.caption : undefined,
    };
  }
  if (
    boardId &&
    typeof record.file === "string" &&
    /^[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/i.test(record.file)
  ) {
    return {
      url: `/api/moodboards/krea?board=${encodeURIComponent(boardId)}&file=${encodeURIComponent(record.file)}`,
      weight: 1,
    };
  }
  return null;
}

export function normalizeKreaSources(payload: unknown): KreaSourceBoard[] {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const raw =
    record.boards ??
    record.sources ??
    record.kreaBoards ??
    record.moodboards ??
    (Array.isArray(payload) ? payload : []);
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item): KreaSourceBoard | null => {
      if (!item || typeof item !== "object") return null;
      const board = item as Record<string, unknown>;
      const id =
        String(board.id ?? board.uuid ?? board.board ?? board.dir ?? board.name ?? "").trim();
      const name = String(board.name ?? id.replace(/_images$/, "")).trim();
      if (!id || !name) return null;
      const rawImages = Array.isArray(board.images)
        ? board.images
        : Array.isArray(board.imageUrls)
          ? board.imageUrls
          : Array.isArray(board.files)
            ? board.files.map((file) => ({ file }))
            : [];
      const images = rawImages
        .map((image) => normalizeImage(image, id.endsWith("_images") ? id : `${id}_images`))
        .filter((image): image is MoodboardImage => image !== null)
        .slice(0, 20);
      return {
        id,
        name,
        description:
          typeof board.description === "string"
            ? board.description
            : typeof board.taste_profile === "string"
              ? board.taste_profile
              : undefined,
        images,
      };
    })
    .filter((board): board is KreaSourceBoard => board !== null);
}

function matchesQuery(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || name.toLowerCase().includes(q);
}

function boardMatchesFilter(board: Moodboard, filter: FilterKey): boolean {
  const kind = moodboardKind(board);
  if (filter === "all") return true;
  if (filter === "moodboards") return kind === "moodboard";
  if (filter === "characters") return kind === "character";
  if (filter === "styles") return kind === "style";
  if (filter === "krea") return isKreaImported(board);
  return false;
}

function openBoard(board: Moodboard) {
  const kind = moodboardKind(board);
  if (kind === "character") navigateTo("characters", { id: board.id });
  else if (kind === "style") navigateTo("styles", { id: board.id });
  else navigateTo("moodboards", { id: board.id });
}

function ThumbnailCollage({
  name,
  images,
}: {
  name: string;
  images: MoodboardImage[];
}) {
  const thumbs = images.slice(0, 4);
  return (
    <div className="grid aspect-square grid-cols-2 grid-rows-2 overflow-hidden bg-[var(--bg-primary)]">
      {Array.from({ length: 4 }).map((_, index) => {
        const image = thumbs[index];
        return image?.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`${image.url}-${index}`}
            src={image.url}
            alt={name}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        ) : (
          <div
            key={`empty-${index}`}
            className="flex h-full w-full items-center justify-center border border-[var(--border-primary)]/40"
          >
            <ImageIcon className="h-5 w-5 text-[var(--text-muted)]" />
          </div>
        );
      })}
    </div>
  );
}

function LocalBoardCard({ board }: { board: Moodboard }) {
  const kind = moodboardKind(board);
  return (
    <button
      type="button"
      onClick={() => openBoard(board)}
      className={`group overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] text-left transition-colors hover:border-[var(--accent-primary)] ${CARD_VIS}`}
    >
      <ThumbnailCollage name={board.name} images={board.images} />
      <div className="space-y-2 p-3">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <p className="truncate text-sm font-medium text-[var(--text-primary)]">
            {board.name}
          </p>
          <span className="flex-shrink-0 rounded-md bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
            {kindBadgeLabel(kind)}
          </span>
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          {board.images.length} images
        </p>
      </div>
    </button>
  );
}

function KreaSourceCard({
  board,
  importing,
  onImport,
}: {
  board: KreaSourceBoard;
  importing: boolean;
  onImport: (board: KreaSourceBoard) => void;
}) {
  return (
    <div className={`overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] ${CARD_VIS}`}>
      <ThumbnailCollage name={board.name} images={board.images} />
      <div className="space-y-3 p-3">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-[var(--text-primary)]">
              {board.name}
            </p>
            <p className="text-xs text-[var(--text-muted)]">
              {board.images.length} source images
            </p>
          </div>
          <span className="flex-shrink-0 rounded-md bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
            Krea
          </span>
        </div>
        <button
          type="button"
          onClick={() => onImport(board)}
          disabled={importing || board.images.length === 0}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--accent-primary)] px-3 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {importing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FolderInput className="h-3.5 w-3.5" />
          )}
          Import
        </button>
      </div>
    </div>
  );
}

function MjGroupCard({
  group,
  importing,
  onImport,
}: {
  group: SvSrefGroup;
  importing: boolean;
  onImport: (group: SvSrefGroup) => void;
}) {
  return (
    <div className={`rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4 ${CARD_VIS}`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-[var(--text-primary)]">
            {group.tag}
          </p>
          <p className="text-xs text-[var(--text-muted)]">
            {group.count} images
          </p>
        </div>
        <span className="rounded-md bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
          Sref
        </span>
      </div>
      <button
        type="button"
        onClick={() => onImport(group)}
        disabled={importing}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--accent-primary)] px-3 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {importing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5" />
        )}
        Import
      </button>
    </div>
  );
}

function ShowMore({
  shown,
  total,
  onMore,
  testId,
}: {
  shown: number;
  total: number;
  onMore: () => void;
  testId: string;
}) {
  if (shown >= total) return null;
  return (
    <div className="mt-4 flex justify-center">
      <button
        type="button"
        onClick={onMore}
        data-testid={testId}
        className="min-h-10 rounded-lg border border-[var(--border-primary)] px-4 py-2 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
      >
        Show more ({total - shown} left)
      </button>
    </div>
  );
}

function CardGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className="overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)]"
        >
          <Skeleton className="aspect-square w-full" rounded="xl" />
          <div className="space-y-2 p-3">
            <Skeleton className="h-3 w-3/4" rounded="md" />
            <Skeleton className="h-3 w-1/2" rounded="md" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function StyleLibraryPage({
  initialBoards = [],
  initialKreaSources = [],
  initialSvGroups,
  initialSvOffline = false,
  embedded = false,
  query: externalQuery,
}: {
  initialBoards?: Moodboard[];
  initialKreaSources?: KreaSourceBoard[];
  initialSvGroups?: SvSrefGroup[];
  initialSvOffline?: boolean;
  /** Rendered as the Collections section of the Styles page. */
  embedded?: boolean;
  /** Controlled search (the Styles page owns the search box). */
  query?: string;
}) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [ownQuery, setQuery] = useState("");
  const query = externalQuery ?? ownQuery;
  const [boards, setBoards] = useState<Moodboard[]>(initialBoards);
  const [loadingBoards, setLoadingBoards] = useState(false);
  const [kreaSources, setKreaSources] = useState<KreaSourceBoard[]>(initialKreaSources);
  const [kreaImporting, setKreaImporting] = useState<string | null>(null);
  const [svGroups, setSvGroups] = useState<SvSrefGroup[] | null>(
    initialSvGroups ?? null,
  );
  const [svOffline, setSvOffline] = useState(initialSvOffline);
  const [loadingSv, setLoadingSv] = useState(initialSvGroups === undefined);
  const [svImporting, setSvImporting] = useState<string | null>(null);

  const refreshBoards = useCallback(async () => {
    setLoadingBoards(true);
    try {
      const res = await listMoodboards();
      if (!res.ok) {
        showToast(res.error ?? "Could not load library.", "error");
        return;
      }
      setBoards(res.moodboards);
    } catch {
      showToast("Could not load library.", "error");
    } finally {
      setLoadingBoards(false);
    }
  }, []);

  const refreshSvGroups = useCallback(async () => {
    setLoadingSv(true);
    try {
      setSvGroups(await listSvSrefGroups(4));
      setSvOffline(false);
    } catch {
      setSvGroups([]);
      setSvOffline(true);
    } finally {
      setLoadingSv(false);
    }
  }, []);

  useEffect(() => {
    void refreshBoards();
    // StyleVault sref groups belong to the style-code system.
    if (STYLE_CODES_ENABLED) void refreshSvGroups();
  }, [refreshBoards, refreshSvGroups]);

  const [boardLimit, setBoardLimit] = useState(LIBRARY_PAGE);
  const [groupLimit, setGroupLimit] = useState(LIBRARY_PAGE);
  const [kreaLimit, setKreaLimit] = useState(LIBRARY_PAGE);
  useEffect(() => {
    setBoardLimit(LIBRARY_PAGE);
    setGroupLimit(LIBRARY_PAGE);
    setKreaLimit(LIBRARY_PAGE);
  }, [filter, query]);

  const visibleBoards = useMemo(
    () =>
      boards.filter(
        (board) => boardMatchesFilter(board, filter) && matchesQuery(board.name, query),
      ),
    [boards, filter, query],
  );

  // Krea sources come only from the caller: /api/moodboards/krea serves
  // single images and has no listing.
  const visibleKreaSources = useMemo(() => {
    const imported = new Set(boards.filter(isKreaImported).map((b) => b.name));
    return kreaSources.filter(
      (source) => !imported.has(source.name) && matchesQuery(source.name, query),
    );
  }, [boards, kreaSources, query]);

  const visibleSvGroups = useMemo(
    () =>
      (svGroups ?? []).filter(
        (group) =>
          matchesQuery(group.tag, query) ||
          matchesQuery(group.sref, query) ||
          matchesQuery(`sref ${group.sref}`, query),
      ),
    [svGroups, query],
  );

  const showLocal = filter !== "mj";
  const showKrea =
    (filter === "all" || filter === "krea") && visibleKreaSources.length > 0;
  const showMj = STYLE_CODES_ENABLED && (filter === "all" || filter === "mj");

  const handleKreaImport = useCallback(
    async (source: KreaSourceBoard) => {
      setKreaImporting(source.id);
      try {
        const res = await createMoodboard({
          name: source.name,
          description: source.description,
          images: source.images,
          kind: "moodboard",
        });
        if (!res.ok || !res.moodboard) {
          showToast(res.error ?? "Import failed.", "error");
          return;
        }
        showToast(`Imported "${res.moodboard.name}"`, "success");
        setKreaSources((current) => current.filter((item) => item.id !== source.id));
        await refreshBoards();
      } catch {
        showToast("Import failed.", "error");
      } finally {
        setKreaImporting(null);
      }
    },
    [refreshBoards],
  );

  const handleSvImport = useCallback(
    async (group: SvSrefGroup) => {
      setSvImporting(group.tag);
      try {
        const res = await importSvTag({ tag: group.tag, kind: "style" });
        if (!res.ok || !res.moodboard) {
          showToast(res.error ?? "Import failed.", "error");
          return;
        }
        showToast(
          `Imported ${res.imported ?? 0}/${res.libraryCount ?? group.count} images as "${res.moodboard.name}"`,
          "success",
        );
        await refreshBoards();
      } catch {
        showToast("Import failed.", "error");
      } finally {
        setSvImporting(null);
      }
    },
    [refreshBoards],
  );

  const filterChips = (
    <div className="flex flex-wrap gap-2">
      {FILTERS.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => setFilter(item.key)}
          className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:px-4 ${
            filter === item.key
              ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white"
              : "border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--text-primary)]"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );

  const body = (
        <div className="space-y-8">
          {showLocal && (
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  {embedded ? "Boards" : "Collections"}
                </h2>
                <span className="text-xs text-[var(--text-muted)]">
                  {visibleBoards.length} boards
                </span>
              </div>
              {loadingBoards ? (
                <CardGridSkeleton />
              ) : visibleBoards.length > 0 ? (
                <>
                  <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                    {visibleBoards.slice(0, boardLimit).map((board) => (
                      <LocalBoardCard key={board.id} board={board} />
                    ))}
                  </div>
                  <ShowMore
                    shown={boardLimit}
                    total={visibleBoards.length}
                    onMore={() => setBoardLimit((n) => n + LIBRARY_PAGE)}
                    testId="style-library-more-boards"
                  />
                </>
              ) : (
                <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--border-primary)] py-16 text-center">
                  <ImageIcon className="mb-3 h-8 w-8 text-[var(--text-muted)]" />
                  <p className="text-sm font-medium text-[var(--text-primary)]">
                    No collections match this view
                  </p>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    Create a moodboard on the Moodboards page, or browse style LoRAs in Explore → Styles.
                  </p>
                </div>
              )}
            </section>
          )}

          {showKrea && (
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  Krea (not imported)
                </h2>
                <span className="text-xs text-[var(--text-muted)]">
                  {visibleKreaSources.length} boards
                </span>
              </div>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {visibleKreaSources.slice(0, kreaLimit).map((source) => (
                  <KreaSourceCard
                    key={source.id}
                    board={source}
                    importing={kreaImporting === source.id}
                    onImport={handleKreaImport}
                  />
                ))}
              </div>
              <ShowMore
                shown={kreaLimit}
                total={visibleKreaSources.length}
                onMore={() => setKreaLimit((n) => n + LIBRARY_PAGE)}
                testId="style-library-more-krea"
              />
            </section>
          )}

          {showMj && (
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  Styles
                </h2>
                <span className="text-xs text-[var(--text-muted)]">
                  {visibleSvGroups.length} groups
                </span>
              </div>
              {loadingSv ? (
                <CardGridSkeleton count={4} />
              ) : svOffline ? (
                // StyleVault is optional: say so in one line, not as an error.
                <p
                  className="rounded-xl border border-dashed border-[var(--border-primary)] px-4 py-4 text-sm text-[var(--text-muted)]"
                  data-testid="style-library-sv-offline"
                >
                  Style collections appear here when StyleVault is running.{" "}
                  <button
                    type="button"
                    onClick={() => void refreshSvGroups()}
                    className="font-medium text-[var(--text-secondary)] underline underline-offset-2 hover:text-[var(--text-primary)]"
                  >
                    Check again
                  </button>
                </p>
              ) : visibleSvGroups.length === 0 ? (
                <p className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-4 py-6 text-sm text-[var(--text-muted)]">
                  No style collections yet
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {visibleSvGroups.slice(0, groupLimit).map((group) => (
                      <MjGroupCard
                        key={group.tag}
                        group={group}
                        importing={svImporting === group.tag}
                        onImport={handleSvImport}
                      />
                    ))}
                  </div>
                  <ShowMore
                    shown={groupLimit}
                    total={visibleSvGroups.length}
                    onMore={() => setGroupLimit((n) => n + LIBRARY_PAGE)}
                    testId="style-library-more-groups"
                  />
                </>
              )}
            </section>
          )}
        </div>
  );

  if (embedded) {
    return (
      <div className="space-y-4" data-testid="style-library-embedded">
        {filterChips}
        {body}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex-shrink-0 border-b border-[var(--border-primary)] px-6 py-4">
        <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-semibold text-[var(--text-primary)]">
              Library
            </h1>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              Moodboards, characters, style datasets, Krea boards, and styles.
            </p>
          </div>
          <div className="relative w-full md:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              aria-label="Filter by name"
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by name..."
              className="input w-full pl-9 text-sm"
            />
          </div>
        </div>
        {filterChips}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{body}</div>
    </div>
  );
}

export default StyleLibraryPage;

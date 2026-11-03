"use client";

import { useMemo, useState } from "react";
import { ImageIcon, Search, X } from "lucide-react";
import { useGenerationStore } from "@/store";
import {
  collectEditorUploads,
  selectEditorGenerations,
  type EditorGenerationFilter,
} from "./editorStartScreen";

const UPLOADS_PREVIEW = 12;
const GENERATIONS_PAGE = 24;

// 3-up on phones, widening to 6-up on desktop.
const GRID_CLASS =
  "grid grid-cols-3 gap-1.5 sm:grid-cols-4 sm:gap-2 lg:grid-cols-6";

interface EditorImagePickerProps {
  onSelect: (url: string, id?: string) => void;
}

function PickerTile({
  url,
  label,
  onPick,
}: {
  url: string;
  label: string;
  onPick: () => void;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <button
      type="button"
      onClick={onPick}
      title={label}
      aria-label={`Edit image: ${label}`}
      className="group relative aspect-square w-full overflow-hidden rounded-lg bg-[var(--bg-tertiary)] outline-none ring-[var(--accent-primary)] transition focus-visible:ring-2 hover:ring-2"
    >
      {failed ? (
        <span className="flex h-full w-full items-center justify-center">
          <ImageIcon className="h-6 w-6 text-[var(--text-tertiary)]" />
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
        />
      )}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-6 text-left text-xs font-medium text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
        Edit
      </span>
    </button>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-medium text-[var(--text-primary)]">
      {children}
    </h2>
  );
}

export function EditorImagePicker({ onSelect }: EditorImagePickerProps) {
  const gallery = useGenerationStore((s) => s.gallery);
  const [filter, setFilter] = useState<EditorGenerationFilter>("all");
  const [query, setQuery] = useState("");
  const [visibleGenerations, setVisibleGenerations] =
    useState(GENERATIONS_PAGE);
  const [showAllUploads, setShowAllUploads] = useState(false);

  const uploads = useMemo(() => collectEditorUploads(gallery), [gallery]);
  const generations = useMemo(
    () => selectEditorGenerations(gallery, { filter, query }),
    [gallery, filter, query],
  );

  const shownUploads = showAllUploads
    ? uploads
    : uploads.slice(0, UPLOADS_PREVIEW);
  const shownGenerations = generations.slice(0, visibleGenerations);

  const changeFilter = (next: EditorGenerationFilter) => {
    setFilter(next);
    setVisibleGenerations(GENERATIONS_PAGE);
  };

  let emptyMessage =
    "Nothing generated yet. Images you create will show up here.";
  if (query.trim()) {
    emptyMessage = `No prompts match "${query.trim()}".`;
  } else if (filter === "liked") {
    emptyMessage =
      "No liked images yet. Heart an image in your gallery to pin it here.";
  }

  return (
    <div className="space-y-10" data-testid="editor-image-picker">
      {uploads.length > 0 && (
        <section aria-labelledby="editor-uploads-heading" className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <SectionHeading>
              <span id="editor-uploads-heading">Your uploads</span>
            </SectionHeading>
            {uploads.length > UPLOADS_PREVIEW && (
              <button
                type="button"
                onClick={() => setShowAllUploads((v) => !v)}
                className="text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
              >
                {showAllUploads ? "Show less" : `Show all ${uploads.length}`}
              </button>
            )}
          </div>
          <div className={GRID_CLASS}>
            {shownUploads.map((upload) => (
              <PickerTile
                key={upload.url}
                url={upload.url}
                label={upload.label}
                onPick={() => onSelect(upload.url)}
              />
            ))}
          </div>
        </section>
      )}

      <section
        aria-labelledby="editor-generations-heading"
        className="space-y-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionHeading>
            <span id="editor-generations-heading">Recent generations</span>
          </SectionHeading>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <div
              role="radiogroup"
              aria-label="Filter generations"
              className="flex shrink-0 items-center gap-1"
            >
              {(["all", "liked"] as const).map((value) => {
                const active = filter === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => changeFilter(value)}
                    className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                      active
                        ? "bg-[var(--accent-primary)] text-white"
                        : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {value === "all" ? "All" : "Liked"}
                  </button>
                );
              })}
            </div>
            <label className="relative flex min-w-0 flex-1 items-center sm:w-64 sm:flex-none">
              <span className="sr-only">Search your prompts</span>
              <Search className="pointer-events-none absolute left-3 h-4 w-4 text-[var(--text-tertiary)]" />
              <input
                type="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setVisibleGenerations(GENERATIONS_PAGE);
                }}
                placeholder="Search your prompts"
                className="w-full rounded-full border border-[var(--border-primary)] bg-[var(--bg-secondary)] py-2 pl-9 pr-8 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none transition-colors focus:border-[var(--border-accent)] [&::-webkit-search-cancel-button]:hidden"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                  className="absolute right-2 rounded-full p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </label>
          </div>
        </div>

        {shownGenerations.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[var(--border-primary)] px-4 py-8 text-center text-sm text-[var(--text-muted)]">
            {emptyMessage}
          </p>
        ) : (
          <div className={GRID_CLASS}>
            {shownGenerations.map((image) => (
              <PickerTile
                key={image.id}
                url={image.url}
                label={image.prompt || "Generated image"}
                onPick={() => onSelect(image.url, image.id)}
              />
            ))}
          </div>
        )}

        {generations.length > shownGenerations.length && (
          <div className="flex justify-center pt-2">
            <button
              type="button"
              onClick={() => setVisibleGenerations((n) => n + GENERATIONS_PAGE)}
              className="rounded-full border border-[var(--border-primary)] px-4 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              Load more
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

export default EditorImagePicker;

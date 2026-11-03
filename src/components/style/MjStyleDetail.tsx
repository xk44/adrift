"use client";

import { useCallback, useState } from "react";
import { Copy, Heart, Search, Wand2, X } from "lucide-react";
import { useUIStore } from "@/store";

export const STYLE_SUBJECTS = [
  "portrait",
  "landscape",
  "still_life",
  "hot_cup_of_coffee",
  "tree",
  "house",
  "animal",
  "street_scene",
] as const;

export interface MjStyleRecord {
  code: string;
  width: number | null;
  height: number | null;
  prompt: string;
  liked: boolean;
  feeds: string[];
  previewUrl: string;
}

interface MjStyleDetailProps {
  record: MjStyleRecord;
  onClose: () => void;
  onSearch?: (query: string) => void;
  /** Images to show instead of the catalog subject renders (saved codes). */
  images?: { src: string; label: string }[];
  /** Extra actions (Styles page: save, favorite, remix, blend, delete). */
  actions?: React.ReactNode;
  /** Optional name shown under the code. */
  subtitle?: string;
}

function subjectLabel(subject: string): string {
  return subject.replaceAll("_", " ");
}

function imageUrl(code: string, subject: string): string {
  return `/api/style-catalog?code=${encodeURIComponent(code)}&subject=${encodeURIComponent(subject)}`;
}

export function MjStyleDetail({
  record,
  onClose,
  onSearch,
  images,
  actions,
  subtitle,
}: MjStyleDetailProps) {
  const appendToPrompt = useUIStore((s) => s.appendToPrompt);
  const setActiveNav = useUIStore((s) => s.setActiveNav);
  const [liked, setLiked] = useState(record.liked);
  const [copied, setCopied] = useState(false);

  const sref = `--sref ${record.code}`;
  const tiles =
    images && images.length > 0
      ? images
      : STYLE_SUBJECTS.map((subject) => ({
          src: imageUrl(record.code, subject),
          label: subjectLabel(subject),
        }));

  const copy = useCallback(() => {
    navigator.clipboard?.writeText(sref).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }, [sref]);

  const tryStyle = useCallback(() => {
    appendToPrompt(sref);
    setActiveNav("create");
  }, [appendToPrompt, setActiveNav, sref]);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm">
      <div className="absolute inset-x-0 bottom-0 top-10 mx-auto flex max-w-[1280px] flex-col overflow-hidden rounded-t-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] shadow-2xl sm:inset-y-6 sm:rounded-lg">
        <header className="flex items-start justify-between gap-4 border-b border-[var(--border-primary)] px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h2 className="truncate font-mono text-lg font-semibold text-[var(--text-primary)]">
              {sref}
            </h2>
            {subtitle && (
              <p className="mt-0.5 truncate text-sm text-[var(--text-secondary)]">
                {subtitle}
              </p>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
              {record.width && record.height && (
                <span>
                  {record.width} x {record.height}
                </span>
              )}
              {record.feeds.map((feed) => (
                <span
                  key={feed}
                  className="rounded border border-[var(--border-primary)] px-1.5 py-0.5"
                >
                  {feed}
                </span>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {tiles.map((tile) => (
              <figure
                key={tile.src}
                className="overflow-hidden rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)]"
              >
                <div className="aspect-square bg-[var(--bg-tertiary)]">
                  <img
                    src={tile.src}
                    alt={`${sref} ${tile.label}`}
                    className="h-full w-full object-cover"
                    loading="lazy"
                    decoding="async"
                  />
                </div>
                <figcaption className="truncate px-2 py-1.5 text-xs capitalize text-[var(--text-muted)]">
                  {tile.label}
                </figcaption>
              </figure>
            ))}
          </div>

          {record.prompt && (
            <div className="mt-4 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3">
              <p className="text-sm leading-6 text-[var(--text-secondary)]">
                {record.prompt}
              </p>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-primary)] bg-[var(--bg-primary)] px-4 py-3 sm:px-5">
          <button
            type="button"
            onClick={tryStyle}
            className="inline-flex h-9 items-center gap-2 rounded-full bg-white px-4 text-sm font-semibold text-black transition-opacity hover:opacity-80"
          >
            <Wand2 className="h-4 w-4" />
            Try Style
          </button>
          <div className="flex flex-wrap items-center gap-2">
            {actions}
            <button
              type="button"
              onClick={copy}
              className="inline-flex h-9 items-center gap-2 rounded-full border border-[var(--border-primary)] px-3 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <Copy className="h-4 w-4" />
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              onClick={() => onSearch?.(record.code)}
              className="inline-flex h-9 items-center gap-2 rounded-full border border-[var(--border-primary)] px-3 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <Search className="h-4 w-4" />
              Search
            </button>
            <button
              type="button"
              onClick={() => setLiked((value) => !value)}
              className="inline-flex h-9 items-center gap-2 rounded-full border border-[var(--border-primary)] px-3 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <Heart
                className={`h-4 w-4 ${liked ? "fill-rose-500 text-rose-500" : ""}`}
              />
              Like
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default MjStyleDetail;

"use client";

import { Heart, Type } from "lucide-react";

/** Author/source caption for an Explore card: the creator's handle, else the source. */
export function exploreCardAuthor(
  username: string | null | undefined,
  source = "Civitai",
): string {
  const handle = username?.trim();
  return handle ? handle : source;
}

interface ExploreCardOverlayProps {
  /** Touch devices: keep the overlay shown after a tap. */
  revealed: boolean;
  author: string;
  prompt?: string;
  liked: boolean;
  onToggleLike: () => void;
  /** Omitted when the card has no prompt to reuse. */
  onUsePrompt?: () => void;
}

const ICON_BUTTON =
  "w-8 h-8 rounded-md flex items-center justify-center text-white/90 hover:text-white hover:bg-white/15 transition-colors";

/**
 * Hover overlay shared by Explore image cards: bottom gradient with the
 * author/source on the left, a one-line prompt above, and icon actions
 * (use prompt, like) on the right. The parent card must carry the
 * `group/exploreCard` class.
 */
export function ExploreCardOverlay({
  revealed,
  author,
  prompt,
  liked,
  onToggleLike,
  onUsePrompt,
}: ExploreCardOverlayProps) {
  return (
    <div
      className={`pointer-events-none absolute inset-0 flex items-end transition-opacity duration-200 ${
        revealed
          ? "opacity-100"
          : "opacity-0 group-hover/exploreCard:opacity-100 group-focus-within/exploreCard:opacity-100"
      }`}
    >
      <div className="absolute inset-x-0 bottom-0 h-40 max-h-full bg-gradient-to-t from-black/80 via-black/35 to-transparent" />
      <div
        className="relative w-full min-w-0 px-3 pb-2.5 pointer-events-auto"
        onTouchStart={(e) => e.stopPropagation()}
      >
        {prompt && (
          <p className="mb-1 truncate text-xs text-white/85" title={prompt}>
            {prompt}
          </p>
        )}
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex-1 min-w-0 truncate text-sm font-medium text-white">
            {author}
          </span>
          <div className="flex items-center gap-0.5 shrink-0">
            {onUsePrompt && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onUsePrompt();
                }}
                className={ICON_BUTTON}
                title="Use prompt"
                aria-label="Use prompt"
              >
                <Type className="w-4 h-4" />
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleLike();
              }}
              className={ICON_BUTTON}
              title={liked ? "Unlike" : "Like"}
              aria-label={liked ? "Unlike" : "Like"}
              aria-pressed={liked}
            >
              <Heart
                className={`w-4 h-4 ${liked ? "fill-rose-400 text-rose-400" : ""}`}
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

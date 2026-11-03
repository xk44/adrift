"use client";

import { ArrowUpRight, Wrench } from "lucide-react";
import type { RunProvenance } from "@/lib/runProvenance";

/**
 * "Made with" chip for Create-feed runs that came from a tool or image action.
 *   meta    — List view meta column, styled like the param chips beside it.
 *   overlay — Grid / Thumbnails hover gradient, styled like the caption chips.
 * `onOpenSource` is set whenever the run names a source run (the feed opens
 * it from loaded history or fetches it by id); without it the "from ↗" link
 * is hidden. `toolHref` + `onOpenTool` (lightbox) turn the label into a link
 * to the Tools page card that made the run.
 */
export function ProvenanceChip({
  provenance,
  tone,
  onOpenSource,
  compact = false,
  linkClassName = "",
  toolHref,
  onOpenTool,
}: {
  provenance: RunProvenance;
  tone: "meta" | "overlay";
  onOpenSource?: () => void;
  /** Thumbnails: icon-only source link. */
  compact?: boolean;
  /** Extra classes for the source link (wall views gate pointer events). */
  linkClassName?: string;
  /** Tools page URL of the card that made the run (lightbox). */
  toolHref?: string;
  /** In-app open for `toolHref` (plain clicks; modified clicks follow the URL). */
  onOpenTool?: () => void;
}) {
  const chipClass =
    tone === "meta"
      ? "chip chip-accent text-xs max-w-full"
      : "inline-flex items-center gap-1 h-5 px-1.5 max-w-full rounded bg-[var(--accent-primary)]/70 text-white text-[10px] leading-5 whitespace-nowrap backdrop-blur-sm";
  const content = (
    <>
      <Wrench
        className={
          tone === "meta" ? "w-3 h-3 shrink-0" : "w-2.5 h-2.5 shrink-0"
        }
        aria-hidden="true"
      />
      <span className="truncate">{provenance.label}</span>
    </>
  );
  const label = toolHref ? (
    <a
      href={toolHref}
      className={`${chipClass} cursor-pointer hover:brightness-110 transition-[filter]`}
      title={`Made with ${provenance.label}: open in Tools`}
      onClick={(e) => {
        e.stopPropagation();
        if (
          !onOpenTool ||
          e.button !== 0 ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey
        )
          return;
        e.preventDefault();
        onOpenTool();
      }}
    >
      {content}
    </a>
  ) : (
    <span className={chipClass} title={`Made with ${provenance.label}`}>
      {content}
    </span>
  );
  if (!onOpenSource) return label;
  return (
    <>
      {label}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpenSource();
        }}
        onTouchStart={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className={
          tone === "meta"
            ? `chip text-xs hover:bg-[var(--accent-primary)]/20 hover:border-[var(--accent-primary)]/50 hover:text-[var(--accent-primary)] transition-colors cursor-pointer ${linkClassName}`
            : `inline-flex items-center gap-0.5 h-5 px-1.5 rounded bg-white/15 text-white text-[10px] leading-5 whitespace-nowrap backdrop-blur-sm hover:bg-white/30 transition-colors ${linkClassName}`
        }
        title="Open the image this was made from"
        aria-label="Open the image this was made from"
      >
        {!compact && "from"}
        <ArrowUpRight
          className={tone === "meta" ? "w-3 h-3" : "w-2.5 h-2.5"}
          aria-hidden="true"
        />
      </button>
    </>
  );
}

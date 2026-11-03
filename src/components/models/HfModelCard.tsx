"use client";

import { Download, ExternalLink, Heart, Lock } from "lucide-react";
import {
  hfBaseModel,
  hfDisplayTags,
  hfTaskLabel,
  type HfModelSummary,
} from "@/lib/hfModels";
import { isHfUpscalerRepo } from "@/lib/hfUpscalers";
import { HfUpscalerDownload } from "./HfUpscalerDownload";
import type { BackendProfile } from "@/lib/models/compat";
import { compatChip, hfModelCompat } from "@/lib/models/exploreCompat";
import { BestQuantBadge, CompatChip } from "./CompatChip";

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function relativeDate(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * Hugging Face result card. The Hub has no reliable preview image, so the
 * cover is typographic: the repo name set large over a quiet tinted field
 * keyed off the task, instead of scraping model cards for pictures.
 */
export function HfModelCard({
  model,
  profile = null,
}: {
  model: HfModelSummary;
  /** Connected GPU profile; null hides the compat chip / quant badge. */
  profile?: BackendProfile | null;
}) {
  const compat = profile ? hfModelCompat(model, profile) : null;
  const chip = compatChip(compat, profile);
  const tags = hfDisplayTags(model, 3);
  const base = hfBaseModel(model);
  const updated = relativeDate(model.lastModified);
  // Upscaler repos get a Download panel; it sits outside the link so its
  // buttons aren't nested in an <a>.
  const upscaler = isHfUpscalerRepo(model) && !model.gated;

  const card = (
    <a
      href={model.url}
      target="_blank"
      rel="noopener noreferrer"
      className={
        upscaler
          ? "group/hfCard block focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-primary)]"
          : "group/hfCard block overflow-hidden rounded-sm border border-[var(--border-primary)] bg-[var(--bg-secondary)] transition-colors hover:border-[var(--border-secondary)] focus:outline-none focus-visible:border-[var(--accent-primary)]"
      }
      aria-label={`${model.id} on Hugging Face`}
    >
      <div
        className="relative flex w-full flex-col justify-end overflow-hidden bg-[var(--bg-tertiary)] p-4"
        style={{ aspectRatio: "4 / 3" }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute -right-3 -top-6 select-none text-[120px] font-semibold leading-none tracking-tight text-[var(--text-primary)] opacity-[0.04]"
        >
          {model.name.slice(0, 2)}
        </span>
        {model.pipelineTag && (
          <div className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-1 text-[10px] font-medium text-white backdrop-blur-sm">
            {hfTaskLabel(model.pipelineTag)}
          </div>
        )}
        <div className="absolute right-2 top-2 flex gap-1">
          {model.gated && (
            <span
              className="flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[10px] font-medium text-white backdrop-blur-sm"
              title="Gated — accept the license on Hugging Face first"
            >
              <Lock className="h-3 w-3" /> Gated
            </span>
          )}
          {model.adult && (
            <span className="rounded-full bg-rose-500/70 px-2 py-1 text-[10px] font-medium text-white backdrop-blur-sm">
              18+
            </span>
          )}
        </div>
        <p className="truncate text-xs text-[var(--text-muted)]">
          {model.author ?? "huggingface"}
        </p>
        <h3
          className="line-clamp-2 break-words text-lg font-semibold leading-snug tracking-tight text-[var(--text-primary)]"
          title={model.id}
        >
          {model.name}
        </h3>
      </div>

      <div className="space-y-2 p-3">
        <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Download className="h-3.5 w-3.5" />
            {compact(model.downloads)}
          </span>
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Heart className="h-3.5 w-3.5" />
            {compact(model.likes)}
          </span>
          {updated && <span className="truncate">Updated {updated}</span>}
          <CompatChip chip={chip} />
          <BestQuantBadge
            label={compat?.bestQuantLabel ?? null}
            all={compat?.quantLabels ?? []}
          />
          <ExternalLink className="ml-auto h-3.5 w-3.5 opacity-0 transition-opacity group-hover/hfCard:opacity-100" />
        </div>
        {base && (
          <p
            className="truncate text-[11px] text-[var(--text-muted)]"
            title={base}
          >
            Base: <span className="text-[var(--text-secondary)]">{base}</span>
          </p>
        )}
        {(model.library || tags.length > 0) && (
          <div className="flex flex-wrap gap-1">
            {model.library && (
              <span className="rounded-full border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
                {model.library}
              </span>
            )}
            {tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-[var(--border-primary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </a>
  );

  if (!upscaler) return card;
  return (
    <div className="overflow-hidden rounded-sm border border-[var(--border-primary)] bg-[var(--bg-secondary)] transition-colors hover:border-[var(--border-secondary)]">
      {card}
      <div className="border-t border-[var(--border-primary)] px-3 py-2">
        <HfUpscalerDownload repo={model.id} />
      </div>
    </div>
  );
}

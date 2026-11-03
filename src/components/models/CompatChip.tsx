"use client";

import type { ChipTone, CompatChip as Chip } from "@/lib/models/exploreCompat";

const TONE: Record<ChipTone, string> = {
  good: "bg-emerald-500/10 text-emerald-400",
  warn: "bg-amber-500/10 text-amber-400",
  bad: "bg-red-500/10 text-red-400",
};

/** Small "Fits" / "Tight" / "Too big for 24 GB" chip; renders nothing for null. */
export function CompatChip({ chip }: { chip: Chip | null }) {
  if (!chip) return null;
  return (
    <span
      data-testid="compat-chip"
      title={chip.title}
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${TONE[chip.tone]}`}
    >
      {chip.label}
    </span>
  );
}

/**
 * "Best: Q6_K" badge for versions / repos that offer several quants. When
 * no size is known (Hugging Face lists) or nothing runs, it just counts them.
 */
export function BestQuantBadge({
  label,
  all,
}: {
  label: string | null;
  all: string[];
}) {
  if (!label && all.length < 2) return null;
  return (
    <span
      data-testid="best-quant"
      title={
        label
          ? `Best quality that runs on your GPU. Offered: ${all.join(", ")}.`
          : `Offered: ${all.join(", ")}.`
      }
      className="shrink-0 rounded bg-[color-mix(in_srgb,var(--accent-primary)_14%,transparent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent-primary)]"
    >
      {label
        ? `Best: ${label}`
        : `${all.length} ${all.some((l) => /^I?Q\d/.test(l)) ? "quants" : "formats"}`}
    </span>
  );
}

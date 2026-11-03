"use client";

import { useCallback, useEffect, useState } from "react";
import type { HubCard } from "@/lib/tools/hub";
import {
  WEIGHTS_LABEL,
  readOpenWeightsOnly,
  weightsClass,
  weightsTooltip,
  writeOpenWeightsOnly,
} from "@/lib/tools/openWeights";
import type { LicenseBadge } from "@/lib/tools/licenseBadges";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Persisted "Commercial use OK" toggle (read after mount: SSR-safe). */
export function useOpenWeightsOnly(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    setOn(readOpenWeightsOnly(storage()));
  }, []);
  const set = useCallback((next: boolean) => {
    setOn(next);
    writeOpenWeightsOnly(storage(), next);
  }, []);
  return [on, set];
}

export function OpenWeightsToggle({
  on,
  onChange,
  summary,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  summary: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        data-testid="tools-open-weights-only"
        title={`Every tool runs on open weights in your own ComfyUI. This shows only tools whose models allow commercial use (Open, and Revenue cap under its threshold); it hides Non-commercial, Region-limited and Check license tools. ${summary}.`}
        className="flex h-7 items-center gap-2 rounded-full pl-1 pr-3 text-xs font-medium text-light-primary transition-[background-color,transform] duration-150 hover:bg-light-input active:scale-[0.96] focus:outline-none focus-visible:ring-2 focus-visible:ring-splash dark:text-dark-primary dark:hover:bg-dark-input"
      >
        <span
          aria-hidden
          className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors duration-150 ${
            on ? "bg-splash" : "bg-light-300 dark:bg-dark-300"
          }`}
        >
          <span
            className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-150 ${
              on ? "translate-x-[18px]" : "translate-x-0.5"
            }`}
          />
        </span>
        Commercial use OK
      </button>
      {/* Count lives in the tooltip; the header already has one stat line. */}
      <span className="sr-only" data-testid="tools-open-weights-count">
        {summary}
      </span>
    </div>
  );
}

/** Dot colour per badge; the chip itself is one neutral style for all. */
export const BADGE_DOT: Record<LicenseBadge, string> = {
  open: "bg-emerald-500 dark:bg-emerald-400",
  cap: "bg-sky-500 dark:bg-sky-400",
  nc: "bg-amber-500 dark:bg-amber-400",
  region: "bg-rose-500 dark:bg-rose-400",
  check: "bg-light-400 dark:bg-dark-300",
};

/**
 * Per-card license chip: Open / Revenue cap / Non-commercial /
 * Region-limited / Check license. The tooltip states the terms and the
 * license URL (the chip sits inside the card button, so no nested link;
 * the runner shows clickable links).
 */
export function WeightsChip({
  card,
  title,
}: {
  card: HubCard;
  /** Overrides the badge tooltip. */
  title?: string | null;
}) {
  if (card.kind === "placeholder") return null;
  const cls = weightsClass(card);
  return (
    <span
      title={title || weightsTooltip(card)}
      data-testid={`tool-weights-${card.key}`}
      data-weights={cls}
      className="inline-flex h-5 min-w-0 items-center gap-1 rounded-full px-1.5 text-[10px] font-medium leading-none text-light-500 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)] dark:text-dark-400 dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]"
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${BADGE_DOT[cls]}`}
      />
      <span className="truncate">{WEIGHTS_LABEL[cls]}</span>
    </span>
  );
}

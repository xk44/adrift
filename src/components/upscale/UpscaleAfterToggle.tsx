"use client";

/**
 * Runner control: queue an upscale of this run's result when it finishes.
 * Controlled; the runner seeds it from the Settings default.
 */

import {
  upscaleAfterFactors,
  type UpscaleAfterChoice,
  type UpscaleAfterMedia,
} from "@/lib/upscale/upscaleAfter";

export function UpscaleAfterToggle({
  media,
  value,
  onChange,
  overridden = false,
  onReset,
  disabled = false,
}: {
  media: UpscaleAfterMedia;
  value: UpscaleAfterChoice;
  onChange: (next: UpscaleAfterChoice) => void;
  /** Differs from the Settings default (offers a reset). */
  overridden?: boolean;
  onReset?: () => void;
  disabled?: boolean;
}) {
  const factors = upscaleAfterFactors(media);
  const { on, factor } = value;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
      data-testid="upscale-after"
    >
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={disabled}
        onClick={() => onChange({ on: !on, factor })}
        className="flex items-center gap-2 rounded-lg text-xs text-[var(--text-secondary)] focus:outline-none focus-visible:ring-1 focus-visible:ring-splash disabled:opacity-50"
      >
        <span
          aria-hidden
          className={`relative h-4 w-7 flex-shrink-0 rounded-full transition-colors duration-200 ${
            on ? "bg-splash" : "bg-light-200 dark:bg-dark-600"
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-200 ${
              on ? "translate-x-3" : ""
            }`}
          />
        </span>
        Upscale after
      </button>
      {factors.length > 1 ? (
        <div
          role="radiogroup"
          aria-label="Upscale after size"
          className="inline-flex rounded-lg border border-[var(--border-secondary)] p-0.5"
        >
          {factors.map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={factor === f}
              disabled={disabled || !on}
              onClick={() => onChange({ on, factor: f })}
              className={`rounded-md px-2 py-0.5 text-[11px] tabular-nums transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-splash disabled:opacity-50 ${
                factor === f
                  ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              }`}
            >
              {f}×
            </button>
          ))}
        </div>
      ) : (
        on && (
          <span className="text-[11px] tabular-nums text-[var(--text-muted)]">
            {factors[0]}×
          </span>
        )
      )}
      {overridden && onReset && (
        <button
          type="button"
          onClick={onReset}
          disabled={disabled}
          title="Back to the Settings default"
          className="rounded text-[11px] text-[var(--text-muted)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-splash disabled:opacity-50"
        >
          Use default
        </button>
      )}
    </div>
  );
}

"use client";

import type { MediaVariant } from "@/lib/tools/toolRegistry";

/**
 * Photo / Video switch for a tool that has one runner per input kind
 * (lib/tools/toolRegistry.ts MEDIA_VARIANT_GROUPS). Picking a variant opens
 * that variant's card in place.
 */
export function MediaVariantSwitch({
  variants,
  active,
  onPick,
}: {
  variants: readonly MediaVariant[];
  active: string;
  onPick: (id: string) => void;
}) {
  return (
    <div className="flex-shrink-0 px-4 pt-3 sm:px-6">
      <div
        role="radiogroup"
        aria-label="Input"
        className="inline-flex rounded-full p-0.5 ring-1 ring-[var(--border-primary)]"
      >
        {variants.map((v) => {
          const on = v.id === active;
          return (
            <button
              key={v.id}
              type="button"
              role="radio"
              aria-checked={on}
              data-testid={`media-variant-${v.id}`}
              onClick={() => {
                if (!on) onPick(v.id);
              }}
              className={`h-8 rounded-full px-4 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] ${
                on
                  ? "bg-[var(--accent-primary)] text-white"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
              }`}
            >
              {v.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

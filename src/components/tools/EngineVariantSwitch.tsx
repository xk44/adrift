"use client";

import type { EngineOption } from "@/lib/tools/engineGroups";
import { setupHint } from "@/lib/tools/setupHint";
import { BADGE_LABEL } from "@/lib/tools/licenseBadges";
import { BADGE_DOT } from "./OpenWeightsFilter";

/**
 * Engine picker for a merged tool card (lib/tools/engineGroups.ts). Each
 * engine shows its readiness and license; picking one opens that engine's
 * runner in place (its own card key, so the URL names the engine).
 */
export function EngineVariantSwitch({
  options,
  active,
  onPick,
}: {
  options: EngineOption[];
  active: string;
  onPick: (key: string) => void;
}) {
  if (options.length < 2) return null;
  return (
    <div className="flex-shrink-0 px-4 pt-3 sm:px-6">
      <div
        role="radiogroup"
        aria-label="Engine"
        data-testid="engine-switch"
        className="flex flex-wrap gap-1.5"
      >
        {options.map((o) => {
          const on = o.key === active;
          const status = o.available
            ? null
            : o.checking
              ? "Checking…"
              : (setupHint(o.reason, o.model) ?? "Needs setup");
          return (
            <button
              key={o.key}
              type="button"
              role="radio"
              aria-checked={on}
              data-testid={`engine-variant-${o.key}`}
              title={o.reason ?? o.model ?? undefined}
              onClick={() => {
                if (!on) onPick(o.key);
              }}
              className={`flex min-h-8 flex-col items-start rounded-xl border px-3 py-1.5 text-left text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-splash ${
                on
                  ? "border-splash bg-splash/10 text-splash"
                  : "border-light-100 text-light-500 hover:border-splash/60 dark:border-dark-750 dark:text-dark-400"
              }`}
            >
              <span className="flex items-center gap-1.5 font-medium">
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 rounded-full ${
                    o.available
                      ? "bg-emerald-500"
                      : o.checking
                        ? "bg-light-400 dark:bg-dark-300"
                        : "bg-amber-500"
                  }`}
                />
                {o.label}
              </span>
              <span
                className="flex items-center gap-1 text-[10px] opacity-80"
                data-testid="engine-license"
                data-badge={o.badge}
                title={o.badgeTitle}
              >
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${BADGE_DOT[o.badge]}`}
                />
                {BADGE_LABEL[o.badge]}
              </span>
              {status && (
                <span
                  className="text-[10px] font-medium text-amber-600 dark:text-amber-400"
                  data-testid="engine-setup-hint"
                >
                  {status}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

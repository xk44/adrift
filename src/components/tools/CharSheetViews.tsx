"use client";

import { useMemo } from "react";
import {
  CHAR_SHEET_DEFAULT_VIEWS,
  CHAR_SHEET_GROUPS,
  CHAR_SHEET_VIEWS,
  charSheetLayout,
  parseCharSheetViews,
} from "@/lib/oj/h3CharSheet";

const LABEL = new Map(
  CHAR_SHEET_VIEWS.map((v) => [
    v.id,
    v.group === "head" || v.group === "body"
      ? `${v.group === "head" ? "Head" : "Body"} ${v.label.toLowerCase()}`
      : v.label,
  ]),
);

/**
 * H3 Character Sheet view checklist: toggle chips per group plus a live
 * schematic of the panel grid the compiler will describe. The value is the
 * CSV kept in settings.picks.views (unset = the default set).
 */
export function CharSheetViews({
  value,
  onChange,
  width,
  height,
}: {
  value: string | undefined;
  onChange: (csv: string) => void;
  width: number;
  height: number;
}) {
  const views = useMemo(
    () => parseCharSheetViews(value ?? CHAR_SHEET_DEFAULT_VIEWS),
    [value],
  );
  const layout = useMemo(
    () => charSheetLayout(views, width, height),
    [views, width, height],
  );
  const on = new Set(views);
  const set = (ids: string[]) => onChange(parseCharSheetViews(ids).join(","));
  const toggle = (id: string) =>
    set(on.has(id) ? views.filter((v) => v !== id) : [...views, id]);

  return (
    <section className="space-y-2" data-testid="charsheet-views">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
          Views{" "}
          <span className="font-normal text-light-500 dark:text-dark-400">
            ({views.length} of {CHAR_SHEET_VIEWS.length})
          </span>
        </span>
        <span className="flex gap-2 text-[11px]">
          <button
            type="button"
            aria-label="Select all views"
            className="min-h-8 px-1 text-light-500 hover:text-splash focus:outline-none focus-visible:ring-2 focus-visible:ring-splash dark:text-dark-400"
            onClick={() => set(CHAR_SHEET_VIEWS.map((v) => v.id))}
          >
            All
          </button>
          <button
            type="button"
            aria-label="Reset to the default views"
            className="min-h-8 px-1 text-light-500 hover:text-splash focus:outline-none focus-visible:ring-2 focus-visible:ring-splash dark:text-dark-400"
            onClick={() => set([...CHAR_SHEET_DEFAULT_VIEWS])}
          >
            Default
          </button>
        </span>
      </div>
      {CHAR_SHEET_GROUPS.map((g) => (
        <div key={g.id} className="space-y-1">
          <span className="text-[11px] text-light-500 dark:text-dark-400">
            {g.label}
          </span>
          <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label={g.label}
          >
            {CHAR_SHEET_VIEWS.filter((v) => v.group === g.id).map((v) => (
              <button
                key={v.id}
                type="button"
                aria-pressed={on.has(v.id)}
                onClick={() => toggle(v.id)}
                className={`min-h-8 rounded-full border px-3 py-1.5 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-splash ${
                  on.has(v.id)
                    ? "border-splash bg-splash/10 text-splash"
                    : "border-light-100 dark:border-dark-750 text-light-500 dark:text-dark-400 hover:border-splash/60"
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      {views.length ? (
        <div
          className="relative w-full overflow-hidden rounded-md border border-light-100 bg-light-50 dark:border-dark-750 dark:bg-dark-900"
          style={{ aspectRatio: `${width} / ${height}` }}
          aria-label={`Sheet layout, ${views.length} panels`}
          role="img"
        >
          {layout.rows.flatMap((row) =>
            row.cells.map((c) => (
              <div
                key={c.view}
                className="absolute flex items-center justify-center border border-light-100 p-0.5 text-center text-[10px] leading-tight text-light-500 dark:border-dark-750 dark:text-dark-400"
                style={{
                  left: `${(c.x / width) * 100}%`,
                  top: `${(c.y / height) * 100}%`,
                  width: `${(c.w / width) * 100}%`,
                  height: `${(c.h / height) * 100}%`,
                }}
              >
                {LABEL.get(c.view)}
              </div>
            )),
          )}
        </div>
      ) : (
        <p role="alert" className="text-[11px] text-red-500">Choose at least one view.</p>
      )}
    </section>
  );
}

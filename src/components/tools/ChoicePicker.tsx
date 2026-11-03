"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Search, X } from "lucide-react";
import type { ActionChoice } from "@/lib/tools/toolsPage";
import {
  CHOICE_SEARCH_MIN,
  chipLabel,
  choiceGroups,
  filterChoiceGroups,
} from "@/lib/tools/choiceGroups";

/**
 * Searchable, grouped chip grid for large preset catalogs (camera moves,
 * motion presets, looks, voices). Replaces a long <select>: every choice
 * is visible at a glance, grouped under section headings, filterable.
 */
export function ChoicePicker({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: readonly ActionChoice[];
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => choiceGroups([...options]), [options]);
  const shown = useMemo(
    () => filterChoiceGroups(groups, query),
    [groups, query],
  );
  const current = options.find((o) => o.id === value);
  const searchable = options.length >= CHOICE_SEARCH_MIN;
  const labelId = useId();
  const scroller = useRef<HTMLDivElement>(null);

  // Bring the current choice into view once (long lists start scrolled).
  useEffect(() => {
    const el = scroller.current?.querySelector<HTMLElement>(
      '[aria-checked="true"]',
    );
    if (el && scroller.current) {
      const box = scroller.current;
      const top = el.offsetTop - box.offsetTop;
      if (top > box.clientHeight - 40) box.scrollTop = top - 48;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-2" data-testid="choice-picker">
      <div className="flex items-baseline justify-between gap-3">
        <span
          id={labelId}
          className="text-xs font-medium text-light-primary dark:text-dark-primary"
        >
          {label}
        </span>
        {current && (
          <span className="truncate text-[11px] text-light-500 dark:text-dark-400">
            {current.label}
          </span>
        )}
      </div>
      <div className="overflow-hidden rounded-xl bg-light-input shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)] dark:bg-dark-input dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
        {searchable && (
          <div className="relative border-b border-black/5 dark:border-white/5">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-light-500 dark:text-dark-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={disabled}
              placeholder={`Search ${options.length} ${label.toLowerCase()}s`}
              aria-label={`Search ${label}`}
              className="h-10 w-full bg-transparent pl-8 pr-9 text-sm text-light-primary placeholder:text-light-500 focus:outline-none dark:text-dark-primary dark:placeholder:text-dark-400 [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-light-500 hover:text-light-primary dark:text-dark-400 dark:hover:text-dark-primary"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
        <div
          ref={scroller}
          role="radiogroup"
          aria-labelledby={labelId}
          className={`space-y-3 overflow-y-auto overscroll-contain p-2.5 ${
            searchable ? "max-h-72" : ""
          }`}
        >
          {shown.length === 0 && (
            <p className="px-1 py-4 text-center text-xs text-light-500 dark:text-dark-400">
              Nothing matches &ldquo;{query}&rdquo;
            </p>
          )}
          {shown.map((g, gi) => (
            <div key={`${g.group}-${gi}`} className="space-y-1.5">
              {g.group && (
                <p className="px-0.5 text-[10px] font-medium text-light-500 dark:text-dark-400">
                  {g.group}
                </p>
              )}
              <div className="flex flex-wrap gap-1.5">
                {g.options.map((o) => {
                  const on = o.id === value;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      title={o.hint ?? o.label}
                      disabled={disabled || o.disabled}
                      onClick={() => onChange(o.id)}
                      className={`flex h-8 items-center gap-1 rounded-lg px-2.5 text-xs transition-[background-color,color,box-shadow,transform] duration-150 active:scale-[0.96] disabled:opacity-40 ${
                        on
                          ? "bg-splash/10 font-medium text-splash shadow-[inset_0_0_0_1px_rgb(var(--c-splash)/0.6)]"
                          : "bg-light-bg text-light-600 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)] hover:text-light-primary dark:bg-dark-850 dark:text-dark-600 dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] dark:hover:text-dark-primary"
                      }`}
                    >
                      {on && <Check className="h-3 w-3" />}
                      {chipLabel(o.label, g.group)}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

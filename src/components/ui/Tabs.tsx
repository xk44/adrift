"use client";

import { useRef, type ComponentType, type KeyboardEvent } from "react";

export interface TabItem<T extends string = string> {
  id: T;
  label: string;
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  /** Optional trailing count/badge text (e.g. "12"). */
  badge?: string | number;
  disabled?: boolean;
}

/**
 * Next tab index for a WAI-ARIA tablist key press, skipping disabled tabs.
 * Returns null for keys the tablist does not handle.
 */
export function nextTabIndex(
  key: string,
  current: number,
  disabled: readonly boolean[],
): number | null {
  const n = disabled.length;
  if (n === 0) return null;
  const step = (from: number, dir: 1 | -1) => {
    for (let i = 1; i <= n; i++) {
      const idx = (((from + dir * i) % n) + n) % n;
      if (!disabled[idx]) return idx;
    }
    return from;
  };
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return step(current, 1);
    case "ArrowLeft":
    case "ArrowUp":
      return step(current, -1);
    case "Home":
      return step(-1, 1);
    case "End":
      return step(n, -1);
    default:
      return null;
  }
}

/** Stable DOM ids so a panel can point back at its tab. */
export function tabId(idPrefix: string, id: string): string {
  return `${idPrefix}-tab-${id}`;
}
export function tabPanelId(idPrefix: string, id: string): string {
  return `${idPrefix}-panel-${id}`;
}

/**
 * The one tab strip for page-level tabs: underline style, horizontally
 * scrollable on narrow screens, ARIA tablist with roving tabindex and
 * arrow/Home/End keys (selection follows focus). The active tab is marked by
 * weight and an underline bar, not colour alone.
 *
 * Give the matching panel `role="tabpanel"`, `id={tabPanelId(idPrefix, id)}`
 * and `aria-labelledby={tabId(idPrefix, id)}` when `idPrefix` is set.
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  idPrefix,
  className = "",
}: {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  idPrefix?: string;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(
    0,
    items.findIndex((t) => t.id === value),
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = nextTabIndex(
      e.key,
      activeIndex,
      items.map((t) => !!t.disabled),
    );
    if (next === null || next === activeIndex) return;
    e.preventDefault();
    onChange(items[next].id);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className={`noScrollbar flex max-w-full items-end gap-1 overflow-x-auto border-b border-[var(--border-primary)] ${className}`}
    >
      {items.map((tab, i) => {
        const active = i === activeIndex;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={idPrefix ? tabId(idPrefix, tab.id) : undefined}
            aria-controls={idPrefix ? tabPanelId(idPrefix, tab.id) : undefined}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            disabled={tab.disabled}
            onClick={() => onChange(tab.id)}
            className={`relative -mb-px inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] disabled:opacity-40 ${
              active
                ? "border-current font-semibold text-[var(--text-primary)]"
                : "border-transparent font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {Icon && <Icon className="h-4 w-4" aria-hidden />}
            <span>{tab.label}</span>
            {tab.badge !== undefined && tab.badge !== "" && (
              <span className="rounded-full bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[11px] leading-none tabular-nums text-[var(--text-secondary)]">
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default Tabs;

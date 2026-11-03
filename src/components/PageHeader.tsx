import type { ReactNode } from "react";
import { collageLayout } from "@/lib/collectionView";

/**
 * Page title for the quiet account/info pages (Updates, Account Settings,
 * Help: centered) and the Setup page (`align="left"`). Scrolls with the
 * content instead of sitting in a divided header strip — large balanced
 * title, muted one-line subtitle, optional actions row underneath.
 */
export function PageHeader({
  title,
  subtitle,
  badge,
  actions,
  align = "center",
}: {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  actions?: ReactNode;
  align?: "center" | "left";
}) {
  const left = align === "left";
  return (
    <div
      data-align={align}
      className={
        left
          ? "max-w-3xl pt-6 pb-5 text-left md:pt-8 md:pb-6"
          : "mx-auto max-w-2xl px-2 pt-6 pb-8 text-center md:pt-12 md:pb-10"
      }
    >
      <h1 className="inline-flex items-center gap-3 text-[1.75rem] font-semibold leading-tight tracking-[-0.02em] text-balance text-light-primary dark:text-dark-primary md:text-4xl">
        {title}
        {badge}
      </h1>
      {subtitle && (
        <p
          className={`mt-2 text-[15px] text-pretty text-[var(--text-tertiary)] md:text-base ${
            left ? "max-w-xl" : "mx-auto max-w-md"
          }`}
        >
          {subtitle}
        </p>
      )}
      {actions && (
        <div
          className={`mt-5 flex items-center gap-2 ${left ? "justify-start" : "justify-center"}`}
        >
          {actions}
        </div>
      )}
    </div>
  );
}

export default PageHeader;

/**
 * Left-aligned hero for the collection pages (Personalize, Moodboards,
 * Characters/Styles datasets, Tasks): a large heading, one or two muted
 * lines, and optional art that sits to the left on desktop and stacks on
 * top on mobile. Scrolls with the page content.
 */
export function HeroHeader({
  title,
  lines,
  eyebrow,
  art,
  align = "left",
  testId,
}: {
  title: ReactNode;
  lines?: ReactNode[];
  eyebrow?: ReactNode;
  art?: ReactNode;
  align?: "left" | "center";
  testId?: string;
}) {
  const centered = align === "center" && !art;
  return (
    <section
      data-testid={testId}
      className={`flex flex-col gap-6 pt-4 pb-5 md:flex-row md:items-center md:gap-10 md:pt-8 md:pb-7 ${
        centered ? "items-center text-center" : ""
      }`}
    >
      {art && <div className="shrink-0 md:w-[42%] md:max-w-[440px]">{art}</div>}
      <div
        className={`min-w-0 flex-1 ${centered ? "mx-auto max-w-2xl" : "max-w-2xl"}`}
      >
        {eyebrow && (
          <div className="mb-2 text-[11px] font-medium text-[var(--text-muted)]">
            {eyebrow}
          </div>
        )}
        <h1 className="text-[1.9rem] font-semibold leading-[1.08] tracking-[-0.025em] text-balance text-light-primary dark:text-dark-primary md:text-[2.75rem]">
          {title}
        </h1>
        {lines?.map((line, i) => (
          <p
            key={i}
            className={`mt-3 text-[15px] leading-relaxed text-pretty text-[var(--text-tertiary)] md:text-base ${
              centered ? "mx-auto max-w-xl" : "max-w-xl"
            }`}
          >
            {line}
          </p>
        ))}
      </div>
    </section>
  );
}

export interface CollectionToolbarSortOption<S extends string> {
  value: S;
  label: string;
}

/**
 * One toolbar row under a hero: All/Selected segmented control (optional),
 * a sort dropdown, a search field, extra actions and the primary "New …"
 * button. Wraps cleanly at phone width — search drops to its own full row.
 */
export function CollectionToolbar<S extends string>({
  scope,
  onScopeChange,
  selectedCount,
  scopeLabels = ["All", "Selected"],
  sort,
  sortOptions,
  onSortChange,
  query,
  onQueryChange,
  searchPlaceholder = "Search…",
  searchAriaLabel = "Search",
  extra,
  primary,
  sticky = false,
  testId,
}: {
  scope?: "all" | "selected";
  onScopeChange?: (scope: "all" | "selected") => void;
  selectedCount?: number;
  scopeLabels?: [string, string];
  sort: S;
  sortOptions: ReadonlyArray<CollectionToolbarSortOption<S>>;
  onSortChange: (sort: S) => void;
  query: string;
  onQueryChange: (query: string) => void;
  searchPlaceholder?: string;
  searchAriaLabel?: string;
  extra?: ReactNode;
  primary?: ReactNode;
  sticky?: boolean;
  testId?: string;
}) {
  const segBtn = (active: boolean) =>
    `rounded-md px-3 py-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-splash/60 ${
      active
        ? "bg-light-primary text-light-bg dark:bg-dark-primary dark:text-dark-bg"
        : "text-[var(--text-tertiary)] hover:text-light-primary dark:hover:text-dark-primary"
    }`;
  return (
    <div
      data-testid={testId}
      className={`flex flex-wrap items-center gap-2 py-3 ${
        sticky ? "sticky top-0 z-20 bg-[var(--bg-primary)]" : ""
      }`}
    >
      {scope && onScopeChange && (
        <div
          role="group"
          aria-label="Show"
          className="flex h-9 items-center gap-0.5 rounded-lg border border-[var(--border-primary)] p-0.5"
        >
          <button
            type="button"
            aria-pressed={scope === "all"}
            onClick={() => onScopeChange("all")}
            className={segBtn(scope === "all")}
          >
            {scopeLabels[0]}
          </button>
          <button
            type="button"
            aria-pressed={scope === "selected"}
            onClick={() => onScopeChange("selected")}
            className={segBtn(scope === "selected")}
          >
            {scopeLabels[1]}
            {selectedCount ? (
              <span className="ml-1.5 tabular-nums opacity-70">
                {selectedCount}
              </span>
            ) : null}
          </button>
        </div>
      )}
      <div className="relative flex items-center">
        <select
          aria-label="Sort"
          value={sort}
          onChange={(e) => onSortChange(e.target.value as S)}
          className="h-9 cursor-pointer appearance-none rounded-lg border border-[var(--border-primary)] bg-transparent py-1 pr-8 pl-3 text-sm font-medium text-light-primary outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-splash/60 dark:text-dark-primary [&>option]:bg-[var(--bg-secondary)]"
        >
          {sortOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-[var(--text-tertiary)]"
        >
          <path
            d="M4 6l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="relative order-last basis-full md:order-none md:w-64 md:basis-auto">
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-tertiary)]"
        >
          <circle
            cx="7"
            cy="7"
            r="4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path
            d="M10.5 10.5L14 14"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchAriaLabel}
          className="h-9 w-full rounded-lg border border-[var(--border-primary)] bg-light-input py-1 pr-3 pl-8 text-sm text-light-primary outline-none placeholder:text-[var(--text-muted)] focus-visible:ring-2 focus-visible:ring-splash/60 dark:bg-dark-input dark:text-dark-primary"
        />
      </div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {extra}
        {primary}
      </div>
    </div>
  );
}

/** Accent primary button used for the toolbar "New …" action. */
export function ToolbarPrimaryButton({
  children,
  onClick,
  ariaLabel,
  disabled,
  icon,
}: {
  children: ReactNode;
  onClick: () => void;
  ariaLabel?: string;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      disabled={disabled}
      className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-splash px-3.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-splash/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)] disabled:opacity-50"
    >
      {icon}
      {children}
    </button>
  );
}

/** Quiet bordered button for secondary toolbar actions. */
export function ToolbarButton({
  children,
  onClick,
  ariaLabel,
  title,
  disabled,
  icon,
}: {
  children?: ReactNode;
  onClick: () => void;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--border-primary)] px-3 text-sm font-medium text-light-primary transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-splash/60 disabled:opacity-50 dark:text-dark-primary"
    >
      {icon}
      {children}
    </button>
  );
}

/** Compact stat chips in a single wrapping row. */
export function StatRow({
  stats,
  className = "",
  testId,
}: {
  stats: Array<{
    label: string;
    value: ReactNode;
    icon?: ReactNode;
    title?: string;
  }>;
  className?: string;
  testId?: string;
}) {
  return (
    <ul
      data-testid={testId}
      className={`flex flex-wrap items-center gap-2 ${className}`}
    >
      {stats.map((s) => (
        <li
          key={s.label}
          title={s.title}
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-1 text-sm"
        >
          {s.icon && (
            <span className="text-[var(--text-tertiary)]" aria-hidden="true">
              {s.icon}
            </span>
          )}
          <span className="font-semibold tabular-nums text-light-primary dark:text-dark-primary">
            {s.value}
          </span>
          <span className="text-[var(--text-tertiary)]">{s.label}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Board cover collage: 1 → full bleed, 2 → halves, 3 → big + two stacked,
 * 4/5 → 2x2, 6+ → 3x2 (when `max` is 6). Thumbnails lazy-load and hide
 * themselves on error so a dead URL shows the tile background, not a
 * broken-image glyph. Renders `empty` when there are no images.
 */
export function ImageCollage({
  urls,
  max = 4,
  empty,
  className = "",
  imgClassName = "",
}: {
  urls: ReadonlyArray<string | null | undefined>;
  max?: 4 | 6;
  empty?: ReactNode;
  className?: string;
  imgClassName?: string;
}) {
  const layout = collageLayout(urls, max);
  if (layout.cells.length === 0) {
    return (
      <div
        className={`flex h-full w-full items-center justify-center ${className}`}
      >
        {empty}
      </div>
    );
  }
  return (
    <div
      className={`grid h-full w-full gap-[2px] ${className}`}
      style={{
        gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
      }}
    >
      {layout.cells.map((cell, i) => (
        <div
          key={`${i}-${cell.url}`}
          className="relative min-h-0 overflow-hidden bg-[var(--bg-tertiary)]"
          style={{
            gridColumn: `span ${cell.colSpan}`,
            gridRow: `span ${cell.rowSpan}`,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={cell.url}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={(e) => {
              e.currentTarget.style.visibility = "hidden";
            }}
            className={`absolute inset-0 h-full w-full object-cover ${imgClassName}`}
          />
        </div>
      ))}
    </div>
  );
}

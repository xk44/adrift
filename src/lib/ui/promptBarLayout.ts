/**
 * Layout classes for the Create prompt bar.
 *
 * The Styles | Images | Settings pills and the "…" menu live OUTSIDE the
 * glass prompt card:
 * - from `sm` up they sit to the right of the card on the same row, the card
 *   taking the remaining width (`flex-1 min-w-0`), the pills vertically
 *   centred on the card's first line;
 * - the pills are icon-only; each name pops in under its icon on hover or
 *   keyboard focus (and stays the button's aria-label), which leaves the
 *   card more width;
 * - when even the icons don't fit, they wrap under the card instead of
 *   squeezing it below 24rem;
 * - below `sm` they get their own row under the card, which wraps cleanly
 *   down to 320 px.
 *
 * Kept as constants so the layout contract is testable without a DOM.
 */

/** Wrapper holding the card and the control row. */
export const PROMPT_ROW_CLASS =
  "cj-prompt-row flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start";

/** Card width: takes the free space, never squeezed below 24rem from `sm`. */
export const PROMPT_CARD_WIDTH_CLASS =
  "min-w-0 flex-1 sm:min-w-[min(100%,24rem)]";

/**
 * Control row. `sm:mt-3` centres the 38 px pill group on the card's first
 * line (1 px border + 14 px padding + 32 px send button + 14 px padding).
 */
export const PROMPT_CONTROLS_CLASS =
  "flex flex-wrap items-center justify-between gap-1 sm:mt-3 sm:ml-auto sm:shrink-0 sm:flex-nowrap sm:justify-end";

/**
 * One icon pill: a 40 px square touch target on phones, 32 px from `sm` up.
 * `group relative` anchors the hover label and the count badge.
 */
export const PROMPT_PILL_SIZE_CLASS =
  "group relative size-10 justify-center sm:size-8";

/** Pill icon: always shown (the pills carry no static text). */
export const PROMPT_PILL_ICON_CLASS = "block h-4 w-4";

/**
 * Pill name: a small label that pops in under the icon on hover (pointer
 * devices only, so a tap on a phone doesn't leave it stuck) and on keyboard
 * focus. The button's aria-label carries the name for screen readers.
 */
const HOVER_LABEL_BASE =
  "cj-prompt-pill-label pointer-events-none absolute top-full z-40 mt-1.5 translate-y-0.5 whitespace-nowrap rounded-md border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2 py-1 text-[11px] font-medium leading-none text-[var(--text-primary)] opacity-0 shadow-sm transition-[opacity,transform] duration-150 [@media(hover:hover)]:group-hover:translate-y-0 [@media(hover:hover)]:group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 motion-reduce:transition-none";

export const PROMPT_PILL_LABEL_CLASS = `${HOVER_LABEL_BASE} left-1/2 -translate-x-1/2`;

/**
 * The same label under the "…" trigger, right-aligned to it: that button is
 * the row's last, so a centred label would hang past the column edge.
 */
export const PROMPT_OVERFLOW_LABEL_CLASS = `${HOVER_LABEL_BASE} right-0`;

/** Selection count on an icon pill: a small badge on the icon's corner. */
export const PROMPT_PILL_COUNT_CLASS =
  "pointer-events-none absolute -right-1 -top-1 min-w-4 rounded-full bg-[var(--accent-primary)] px-1 text-[10px] font-medium leading-4 tabular-nums text-white";

/** "…" trigger: 40 px on phones, matches the pill group from `sm` up. */
export const PROMPT_OVERFLOW_TRIGGER_SIZE_CLASS = "size-10 sm:size-9";

/**
 * Per-row actions in the prompt history list: always visible on touch
 * screens, revealed on hover/focus from `md` up.
 */
export const HISTORY_ROW_ACTION_CLASS =
  "p-2 text-[var(--text-muted)] md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100";

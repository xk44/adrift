/**
 * Keyboard helpers for the Create prompt bar, kept pure so they're testable
 * without a DOM.
 */

/**
 * Phone keyboards (iOS "Smart Punctuation", macOS smart dashes) turn a typed
 * `--` into an em or en dash, so `—ar 16:9` silently stops being a parameter.
 * Turn a dash that starts a word and is followed by a letter back into `--`.
 * Dashes inside prose ("dusk — a lighthouse") are left alone.
 */
export function normalizeSmartDashes(
  value: string,
  caret: number,
): { value: string; caret: number } {
  if (!/[–—]/.test(value)) return { value, caret };
  let nextCaret = caret;
  const next = value.replace(
    /(^|\s)[–—](?=[a-zA-Z])/g,
    (match: string, lead: string, offset: number) => {
      // Each replacement grows the string by one character.
      if (offset + lead.length < caret) nextCaret += 1;
      return `${lead}--`;
    },
  );
  return { value: next, caret: nextCaret };
}

export interface HistoryRecallState {
  /** -1 = editing the draft; 0 = newest history entry, 1 = the one before… */
  index: number;
  /** What the user had typed before they started browsing. */
  draft: string;
}

export const HISTORY_RECALL_IDLE: HistoryRecallState = { index: -1, draft: "" };

/**
 * Shell-style history recall. `history` is newest first. Up steps back in
 * time, Down steps forward and finally restores the draft. Returns null when
 * the key shouldn't be taken over (no history, already at an end, or the
 * caret is mid-text so the arrow should move it between lines).
 */
export function recallPromptHistory({
  direction,
  history,
  state,
  value,
  caret,
}: {
  direction: "up" | "down";
  history: readonly string[];
  state: HistoryRecallState;
  value: string;
  caret: number;
}): { state: HistoryRecallState; value: string } | null {
  if (history.length === 0) return null;
  const browsing = state.index >= 0;
  if (direction === "up") {
    // Only on the first line, and only from an empty prompt unless the user
    // is already browsing (never clobber a half-written prompt).
    if (value.slice(0, caret).includes("\n")) return null;
    if (!browsing && value.trim() !== "") return null;
    const index = state.index + 1;
    if (index >= history.length) return null;
    return {
      state: { index, draft: browsing ? state.draft : value },
      value: history[index],
    };
  }
  if (!browsing) return null;
  if (value.slice(caret).includes("\n")) return null;
  const index = state.index - 1;
  if (index < 0) {
    return { state: HISTORY_RECALL_IDLE, value: state.draft };
  }
  return { state: { index, draft: state.draft }, value: history[index] };
}

/**
 * Example prompts cycled through the empty prompt's placeholder: they show
 * a newcomer what a prompt looks like and quietly teach the `--` syntax.
 */
export const EXAMPLE_PROMPTS: readonly string[] = [
  "What will you imagine?",
  "a lighthouse at dusk, oil painting --ar 3:2",
  "portrait of an old sailor, film grain --ar 2:3",
  "isometric tiny greenhouse, soft light --s 250",
  "neon city street in the rain --ar 16:9 --no people",
  "Type -- for parameters, or press ↑ for your last prompt",
];

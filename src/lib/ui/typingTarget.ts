/**
 * Whether a key event target is a place the user is typing or choosing
 * with the keyboard, so single-key app shortcuts (1-9, ?, /) must not fire.
 * Covers text fields, selects, contenteditable and ARIA comboboxes/listboxes
 * (a digit in a model select should pick an option, not switch page).
 */
export interface TypingTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
  type?: string;
}

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "radio",
  "submit",
  "reset",
  "image",
  "file",
  "color",
  "range",
]);

const TYPING_ROLES = new Set(["combobox", "textbox", "searchbox", "listbox", "spinbutton"]);

export function isTypingTarget(target: EventTarget | TypingTargetLike | null | undefined): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as TypingTargetLike;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (el.type ?? el.getAttribute?.("type") ?? "text").toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  if (el.isContentEditable) return true;
  const role = el.getAttribute?.("role");
  if (role && TYPING_ROLES.has(role)) return true;
  // Inside a combobox/listbox widget (e.g. an option row with focus).
  if (el.closest?.('[role="combobox"],[role="listbox"]')) return true;
  return false;
}

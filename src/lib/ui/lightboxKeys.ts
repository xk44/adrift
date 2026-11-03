/**
 * Lightbox keyboard shortcuts, DOM-free so they can be unit-tested.
 *
 * The lightbox listens on window in the capture phase, so it sees every key
 * before the focused element does. That makes it easy to steal keys from
 * controls that need them: arrow keys seek a focused video, move a focused
 * <select> option or drag the compare slider's handle. `keyOwner` says who
 * the focused element is, and `lightboxKeyIntent` leaves those keys alone.
 */

/** The slice of the event target this module reads. */
export interface LightboxKeyTarget {
  tagName?: string;
  isContentEditable?: boolean;
  /** `type` attribute for inputs. */
  type?: string;
  /** `role` attribute. */
  role?: string | null;
}

/**
 * "text": a field the user types into (every shortcut is off, Escape too).
 * "control": a widget that uses arrow keys itself (video, select, slider).
 * null: anything else (buttons, the dialog itself).
 */
export type LightboxKeyOwner = "text" | "control" | null;

const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "reset",
  "submit",
]);

export function keyOwner(
  target: LightboxKeyTarget | null | undefined,
): LightboxKeyOwner {
  if (!target) return null;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || target.isContentEditable) return "text";
  if (tag === "INPUT") {
    const type = (target.type ?? "text").toLowerCase();
    if (type === "range") return "control";
    return NON_TEXT_INPUTS.has(type) ? null : "text";
  }
  if (tag === "SELECT" || tag === "VIDEO" || tag === "AUDIO") return "control";
  if (target.role === "slider") return "control";
  return null;
}

export interface LightboxKeyContext {
  owner: LightboxKeyOwner;
  compareActive: boolean;
  zoomed: boolean;
  canCompare: boolean;
  canQuickEdit: boolean;
  canZoom: boolean;
}

export type LightboxKeyIntent =
  | "close"
  | "exit-compare"
  | "exit-zoom"
  | "prev"
  | "next"
  | "compare"
  | "quick-edit"
  | "tools"
  | "zoom";

export interface LightboxKeyEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

/** What a key press should do in the lightbox, or null to leave it alone. */
export function lightboxKeyIntent(
  e: LightboxKeyEvent,
  ctx: LightboxKeyContext,
): LightboxKeyIntent | null {
  // Typing: leave every key (Escape included) to the field and the page.
  if (ctx.owner === "text") return null;
  const modified = Boolean(e.metaKey || e.ctrlKey || e.altKey);
  switch (e.key) {
    case "Escape":
      // Peel one layer per press: zoom, then compare, then the lightbox.
      if (ctx.zoomed) return "exit-zoom";
      if (ctx.compareActive) return "exit-compare";
      return "close";
    case "ArrowLeft":
    case "ArrowRight":
      // A focused video/select/slider owns its arrows. While comparing the
      // arrows are hidden and the wipe handle is the arrow target; while
      // zoomed the arrows scroll the enlarged image.
      if (modified || ctx.owner === "control") return null;
      if (ctx.compareActive || ctx.zoomed) return null;
      return e.key === "ArrowLeft" ? "prev" : "next";
  }
  if (modified) return null;
  switch (e.key.toLowerCase()) {
    case "c":
      return ctx.canCompare ? "compare" : null;
    case "e":
      return ctx.canQuickEdit ? "quick-edit" : null;
    case "t":
      return "tools";
    case "z":
      return ctx.canZoom ? "zoom" : null;
  }
  return null;
}

/**
 * Modal focus management, framework-free so it can be unit-tested without a
 * DOM: traps Tab inside the dialog, optionally closes on Escape, moves focus
 * in on open and restores it to the opener on close. `useDialogFocus` is the
 * React wrapper.
 *
 * Only the top-most active dialog reacts to keys, so a dialog opened over
 * another (Describe over the Lightbox) owns Tab/Escape until it closes.
 */

export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** The slice of HTMLElement this module touches (keeps tests DOM-free). */
export interface FocusableLike {
  focus(options?: FocusOptions): void;
  contains(other: unknown): boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute?(name: string): void;
  hasAttribute(name: string): boolean;
  getClientRects(): { length: number };
  querySelectorAll?(selector: string): ArrayLike<FocusableLike>;
  isConnected?: boolean;
}

export interface KeyEventLike {
  key: string;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  preventDefault(): void;
  stopPropagation?(): void;
}

export interface DocumentLike {
  activeElement: unknown;
  addEventListener(type: "keydown", fn: (e: KeyEventLike) => void): void;
  removeEventListener(type: "keydown", fn: (e: KeyEventLike) => void): void;
}

export interface DialogFocusOptions {
  /** Called on Escape. Omit when the dialog already handles Escape itself. */
  onEscape?: () => void;
  /**
   * Where focus goes on open: "first" focusable (default), the "container"
   * itself, "none" (the dialog focuses something on its own), or an element.
   * Focus that is already inside the dialog is never moved.
   */
  initialFocus?: "first" | "container" | "none" | FocusableLike | null;
  /** Put focus back on the element that had it before opening (default true). */
  restoreFocus?: boolean;
  /** Accessible name, applied when the container has no aria-label(ledby). */
  label?: string;
  /**
   * Keep Tab inside the dialog (default true). A getter lets a dialog that is
   * only modal at some widths (the desktop lightbox leaves the prompt bar
   * reachable) decide per key press.
   */
  trap?: boolean | (() => boolean);
}

const stack: object[] = [];

/** Visible, enabled tabbable descendants in DOM order. */
export function getFocusable(container: FocusableLike): FocusableLike[] {
  const list = container.querySelectorAll?.(FOCUSABLE_SELECTOR);
  if (!list) return [];
  return Array.from(list).filter(
    (el) =>
      !el.hasAttribute("disabled") &&
      el.getAttribute("aria-hidden") !== "true" &&
      el.getClientRects().length > 0,
  );
}

/**
 * Where Tab should go next, or null to let the browser move focus normally.
 * Wraps at both ends and pulls focus back in when it escaped the dialog.
 */
export function nextTrapTarget(
  container: FocusableLike,
  active: unknown,
  shift: boolean,
): FocusableLike | null | "stay" {
  const items = getFocusable(container);
  if (items.length === 0) return "stay";
  const first = items[0];
  const last = items[items.length - 1];
  const inside = active != null && container.contains(active);
  if (!inside || active === container) return shift ? last : first;
  if (shift && active === first) return last;
  if (!shift && active === last) return first;
  return null;
}

/**
 * Ensures dialog semantics without forcing every call site to repeat them.
 * Returns the attribute names it added so they can be removed again (a panel
 * that is only modal on phones must not stay aria-modal after a resize).
 */
export function applyDialogAttributes(
  container: FocusableLike,
  label?: string,
): string[] {
  const added: string[] = [];
  const set = (name: string, value: string) => {
    container.setAttribute(name, value);
    added.push(name);
  };
  if (!container.hasAttribute("role")) set("role", "dialog");
  if (!container.hasAttribute("aria-modal")) set("aria-modal", "true");
  if (
    label &&
    !container.hasAttribute("aria-label") &&
    !container.hasAttribute("aria-labelledby")
  ) {
    set("aria-label", label);
  }
  return added;
}

/**
 * Activates focus management for one dialog. Returns the cleanup that
 * removes the key listener and restores focus.
 */
export function activateDialogFocus(
  container: FocusableLike,
  doc: DocumentLike,
  options: DialogFocusOptions = {},
): () => void {
  const token = {};
  stack.push(token);
  const previouslyFocused = doc.activeElement as FocusableLike | null;

  const addedAttrs = applyDialogAttributes(container, options.label);

  const focusInto = (target: FocusableLike) => {
    try {
      target.focus({ preventScroll: true });
    } catch {
      /* element vanished between query and focus */
    }
  };
  const focusContainer = () => {
    if (!container.hasAttribute("tabindex")) {
      container.setAttribute("tabindex", "-1");
    }
    focusInto(container);
  };

  const initial = options.initialFocus ?? "first";
  if (!container.contains(doc.activeElement) && initial !== "none") {
    if (initial === "container") focusContainer();
    else if (initial === "first" || initial == null) {
      const first = getFocusable(container)[0];
      if (first) focusInto(first);
      else focusContainer();
    } else focusInto(initial);
  }

  const onKeyDown = (e: KeyEventLike) => {
    if (stack[stack.length - 1] !== token) return;
    if (e.key === "Tab") {
      // The dialog already handled Tab itself (the command palette keeps
      // focus in its search field) — don't move focus a second time.
      if (e.defaultPrevented) return;
      const trap =
        typeof options.trap === "function"
          ? options.trap()
          : options.trap !== false;
      if (!trap) return;
      const target = nextTrapTarget(container, doc.activeElement, !!e.shiftKey);
      if (target === null) return;
      e.preventDefault();
      if (target !== "stay") focusInto(target);
      return;
    }
    if (
      e.key === "Escape" &&
      options.onEscape &&
      !e.defaultPrevented &&
      !e.isComposing
    ) {
      e.preventDefault();
      options.onEscape();
    }
  };
  doc.addEventListener("keydown", onKeyDown);

  return () => {
    doc.removeEventListener("keydown", onKeyDown);
    const idx = stack.indexOf(token);
    if (idx !== -1) stack.splice(idx, 1);
    for (const name of addedAttrs) container.removeAttribute?.(name);
    if (options.restoreFocus === false || !previouslyFocused) return;
    if (previouslyFocused.isConnected === false) return;
    const active = doc.activeElement;
    // Only restore when focus is still ours (or lost to <body>); never yank it
    // from wherever the close action deliberately sent it.
    const lost =
      active == null ||
      container.contains(active) ||
      (typeof (active as { tagName?: string }).tagName === "string" &&
        (active as { tagName: string }).tagName === "BODY");
    if (lost) focusInto(previouslyFocused);
  };
}

/** Test hook: number of dialogs currently holding focus. */
export function activeDialogCount(): number {
  return stack.length;
}

/** Below Tailwind's md breakpoint the lightbox is a full-screen modal. */
export function isLightboxFullScreen(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 767px)").matches
  );
}

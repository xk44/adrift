/**
 * Route-change a11y for the single-page shell: a page title per view and
 * focus moved to the new view's heading, so screen-reader and keyboard users
 * learn the page changed (the SPA never reloads, so the browser won't).
 */

export const APP_NAME = "Adrift";

/** `Label · Adrift`, or just `Adrift` when there is no label. */
export function documentTitleFor(label: string | undefined | null): string {
  const clean = (label ?? "").trim();
  return clean ? `${clean} · ${APP_NAME}` : APP_NAME;
}

interface FocusableEl {
  focus: (opts?: { preventScroll?: boolean }) => void;
  setAttribute: (name: string, value: string) => void;
  hasAttribute: (name: string) => boolean;
}

interface QueryRoot {
  querySelector: (selector: string) => unknown;
}

/**
 * Focus the first h1 inside `root` (falling back to `root` itself). Pages
 * are lazy-loaded, so the heading may not exist yet: retry each frame for up
 * to `timeoutMs`. Returns a cancel function.
 */
export function focusPageHeading(
  root: (QueryRoot & FocusableEl) | null,
  {
    timeoutMs = 1500,
    schedule = (cb: () => void) => setTimeout(cb, 50),
    cancel = (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now = () => Date.now(),
  }: {
    timeoutMs?: number;
    schedule?: (cb: () => void) => unknown;
    cancel?: (handle: unknown) => void;
    now?: () => number;
  } = {},
): () => void {
  if (!root) return () => {};
  const started = now();
  let handle: unknown = null;
  let cancelled = false;

  const focusEl = (el: FocusableEl) => {
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    el.focus({ preventScroll: true });
  };

  const attempt = () => {
    if (cancelled) return;
    const h1 = root.querySelector("h1") as FocusableEl | null;
    if (h1) {
      focusEl(h1);
      return;
    }
    if (now() - started >= timeoutMs) {
      focusEl(root);
      return;
    }
    handle = schedule(attempt);
  };
  attempt();
  return () => {
    cancelled = true;
    if (handle !== null) cancel(handle);
  };
}

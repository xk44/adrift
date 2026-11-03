/**
 * URL ↔ store nav sync (driven by hooks/useNavSync).
 *
 * Pages own their query params (Explore tab/view/filters, Tools `?tool=`,
 * Workflows tab + Civitai filters):
 *
 *  - Each pathname's query is remembered when the app navigates away from it
 *    and re-applied when the app navigates back (transient keys such as the
 *    lightbox's `?image=` are not carried).
 *  - Store → URL runs as a synchronous store subscription, so the URL is
 *    already the target page's (with its remembered query) when that page
 *    mounts and reads it. A React effect would run after the page's own mount
 *    effects (child effects first), so pages would read the previous page's URL.
 *  - Navigating to the page already shown leaves its query alone.
 *
 * Back/forward needs no memory: history entries keep their own query.
 */
import { useUIStore } from "@/store";
import type { NavKey, NavParams } from "@/types";
import {
  buildPathname,
  canonicalSearch,
  parseHash,
  resolvePathname,
  unknownPathNotice,
} from "@/lib/routeMapper";

/** Query keys that describe a momentary overlay, not page state. */
export const TRANSIENT_QUERY_KEYS: readonly string[] = ["image"];

/** `search` minus transient keys, as "?…" or "" when nothing is left. */
export function persistentSearch(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of TRANSIENT_QUERY_KEYS) params.delete(key);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function pathKey(pathname: string): string {
  return "/" + pathname.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Last query seen on each pathname when the app navigated away from it. */
export class NavQueryMemory {
  private readonly byPath = new Map<string, string>();

  remember(pathname: string, search: string): void {
    const kept = persistentSearch(search);
    if (kept) this.byPath.set(pathKey(pathname), kept);
    // Leaving with no filters set clears what was remembered.
    else this.byPath.delete(pathKey(pathname));
  }

  recall(pathname: string): string {
    return this.byPath.get(pathKey(pathname)) ?? "";
  }

  clear(): void {
    this.byPath.clear();
  }
}

/**
 * Href for an in-app move from `from` to `targetPath`: remembers the page
 * being left and restores the target's remembered query. Null when already
 * on `targetPath` (its current query is kept as is).
 */
export function navTransitionHref(
  memory: NavQueryMemory,
  from: { pathname: string; search: string },
  targetPath: string,
): string | null {
  if (pathKey(from.pathname) === pathKey(targetPath)) return null;
  memory.remember(from.pathname, from.search);
  return targetPath + memory.recall(targetPath);
}

/**
 * Fired after an in-app move that changes the URL query without a popstate
 * (e.g. a "Get model" link while Setup is already open), so a page that
 * keeps tab state in the query can re-read it.
 */
export const NAV_QUERY_EVENT = "adrift:nav-query";

function notifyNavQuery(): void {
  try {
    window.dispatchEvent(new Event(NAV_QUERY_EVENT));
  } catch {
    // non-DOM test environment
  }
}

// Module state (one app shell per window)

export const navQueryMemory = new NavQueryMemory();

/** >0 while the store is being set FROM the URL: don't echo it back. */
let applyingUrl = 0;

function setNav(nav: NavKey, params: NavParams): void {
  applyingUrl++;
  try {
    useUIStore.setState({ activeNav: nav, navParams: params });
  } finally {
    applyingUrl--;
  }
}

function pushNavUrl(nav: NavKey, params: NavParams): void {
  const href = navTransitionHref(
    navQueryMemory,
    window.location,
    buildPathname(nav, params),
  );
  if (href !== null) window.history.pushState(null, "", href);
}

/**
 * Initial URL → store (pathname first, then legacy hash). Returns a notice
 * when the path was unknown and the store default page was opened instead.
 */
export function applyInitialUrl(): string | null {
  const { pathname, search, hash } = window.location;
  const resolved = resolvePathname(pathname);
  if (resolved) {
    setNav(resolved.nav, resolved.params);
    if (resolved.match !== "exact") {
      // Alias / known prefix (e.g. /styles) → canonical URL, keep the query
      // (an old /workflows?tab=… query becomes Setup's tab/section)
      window.history.replaceState(
        null,
        "",
        buildPathname(resolved.nav, resolved.params) +
          canonicalSearch(resolved, search),
      );
    }
    return null;
  }
  const navFromHash = parseHash(hash);
  if (navFromHash) {
    setNav(navFromHash, {});
    // Migrate: hash URL → pathname URL, keep the query
    window.history.replaceState(null, "", buildPathname(navFromHash) + search);
    return null;
  }
  // No route info in URL — use the store's page. An unknown path says so
  // rather than silently swapping pages.
  const newPath = buildPathname(useUIStore.getState().activeNav);
  const notice = unknownPathNotice(pathname, newPath);
  window.history.replaceState(null, "", newPath);
  return notice;
}

/** Back/forward: the URL (with its own query) → store. */
export function applyPoppedUrl(): void {
  const { pathname, search } = window.location;
  const resolved = resolvePathname(pathname);
  if (resolved) {
    if (resolved.legacy) {
      // An old history entry (/workflows, /manager…): show it as Setup
      window.history.replaceState(
        null,
        "",
        buildPathname(resolved.nav) + canonicalSearch(resolved, search),
      );
    }
    setNav(resolved.nav, resolved.params);
    return;
  }
  const navFromHash = parseHash(window.location.hash);
  if (navFromHash) setNav(navFromHash, {});
}

/** Store → URL subscription + popstate listener. Returns the teardown. */
export function startNavUrlSync(): () => void {
  const unsubscribe = useUIStore.subscribe((state, prev) => {
    if (applyingUrl > 0) return;
    if (
      state.activeNav === prev.activeNav &&
      state.navParams === prev.navParams
    ) {
      return;
    }
    pushNavUrl(state.activeNav, state.navParams);
  });
  window.addEventListener("popstate", applyPoppedUrl);
  return () => {
    unsubscribe();
    window.removeEventListener("popstate", applyPoppedUrl);
  };
}

/**
 * Navigate to a NavKey using pushState (no full page reload).
 * Updates both the URL and the UI store; the target page gets back the
 * query it had when the app last left it.
 */
export function navigateTo(nav: NavKey, params?: NavParams): void {
  const next = params ?? {};
  setNav(nav, next);
  pushNavUrl(nav, next);
}

/**
 * Navigate to a URL path (optionally with its own query), parsing it and
 * updating the store. Without a query the page's remembered one is used.
 */
export function navigateToPath(path: string): void {
  const queryAt = path.search(/[?#]/);
  const pathname = queryAt === -1 ? path : path.slice(0, queryAt);
  const suffix = queryAt === -1 ? "" : path.slice(queryAt);
  const result = resolvePathname(pathname);
  if (!result) return;
  setNav(result.nav, result.params);
  const target =
    result.match === "exact"
      ? pathname
      : buildPathname(result.nav, result.params);
  if (result.legacy) {
    // Old page link → Setup tab; its own query is translated, never recalled
    const query = suffix.startsWith("?") ? suffix.split("#")[0] : "";
    navQueryMemory.remember(window.location.pathname, window.location.search);
    window.history.pushState(
      null,
      "",
      target + canonicalSearch(result, query),
    );
    notifyNavQuery();
    return;
  }
  if (suffix) {
    navQueryMemory.remember(window.location.pathname, window.location.search);
    window.history.pushState(null, "", target + suffix);
    notifyNavQuery();
    return;
  }
  const href = navTransitionHref(navQueryMemory, window.location, target);
  if (href !== null) window.history.pushState(null, "", href);
}

/**
 * Route Mapper — path-to-NavKey bidirectional mapping with param extraction.
 *
 * This is a pure module (no React/Next.js deps) so it can be unit-tested
 * independently. It defines the mapping between URL path segments and the
 * NavKey values used in the app shell, including dynamic route params.
 */

import type { NavKey } from "@/types";
import {
  LEGACY_SETUP_PATHS,
  legacySetupSearch,
  type LegacySetupPage,
} from "@/lib/setupUrl";

type RouteParams = Record<string, string | undefined>;

// Route mapping definitions

/** A parsed route result: which NavKey + optional dynamic params */
export interface ParsedRoute {
  nav: NavKey;
  params: Record<string, string>;
}

/**
 * Static path → NavKey mapping.
 * Dynamic segments use `:param` syntax (e.g. `:id`).
 * For @username routes, the pattern is `/@:username`.
 * Order matters: more specific (dynamic) routes should be listed FIRST.
 */
const ROUTE_TABLE: readonly [pattern: string, nav: NavKey][] = [
  // Dynamic routes first (more specific → must match before their parent)
  ["/@:username", "profile"],
  ["/moodboards/:id", "moodboards"],
  ["/characters/:id", "characters"],
  // Styles hub URLs. `/styles` is the canonical Browse page (nav key
  // `library`). Its Map, Clusters, Images and Train views are nav key
  // `style-vault`, at `/style-vault` and `/styles/<view>`. Style datasets (nav
  // key `styles`, a legacy name) live at `/style-datasets`. `/styles/vault/:id`
  // and `/styles/:id` stay parseable for old bookmarks.
  ["/style-datasets/:id", "styles"],
  ["/styles/vault/:id", "style-vault"],
  ["/styles/vault", "style-vault"],
  ["/styles/:id", "style-vault"],
  ["/style-creator/:id", "style-creator"],
  // Static routes
  ["/settings", "account-settings"],
  ["/account", "account-settings"],
  ["/account-settings", "account-settings"],
  ["/explore", "explore"],
  ["/create", "create"],
  ["/edit", "edit"],
  ["/organize", "organize"],
  ["/personalize", "personalize"],
  ["/styles", "library"],
  ["/library", "library"],
  ["/moodboards", "moodboards"],
  ["/characters", "characters"],
  ["/style-datasets", "styles"],
  ["/style-creator", "style-creator"],
  ["/style-vault", "style-vault"],
  // Setup merges the old Workflows, Pipelines and Manager pages; their
  // paths are LEGACY_SETUP_PATHS (resolved below, query translated).
  ["/setup", "setup"],
  ["/tasks", "tasks"],
  ["/tools", "tools"],
  ["/help", "help"],
  ["/updates", "updates"],
  ["/profile", "profile"],
];

// NavKey → default path mapping (for URL construction)

const NAV_TO_DEFAULT_PATH: Record<NavKey, string> = {
  explore: "/explore",
  create: "/create",
  edit: "/edit",
  organize: "/organize",
  personalize: "/personalize",
  library: "/styles",
  moodboards: "/moodboards",
  characters: "/characters",
  styles: "/style-datasets",
  "style-creator": "/style-creator",
  "style-vault": "/style-vault",
  setup: "/setup",
  tasks: "/tasks",
  tools: "/tools",
  profile: "/profile",
  "account-settings": "/settings",
  help: "/help",
  updates: "/updates",
};

// Hash-based route table (legacy, still supported)

const HASH_ROUTES: Record<string, NavKey> = {
  explore: "explore",
  create: "create",
  edit: "edit",
  organize: "organize",
  personalize: "personalize",
  library: "library",
  moodboards: "moodboards",
  characters: "characters",
  "style-datasets": "styles",
  "style-creator": "style-creator",
  "style-vault": "style-vault",
  setup: "setup",
  // Old pages, now Setup tabs
  pipelines: "setup",
  workflows: "setup",
  manager: "setup",
  tasks: "tasks",
  tools: "tools",
  profile: "profile",
  "account-settings": "account-settings",
  help: "help",
  updates: "updates",
};

const STYLES_LIBRARY_VIEW_IDS: ReadonlySet<string> = new Set([
  "map",
  "clusters",
  "images",
  "train",
]);

// Path parsing

/**
 * Match a route pattern with `:param` segments against a concrete path.
 *
 * Special handling for `@`-prefixed segments: the pattern `/@:username`
 * is stored as a single pattern segment `@:username`. When the path
 * contains `/@alice`, it splits into `["@alice"]` while the pattern splits
 * into `["@:username"]`. We handle the `@` prefix by stripping it from
 * both sides before comparing.
 */
function matchPattern(
  pattern: string,
  path: string,
): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};

  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    const sp = pathParts[i];

    // Handle @-prefixed dynamic segments, e.g. pattern "@:username" vs path "@alice"
    if (pp.startsWith("@:") && sp.startsWith("@")) {
      const paramName = pp.slice(2); // strip "@:" to get "username"
      const paramValue = sp.slice(1); // strip "@" to get "alice"
      params[paramName] = paramValue;
      continue;
    }

    // Handle regular dynamic segments, e.g. pattern ":id" vs path "abc123"
    if (pp.startsWith(":")) {
      const paramName = pp.slice(1);
      params[paramName] = sp;
      continue;
    }

    // Static segment — must match exactly
    if (pp !== sp) return null;
  }

  return params;
}

/**
 * Match a URL pathname against the route table.
 * Returns the NavKey and extracted params, or null if no match.
 */
export function parsePathname(pathname: string): ParsedRoute | null {
  // Normalize: ensure leading slash, strip trailing slashes
  const path = "/" + pathname.replace(/^\/+/, "").replace(/\/+$/, "");

  for (const [pattern, nav] of ROUTE_TABLE) {
    const params = matchPattern(pattern, path);
    if (params !== null) {
      return { nav, params };
    }
  }

  // Root path → create (default landing)
  if (path === "/") {
    return { nav: "create", params: {} };
  }

  return null;
}

// Forgiving resolution (aliases + known-prefix fallback)

/**
 * Paths people type or guess that are not canonical routes. Each maps to the
 * page a reader would expect; the URL is then normalized to that page's
 * canonical path (`/style` and `/style-library` land on `/styles`).
 */
const PATH_ALIASES: Readonly<Record<string, NavKey>> = {
  "/style": "library",
  "/style-library": "library",
  "/moodboard": "moodboards",
  "/character": "characters",
  "/task": "tasks",
  "/tool": "tools",
  "/update": "updates",
  "/changelog": "updates",
  "/settings": "account-settings",
  "/me": "profile",
  "/home": "create",
  "/imagine": "create",
  "/editor": "edit",
  "/gallery": "organize",
  "/archive": "organize",
  "/feed": "explore",
};

/** A resolved route plus whether the URL was already the canonical form. */
export interface ResolvedRoute extends ParsedRoute {
  /** "exact" = a ROUTE_TABLE hit; "alias"/"prefix" = URL should be normalized. */
  match: "exact" | "alias" | "prefix";
  /** Set when the path was a page merged into Setup (its query needs translating). */
  legacy?: LegacySetupPage;
}

function normalizePath(pathname: string): string {
  return "/" + pathname.replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Like {@link parsePathname} but forgiving: tries exact routes, then
 * case-insensitive exact routes and aliases, then the first path segment
 * (e.g. `/organize/foo/bar` → organize). Returns null only when nothing
 * sensible matches, so callers can say so instead of silently rendering
 * the default page.
 */
export function resolvePathname(pathname: string): ResolvedRoute | null {
  const exact = parsePathname(pathname);
  if (exact) return { ...exact, match: "exact" };

  const path = normalizePath(pathname);
  const lower = path.toLowerCase();

  if (lower !== path) {
    const folded = parsePathname(lower);
    // Only static routes: dynamic params (ids, usernames) are case-sensitive
    if (folded && Object.keys(folded.params).length === 0) {
      return { ...folded, match: "alias" };
    }
  }

  const alias = PATH_ALIASES[lower];
  if (alias) return { nav: alias, params: {}, match: "alias" };
  const legacy = LEGACY_SETUP_PATHS[lower];
  if (legacy) return { nav: "setup", params: {}, match: "alias", legacy };

  const first = lower.split("/").filter(Boolean)[0];
  if (first && lower !== `/${first}`) {
    const head = `/${first}`;
    const headLegacy = LEGACY_SETUP_PATHS[head];
    if (headLegacy) {
      return { nav: "setup", params: {}, match: "prefix", legacy: headLegacy };
    }
    const headExact = parsePathname(head);
    if (headExact && Object.keys(headExact.params).length === 0) {
      return { nav: headExact.nav, params: {}, match: "prefix" };
    }
    const headAlias = PATH_ALIASES[head];
    if (headAlias) return { nav: headAlias, params: {}, match: "prefix" };
  }

  return null;
}

/**
 * Toast text for a path nothing resolved, or null when there is nothing to
 * say (root, or the fallback is the same path). Pure so it can be tested.
 */
export function unknownPathNotice(
  pathname: string,
  fallbackPath: string,
): string | null {
  const path = normalizePath(pathname);
  if (path === "/" || path === normalizePath(fallbackPath)) return null;
  const shown = path.length > 40 ? `${path.slice(0, 39)}…` : path;
  return `Nothing lives at ${shown} — opened ${fallbackPath} instead`;
}

/**
 * The query to keep when normalizing a resolved URL: an old Workflows /
 * Pipelines / Manager query becomes Setup's `?tab=&section=`.
 */
export function canonicalSearch(resolved: ResolvedRoute, search: string): string {
  return resolved.legacy ? legacySetupSearch(resolved.legacy, search) : search;
}

/** Match hash-based routes. Returns NavKey or null. */
export function parseHash(hash: string): NavKey | null {
  const segment = hash.replace(/^#\/?/, "");
  return HASH_ROUTES[segment] ?? null;
}

/**
 * Build a pathname for a given NavKey and params.
 * If params are provided and a dynamic route pattern exists, the full
 * path with params substituted in will be returned.
 * Otherwise falls back to the default static path.
 */
export function buildPathname(nav: NavKey, params?: RouteParams): string {
  // Library views get short URLs that parse back through `/styles/:id`.
  if (nav === "style-vault" && params?.id && STYLES_LIBRARY_VIEW_IDS.has(params.id)) {
    return `/styles/${params.id}`;
  }
  // If we have params, try to find a dynamic pattern
  if (params && Object.keys(params).length > 0) {
    for (const [pattern, patternNav] of ROUTE_TABLE) {
      if (patternNav !== nav) continue;
      if (!pattern.includes(":")) continue;

      let path = pattern;
      let allFilled = true;

      for (const [key, rawValue] of Object.entries(params)) {
        if (!rawValue) continue;
        const value = encodeURIComponent(rawValue);
        if (key === "username") {
          // /@:username → /@value
          const placeholder = "@:" + key;
          if (path.includes(placeholder)) {
            path = path.replace(placeholder, `@${value}`);
          } else {
            allFilled = false;
          }
        } else {
          const placeholder = `:${key}`;
          if (path.includes(placeholder)) {
            path = path.replace(placeholder, value);
          } else {
            allFilled = false;
          }
        }
      }

      // Verify all placeholders are filled
      if (allFilled && !path.includes(":")) {
        return path;
      }
    }
  }

  return NAV_TO_DEFAULT_PATH[nav] ?? "/create";
}

/** Build a hash URL for a NavKey (legacy format). */
export function buildHash(nav: NavKey): string {
  const route = Object.entries(HASH_ROUTES).find(
    ([, navKey]) => navKey === nav,
  );
  return route ? `#/${route[0]}` : "#/create";
}

/**
 * Determine the preferred URL from a NavKey + params.
 * Uses pathname-based routing.
 */
export function buildUrl(nav: NavKey, params?: RouteParams): string {
  return buildPathname(nav, params);
}

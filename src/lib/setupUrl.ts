/**
 * URL state for the Setup page (`/setup`): `?tab=` picks the top tab and
 * `?section=` the view inside it. Setup merges the old Workflows, Pipelines
 * and Manager pages; their URLs (and the old Workflows `?tab=` values) are
 * translated here so bookmarks and in-app links keep working.
 *
 * Pure module: no React, no store. `openSetupTab` (navigation) lives in
 * `setupNav.ts` so this file stays testable without a DOM.
 */

export const SETUP_TABS = ["workflows", "routing", "nodes", "models"] as const;
export type SetupTab = (typeof SETUP_TABS)[number];
export const DEFAULT_SETUP_TAB: SetupTab = "workflows";

/** Views inside each tab; the first one is the tab's default. */
export const SETUP_SECTIONS = {
  workflows: ["saved", "packs", "params", "import"],
  routing: ["slots"],
  nodes: ["packs", "templates"],
  models: ["names", "download", "catalog"],
} as const satisfies Record<SetupTab, readonly string[]>;

export type SetupSection<T extends SetupTab = SetupTab> =
  (typeof SETUP_SECTIONS)[T][number];

export const SETUP_TAB_LABELS: Record<SetupTab, string> = {
  workflows: "Workflows",
  routing: "Button routing",
  nodes: "Node packs",
  models: "Models",
};

export const SETUP_SECTION_LABELS: Record<string, string> = {
  "workflows.saved": "Saved workflows",
  "workflows.packs": "Workflow packs",
  "workflows.params": "Parameters",
  "workflows.import": "Import / export",
  "routing.slots": "Button routing",
  "nodes.packs": "Node packs",
  "nodes.templates": "Bundles",
  "models.names": "Model names",
  "models.download": "Download",
  "models.catalog": "Catalog",
};

export interface SetupLocation {
  tab: SetupTab;
  section: string;
}

export function isSetupTab(
  value: string | null | undefined,
): value is SetupTab {
  return (SETUP_TABS as readonly string[]).includes(value ?? "");
}

export function defaultSection(tab: SetupTab): string {
  return SETUP_SECTIONS[tab][0];
}

/** Read `?tab=` / `?section=`; unknown values fall back to the defaults. */
export function parseSetupLocation(
  search: string | URLSearchParams,
): SetupLocation {
  const sp = typeof search === "string" ? new URLSearchParams(search) : search;
  const rawTab = sp.get("tab");
  const tab = isSetupTab(rawTab) ? rawTab : DEFAULT_SETUP_TAB;
  const rawSection = sp.get("section") ?? "";
  const sections = SETUP_SECTIONS[tab] as readonly string[];
  const section = sections.includes(rawSection) ? rawSection : sections[0];
  return { tab, section };
}

/**
 * Query update for a tab/section change. Defaults are left out of the URL;
 * changing tab also drops the old tab's section.
 */
export function setupLocationToUrl(loc: { tab: SetupTab; section?: string }): {
  tab: string | null;
  section: string | null;
} {
  const section =
    loc.section && loc.section !== defaultSection(loc.tab) ? loc.section : null;
  return {
    tab: loc.tab === DEFAULT_SETUP_TAB ? null : loc.tab,
    section,
  };
}

/** `/setup` href for a tab (and optional section + extra query). */
export function setupHref(
  tab: SetupTab,
  section?: string,
  extra?: Record<string, string>,
): string {
  const sp = new URLSearchParams();
  const q = setupLocationToUrl({ tab, section });
  if (q.tab) sp.set("tab", q.tab);
  if (q.section) sp.set("section", q.section);
  for (const [k, v] of Object.entries(extra ?? {})) if (v) sp.set(k, v);
  const qs = sp.toString();
  return qs ? `/setup?${qs}` : "/setup";
}

// Legacy pages

/** Pages merged into Setup, keyed by their old path segment. */
export type LegacySetupPage = "workflows" | "pipelines" | "manager" | "models";

export const LEGACY_SETUP_PATHS: Readonly<Record<string, LegacySetupPage>> = {
  "/workflows": "workflows",
  "/workflow": "workflows",
  "/pipelines": "pipelines",
  "/pipeline": "pipelines",
  "/button-routing": "pipelines",
  "/routing": "pipelines",
  "/manager": "manager",
  "/node-packs": "manager",
  "/nodes": "manager",
  "/models": "models",
};

/** Old Workflows `?tab=` values → Setup tab/section. */
const LEGACY_WORKFLOWS_TABS: Readonly<Record<string, SetupLocation>> = {
  aliases: { tab: "models", section: "names" },
  workflows: { tab: "workflows", section: "saved" },
  packs: { tab: "workflows", section: "packs" },
  civitai: { tab: "models", section: "download" },
  params: { tab: "workflows", section: "params" },
  import: { tab: "workflows", section: "import" },
};

/** Where an old page's URL lands in Setup (old Workflows `?tab=` kept). */
export function legacySetupLocation(
  page: LegacySetupPage,
  search: string,
): SetupLocation {
  const sp = new URLSearchParams(search);
  if (page === "pipelines") return { tab: "routing", section: "slots" };
  if (page === "manager") return { tab: "nodes", section: "packs" };
  if (page === "models") return { tab: "models", section: "names" };
  const old = sp.get("tab");
  if (old && LEGACY_WORKFLOWS_TABS[old]) return LEGACY_WORKFLOWS_TABS[old];
  return { tab: "workflows", section: "saved" };
}

/**
 * Rewrite an old page's query for `/setup`: its tab becomes Setup's
 * tab/section, every other key (e.g. the Civitai filters) is kept.
 */
export function legacySetupSearch(
  page: LegacySetupPage,
  search: string,
): string {
  const loc = legacySetupLocation(page, search);
  const sp = new URLSearchParams(search);
  sp.delete("tab");
  sp.delete("section");
  const q = setupLocationToUrl(loc);
  const out = new URLSearchParams();
  if (q.tab) out.set("tab", q.tab);
  if (q.section) out.set("section", q.section);
  for (const [k, v] of sp) out.append(k, v);
  const qs = out.toString();
  return qs ? `?${qs}` : "";
}

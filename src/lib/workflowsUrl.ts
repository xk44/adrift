/**
 * URL state for the Workflows page: `?tab=` plus the Civitai tab's model
 * browser filters and search. Uses the same filter keys as Explore → Models
 * (src, msort, mperiod, …, see modelFilters.ts) so links read the same; only
 * non-default values are written.
 */
import {
  DEFAULT_MODEL_FILTERS,
  modelFiltersFromUrl,
  modelFiltersToUrl,
  type ModelFilters,
} from "@/lib/modelFilters";

export const WORKFLOWS_TABS = [
  "aliases",
  "workflows",
  "packs",
  "civitai",
  "params",
  "import",
] as const;
export type WorkflowsTab = (typeof WORKFLOWS_TABS)[number];
export const DEFAULT_WORKFLOWS_TAB: WorkflowsTab = "aliases";

export function parseWorkflowsTab(value: string | null): WorkflowsTab {
  return (WORKFLOWS_TABS as readonly string[]).includes(value ?? "")
    ? (value as WorkflowsTab)
    : DEFAULT_WORKFLOWS_TAB;
}

/** `?tab=` update (the default tab is left out of the URL). */
export function workflowsTabToUrl(tab: WorkflowsTab): { tab: string | null } {
  return { tab: tab === DEFAULT_WORKFLOWS_TAB ? null : tab };
}

/** The Civitai tab opens on the most-downloaded models. */
export const WORKFLOWS_CIVITAI_DEFAULTS: ModelFilters = {
  ...DEFAULT_MODEL_FILTERS,
  sort: "Most Downloaded",
};

export interface WorkflowsCivitaiState {
  filters: ModelFilters;
  query: string;
}

export function workflowsCivitaiFromUrl(
  sp: URLSearchParams,
): WorkflowsCivitaiState {
  return {
    filters: modelFiltersFromUrl(sp, WORKFLOWS_CIVITAI_DEFAULTS),
    query: sp.get("q") ?? "",
  };
}

export function workflowsCivitaiFiltersToUrl(
  filters: ModelFilters,
): Record<string, string | null> {
  return modelFiltersToUrl(filters, WORKFLOWS_CIVITAI_DEFAULTS);
}

export function workflowsCivitaiQueryToUrl(query: string): { q: string | null } {
  return { q: query.trim() ? query : null };
}

/**
 * Open a Setup tab from anywhere (contextual "Get model", "Open node packs",
 * "Button routing" links). Setup is the one home for workflows, button
 * routing, node packs and model downloads; other pages link here instead of
 * carrying their own copy of that UI.
 */
import { navigateToPath } from "@/lib/navUrlSync";
import { setupHref, type SetupTab } from "@/lib/setupUrl";

export function openSetupTab(
  tab: SetupTab,
  section?: string,
  /** Extra query, e.g. `{ q: "flux" }` to pre-fill the model search. */
  extra?: Record<string, string>,
): void {
  navigateToPath(setupHref(tab, section, extra));
}

/** Setup › Models › Download, optionally searching for `query`. */
export function openModelDownloads(query?: string): void {
  openSetupTab("models", "download", query ? { q: query } : undefined);
}

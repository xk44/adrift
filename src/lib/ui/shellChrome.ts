import type { NavKey } from "@/types";
import { isStylesNav } from "@/lib/stylesHub";

/**
 * Pages that render without the global prompt bar: the quiet account/info
 * pages (the reference site's updates and account pages have no prompt
 * input) and Setup (workflows, button routing, node packs,
 * models), where a prompt has nothing to act on.
 */
export const CHROME_PAGES: readonly NavKey[] = [
  "updates",
  "account-settings",
  "help",
  "setup",
];

export function isChromePage(nav: NavKey): boolean {
  return CHROME_PAGES.includes(nav);
}

/**
 * Pages that keep the prompt bar on desktop but drop it below md, where the
 * ~140 px dock would eat a third of a phone screen on a page whose own
 * controls are the point (Tools, Styles, Profile). Create/Explore/Organize
 * and the boards keep it everywhere.
 */
export const DESKTOP_PROMPT_PAGES: readonly NavKey[] = ["tools", "profile"];

export function isPromptBarDesktopOnly(nav: NavKey): boolean {
  return DESKTOP_PROMPT_PAGES.includes(nav) || isStylesNav(nav);
}

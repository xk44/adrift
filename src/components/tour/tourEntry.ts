/**
 * Shared "Take the tour" / "What's on this page" entry points (Help,
 * Settings, account menu, command palette).
 */
import { useUIStore } from "@/store";
import { NAV_DESTINATIONS } from "@/lib/ui/navRegistry";
import { startPageTour, tourResumePoint } from "@/store/tourStore";
import type { NavKey } from "@/types";

const NO_STOPS_HINT =
  "Nothing to point out here yet. Take the full tour for a walk through every page.";

/** Label + hint for a page the intro never visits. */
export function pageTourFallback(nav: NavKey): { label: string; hint: string } {
  const dest = NAV_DESTINATIONS.find(
    (d) => d.key === nav || d.aliases?.includes(nav),
  );
  return dest
    ? { label: dest.label, hint: dest.hint }
    : { label: "This page", hint: NO_STOPS_HINT };
}

/** "What's on this page" for the page that is open now. */
export function startCurrentPageTour(): void {
  const nav = useUIStore.getState().activeNav;
  startPageTour(nav, pageTourFallback(nav));
}

/** Sub-line for "Take the tour": where it picks up, if it was paused. */
export function tourEntryHint(): string {
  const at = tourResumePoint();
  return at
    ? `Picks up at stop ${at.index + 1} of ${at.count}`
    : "A short walk through every page";
}

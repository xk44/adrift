"use client";

/**
 * Runs the intro tour: starts it once after the first-run setup wizard
 * closes (see shouldAutoStartTour), on `?tour=1`, or from Help / Settings /
 * the command palette via startTour(); moves the app to each stop's page and
 * renders the overlay.
 */
import { useEffect, useRef } from "react";
import { useUIStore } from "@/store";
import { useExploreStore } from "@/store/exploreStore";
import { useOnboardingStore } from "@/store/onboardingStore";
import { startTour, useTourStore } from "@/store/tourStore";
import { navigateToDestination } from "@/lib/ui/navRegistry";
import { navigateToPath } from "@/lib/navUrlSync";
import {
  forcedTour,
  readTourSeen,
  shouldAutoStartTour,
  stripTourParam,
  type TourPage,
  type TourPrepare,
} from "@/lib/tour/tour";
import { showToast } from "@/components/Toast";
import { TourOverlay } from "./TourOverlay";

/** Wait after the wizard closes (its "try a prompt" focus runs first). */
const AUTO_START_DELAY_MS = 400;
/** The prompt settings panel docks beside the feed from here up (a full-screen sheet below). */
const DOCKED_PANEL_MIN_WIDTH = 768;

function goToPage(page: TourPage): void {
  if ("path" in page) {
    navigateToPath(page.path);
    return;
  }
  const ui = useUIStore.getState();
  navigateToDestination(page.nav, {
    setActiveNav: ui.setActiveNav,
    setStylesHubTab: ui.setStylesHubTab,
  });
}

/** Apply a stop's page set-up; returns its undo. */
function runPrepare(prepare: TourPrepare): () => void {
  switch (prepare) {
    case "explore-models": {
      const prev = useExploreStore.getState().secondaryTab;
      if (prev === "models") return () => {};
      useExploreStore.getState().setSecondaryTab("models");
      return () => {
        // Only while still on Explore: the store writes ?view= to the URL.
        if (useUIStore.getState().activeNav === "explore")
          useExploreStore.getState().setSecondaryTab(prev);
      };
    }
    case "prompt-settings": {
      // Phones: the panel would cover the whole screen, so the stop
      // falls back to the prompt controls instead.
      const ui = useUIStore.getState();
      if (ui.settingsOpen || window.innerWidth < DOCKED_PANEL_MIN_WIDTH)
        return () => {};
      ui.setSettingsOpen(true);
      return () => useUIStore.getState().setSettingsOpen(false);
    }
  }
}

export function TourHost() {
  const open = useTourStore((s) => s.open);
  const tour = useTourStore((s) => s.tour);
  const steps = useTourStore((s) => s.steps);
  const index = useTourStore((s) => s.index);
  const next = useTourStore((s) => s.next);
  const back = useTourStore((s) => s.back);
  const goTo = useTourStore((s) => s.goTo);
  const skip = useTourStore((s) => s.skip);
  const close = useTourStore((s) => s.close);
  const undoPrepare = useRef<(() => void) | null>(null);

  // ?tour=1: start now (works in automated browsers too), then drop the param
  // so reload / Back don't replay it.
  useEffect(() => {
    const { search, pathname, hash } = window.location;
    if (!forcedTour(search)) return;
    window.history.replaceState(
      window.history.state,
      "",
      pathname + stripTourParam(search) + hash,
    );
    startTour({ fresh: true });
  }, []);

  // Once, right after the first-run wizard closes.
  useEffect(() => {
    let timer: number | undefined;
    const unsub = useOnboardingStore.subscribe((s, prev) => {
      const go = shouldAutoStartTour(
        { wasOpen: prev.open, wasFirstRun: prev.firstRun, isOpen: s.open },
        readTourSeen(),
      );
      if (!go) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!useOnboardingStore.getState().open) startTour({ fresh: true });
      }, AUTO_START_DELAY_MS);
    });
    return () => {
      unsub();
      window.clearTimeout(timer);
    };
  }, []);

  // Clear the way when the tour opens: settings panel and lightbox would
  // cover the stops.
  useEffect(() => {
    if (!open) return;
    const ui = useUIStore.getState();
    ui.setSettingsOpen(false);
    ui.closeLightbox();
  }, [open]);

  // Move to each stop's page; undo the previous stop's set-up first.
  useEffect(() => {
    if (!open) return;
    const step = steps[index];
    if (!step) return;
    undoPrepare.current?.();
    undoPrepare.current = null;
    goToPage(step.page);
    if (step.prepare) undoPrepare.current = runPrepare(step.prepare);
  }, [open, index, steps]);

  useEffect(() => {
    if (open) return;
    undoPrepare.current?.();
    undoPrepare.current = null;
  }, [open]);

  if (!open) return null;
  const step = steps[index];
  if (!step) return null;
  const intro = tour === "intro";

  return (
    <TourOverlay
      step={step}
      steps={steps}
      index={index}
      onNext={next}
      onBack={back}
      onGoTo={goTo}
      skipLabel={intro ? "Skip tour" : "Close"}
      onSkip={() => {
        const resumable = intro && index > 0 && index < steps.length - 1;
        skip();
        if (resumable)
          showToast(
            "Tour paused. Take the tour again from Help or the command palette to pick up here.",
            "info",
          );
      }}
      finishAction={
        intro
          ? {
              label: "Open Help",
              onClick: () => {
                close();
                goToPage({ nav: "help" });
              },
            }
          : {
              label: "Full tour",
              onClick: () => startTour({ fresh: true }),
            }
      }
    />
  );
}

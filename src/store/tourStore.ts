/**
 * Guided tours: the intro walk-through and per-page "What's on this page".
 * Transitions live in tourReducer (pure); this store adds persistence: the
 * intro marks itself seen, remembers where it was skipped, and resumes there.
 * TourHost renders it.
 */
import { createWithEqualityFn } from "zustand/traditional";
import type { NavKey } from "@/types";
import {
  markTourSeen,
  readTourProgress,
  resumeIndex,
  TOUR_CLOSED,
  TOUR_STEPS,
  tourReducer,
  tourSteps,
  writeTourProgress,
  type TourEvent,
  type TourId,
  type TourStep,
} from "@/lib/tour/tour";

interface TourState {
  open: boolean;
  tour: TourId;
  index: number;
  /** Stops of the open tour (page tours are computed when they start). */
  steps: readonly TourStep[];
  /** Start the intro; resumes at the saved stop unless `fresh`. */
  start: (opts?: { fresh?: boolean }) => void;
  startPage: (nav: NavKey, fallback?: { label: string; hint: string }) => void;
  next: () => void;
  back: () => void;
  goTo: (index: number) => void;
  /** Close before the end; the intro remembers the stop to resume from. */
  skip: () => void;
  /** Close without saving progress (finished, or closed by the app). */
  close: () => void;
}

export const useTourStore = createWithEqualityFn<TourState>((set, get) => {
  const send = (event: TourEvent) => {
    const { open, tour, index, steps } = get();
    const nextState = tourReducer({ open, tour, index }, event, steps.length);
    if (tour === "intro" && open && !nextState.open) {
      // Finished (next past the end) clears; skip mid-way saves the stop.
      const resumable =
        event.type === "skip" && index > 0 && index < steps.length - 1;
      writeTourProgress(resumable ? (steps[index]?.id ?? null) : null);
    }
    set(nextState);
  };
  return {
    ...TOUR_CLOSED,
    steps: TOUR_STEPS,
    start: (opts) => {
      markTourSeen();
      const index = opts?.fresh
        ? 0
        : resumeIndex(TOUR_STEPS, readTourProgress());
      writeTourProgress(null);
      set({ steps: TOUR_STEPS });
      send({ type: "start", tour: "intro", index });
    },
    startPage: (nav, fallback) => {
      const tour: TourId = `page:${nav}`;
      set({ steps: tourSteps(tour, fallback) });
      send({ type: "start", tour });
    },
    next: () => send({ type: "next" }),
    back: () => send({ type: "back" }),
    goTo: (index) => send({ type: "goto", index }),
    skip: () => send({ type: "skip" }),
    close: () => {
      const { tour, open } = get();
      if (tour === "intro" && open) writeTourProgress(null);
      set({ ...TOUR_CLOSED, tour });
    },
  };
});

/** Start (or resume) the intro from anywhere, no hook needed. */
export function startTour(opts?: { fresh?: boolean }): void {
  useTourStore.getState().start(opts);
}

/** "What's on this page" for `nav`. */
export function startPageTour(
  nav: NavKey,
  fallback?: { label: string; hint: string },
): void {
  useTourStore.getState().startPage(nav, fallback);
}

/** The intro stop a "Resume" entry would open, or null when it starts fresh. */
export function tourResumePoint(): { index: number; count: number } | null {
  const index = resumeIndex(TOUR_STEPS, readTourProgress());
  return index > 0 ? { index, count: TOUR_STEPS.length } : null;
}

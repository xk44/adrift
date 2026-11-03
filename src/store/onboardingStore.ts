/**
 * First-run wizard ("Set up Adrift"): open/close + current step.
 *
 * `openOnboarding()` is the one entry point for every caller (Settings,
 * the command palette, a first-run screen); OnboardingHost renders the wizard.
 */
import { createWithEqualityFn } from "zustand/traditional";

export type OnboardingStep = "connect" | "folders" | "packs" | "done";

/** localStorage flag: the wizard was finished or skipped once. */
export const ONBOARDED_KEY = "adrift.onboarded";

export interface OpenOnboardingOptions {
  /** Starter pack id to show, tick and scroll to on the Models step. */
  focus?: string;
  /**
   * Opened by the first-run check (OnboardingHost), not by hand. Closing a
   * first-run wizard starts the intro tour once (TourHost).
   */
  firstRun?: boolean;
}

interface OnboardingState {
  open: boolean;
  step: OnboardingStep;
  /** Pack the caller asked to highlight (Models step); null otherwise. */
  focus: string | null;
  /** This wizard was opened by the first-run check. */
  firstRun: boolean;
  openOnboarding: (step?: OnboardingStep, opts?: OpenOnboardingOptions) => void;
  setStep: (step: OnboardingStep) => void;
  close: () => void;
}

export const useOnboardingStore = createWithEqualityFn<OnboardingState>((set, get) => ({
  open: false,
  step: "connect",
  focus: null,
  firstRun: false,
  openOnboarding: (step = "connect", opts) =>
    set({
      open: true,
      step,
      focus: opts?.focus ?? null,
      // A jump to another step of an open first-run wizard keeps it first-run.
      firstRun: opts?.firstRun ?? (get().open && get().firstRun),
    }),
  setStep: (step) => set({ step }),
  close: () => set({ open: false, focus: null, firstRun: false }),
}));

/** Open the setup wizard from anywhere (no hook needed). */
export function openOnboarding(
  step?: OnboardingStep,
  opts?: OpenOnboardingOptions,
): void {
  useOnboardingStore.getState().openOnboarding(step, opts);
}

/**
 * "Finished or skipped once" is kept server-side (data/runtime_settings.json,
 * POST /api/settings/onboarded) so every device on the network skips the
 * wizard after one completes it. localStorage is a fast cache and the
 * fallback when the server can't be reached or written.
 */
export function readOnboarded(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDED_KEY) === "1";
  } catch {
    return false;
  }
}

function cacheOnboarded(): void {
  try {
    window.localStorage.setItem(ONBOARDED_KEY, "1");
  } catch {
    // private mode / blocked storage: the wizard may show again, harmless
  }
}

/** Seen from the server (GET /api/settings/comfy-connection `onboarded`). */
export function syncOnboardedFromServer(serverOnboarded: boolean | undefined): boolean {
  if (serverOnboarded) cacheOnboarded();
  return readOnboarded() || !!serverOnboarded;
}

export function markOnboarded(): void {
  cacheOnboarded();
  // Best effort: a failed save only means another device may still see it.
  try {
    void fetch("/api/settings/onboarded", {
      method: "POST",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    }).catch(() => undefined);
  } catch {
    // no fetch (old test env): local cache still applies
  }
}

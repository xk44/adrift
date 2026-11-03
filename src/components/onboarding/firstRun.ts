/**
 * Which wizard step a first visit opens on, or null for none.
 *
 * ComfyUI already answering is the common case: open on the Folders step
 * (prefilled, one Next) and then the VRAM-matched starter models.
 * Not configured or not answering: start at Connect.
 */
import type { OnboardingStep } from "@/store/onboardingStore";

export function firstRunStep(
  status: { configured: boolean; reachable: boolean } | null,
): OnboardingStep | null {
  if (!status) return null;
  if (status.reachable) return "folders";
  return "connect";
}

const STEPS: readonly OnboardingStep[] = ["connect", "folders", "packs", "done"];

/** `?setup=folders` (or connect / packs / done) -> that step, else null. */
export function forcedSetupStep(search: string): OnboardingStep | null {
  const v = new URLSearchParams(search).get("setup");
  return v && (STEPS as readonly string[]).includes(v)
    ? (v as OnboardingStep)
    : null;
}

"use client";

/**
 * Mount once (page.tsx). Keeps the browser's ComfyUI socket pointed at the
 * saved connection, opens the setup wizard once on first run (at Connect when
 * ComfyUI isn't answering, at the starter models when it is), and renders it
 * whenever openOnboarding() is called.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { setComfyWsBaseOverride } from "@/lib/comfy/wsBaseOverride";
import {
  clearBackendProfile,
  primeBackendProfile,
} from "@/lib/models/backendProfile";
import {
  backendKey,
  notifyComfyBackendChanged,
} from "@/lib/comfy/backendChange";
import { syncOnboardedFromServer, useOnboardingStore } from "@/store/onboardingStore";
import { getConnection, type ConnectionStatus } from "./api";
import { OnboardingWizard } from "./OnboardingWizard";
import { firstRunStep, forcedSetupStep } from "./firstRun";

export function OnboardingHost() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const open = useOnboardingStore((s) => s.open);
  const checkedFirstRun = useRef(false);
  const lastBackend = useRef<string | null>(null);

  const load = useCallback(
    async (quick = false): Promise<ConnectionStatus | null> => {
      const s = await getConnection(quick);
      if (!s) return null;
      setStatus(s);
      // Another ComfyUI (address or token): forget what the old one told us.
      const key = backendKey(s);
      const switched = lastBackend.current !== null && key !== lastBackend.current;
      lastBackend.current = key;
      if (switched) {
        clearBackendProfile();
        notifyComfyBackendChanged();
      }
      if (setComfyWsBaseOverride(s.wsBase)) {
        // Address changed: drop the cached GPU profile, reconnect the socket.
        clearBackendProfile();
        window.dispatchEvent(new Event("cj:ws-reconnect"));
      }
      if (s.probe.ok) primeBackendProfile(s.probe.profile);
      return s;
    },
    [],
  );
  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  useEffect(() => {
    // ?setup=<step> opens the wizard at that step (docs, screenshots); it
    // works in automated browsers and changes no saved setting.
    const forced = forcedSetupStep(
      typeof window !== "undefined" ? window.location.search : "",
    );
    if (forced) {
      checkedFirstRun.current = true;
      useOnboardingStore.getState().openOnboarding(forced);
    }
    void (async () => {
      const latest = await load(true);
      if (checkedFirstRun.current) return;
      checkedFirstRun.current = true;
      const s = useOnboardingStore.getState();
      if (s.open || syncOnboardedFromServer(latest?.onboarded)) return;
      // Automated browsers (tests, screenshots) never get the wizard unasked.
      if (typeof navigator !== "undefined" && navigator.webdriver) return;
      const step = firstRunStep(latest);
      // firstRun: closing this wizard starts the intro tour once.
      if (step)
        useOnboardingStore.getState().openOnboarding(step, { firstRun: true });
    })();
  }, [load]);

  // Fresh status each time the wizard opens.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  return <OnboardingWizard status={status} refreshStatus={refresh} />;
}

"use client";

import { useEffect, useState } from "react";
import type { BackendProfile } from "@/lib/models/compat";
import { getBackendProfile } from "@/lib/models/backendProfile";

export type BackendProfileStatus = "loading" | "ready" | "offline";

/** While ComfyUI is unreachable, check again this often. */
export const PROFILE_RETRY_MS = 10_000;

/**
 * Load the profile; while offline keep re-checking so connecting ComfyUI
 * later lights up the chips / toggle without a page reload. Returns a stop fn.
 */
export function watchBackendProfile(
  onResult: (profile: BackendProfile | null) => void,
  get: () => Promise<BackendProfile | null> = () => getBackendProfile(),
  retryMs: number = PROFILE_RETRY_MS,
): () => void {
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    void get().then((profile) => {
      if (!alive) return;
      onResult(profile);
      if (!profile) timer = setTimeout(run, retryMs);
    });
  };
  run();
  return () => {
    alive = false;
    if (timer) clearTimeout(timer);
  };
}

/**
 * The connected ComfyUI's GPU profile for model cards and the "Fits my GPU"
 * filter. getBackendProfile() memoizes and shares one in-flight request, so
 * every caller on the page costs a single GET /api/comfy/system.
 */
export function useBackendProfile(): {
  profile: BackendProfile | null;
  status: BackendProfileStatus;
} {
  const [state, setState] = useState<{
    profile: BackendProfile | null;
    status: BackendProfileStatus;
  }>({ profile: null, status: "loading" });
  useEffect(
    () =>
      watchBackendProfile((profile) =>
        setState({ profile, status: profile ? "ready" : "offline" }),
      ),
    [],
  );
  return state;
}

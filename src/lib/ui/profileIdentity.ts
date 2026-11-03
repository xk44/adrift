"use client";

import { useEffect, useState } from "react";
import { STORAGE_KEYS, readLocalStorage } from "@/lib/storageKeys";

export interface ProfileIdentity {
  /** Display name or username; the shell shows only the avatar. */
  name: string;
  /** Avatar letter, or null to show the generic person icon. */
  initial: string | null;
}

/** Shown until the user sets a display name (not a fake "User"). */
export const PROFILE_FALLBACK: ProfileIdentity = {
  name: "Profile",
  initial: null,
};

/** The pre-fill the profile pages store before the user edits anything. */
const PLACEHOLDER_NAMES = new Set(["user", ""]);

/**
 * Account-row identity from the stored local profile JSON
 * (STORAGE_KEYS.profile). Display name first, then username; the
 * "User"/"user" placeholders count as unset.
 */
export function profileIdentity(raw: string | null): ProfileIdentity {
  if (!raw) return PROFILE_FALLBACK;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return PROFILE_FALLBACK;
  }
  if (!parsed || typeof parsed !== "object") return PROFILE_FALLBACK;
  const p = parsed as { displayName?: unknown; username?: unknown };
  for (const candidate of [p.displayName, p.username]) {
    if (typeof candidate !== "string") continue;
    const name = candidate.trim();
    if (PLACEHOLDER_NAMES.has(name.toLowerCase())) continue;
    const initial = Array.from(name)[0]?.toUpperCase() ?? null;
    return { name, initial };
  }
  return PROFILE_FALLBACK;
}

/**
 * Hydration-safe hook: renders the fallback on the server and first paint,
 * then the stored profile; refreshes on cross-tab storage writes and when
 * the window regains focus.
 */
export function useProfileIdentity(): ProfileIdentity {
  const [identity, setIdentity] = useState<ProfileIdentity>(PROFILE_FALLBACK);
  useEffect(() => {
    const read = () =>
      setIdentity(profileIdentity(readLocalStorage(STORAGE_KEYS.profile)));
    read();
    window.addEventListener("storage", read);
    window.addEventListener("focus", read);
    return () => {
      window.removeEventListener("storage", read);
      window.removeEventListener("focus", read);
    };
  }, []);
  return identity;
}

/**
 * Saved Character Profiles as identity-training seeds. Reads the persisted
 * profile store straight from browser storage (key and shape owned by the
 * character profile store), so this module never imports the store and
 * works whether or not any profiles exist.
 */

import { STORAGE_KEYS, readLocalStorage } from "@/lib/storageKeys";

export const PROFILE_STORAGE_KEY = STORAGE_KEYS.characterProfiles;

export interface ProfileSeed {
  id: string;
  name: string;
  /** Usable photo URLs: data: images or same-origin paths. */
  photos: string[];
}

function usablePhotoUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (/^data:image\/(png|jpe?g|webp);base64,/i.test(value)) return value;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  return null;
}

/** Parse the persisted zustand payload; anything malformed yields []. */
export function parseProfileSeeds(raw: string | null): ProfileSeed[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const profiles = (data as { state?: { profiles?: unknown } } | null)?.state
    ?.profiles;
  if (!Array.isArray(profiles)) return [];
  const out: ProfileSeed[] = [];
  for (const p of profiles) {
    if (!p || typeof p !== "object") continue;
    const { id, name, refs } = p as {
      id?: unknown;
      name?: unknown;
      refs?: unknown;
    };
    if (typeof id !== "string" || typeof name !== "string") continue;
    const photos = (Array.isArray(refs) ? refs : [])
      .map((r) => {
        const ref = r as { dataUrl?: unknown; previewUrl?: unknown } | null;
        return usablePhotoUrl(ref?.dataUrl) ?? usablePhotoUrl(ref?.previewUrl);
      })
      .filter((u): u is string => u !== null);
    if (photos.length) out.push({ id, name, photos });
  }
  return out;
}

export function readProfileSeeds(): ProfileSeed[] {
  try {
    return parseProfileSeeds(readLocalStorage(PROFILE_STORAGE_KEY));
  } catch {
    return [];
  }
}

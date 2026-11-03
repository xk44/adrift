/**
 * Saved Locations
 * Reusable places for Cinema Studio multi-shot scenes: a name, the location
 * text every shot shares, and an optional reference image (a gallery pick or
 * a downscaled upload, stored the same way as Character Profile refs).
 *
 * Pure helpers only; the persisted store lives in
 * `src/store/cinemaLocationStore.ts`.
 */

import type { ToolImage } from "./runTool";
import { fromStoredRef, toStoredRef } from "./characterProfiles";

export const LOCATION_NAME_MAX = 60;
/** Same cap as the scene editor's location field. */
export const LOCATION_TEXT_MAX = 300;
export const LOCATION_MAX = 50;
/** Serialized-size ceiling for all locations (localStorage is shared, ~5 MB). */
export const LOCATION_STORAGE_BUDGET = 1_500_000;

export interface SavedLocation {
  id: string;
  name: string;
  /** Location text shared by every shot of a scene. */
  description: string;
  /** Optional reference image (stored form, see toStoredRef). */
  ref?: ToolImage;
  createdAt: number;
  updatedAt: number;
}

export interface LocationDraft {
  id?: string;
  name: string;
  description: string;
  ref?: ToolImage | null;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Why a draft can't be saved, or null. */
export function validateLocationDraft(draft: LocationDraft): string | null {
  if (!oneLine(draft.name)) return "Give the location a name.";
  if (!oneLine(draft.description)) return "Describe the location first.";
  if (draft.ref && draft.ref.source === "upload" && !draft.ref.dataUrl)
    return "The reference image is still loading.";
  return null;
}

export function newLocationId(now = Date.now()): string {
  return `loc_${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Normalize a valid draft into a location (throws on an invalid one). */
export function buildLocation(
  draft: LocationDraft,
  prev?: SavedLocation,
  now = Date.now(),
): SavedLocation {
  const err = validateLocationDraft(draft);
  if (err) throw new Error(err);
  const out: SavedLocation = {
    id: prev?.id ?? draft.id ?? newLocationId(now),
    name: oneLine(draft.name).slice(0, LOCATION_NAME_MAX),
    description: oneLine(draft.description).slice(0, LOCATION_TEXT_MAX),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  if (draft.ref) out.ref = toStoredRef(draft.ref);
  return out;
}

/**
 * Insert or replace (same id, or same name ignoring case) at the front.
 * Oldest entries past LOCATION_MAX drop off the end.
 */
export function upsertLocation(
  list: SavedLocation[],
  loc: SavedLocation,
): SavedLocation[] {
  const key = loc.name.toLowerCase();
  const rest = list.filter(
    (l) => l.id !== loc.id && l.name.toLowerCase() !== key,
  );
  return [loc, ...rest].slice(0, LOCATION_MAX);
}

/** Saved ref back into a submittable ToolImage, or null. */
export function locationImage(loc: SavedLocation): ToolImage | null {
  return loc.ref ? fromStoredRef(loc.ref) : null;
}

export function locationsSize(list: SavedLocation[]): number {
  return JSON.stringify(list).length;
}

function isRef(v: unknown): v is ToolImage {
  if (!v || typeof v !== "object") return false;
  const r = v as Partial<ToolImage>;
  if (typeof r.id !== "string" || typeof r.label !== "string") return false;
  if (r.source === "gallery") return typeof r.previewUrl === "string";
  if (r.source === "upload")
    return typeof r.dataUrl === "string" && r.dataUrl.startsWith("data:image/");
  return false;
}

/** Drop malformed entries from persisted state (old versions, hand edits). */
export function sanitizeLocations(raw: unknown): SavedLocation[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedLocation[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (out.length >= LOCATION_MAX) break;
    if (!v || typeof v !== "object") continue;
    const l = v as Partial<SavedLocation>;
    if (typeof l.id !== "string" || seen.has(l.id)) continue;
    if (typeof l.name !== "string" || !oneLine(l.name)) continue;
    if (typeof l.description !== "string" || !oneLine(l.description)) continue;
    seen.add(l.id);
    const loc: SavedLocation = {
      id: l.id,
      name: oneLine(l.name).slice(0, LOCATION_NAME_MAX),
      description: oneLine(l.description).slice(0, LOCATION_TEXT_MAX),
      createdAt: Number(l.createdAt) || 0,
      updatedAt: Number(l.updatedAt) || 0,
    };
    if (isRef(l.ref))
      loc.ref = {
        ...l.ref,
        width: Number(l.ref.width) || 0,
        height: Number(l.ref.height) || 0,
      };
    out.push(loc);
  }
  return out;
}

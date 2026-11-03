/**
 * Character Profiles
 * A saved, reusable identity: a name, 1-4 reference images (the user's own
 * uploads or gallery picks), a look built from the Actor Builder menus, a
 * default prompt suffix and the identity engine it works best with. Tools
 * that take a reference image offer the profiles in a compact picker.
 *
 * Identity is carried by reference-image engines (Krea 2 identity edit,
 * Character Reference), not by a per-profile trained LoRA.
 *
 * Pure helpers only; the persisted store lives in
 * `src/store/characterProfileStore.ts`.
 */

import type { ToolImage } from "./runTool";
import { CAST_FIELDS, cleanNotes, type CastField } from "./templates";

export const PROFILE_MAX_REFS = 4;
export const PROFILE_NAME_MAX = 60;
export const PROFILE_SUFFIX_MAX = 300;
/** Longest side of an uploaded reference kept in browser storage. */
export const PROFILE_REF_MAX_SIDE = 768;
/**
 * An upload already within PROFILE_REF_MAX_SIDE and at most this many data
 * URL characters is stored as-is (no lossy re-encode); larger ones shrink.
 */
export const PROFILE_REF_KEEP_CHARS = 400_000;
/** Serialized-size ceiling for all profiles (localStorage is ~5 MB per origin, shared). */
export const PROFILE_STORAGE_BUDGET = 3_000_000;

export type IdentityEngineId = "krea2-identity" | "moss-charref";

export interface IdentityEngine {
  id: IdentityEngineId;
  label: string;
  /** Hub card key the profile opens with. */
  toolKey: string;
  hint: string;
}

/** Existing reference-identity paths (no training). First = default. */
export const IDENTITY_ENGINES: IdentityEngine[] = [
  {
    id: "krea2-identity",
    label: "Krea 2 identity edit",
    toolKey: "catalog:krea2-general-edit",
    hint: "Photoreal people: edits the reference while keeping the face.",
  },
  {
    id: "moss-charref",
    label: "Character Reference",
    toolKey: "catalog:moss-charref",
    hint: "Anime / illustrated characters redrawn in new scenes.",
  },
];

export const DEFAULT_IDENTITY_ENGINE: IdentityEngineId = "krea2-identity";

export function identityEngine(id: string | undefined): IdentityEngine {
  return (
    IDENTITY_ENGINES.find((e) => e.id === id) ??
    IDENTITY_ENGINES.find((e) => e.id === DEFAULT_IDENTITY_ENGINE)!
  );
}

/** Actor Builder fields that describe the person (not the shot or genre). */
export const PROFILE_LOOK_KEYS = [
  "archetype",
  "age",
  "build",
  "outfit",
] as const;
export type ProfileLookKey = (typeof PROFILE_LOOK_KEYS)[number];
export type ProfileLook = Partial<Record<ProfileLookKey, string>>;

/** Look menus for the profile editor: Actor Builder options plus "None". */
export const PROFILE_LOOK_FIELDS: CastField[] = PROFILE_LOOK_KEYS.map((key) => {
  const f = CAST_FIELDS.find((c) => c.key === key)!;
  const hasEmpty = f.options.some((o) => !o.text);
  return {
    ...f,
    options: hasEmpty
      ? f.options
      : [{ id: "none", label: "None", text: "" }, ...f.options],
  };
});

export interface CharacterProfile {
  id: string;
  name: string;
  /** 1-4 references; uploads keep a downscaled data URL, gallery picks a run ref. */
  refs: ToolImage[];
  look: ProfileLook;
  suffix: string;
  engine: IdentityEngineId;
  createdAt: number;
  updatedAt: number;
}

export interface ProfileDraft {
  id?: string;
  name: string;
  refs: (ToolImage | null)[];
  look?: ProfileLook;
  suffix?: string;
  engine?: string;
}

/** Why a draft can't be saved, or null. */
export function validateProfileDraft(draft: ProfileDraft): string | null {
  if (!draft.name.trim()) return "Give the profile a name.";
  const refs = draft.refs.filter(Boolean);
  if (refs.length === 0) return "Add at least one reference image.";
  if (refs.length > PROFILE_MAX_REFS)
    return `Use at most ${PROFILE_MAX_REFS} reference images.`;
  if (refs.some((r) => r!.source === "upload" && !r!.dataUrl))
    return "A reference image is still loading.";
  return null;
}

function cleanLook(look: ProfileLook | undefined): ProfileLook {
  const out: ProfileLook = {};
  if (!look) return out;
  for (const f of PROFILE_LOOK_FIELDS) {
    const key = f.key as ProfileLookKey;
    const v = look[key];
    const opt = f.options.find((o) => o.id === v);
    if (opt && opt.text) out[key] = opt.id;
  }
  return out;
}

/**
 * Shrink a reference for storage: gallery picks keep only the run pointer and
 * URL (pixels are fetched again on use); uploads keep the data URL, and the
 * preview is rebuilt from it so the bytes are stored once.
 */
export function toStoredRef(img: ToolImage): ToolImage {
  if (img.source === "gallery") {
    return {
      id: img.id,
      source: "gallery",
      previewUrl: img.previewUrl,
      label: img.label,
      width: img.width,
      height: img.height,
      ...(img.runId ? { runId: img.runId } : {}),
      ...(typeof img.jobIndex === "number" ? { jobIndex: img.jobIndex } : {}),
    };
  }
  return {
    id: img.id,
    source: "upload",
    previewUrl: "",
    label: img.label,
    width: img.width,
    height: img.height,
    dataUrl: img.dataUrl,
  };
}

/** Stored ref back into a ToolImage the runners can submit. */
export function fromStoredRef(ref: ToolImage): ToolImage {
  return ref.source === "upload"
    ? { ...ref, previewUrl: ref.previewUrl || ref.dataUrl || "" }
    : { ...ref };
}

export function newProfileId(now = Date.now()): string {
  return `cp_${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Normalize a valid draft into a profile (throws on an invalid one). */
export function buildProfile(
  draft: ProfileDraft,
  prev?: CharacterProfile,
  now = Date.now(),
): CharacterProfile {
  const err = validateProfileDraft(draft);
  if (err) throw new Error(err);
  return {
    id: prev?.id ?? draft.id ?? newProfileId(now),
    name: draft.name.replace(/\s+/g, " ").trim().slice(0, PROFILE_NAME_MAX),
    refs: draft.refs
      .filter((r): r is ToolImage => Boolean(r))
      .slice(0, PROFILE_MAX_REFS)
      .map(toStoredRef),
    look: cleanLook(draft.look),
    suffix: cleanNotes(draft.suffix, PROFILE_SUFFIX_MAX),
    engine: identityEngine(draft.engine).id,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
}

/** "a calm, watchful sage, in their thirties, with freckles ..." or "". */
export function compileProfileLook(look: ProfileLook): string {
  const parts: string[] = [];
  for (const f of PROFILE_LOOK_FIELDS) {
    const opt = f.options.find((o) => o.id === look[f.key as ProfileLookKey]);
    if (!opt?.text) continue;
    parts.push(f.key === "build" ? `with ${opt.text}` : opt.text);
  }
  return parts.join(", ");
}

/** The text a profile adds to a prompt: look, then the user's suffix. */
export function profilePromptSuffix(
  p: Pick<CharacterProfile, "look" | "suffix">,
): string {
  return [compileProfileLook(p.look), p.suffix.trim()]
    .filter(Boolean)
    .join(", ");
}

/**
 * Append a profile's suffix to a prompt. Idempotent; when switching profiles
 * the previous profile's suffix is removed first if the prompt still ends
 * with it.
 */
export function applyProfileSuffix(
  text: string,
  next: Pick<CharacterProfile, "look" | "suffix"> | null,
  prev?: Pick<CharacterProfile, "look" | "suffix"> | null,
): string {
  let base = text.trimEnd();
  const prevSuffix = prev ? profilePromptSuffix(prev) : "";
  if (prevSuffix && base.endsWith(prevSuffix)) {
    base = base
      .slice(0, base.length - prevSuffix.length)
      .replace(/[\s,]+$/, "");
  }
  const add = next ? profilePromptSuffix(next) : "";
  if (!add) return base;
  if (base.endsWith(add)) return base;
  return base ? `${base}, ${add}` : add;
}

const SLOT_PRIORITY = [
  /character/i,
  /face/i,
  /identity/i,
  /person|people|actor|model/i,
  /subject/i,
  /reference/i,
];

/** Which image slot a profile fills: the identity-like one, else the first. */
export function pickProfileSlot(labels: readonly string[]): number {
  for (const re of SLOT_PRIORITY) {
    const i = labels.findIndex((l) => re.test(l));
    if (i >= 0) return i;
  }
  return 0;
}

/**
 * How to store an uploaded reference: null = keep the original data URL;
 * else the size to resample it to (high quality, JPEG for storage).
 */
export function profileRefShrink(
  width: number,
  height: number,
  dataUrlChars: number,
): { width: number; height: number } | null {
  if (!(width > 0) || !(height > 0)) return null;
  const long = Math.max(width, height);
  if (long <= PROFILE_REF_MAX_SIDE && dataUrlChars <= PROFILE_REF_KEEP_CHARS)
    return null;
  const scale = Math.min(1, PROFILE_REF_MAX_SIDE / long);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Serialized size of a profile list (what localStorage would hold). */
export function profilesSize(profiles: CharacterProfile[]): number {
  return JSON.stringify(profiles).length;
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
export function sanitizeProfiles(raw: unknown): CharacterProfile[] {
  if (!Array.isArray(raw)) return [];
  const out: CharacterProfile[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const p = v as Partial<CharacterProfile>;
    if (typeof p.id !== "string" || seen.has(p.id)) continue;
    if (typeof p.name !== "string" || !p.name.trim()) continue;
    const refs = Array.isArray(p.refs)
      ? p.refs.filter(isRef).slice(0, PROFILE_MAX_REFS)
      : [];
    if (refs.length === 0) continue;
    seen.add(p.id);
    out.push({
      id: p.id,
      name: p.name.slice(0, PROFILE_NAME_MAX),
      refs: refs.map((r) => ({
        ...r,
        width: Number(r.width) || 0,
        height: Number(r.height) || 0,
      })),
      look: cleanLook(p.look),
      suffix: cleanNotes(
        typeof p.suffix === "string" ? p.suffix : "",
        PROFILE_SUFFIX_MAX,
      ),
      engine: identityEngine(p.engine).id,
      createdAt: Number(p.createdAt) || 0,
      updatedAt: Number(p.updatedAt) || 0,
    });
  }
  return out;
}

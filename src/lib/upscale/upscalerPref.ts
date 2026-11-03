/**
 * The global upscaler preference (Settings → Upscaler), saved server-side in
 * runtime_settings.json as `upscaler`:
 *
 *   photo / illustration / video  chosen model file per content type;
 *                                 absent = the DEFAULT_CHAINS table
 *   scale                         Faithful upscale output factor (2 / 4);
 *                                 absent = the model's own factor
 *   lock                          absent/true = every graph's image upscaler
 *                                 follows the choice at submit; false = only
 *                                 Adrift's Upscale actions do
 *   after                         true = tool runners start with "Upscale
 *                                 after" on (upscaleAfter.ts); absent = off
 *
 * resolveDefaultModel picks the model a content type uses against the live
 * UpscaleModelLoader list: the user's choice if installed, else the first
 * installed table entry, else null (keep the graph's own). Pure.
 */
import {
  DEFAULT_CHAINS,
  canBeDefault,
  describeUpscaler,
  matchesStem,
  upscalerStem,
  type UpscaleContent,
  UPSCALE_CONTENTS,
} from "./upscalerCatalog";
import { sanitizeUpscaleModel, upscaleModelScale } from "./upscaleModels";

export const UPSCALE_SCALES = [2, 4] as const;
export type UpscaleScale = (typeof UPSCALE_SCALES)[number];

export interface UpscalerPref {
  photo?: string;
  illustration?: string;
  video?: string;
  scale?: UpscaleScale;
  lock?: false;
  after?: true;
}

export function isUpscaleContent(v: unknown): v is UpscaleContent {
  return (
    typeof v === "string" && (UPSCALE_CONTENTS as readonly string[]).includes(v)
  );
}

/** Validated preference, or null when nothing differs from the defaults. */
export function sanitizeUpscalerPref(raw: unknown): UpscalerPref | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: UpscalerPref = {};
  for (const c of UPSCALE_CONTENTS) {
    const m = sanitizeUpscaleModel(r[c]);
    if (m) out[c] = m;
  }
  if (r.scale === 2 || r.scale === 4) out.scale = r.scale;
  if (r.lock === false) out.lock = false;
  if (r.after === true) out.after = true;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Apply a PUT patch: a string sets, null clears, absent keeps. `lock: true`
 * and `after: false` are stored as absent (the defaults).
 */
export function mergeUpscalerPref(
  current: UpscalerPref | null | undefined,
  patch: Record<string, unknown>,
): UpscalerPref | null {
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const c of UPSCALE_CONTENTS) {
    if (patch[c] === null || patch[c] === "") delete next[c];
    else if (patch[c] !== undefined) next[c] = patch[c];
  }
  if (patch.scale === null) delete next.scale;
  else if (patch.scale !== undefined) next.scale = patch.scale;
  if (patch.lock === true) delete next.lock;
  else if (patch.lock === false) next.lock = false;
  if (patch.after === true) next.after = true;
  else if (patch.after === false || patch.after === null) delete next.after;
  return sanitizeUpscalerPref(next);
}

/** Validation errors for a PUT body ("" = fine). */
export function upscalerPatchError(patch: Record<string, unknown>): string {
  for (const c of UPSCALE_CONTENTS) {
    const v = patch[c];
    if (v === undefined || v === null || v === "") continue;
    if (!sanitizeUpscaleModel(v)) return `${c}: not a model file name`;
    if (!usable(v as string))
      return `${c}: 1x cleanup and face models can't be a default`;
  }
  if (
    patch.scale !== undefined &&
    patch.scale !== null &&
    patch.scale !== 2 &&
    patch.scale !== 4
  )
    return "scale must be 2, 4 or null";
  if (patch.lock !== undefined && typeof patch.lock !== "boolean")
    return "lock must be true or false";
  if (
    patch.after !== undefined &&
    patch.after !== null &&
    typeof patch.after !== "boolean"
  )
    return "after must be true, false or null";
  return "";
}

export function isLocked(pref: UpscalerPref | null | undefined): boolean {
  return pref?.lock !== false;
}

/** Factor for an upscaler file: catalog first, then the name. */
export function knownScale(file: string): number | null {
  return describeUpscaler(file, upscaleModelScale(file)).scale;
}

export interface ResolvedUpscaler {
  file: string;
  source: "choice" | "table";
}

/**
 * Live name for a chosen file: exact, else the same stem (other extension or
 * folder, or a training-step suffix: "4x_fatal_Anime.pth" finds
 * "4x_fatal_Anime_500000_G.pth").
 */
function findLive(want: string, live: readonly string[]): string | undefined {
  if (live.includes(want)) return want;
  const stem = upscalerStem(want);
  return (
    live.find((f) => upscalerStem(f) === stem) ??
    live.find((f) => matchesStem(f, stem))
  );
}

function usable(file: string): boolean {
  return canBeDefault(describeUpscaler(file, upscaleModelScale(file)));
}

/** First installed file of a stem chain. */
function firstInstalled(
  chain: readonly string[],
  live: readonly string[],
): string | undefined {
  for (const stem of chain) {
    const hit = live.find((f) => matchesStem(f, stem) && usable(f));
    if (hit) return hit;
  }
  return undefined;
}

export function resolveDefaultModel(
  content: UpscaleContent,
  pref: UpscalerPref | null | undefined,
  live: readonly string[],
): ResolvedUpscaler | null {
  const chosen = pref?.[content];
  if (chosen) {
    const hit = findLive(chosen, live);
    if (hit && usable(hit)) return { file: hit, source: "choice" };
  }
  const table = firstInstalled(DEFAULT_CHAINS[content], live);
  return table ? { file: table, source: "table" } : null;
}

export type ResolvedDefaults = Record<UpscaleContent, ResolvedUpscaler | null>;

export function resolveAllDefaults(
  pref: UpscalerPref | null | undefined,
  live: readonly string[],
): ResolvedDefaults {
  return {
    photo: resolveDefaultModel("photo", pref, live),
    illustration: resolveDefaultModel("illustration", pref, live),
    video: resolveDefaultModel("video", pref, live),
  };
}

const ILLUSTRATION_MODEL_RE =
  /anime|illustrious|noob|animagine|pony|niji|waifu|manga|cartoon|toon|anything-?v|counterfeit/i;

/** Content type of a source from its checkpoint / LoRA names (default photo). */
export function contentFromModelNames(
  names: readonly (string | undefined | null)[],
): Exclude<UpscaleContent, "video"> {
  return names.some(
    (n) => typeof n === "string" && ILLUSTRATION_MODEL_RE.test(n),
  )
    ? "illustration"
    : "photo";
}

/** Content type of a gallery image / run from its model and LoRAs. */
export function imageUpscaleContent(src: {
  model?: string;
  loras?: readonly { name: string; filename?: string }[];
}): Exclude<UpscaleContent, "video"> {
  return contentFromModelNames([
    src.model,
    ...(src.loras ?? []).map((l) => l.filename ?? l.name),
  ]);
}

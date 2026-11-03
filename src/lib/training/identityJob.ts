/**
 * Identity LoRA job spec
 * Pure helpers behind the "Train Identity" tool: 10-30 photos of one person
 * or character become a `character` dataset board plus a LoRA training
 * request for the existing StyleVault trainer route
 * (`POST /api/moodboards/[id]/train`).
 *
 * Defaults are sized for a single 24 GB card: Krea 2 trains with
 * an fp8 base and block swap on the musubi-tuner backend, so rank 16-32 at
 * 1024 px fits. The step count scales with the photo count (about 100 steps
 * per photo) inside a per-preset window.
 */

import { captionText } from "@/lib/moodboards/captions";
import type {
  TrainMoodboardRequest,
  TrainingModelFamily,
} from "@/lib/sref/apiClient";

export const IDENTITY_MIN_PHOTOS = 10;
export const IDENTITY_MAX_PHOTOS = 30;
export const IDENTITY_NAME_MAX = 60;
export const IDENTITY_NOTE_MAX = 200;

export type IdentitySubject = "person" | "woman" | "man" | "character";
export type IdentityPreset = "quick" | "balanced" | "detailed";
/** "trigger": short "<trigger> <subject>" captions written here (no GPU).
 *  "auto": the trainer's captioner describes each photo, trigger first. */
export type IdentityCaptionMode = "trigger" | "auto";

export const IDENTITY_SUBJECTS: { id: IdentitySubject; label: string }[] = [
  { id: "person", label: "Person" },
  { id: "woman", label: "Woman" },
  { id: "man", label: "Man" },
  { id: "character", label: "Illustrated character" },
];

export interface IdentityPresetSpec {
  id: IdentityPreset;
  label: string;
  hint: string;
  stepsPerPhoto: number;
  minSteps: number;
  maxSteps: number;
  rank: number;
  resolution: number;
}

export const IDENTITY_PRESETS: IdentityPresetSpec[] = [
  {
    id: "quick",
    label: "Quick",
    hint: "Fewer steps at 768 px. A first look at the likeness.",
    stepsPerPhoto: 60,
    minSteps: 800,
    maxSteps: 1400,
    rank: 16,
    resolution: 768,
  },
  {
    id: "balanced",
    label: "Balanced",
    hint: "Rank 16 at 1024 px. Good likeness for most photo sets.",
    stepsPerPhoto: 100,
    minSteps: 1500,
    maxSteps: 2500,
    rank: 16,
    resolution: 1024,
  },
  {
    id: "detailed",
    label: "Detailed",
    hint: "Rank 32, more steps. Finer facial detail, slower.",
    stepsPerPhoto: 120,
    minSteps: 2000,
    maxSteps: 3200,
    rank: 32,
    resolution: 1024,
  },
];

export const DEFAULT_IDENTITY_PRESET: IdentityPreset = "balanced";

export interface IdentityFamilySpec {
  id: TrainingModelFamily;
  label: string;
  hint: string;
  /** Learning rate sent to the trainer. */
  lr: number;
  /** Transformer blocks swapped to system RAM (24 GB VRAM budget). */
  blocksToSwap: number;
  experimental: boolean;
}

export const IDENTITY_FAMILIES: IdentityFamilySpec[] = [
  {
    id: "krea2",
    label: "Krea 2",
    hint: "Photoreal identity. musubi-tuner, fp8 base with block swap.",
    // The trainer's verified Krea 2 rate (warmup + grad clipping server-side).
    lr: 5e-5,
    blocksToSwap: 20,
    experimental: false,
  },
  {
    id: "moss_image",
    label: "MOSS Image (experimental)",
    hint: "ai-toolkit backend, not yet validated end to end.",
    lr: 1e-4,
    blocksToSwap: 20,
    experimental: true,
  },
];

export const DEFAULT_IDENTITY_FAMILY: TrainingModelFamily = "krea2";

export function identityPreset(id: string | undefined): IdentityPresetSpec {
  return (
    IDENTITY_PRESETS.find((p) => p.id === id) ??
    IDENTITY_PRESETS.find((p) => p.id === DEFAULT_IDENTITY_PRESET)!
  );
}

export function identityFamily(id: string | undefined): IdentityFamilySpec {
  return (
    IDENTITY_FAMILIES.find((f) => f.id === id) ??
    IDENTITY_FAMILIES.find((f) => f.id === DEFAULT_IDENTITY_FAMILY)!
  );
}

/**
 * A rare, model-unknown activation token from the identity name: "zx" + up
 * to 10 lowercase letters/digits ("Ana Lima" -> "zxanalima"). Real words make
 * weak triggers because the base model already has a meaning for them.
 */
export function deriveTriggerWord(name: string): string {
  const core = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 10);
  return `zx${core || "subject"}`;
}

const TRIGGER_RE = /^[a-z0-9_]{3,40}$/;

/** Why a trigger word is unusable, or null. */
export function triggerWordError(trigger: string): string | null {
  if (!TRIGGER_RE.test(trigger))
    return "Trigger word: 3-40 lowercase letters, digits or underscores.";
  return null;
}

/** Steps for a photo count under a preset (clamped to the preset window). */
export function identitySteps(
  photoCount: number,
  preset: IdentityPreset,
): number {
  const p = identityPreset(preset);
  const raw = Math.max(0, Math.round(photoCount)) * p.stepsPerPhoto;
  const clamped = Math.min(p.maxSteps, Math.max(p.minSteps, raw));
  // Round to 50 so the trainer's checkpoint cadence lands on clean numbers.
  return Math.round(clamped / 50) * 50;
}

export interface IdentityJobInput {
  name: string;
  /** Empty/omitted = derived from the name. */
  triggerWord?: string;
  subject?: IdentitySubject;
  photoCount: number;
  family?: TrainingModelFamily;
  preset?: IdentityPreset;
  captionMode?: IdentityCaptionMode;
  /** Optional per-photo notes ("side profile, outdoors"), index-aligned. */
  notes?: (string | undefined | null)[];
}

/** Why the input can't become a job, or null. */
export function validateIdentityInput(input: IdentityJobInput): string | null {
  const name = input.name.trim();
  if (!name) return "Give the identity a name.";
  if (name.length > IDENTITY_NAME_MAX)
    return `Keep the name under ${IDENTITY_NAME_MAX} characters.`;
  const trigger = input.triggerWord?.trim();
  if (trigger) {
    const err = triggerWordError(trigger);
    if (err) return err;
  }
  if (input.photoCount < IDENTITY_MIN_PHOTOS)
    return `Add at least ${IDENTITY_MIN_PHOTOS} photos (${input.photoCount} so far).`;
  if (input.photoCount > IDENTITY_MAX_PHOTOS)
    return `Use at most ${IDENTITY_MAX_PHOTOS} photos (${input.photoCount} selected).`;
  return null;
}

/** Train request body for `POST /api/moodboards/[id]/train`. */
export type IdentityTrainRequest = TrainMoodboardRequest & {
  model_family: TrainingModelFamily;
};

export interface IdentityJobSpec {
  /** Name of the `character` dataset board that holds the photos. */
  boardName: string;
  triggerWord: string;
  subject: IdentitySubject;
  family: TrainingModelFamily;
  preset: IdentityPreset;
  captionMode: IdentityCaptionMode;
  /** One caption per photo; "" leaves the photo to the trainer's captioner. */
  captions: string[];
  request: IdentityTrainRequest;
  /** Prompt fragment that activates the LoRA once deployed. */
  activation: string;
}

function cleanNote(note: string | undefined | null): string {
  return (note ?? "").replace(/\s+/g, " ").trim().slice(0, IDENTITY_NOTE_MAX);
}

/** Per-photo caption for the "trigger" mode: "<trigger> <subject>[, note]". */
export function identityCaption(
  triggerWord: string,
  subject: IdentitySubject,
  note?: string | null,
): string {
  const cleaned = cleanNote(note);
  return captionText(
    cleaned
      ? `${triggerWord} ${subject}, ${cleaned}`
      : `${triggerWord} ${subject}`,
    triggerWord,
  );
}

/**
 * Build the full job spec. Throws on invalid input (callers validate first
 * with `validateIdentityInput` to show the message).
 */
export function buildIdentityJob(input: IdentityJobInput): IdentityJobSpec {
  const error = validateIdentityInput(input);
  if (error) throw new Error(error);
  const name = input.name.trim();
  const triggerWord = input.triggerWord?.trim() || deriveTriggerWord(name);
  const subject = input.subject ?? "person";
  const fam = identityFamily(input.family);
  const preset = identityPreset(input.preset);
  const captionMode: IdentityCaptionMode = input.captionMode ?? "trigger";
  const count = Math.round(input.photoCount);

  const captions = Array.from({ length: count }, (_, i) => {
    const note = input.notes?.[i];
    if (captionMode === "auto") {
      // A manual note still wins; the rest go to the captioner.
      return cleanNote(note) ? identityCaption(triggerWord, subject, note) : "";
    }
    return identityCaption(triggerWord, subject, note);
  });

  const request: IdentityTrainRequest = {
    model_family: fam.id,
    trigger_word: triggerWord,
    steps: identitySteps(count, preset.id),
    lr: fam.lr,
    rank: preset.rank,
    resolution: preset.resolution,
    blocks_to_swap: fam.blocksToSwap,
    // Shared projector layers stay frozen (trainer default, avoids divergence).
    exclude_shared: true,
    auto_caption: captionMode === "auto",
    caption_ext: "txt",
  };

  return {
    boardName: `Identity: ${name}`.slice(0, 100),
    triggerWord,
    subject,
    family: fam.id,
    preset: preset.id,
    captionMode,
    captions,
    request,
    activation: `${triggerWord} ${subject}`,
  };
}

/** Prompt for Create once the LoRA is deployed under `loraShortcode`. */
export function identityPrompt(
  spec: Pick<IdentityJobSpec, "activation">,
  loraShortcode: string,
  scene = "portrait photo, natural light",
): string {
  const s = scene.trim();
  return `${spec.activation}${s ? `, ${s}` : ""} --lora ${loraShortcode.trim()}`;
}

const UPLOAD_PREFIX = "/api/moodboards/upload?file=";
const UPLOAD_FILE_RE = /^[A-Za-z0-9._-]{1,200}$/;

/** A photo stored by the moodboard upload route (no remote or arbitrary paths). */
export function isUploadedPhotoUrl(url: string): boolean {
  if (!url.startsWith(UPLOAD_PREFIX)) return false;
  const file = url.slice(UPLOAD_PREFIX.length);
  return UPLOAD_FILE_RE.test(file) && !file.includes("..");
}

/** The deployed LoRA shortcode whose trigger list carries `triggerWord`. */
export function findIdentityLora(
  entries: { shortcode: string; triggers?: string[] }[],
  triggerWord: string,
): string | null {
  const t = triggerWord.trim().toLowerCase();
  if (!t) return null;
  const hit = entries.find((e) =>
    (e.triggers ?? []).some((x) => x.trim().toLowerCase() === t),
  );
  return hit?.shortcode ?? null;
}

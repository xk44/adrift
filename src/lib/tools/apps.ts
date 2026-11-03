/**
 * Hub "Apps": one-click effect templates (appTemplates.json) run through one
 * generic runner — step 1 is an edit with the templated prompt on an
 * existing edit engine, optional step 2 animates the result (LTXV i2v).
 */

import raw from "./appTemplates.json";
import {
  DUAL_ENGINES,
  SINGLE_ENGINES,
  fillTemplate,
  type EditEngineId,
} from "./templates";

export const APP_CATEGORIES = [
  "Ads & Products",
  "Portraits",
  "Style & Art",
  "Characters & Games",
  "Scenes & FX",
] as const;

export type AppCategory = (typeof APP_CATEGORIES)[number];

export const APP_EDIT_MODES = ["insert", "tryon", "swap"] as const;

/**
 * Follow-up chains that replace the generic Animate step (appFollowUp.ts):
 *   match_cut    step-1 image cut out (qwen21-remove-bg) + a transition clip
 *                from the original photo to the step-1 image
 *   bullet_time  step 1 is a clean background plate; the bullet-time orbit
 *                (wan_motion) then runs on the original photo
 */
export const APP_FOLLOW_UP_KINDS = ["match_cut", "bullet_time"] as const;

export interface AppFollowUp {
  kind: (typeof APP_FOLLOW_UP_KINDS)[number];
  /** Step-2 heading. */
  label: string;
  /** Video prompt (match_cut: how it moves; bullet_time: the subject). */
  prompt: string;
  /** match_cut: also cut the step-1 image out to an RGBA PNG. */
  cutout?: boolean;
}

export interface AppTextInput {
  label: string;
  placeholder: string;
  default?: string;
}

/**
 * Optional layout/look variant: swaps the step-1 prompt. The template's own
 * `prompt` stays the default ("Classic") choice.
 */
export interface AppVariant {
  id: string;
  label: string;
  /** Replacement edit instruction; same `{text}` rules as `prompt`. */
  prompt: string;
}

export interface AppTemplate {
  id: string;
  name: string;
  category: AppCategory;
  description: string;
  inputs?: {
    /** Second image (photo + reference apps). */
    second?: { label: string };
    /** One text field, inserted as {text}. */
    text?: AppTextInput;
  };
  /** Edit instruction; `{text}` = the text field. */
  prompt: string;
  /** Picker heading for `variants` (e.g. "Layout"). */
  variantLabel?: string;
  /** Alternative prompts; the base `prompt` is the default choice. */
  variants?: AppVariant[];
  /** Optional step-2 motion prompt (enables Animate). */
  motion?: string;
  /** Grounded Krea 2 edit mode for two-image apps. */
  editMode?: (typeof APP_EDIT_MODES)[number];
  /**
   * One-action chain: queue step 2 (animate) automatically as soon as
   * step 1 finishes (e.g. Sketch to Video). Requires `motion`.
   */
  autoAnimate?: boolean;
  /**
   * Optional step-3 sound prompt (MMAudio video-to-audio on the animated
   * clip, non-commercial). Requires `motion`; with `autoAnimate` the sound
   * is added automatically too.
   */
  sound?: string;
  /** Chain that replaces the Animate step (no `motion` / `sound`). */
  followUp?: AppFollowUp;
}

/** Variant id that selects the template's base `prompt`. */
export const APP_DEFAULT_VARIANT = "classic";

/** Returns a list of problems; empty = valid. */
export function validateAppTemplates(data: unknown): string[] {
  const errors: string[] = [];
  const apps = (data as { apps?: unknown })?.apps;
  if (!Array.isArray(apps)) return ["apps must be an array"];
  const ids = new Set<string>();
  apps.forEach((a: Partial<AppTemplate>, i) => {
    const at = `apps[${i}]${a?.id ? ` (${a.id})` : ""}`;
    if (!a || typeof a !== "object") {
      errors.push(`${at}: not an object`);
      return;
    }
    if (typeof a.id !== "string" || !/^[a-z0-9_]+$/.test(a.id))
      errors.push(`${at}: id must be snake_case`);
    else if (ids.has(a.id)) errors.push(`${at}: duplicate id`);
    else ids.add(a.id);
    if (typeof a.name !== "string" || !a.name.trim())
      errors.push(`${at}: name required`);
    if (!APP_CATEGORIES.includes(a.category as AppCategory))
      errors.push(`${at}: unknown category ${String(a.category)}`);
    if (typeof a.description !== "string" || !a.description.trim())
      errors.push(`${at}: description required`);
    if (typeof a.prompt !== "string" || a.prompt.trim().length < 20)
      errors.push(`${at}: prompt too short`);
    const hasText = Boolean(a.inputs?.text);
    const usesText =
      typeof a.prompt === "string" && a.prompt.includes("{text}");
    if (hasText !== usesText)
      errors.push(`${at}: {text} placeholder and text input must go together`);
    const unknown = (a.prompt ?? "")
      .match(/\{(\w+)\}/g)
      ?.filter((m) => m !== "{text}");
    if (unknown?.length)
      errors.push(`${at}: unknown placeholder ${unknown[0]}`);
    if (a.variants !== undefined) {
      if (!Array.isArray(a.variants) || a.variants.length === 0)
        errors.push(`${at}: variants must be a non-empty array`);
      else {
        if (typeof a.variantLabel !== "string" || !a.variantLabel.trim())
          errors.push(`${at}: variants need a variantLabel`);
        const vids = new Set<string>([APP_DEFAULT_VARIANT]);
        a.variants.forEach((v, vi) => {
          const vat = `${at} variants[${vi}]`;
          if (!v || typeof v.id !== "string" || !/^[a-z0-9_]+$/.test(v.id))
            errors.push(`${vat}: id must be snake_case`);
          else if (vids.has(v.id)) errors.push(`${vat}: duplicate id ${v.id}`);
          else vids.add(v.id);
          if (typeof v?.label !== "string" || !v.label.trim())
            errors.push(`${vat}: label required`);
          if (typeof v?.prompt !== "string" || v.prompt.trim().length < 20)
            errors.push(`${vat}: prompt too short`);
          else {
            if (v.prompt.includes("{text}") !== hasText)
              errors.push(
                `${vat}: {text} placeholder and text input must go together`,
              );
            const bad = v.prompt
              .match(/\{(\w+)\}/g)
              ?.filter((m) => m !== "{text}");
            if (bad?.length)
              errors.push(`${vat}: unknown placeholder ${bad[0]}`);
          }
        });
      }
    } else if (a.variantLabel !== undefined)
      errors.push(`${at}: variantLabel without variants`);
    if (a.inputs?.text && !a.inputs.text.label?.trim())
      errors.push(`${at}: text input needs a label`);
    if (a.inputs?.second && !a.inputs.second.label?.trim())
      errors.push(`${at}: second image needs a label`);
    if (a.editMode !== undefined) {
      if (!APP_EDIT_MODES.includes(a.editMode))
        errors.push(`${at}: unknown editMode ${String(a.editMode)}`);
      if (!a.inputs?.second)
        errors.push(`${at}: editMode is only for two-image apps`);
    }
    if (
      a.motion !== undefined &&
      (typeof a.motion !== "string" || !a.motion.trim())
    )
      errors.push(`${at}: motion must be a non-empty string`);
    if (a.autoAnimate !== undefined) {
      if (typeof a.autoAnimate !== "boolean")
        errors.push(`${at}: autoAnimate must be a boolean`);
      else if (a.autoAnimate && !a.motion)
        errors.push(`${at}: autoAnimate needs a motion prompt`);
    }
    if (a.sound !== undefined) {
      if (typeof a.sound !== "string" || !a.sound.trim())
        errors.push(`${at}: sound must be a non-empty string`);
      else if (!a.motion) errors.push(`${at}: sound needs a motion prompt`);
    }
    if (a.followUp !== undefined) {
      const f = a.followUp;
      if (!f || !APP_FOLLOW_UP_KINDS.includes(f.kind))
        errors.push(`${at}: unknown followUp kind ${String(f?.kind)}`);
      else {
        if (typeof f.label !== "string" || !f.label.trim())
          errors.push(`${at}: followUp needs a label`);
        if (typeof f.prompt !== "string" || !f.prompt.trim())
          errors.push(`${at}: followUp needs a prompt`);
        if (f.cutout !== undefined && f.kind !== "match_cut")
          errors.push(`${at}: followUp cutout is only for match_cut`);
      }
      if (a.motion !== undefined || a.autoAnimate || a.sound !== undefined)
        errors.push(`${at}: followUp replaces motion / autoAnimate / sound`);
    }
  });
  return errors;
}

export const APP_TEMPLATES: AppTemplate[] = (raw as { apps: AppTemplate[] })
  .apps;

export function getApp(id: string): AppTemplate | undefined {
  return APP_TEMPLATES.find((a) => a.id === id);
}

export function appNeedsSecondImage(app: AppTemplate): boolean {
  return Boolean(app.inputs?.second);
}

/** Engine preference for an app: dual-image apps need a two-ref engine. */
export function appEngines(app: AppTemplate): EditEngineId[] {
  return appNeedsSecondImage(app) ? DUAL_ENGINES : SINGLE_ENGINES;
}

/** Picker options for an app's variants: "Classic" (base prompt) first. */
export function appVariantChoices(
  app: AppTemplate,
): { id: string; label: string }[] {
  if (!app.variants?.length) return [];
  return [
    { id: APP_DEFAULT_VARIANT, label: "Classic" },
    ...app.variants.map((v) => ({ id: v.id, label: v.label })),
  ];
}

/**
 * Step-1 edit prompt; an empty text field falls back to its default. An
 * unknown or missing variant id uses the base prompt.
 */
export function compileAppPrompt(
  app: AppTemplate,
  text?: string,
  variantId?: string,
): string {
  const value = (text ?? "").trim() || app.inputs?.text?.default || "";
  const variant = app.variants?.find((v) => v.id === variantId);
  return fillTemplate(variant?.prompt ?? app.prompt, { text: value });
}

export function appAutoAnimates(app: AppTemplate): boolean {
  return Boolean(app.autoAnimate && app.motion);
}

/**
 * Whether the runner should queue step 2 now: auto-chain on, step 1 just
 * finished, and step 2 not already queued for this step-1 run.
 */
export function shouldAutoAnimate(state: {
  enabled: boolean;
  step1RunId: string | null;
  step1Done: boolean;
  animatedRunId: string | null;
}): boolean {
  return (
    state.enabled &&
    state.step1Done &&
    state.step1RunId !== null &&
    state.animatedRunId !== state.step1RunId
  );
}

export function compileMotionPrompt(app: AppTemplate, custom?: string): string {
  return (custom ?? "").trim() || app.motion || "";
}

/** Step-3 sound prompt (user text overrides the template's). */
export function compileSoundPrompt(app: AppTemplate, custom?: string): string {
  return (custom ?? "").trim() || app.sound || "";
}

/** add_sound params for step 3 (pack "audio", MMAudio). */
export function appSoundParams(
  app: AppTemplate,
  custom?: string,
): Record<string, unknown> {
  const prompt = compileSoundPrompt(app, custom);
  return {
    pack_id: "audio",
    ...(prompt ? { prompt } : {}),
    negative_prompt: "music, speech, voice, talking",
  };
}

/**
 * Whether to queue step 3 now: chain on, the clip just finished, and sound
 * not already queued for that clip run.
 */
export function shouldAutoSound(state: {
  enabled: boolean;
  clipRunId: string | null;
  clipDone: boolean;
  soundedRunId: string | null;
}): boolean {
  return (
    state.enabled &&
    state.clipDone &&
    state.clipRunId !== null &&
    state.soundedRunId !== state.clipRunId
  );
}

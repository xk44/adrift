/**
 * Pure helpers for the Style Creator start screen: prompt/flag handling,
 * compact param chips for recent-prompt cards, style-tile collages, and
 * prompt-relevance ordering for the session image picker.
 */

import type { GalleryImage } from "@/types";
import { isDisplayableParam } from "@/lib/ui/displayParams";

/** Local style session persisted in localStorage (see useStyleSessions). */
export interface StyleSession {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  selectedImageIds: string[];
  status: "draft" | "extracting" | "done";
  styleCode?: string;
  /** Prompt typed on the start screen (may include --flags). */
  prompt?: string;
}

/** Subjects rendered for every catalog style code (see /api/style-catalog). */
export const CATALOG_COLLAGE_SUBJECTS = [
  "portrait",
  "landscape",
  "still_life",
  "hot_cup_of_coffee",
] as const;

export function catalogStyleImageUrl(code: string, subject: string): string {
  return `/api/style-catalog?code=${encodeURIComponent(code)}&subject=${encodeURIComponent(subject)}`;
}

/** Prompt text with every trailing `--flag value` segment removed. */
export function stripPromptFlags(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.startsWith("--")) return "";
  return trimmed.split(/\s+--(?=[A-Za-z])/)[0].trim();
}

/**
 * Prompt to reuse on the start screen: per-image `--seed` is dropped so a
 * style session explores variety instead of pinning one sample.
 */
export function promptForReuse(fullPrompt: string): string {
  return fullPrompt
    .replace(/(^|\s)--seed(?:\s+(?!--)\S+)?/gi, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Short session name derived from the prompt text, or the fallback. */
export function sessionNameFromPrompt(
  prompt: string,
  fallback: string,
  max = 40,
): string {
  const text = stripPromptFlags(prompt).replace(/\s+/g, " ");
  if (!text) return fallback;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Extract the `--sref` value(s) from a prompt, if any. */
export function promptSrefCodes(prompt: string): string[] {
  const match = prompt.match(/(?:^|\s)--sref((?:\s+(?!--)\S+)*)/i);
  if (!match) return [];
  return match[1].trim().split(/\s+/).filter(Boolean);
}

/**
 * Put `--sref <code>` into the prompt, replacing any existing --sref values.
 * Passing the code that is already the sole sref removes it (toggle).
 */
export function togglePromptSref(prompt: string, code: string): string {
  const existing = promptSrefCodes(prompt);
  const without = prompt
    .replace(/(^|\s)--sref(?:\s+(?!--)\S+)*/i, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (existing.length === 1 && existing[0] === code) return without;
  return without ? `${without} --sref ${code}` : `--sref ${code}`;
}

/** Long param ids → the compact flag users type. */
const COMPACT_KEYS: Readonly<Record<string, string>> = {
  aspectRatio: "ar",
  aspect: "ar",
  stylize: "s",
  chaos: "c",
  weird: "w",
  quality: "q",
  version: "v",
  repeat: "r",
  profile: "p",
  mossSpeed: "speed",
  h3Speed: "speed",
};

/** Keys never shown on recent-prompt cards (per-image or noisy). */
const CARD_HIDDEN_KEYS = new Set([
  "seed",
  "no",
  "negativePrompt",
  "model",
  "vae",
  "lora",
  "sampler",
  "scheduler",
]);

/** Display order: the params people scan for first. */
const CHIP_ORDER = ["ar", "s", "c", "w", "q", "v", "sref", "p"];

function formatChipValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(" ");
  return String(value);
}

/**
 * Humanized, compact param chips (`ar 1:1`, `s 250`, `raw`) for a gallery
 * image's params map. Hidden/internal params and seeds are dropped.
 */
export function compactParamChips(
  params: Record<string, unknown> | undefined,
  max = 4,
): string[] {
  if (!params) return [];
  const seen = new Set<string>();
  const chips: { key: string; text: string }[] = [];
  for (const [rawKey, value] of Object.entries(params)) {
    if (CARD_HIDDEN_KEYS.has(rawKey)) continue;
    if (!isDisplayableParam(rawKey, value)) continue;
    const key = COMPACT_KEYS[rawKey] ?? rawKey;
    if (seen.has(key)) continue;
    seen.add(key);
    if (value === true) {
      chips.push({ key, text: key });
    } else {
      const text = formatChipValue(value);
      chips.push({
        key,
        text: `${key} ${text.length > 18 ? `${text.slice(0, 17)}…` : text}`,
      });
    }
  }
  const rank = (key: string) => {
    const index = CHIP_ORDER.indexOf(key);
    return index === -1 ? CHIP_ORDER.length : index;
  };
  return chips
    .map((chip, index) => ({ ...chip, index }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.index - b.index)
    .slice(0, max)
    .map((chip) => chip.text);
}

export interface RecentPromptCard {
  id: string;
  thumbUrl: string;
  text: string;
  fullPrompt: string;
  chips: string[];
}

function createdAtMs(image: GalleryImage): number {
  const ms = Date.parse(image.createdAt);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Latest distinct prompts from the gallery (newest first), one card per
 * prompt. Hidden, external, and prompt-less images are skipped.
 */
export function recentPromptCards(
  gallery: readonly GalleryImage[],
  limit = 6,
): RecentPromptCard[] {
  const sorted = gallery
    .filter((img) => !img.hidden && !img.external && img.url)
    .map((img, index) => ({ img, index }))
    .sort(
      (a, b) => createdAtMs(b.img) - createdAtMs(a.img) || a.index - b.index,
    );
  const seen = new Set<string>();
  const cards: RecentPromptCard[] = [];
  for (const { img } of sorted) {
    const text = stripPromptFlags(img.prompt || img.fullPrompt || "");
    if (!text) continue;
    const key = text.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push({
      id: img.id,
      thumbUrl: img.url,
      text,
      fullPrompt: promptForReuse(img.fullPrompt || img.prompt),
      chips: compactParamChips(img.paramsMap),
    });
    if (cards.length >= limit) break;
  }
  return cards;
}

/**
 * Up to four image URLs for a saved style tile: the session that produced the
 * code (its picked references) first, then the saved thumbnail.
 */
export function savedStyleCollage(
  code: string,
  thumbnailUrl: string | undefined,
  sessions: readonly StyleSession[],
  galleryById: ReadonlyMap<string, GalleryImage>,
): string[] {
  const urls: string[] = [];
  const session = sessions.find((s) => s.styleCode === code);
  for (const id of session?.selectedImageIds ?? []) {
    const url = galleryById.get(id)?.url;
    if (url && !urls.includes(url)) urls.push(url);
    if (urls.length >= 4) break;
  }
  if (thumbnailUrl && !urls.includes(thumbnailUrl) && urls.length < 4) {
    urls.unshift(thumbnailUrl);
  }
  return urls.slice(0, 4);
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "and",
  "in",
  "on",
  "with",
  "at",
  "to",
  "for",
  "by",
]);

function promptTokens(text: string): Set<string> {
  return new Set(
    stripPromptFlags(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 1 && !STOP_WORDS.has(word)),
  );
}

/**
 * Order picker images so those whose prompt shares words with the session
 * prompt come first (stable otherwise). No prompt → input order.
 */
export function rankImagesByPrompt<T extends Pick<GalleryImage, "prompt">>(
  images: readonly T[],
  prompt: string | undefined,
): T[] {
  const wanted = promptTokens(prompt ?? "");
  if (wanted.size === 0) return [...images];
  return images
    .map((img, index) => {
      let score = 0;
      for (const token of promptTokens(img.prompt ?? "")) {
        if (wanted.has(token)) score++;
      }
      return { img, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.img);
}

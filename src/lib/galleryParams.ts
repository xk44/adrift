/**
 * Gallery prompt parameter chips.
 * Keeps per-image --seed visible/clickable without duplicating the base run seed.
 */

import { displayParamKey, isDisplayableParam } from "@/lib/ui/displayParams";

const HIDDEN_PARAM_KEYS = new Set(["negativePrompt", "no", "seed"]);

export function buildGalleryParamChips(
  params: Record<string, unknown>,
  seed?: number,
): string[] {
  const chips: string[] = [];

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || HIDDEN_PARAM_KEYS.has(key)) continue;
    if (!isDisplayableParam(key, value)) continue;

    if (key === "ar") {
      chips.push(`ar ${value}`);
    } else if (key === "lora" && Array.isArray(value)) {
      chips.push(`lora ${(value as string[]).join(" ")}`);
    } else if (typeof value === "boolean" && value) {
      chips.push(key);
    } else if (typeof value !== "boolean") {
      chips.push(`${displayParamKey(key)} ${value}`);
    }
  }

  if (typeof seed === "number" && Number.isFinite(seed)) {
    chips.push(`--seed ${Math.trunc(seed)}`);
  }

  return chips;
}

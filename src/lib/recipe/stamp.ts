/**
 * Put the recipe into a prompt's extra_pnginfo. ComfyUI then writes it as
 * the PNG text chunk "adrift_recipe" (SaveImage) and into the video
 * metadata comment (VHS_VideoCombine / SaveVideo). Server-only.
 */

import packageJson from "../../../package.json";
import { readEmbedRecipe } from "@/lib/runtimeSettings";
import { buildRecipe, RECIPE_KEY, type AdriftRecipe } from "./recipe";

export const ADRIFT_VERSION: string =
  (packageJson as { version?: string }).version ?? "unknown";

/** extra_pnginfo keys Adrift adds (the "workflow" UI graph is ComfyUI's own). */
const ADRIFT_PNGINFO_KEYS = ["cj", RECIPE_KEY];

export interface StampResult {
  extraData: Record<string, unknown> | undefined;
  /** Recipe for the DB row; null when the prompt is not an Adrift job. */
  recipe: AdriftRecipe | null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Build the recipe for an Adrift job (its extra_pnginfo carries "cj") from
 * the job params and the final graph. With embedding off, the recipe and
 * the "cj" params are left out of the files (the DB row is still kept).
 */
export function stampRecipe(
  extraData: Record<string, unknown> | undefined,
  graph: unknown,
  embed: boolean = readEmbedRecipe(),
): StampResult {
  const info = isObj(extraData?.extra_pnginfo) ? extraData.extra_pnginfo : null;
  const cj = info && isObj(info.cj) ? info.cj : null;
  if (!info || !cj) return { extraData, recipe: null };
  const recipe = buildRecipe({
    params: isObj(cj.params) ? cj.params : {},
    graph,
    adriftVersion: ADRIFT_VERSION,
  });
  let nextInfo: Record<string, unknown>;
  if (embed) {
    nextInfo = { ...info, [RECIPE_KEY]: recipe };
  } else {
    nextInfo = Object.fromEntries(
      Object.entries(info).filter(([k]) => !ADRIFT_PNGINFO_KEYS.includes(k)),
    );
  }
  const next: Record<string, unknown> = { ...extraData };
  if (Object.keys(nextInfo).length) next.extra_pnginfo = nextInfo;
  else delete next.extra_pnginfo;
  return { extraData: next, recipe };
}

/** Keep the recipe row for a queued prompt; never fails the queue. */
export async function persistRecipe(
  promptId: string | undefined,
  recipe: AdriftRecipe | null,
): Promise<void> {
  if (!promptId || !recipe) return;
  try {
    const { saveRecipe } = await import("./store");
    saveRecipe(promptId, recipe);
  } catch {
    // DB unavailable (tests, read-only data folder): files still carry it.
  }
}

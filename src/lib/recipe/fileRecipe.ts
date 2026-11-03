/**
 * Find the Adrift recipe inside an output file: the PNG "adrift_recipe"
 * chunk (or the older "cj" chunk), or the JSON a video's metadata comment
 * carries. Client-safe.
 */

import { isPng, readPngTextChunks } from "@/lib/pngMeta";
import { parseRecipe, RECIPE_KEY, type ParsedRecipe } from "./recipe";

/** Bytes scanned at each end of a video (moov / Tags may sit at either). */
const VIDEO_SCAN_BYTES = 8 * 1024 * 1024;

const RECIPE_START_RE = /\{\s*"schema"\s*:\s*"adrift\.recipe"/g;

/** The balanced JSON object starting at `start` (string-aware), or null. */
export function extractJsonObject(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

/** First parseable recipe object embedded anywhere in `text`. */
export function findRecipeInText(text: string): ParsedRecipe | null {
  RECIPE_START_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RECIPE_START_RE.exec(text))) {
    const json = extractJsonObject(text, m.index);
    if (!json) continue;
    const parsed = parseRecipe(json);
    if (parsed.ok) return parsed;
  }
  return null;
}

/** Recipe from PNG bytes: "adrift_recipe" first, then the legacy "cj" chunk. */
export function recipeFromPngBytes(bytes: Uint8Array): ParsedRecipe | null {
  if (!isPng(bytes)) return null;
  const chunks = readPngTextChunks(bytes);
  if (chunks[RECIPE_KEY]) {
    const parsed = parseRecipe(chunks[RECIPE_KEY]);
    if (parsed.ok) return parsed;
  }
  if (chunks.cj) {
    const parsed = parseRecipe(chunks.cj);
    if (parsed.ok) return parsed;
  }
  return null;
}

const latin1 = new TextDecoder("latin1");

/** Recipe from container bytes (MP4/MOV/WebM/MKV metadata), any encoding of the comment. */
export function recipeFromVideoBytes(bytes: Uint8Array): ParsedRecipe | null {
  return findRecipeInText(latin1.decode(bytes));
}

function isVideoFile(file: File): boolean {
  return (
    file.type.startsWith("video/") ||
    /\.(mp4|m4v|mov|webm|mkv)$/i.test(file.name)
  );
}

export function mayCarryRecipe(file: File): boolean {
  return (
    file.type === "image/png" || /\.png$/i.test(file.name) || isVideoFile(file)
  );
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Read a dropped / picked file's recipe; null when it carries none. */
export async function readRecipeFromFile(
  file: File,
): Promise<ParsedRecipe | null> {
  if (!mayCarryRecipe(file)) return null;
  if (!isVideoFile(file)) return recipeFromPngBytes(await bytesOf(file));
  if (file.size <= VIDEO_SCAN_BYTES * 2) {
    return recipeFromVideoBytes(await bytesOf(file));
  }
  return (
    recipeFromVideoBytes(await bytesOf(file.slice(0, VIDEO_SCAN_BYTES))) ??
    recipeFromVideoBytes(
      await bytesOf(file.slice(file.size - VIDEO_SCAN_BYTES)),
    )
  );
}

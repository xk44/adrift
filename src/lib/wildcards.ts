/**
 * File-backed wildcard library
 * `__name__` tokens in a prompt are replaced by a random line from
 * `data/wildcards/<name>.txt` (one option per line, `#` comments, blank
 * lines ignored). Chosen lines may themselves contain `__other__` tokens
 * (nested, capped at WILDCARD_MAX_DEPTH) and `{a|b}` alternation.
 *
 * Expansion is deterministic for a given seed (mulberry32 RNG).
 * Names are restricted to [a-z0-9_-/]; that, plus the realpath containment
 * check in the fs loader, makes path traversal impossible.
 *
 * Pure parts live here (safe for client bundles); fs access is in
 * wildcardsFs.ts.
 */

import { expandDynamicPrompt } from "@/lib/oj/dynamicPrompts";

export const WILDCARD_MAX_DEPTH = 5;
export const WILDCARD_MAX_NAME_LENGTH = 64;
export const WILDCARD_MAX_OUTPUT_LENGTH = 20_000;

/** Matches `__name__` tokens; name validity is re-checked afterwards. */
const TOKEN_RE = /__([a-z0-9](?:[a-z0-9_\-/]*?[a-z0-9])?)__/g;

export function isValidWildcardName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > WILDCARD_MAX_NAME_LENGTH) return false;
  if (!/^[a-z0-9_\-/]+$/.test(name)) return false;
  if (name.includes("__")) return false;
  // No empty segments (leading/trailing/double slash).
  return name.split("/").every((seg) => seg.length > 0);
}

/** Parse wildcard file text into its option list. */
export function parseWildcardFile(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

/** Small seeded RNG returning [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hasWildcards(prompt: string): boolean {
  TOKEN_RE.lastIndex = 0;
  const found = TOKEN_RE.test(prompt);
  TOKEN_RE.lastIndex = 0;
  return found;
}

export type WildcardExpansion = {
  text: string;
  /** Names that were requested but have no (valid) file. Left literal. */
  missing: string[];
  /** True when a nested token was left unexpanded due to the depth cap. */
  depthExceeded: boolean;
  /** Names actually substituted, in order. */
  used: string[];
};

/**
 * Expand `__name__` tokens. `lookup` returns the option list for a name or
 * null when unknown. Same seed + same files => identical output.
 */
export function expandWildcards(
  prompt: string,
  lookup: (name: string) => string[] | null,
  seed: number,
  opts: { braces?: boolean } = {},
): WildcardExpansion {
  const rng = mulberry32(seed);
  const missing = new Set<string>();
  const used: string[] = [];
  let depthExceeded = false;

  const run = (text: string, depth: number): string =>
    text.replace(TOKEN_RE, (token, name: string) => {
      if (!isValidWildcardName(name)) return token;
      if (depth >= WILDCARD_MAX_DEPTH) {
        depthExceeded = true;
        return token;
      }
      const options = lookup(name);
      if (!options || options.length === 0) {
        missing.add(name);
        return token;
      }
      const pick = options[Math.min(options.length - 1, Math.floor(rng() * options.length))];
      used.push(name);
      return run(pick, depth + 1);
    });

  let out = run(prompt, 0);
  if (opts.braces !== false) out = expandDynamicPrompt(out, rng);
  if (out.length > WILDCARD_MAX_OUTPUT_LENGTH) {
    out = out.slice(0, WILDCARD_MAX_OUTPUT_LENGTH);
  }
  return { text: out, missing: [...missing], depthExceeded, used };
}

/**
 * Compact, typeable param chips for the Create feed.
 *
 * Gallery images persist chips as "key value" strings built from the parsed
 * params map, so keys are internal ids ("aspectRatio 1:1", "stylize 250") and
 * every image in a run carries its own "--seed N" chip. The feed renders:
 *   - humanized short flags ("ar 1:1", "s 250", "c 20"), so a chip reads like
 *     what the user would type and clicking it inserts a valid flag;
 *   - ONE seed chip per run ("seed 1000", "seed 1000…1003", "seed 7 +3");
 *   - the prompt text with the flags that already render as chips stripped
 *     (the full prompt is still what Copy / Use text puts on the clipboard).
 */

import registry from "@/lib/oj/registry.json";
import { filterParamChips } from "@/lib/ui/displayParams";

export interface ParamChip {
  /** Canonical registry id ("stylize", "ar", "seed"), used for dedupe/strip. */
  key: string;
  /** Text shown on the chip ("s 250"). */
  label: string;
  /** Typeable flag the chip inserts on click ("--s"). */
  flag: string;
  /** Value inserted after the flag ("250"); empty for boolean flags. */
  value: string;
}

interface RegistryParam {
  flags: string[];
}

const REGISTRY_PARAMS = (registry as { params: Record<string, RegistryParam> })
  .params;

/** Persisted/internal key spellings that are not registry ids or flags. */
const EXTRA_KEY_ALIASES: Readonly<Record<string, string>> = {
  aspectratio: "ar",
  aspect_ratio: "ar",
  aspect: "ar",
  imageweight: "iw",
  image_weight: "iw",
  styleweight: "sw",
  style_weight: "sw",
  charweight: "cw",
  characterweight: "cw",
  character_weight: "cw",
};

/** lower-cased id / flag name / alias → canonical registry id. */
const KEY_INDEX: Map<string, string> = (() => {
  const index = new Map<string, string>();
  // Longer flags first so a short alias never shadows a full flag name
  // (mirrors the parser's collision rule).
  const flagEntries: Array<[string, string]> = [];
  for (const [id, def] of Object.entries(REGISTRY_PARAMS)) {
    for (const flag of def.flags) {
      flagEntries.push([flag.replace(/^--/, "").toLowerCase(), id]);
    }
  }
  flagEntries.sort((a, b) => a[0].length - b[0].length);
  for (const [name, id] of flagEntries) index.set(name, id);
  for (const id of Object.keys(REGISTRY_PARAMS))
    index.set(id.toLowerCase(), id);
  for (const [alias, id] of Object.entries(EXTRA_KEY_ALIASES)) {
    if (REGISTRY_PARAMS[id]) index.set(alias, id);
  }
  return index;
})();

/** Canonical registry id for a chip/flag key, or the key itself if unknown. */
export function canonicalParamKey(key: string): string {
  const bare = key.replace(/^--?/, "");
  return KEY_INDEX.get(bare.toLowerCase()) ?? bare;
}

/** Shortest typeable flag for a canonical key ("stylize" → "--s"). */
export function shortFlagFor(key: string): string {
  const def = REGISTRY_PARAMS[key];
  if (!def || def.flags.length === 0) return `--${key}`;
  return def.flags.reduce((best, flag) =>
    flag.length < best.length ? flag : best,
  );
}

const ASPECT_ONLY = /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/;
const CHIP_PATTERN = /^(?:--?)?([A-Za-z_][\w-]*)(?:\s+(.*))?$/;

/** Humanize one persisted chip string; null when it can't be read as a param. */
export function humanizeParamChip(chip: string): ParamChip | null {
  const trimmed = chip.trim();
  if (!trimmed) return null;
  if (ASPECT_ONLY.test(trimmed)) {
    return { key: "ar", label: `ar ${trimmed}`, flag: "--ar", value: trimmed };
  }
  const match = trimmed.match(CHIP_PATTERN);
  if (!match) return null;
  const key = canonicalParamKey(match[1]);
  const value = (match[2] ?? "").trim();
  const flag = shortFlagFor(key);
  const name = flag.replace(/^--/, "");
  return { key, label: value ? `${name} ${value}` : name, flag, value };
}

/**
 * Compress a run's seeds to one label: "seed 1000" (single/identical),
 * "seed 1000…1003" (contiguous ascending), else "seed <first> +<n others>".
 */
export function formatSeedLabel(seeds: readonly number[]): string | null {
  const valid = seeds.filter((s) => Number.isFinite(s)).map(Math.trunc);
  if (valid.length === 0) return null;
  const unique = [...new Set(valid)];
  if (unique.length === 1) return `seed ${unique[0]}`;
  const contiguous = unique.every((s, i) => i === 0 || s === unique[i - 1] + 1);
  if (contiguous) return `seed ${unique[0]}…${unique[unique.length - 1]}`;
  return `seed ${unique[0]} +${unique.length - 1}`;
}

/**
 * Build the feed's chip list from persisted chip strings plus the run's
 * per-image seeds. Internal/no-op chips are dropped (filterParamChips), seed
 * chips collapse into one trailing chip, and duplicate keys keep the first.
 */
export function buildParamChips(
  chips: readonly string[],
  seeds: readonly number[] = [],
): ParamChip[] {
  const out: ParamChip[] = [];
  const seen = new Set<string>();
  for (const raw of filterParamChips(chips)) {
    const chip = humanizeParamChip(raw);
    if (!chip || chip.key === "seed") continue;
    // lora (and other multi-value flags) may legitimately repeat.
    const dedupeKey = chip.key === "lora" ? `lora:${chip.value}` : chip.key;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(chip);
  }
  const seedLabel = formatSeedLabel(seeds);
  if (seedLabel) {
    const first = seeds.find((s) => Number.isFinite(s));
    out.push({
      key: "seed",
      label: seedLabel,
      flag: "--seed",
      value: String(Math.trunc(first as number)),
    });
  }
  return out;
}

/**
 * Prompt text for display when params render as chips: removes `--flag
 * [value…]` segments whose key is already a chip (plus any seed), and keeps
 * flags that have no chip (e.g. `--no hands`) so nothing silently vanishes.
 * Returns the original text if stripping would leave it empty.
 */
export function stripChipFlagsFromPrompt(
  text: string,
  chipKeys: Iterable<string>,
): string {
  const firstFlag = text.search(/(?:^|\s)--[A-Za-z]/);
  if (firstFlag < 0) return text;
  const base = text.slice(0, firstFlag).trim();
  const shown = new Set(chipKeys);
  shown.add("seed");
  const tokens = text.slice(firstFlag).trim().split(/\s+/);
  const kept: string[] = [];
  let keeping = true;
  for (const token of tokens) {
    if (/^--[A-Za-z]/.test(token)) {
      keeping = !shown.has(canonicalParamKey(token));
      if (keeping) kept.push(token);
    } else if (keeping) {
      kept.push(token);
    }
  }
  const result = [base, ...kept].filter(Boolean).join(" ");
  return result || text;
}

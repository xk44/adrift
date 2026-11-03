/**
 * Editable rerun: take an image's prompt and produce N prompt variants with
 * per-run parameter overrides (stylize / chaos / weird / aspect / seed).
 *
 * Operates purely at the prompt-string level so it composes with the existing
 * prompt parser — an overridden flag is stripped and re-appended, an untouched flag
 * is left exactly as the original prompt had it. Built for the s-slider dataset
 * loop: fix a prompt, sweep a parameter, fan out several seeds.
 */

export interface RerunOverrides {
  /** 0-1000; null/undefined leaves any existing --s/--stylize untouched. */
  stylize?: number | null;
  /** 0-100; null/undefined leaves any existing --chaos/--c untouched. */
  chaos?: number | null;
  /**
   * Reserved: --weird has no effect yet and the UI does not offer it.
   * null/undefined leaves it untouched.
   */
  weird?: number | null;
  /** "W:H"; null/undefined leaves any existing --ar/--aspect untouched. */
  aspect?: string | null;
  /**
   * Base seed. When set, variant i uses seed+i (reproducible fan-out).
   * When null/undefined, no --seed is appended and the backend randomizes
   * each job independently.
   */
  seed?: number | null;
  /** Number of variants to emit (clamped 1-25). Defaults to 1. */
  count?: number;
}

const FLAG_ALIASES = {
  stylize: ["--stylize", "--s"],
  chaos: ["--chaos", "--c"],
  weird: ["--weird", "--w"],
  aspect: ["--aspect", "--ar"],
  seed: ["--seed"],
} as const;

const ALWAYS_STRIPPED = FLAG_ALIASES.seed;

/**
 * Remove `--flag <value>` occurrences from a prompt. Each of these params
 * (seed/stylize/chaos/weird/aspect) takes exactly one value token, so we drop
 * the flag plus at most one following non-flag token. Case-insensitive on the
 * flag; a trailing flag with no value is dropped on its own.
 */
export function stripFlags(prompt: string, flags: readonly string[]): string {
  const lowered = new Set(flags.map((f) => f.toLowerCase()));
  const tokens = prompt.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let dropNextValue = false;
  for (const token of tokens) {
    const isFlag = token.startsWith("--");
    if (dropNextValue) {
      dropNextValue = false;
      if (!isFlag) continue; // consume the single value token
    }
    if (isFlag && lowered.has(token.toLowerCase())) {
      dropNextValue = true;
      continue;
    }
    out.push(token);
  }
  return out.join(" ").trim();
}

function clampCount(count: number | undefined): number {
  if (!count || !Number.isFinite(count)) return 1;
  return Math.max(1, Math.min(25, Math.floor(count)));
}

/**
 * Base prompt with the overridden flags stripped and the canonical override
 * flags appended once. Seed is handled per-variant by {@link buildRerunPrompts}.
 */
export function applyOverrides(
  prompt: string,
  overrides: Omit<RerunOverrides, "seed" | "count">,
): string {
  let result = prompt;
  const appended: string[] = [];

  const num = (key: "stylize" | "chaos" | "weird", canonical: string): void => {
    const value = overrides[key];
    if (value === null || value === undefined) return;
    result = stripFlags(result, FLAG_ALIASES[key]);
    appended.push(`${canonical} ${Math.round(value)}`);
  };

  num("stylize", "--s");
  num("chaos", "--chaos");
  num("weird", "--weird");

  if (overrides.aspect !== null && overrides.aspect !== undefined) {
    const aspect = overrides.aspect.trim();
    if (aspect) {
      result = stripFlags(result, FLAG_ALIASES.aspect);
      appended.push(`--ar ${aspect}`);
    }
  }

  result = [result, ...appended]
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return result;
}

/**
 * Produce `count` prompt variants from a base prompt + overrides. Any existing
 * --seed on the base prompt is always removed first. When `seed` is set the
 * variants get seed, seed+1, … (reproducible); otherwise no seed is appended.
 */
export function buildRerunPrompts(
  basePrompt: string,
  overrides: RerunOverrides = {},
): string[] {
  const { seed, count, ...paramOverrides } = overrides;
  const stripped = stripFlags(basePrompt, ALWAYS_STRIPPED);
  const withParams = applyOverrides(stripped, paramOverrides);
  const n = clampCount(count);

  return Array.from({ length: n }, (_, i) => {
    if (seed === null || seed === undefined) return withParams;
    return `${withParams} --seed ${Math.round(seed) + i}`.trim();
  });
}

/**
 * Dynamic prompts / wildcards
 * Expands Automatic1111/SD.Next-style `{a|b|c}` alternation syntax by
 * picking one option at random. Supports arbitrary nesting, e.g.
 * `{big {red|green}|small blue}`.
 *
 * This is a pure text transform with no knowledge of prompt `--flags` or
 * ComfyUI attention weighting (`(word:1.3)`, `[word]`) — it only reacts to
 * `{`, `}`, and `|`, so those other syntaxes pass through untouched.
 *
 * Escaping: `\{`, `\}`, `\|`, and `\\` are treated as literal characters
 * (the backslash is stripped). Unbalanced braces (no matching partner) are
 * left as literal text rather than erroring.
 */

/**
 * Build a map of opening-brace index -> matching closing-brace index,
 * using a stack so nested groups pair up correctly. Escaped braces
 * (`\{`, `\}`) are skipped and never considered part of the structure.
 * Any `{` left without a matching `}` (and vice versa) is simply absent
 * from the map, which causes it to be treated as literal text later.
 */
function buildBraceMatches(input: string): Map<number, number> {
  const matches = new Map<number, number>();
  const stack: number[] = [];

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (ch === "\\" && i + 1 < input.length && "{}|\\".includes(input[i + 1])) {
      i++; // skip the escaped character
      continue;
    }

    if (ch === "{") {
      stack.push(i);
    } else if (ch === "}") {
      if (stack.length > 0) {
        const open = stack.pop() as number;
        matches.set(open, i);
      }
      // Stray closing brace with no open partner: leave as literal.
    }
  }

  return matches;
}

/**
 * Split the range [start, end) of `input` into top-level alternatives on
 * unescaped `|` characters, skipping over any nested `{...}` group (as
 * defined by `matches`) so pipes inside a nested group don't split the
 * outer alternation.
 */
function splitAlternatives(
  input: string,
  start: number,
  end: number,
  matches: Map<number, number>,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let segmentStart = start;
  let i = start;

  while (i < end) {
    const ch = input[i];

    if (ch === "\\" && i + 1 < end && "{}|\\".includes(input[i + 1])) {
      i += 2;
      continue;
    }

    if (ch === "{" && matches.has(i)) {
      i = (matches.get(i) as number) + 1;
      continue;
    }

    if (ch === "|") {
      ranges.push({ start: segmentStart, end: i });
      segmentStart = i + 1;
      i++;
      continue;
    }

    i++;
  }

  ranges.push({ start: segmentStart, end });
  return ranges;
}

/**
 * Recursively expand the range [start, end) of `input`, resolving any
 * `{...}` groups (per `matches`) by picking one alternative via `rng` and
 * un-escaping literal `\{`, `\}`, `\|`, `\\`.
 */
function expandRange(
  input: string,
  start: number,
  end: number,
  matches: Map<number, number>,
  rng: () => number,
): string {
  let result = "";
  let i = start;

  while (i < end) {
    const ch = input[i];

    if (ch === "\\" && i + 1 < end && "{}|\\".includes(input[i + 1])) {
      result += input[i + 1];
      i += 2;
      continue;
    }

    if (ch === "{" && matches.has(i)) {
      const close = matches.get(i) as number;
      const alternatives = splitAlternatives(input, i + 1, close, matches);
      const raw = rng();
      const idx = Math.min(
        alternatives.length - 1,
        Math.max(0, Math.floor(raw * alternatives.length)),
      );
      const chosen = alternatives[idx];
      result += expandRange(input, chosen.start, chosen.end, matches, rng);
      i = close + 1;
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

/**
 * Expand `{a|b|c}` wildcard alternation in a prompt, picking one option at
 * random (or deterministically via a seeded `rng`). Nested groups like
 * `{big {red|green}|small blue}` are supported. Text with no braces is
 * returned unchanged (aside from un-escaping any literal `\{`/`\}`/`\|`).
 *
 * Pass a seeded `rng` (returning values in `[0, 1)`) for deterministic
 * expansion in tests.
 */
export function expandDynamicPrompt(
  prompt: string,
  rng: () => number = Math.random,
): string {
  if (!prompt) return prompt;
  const matches = buildBraceMatches(prompt);
  return expandRange(prompt, 0, prompt.length, matches, rng);
}

/**
 * Cap on the number of grid cells `expandDynamicPromptGrid` will produce, so a
 * pathological prompt (`{a|b|c|d} {1|2|3|4} ...`) can't blow up into thousands
 * of jobs. Combinations past the cap are dropped.
 */
export const MAX_GRID_CELLS = 100;

/**
 * Recursively enumerate *every* combination of `{a|b|c}` alternatives in the
 * range [start, end) — the cartesian product across all groups — rather than
 * picking one. Returns the list of fully-expanded strings, capped at
 * MAX_GRID_CELLS to bound the fan-out.
 */
function expandRangeAll(
  input: string,
  start: number,
  end: number,
  matches: Map<number, number>,
): string[] {
  let results = [""];
  let i = start;

  const cap = (arr: string[]): string[] =>
    arr.length > MAX_GRID_CELLS ? arr.slice(0, MAX_GRID_CELLS) : arr;

  while (i < end) {
    const ch = input[i];

    if (ch === "\\" && i + 1 < end && "{}|\\".includes(input[i + 1])) {
      const lit = input[i + 1];
      results = results.map((r) => r + lit);
      i += 2;
      continue;
    }

    if (ch === "{" && matches.has(i)) {
      const close = matches.get(i) as number;
      const alternatives = splitAlternatives(input, i + 1, close, matches);
      const altExpansions = alternatives.flatMap((a) =>
        expandRangeAll(input, a.start, a.end, matches),
      );
      results = cap(results.flatMap((r) => altExpansions.map((e) => r + e)));
      i = close + 1;
      continue;
    }

    results = results.map((r) => r + ch);
    i++;
  }

  return results;
}

/**
 * Expand `{a|b|c}` wildcards combinatorially: return one string per combination
 * of alternatives (the cartesian product) instead of a single random pick. This
 * powers the XYZ-plot / grid mode — `{photo|painting} of a {cat|dog}` yields the
 * four cells `photo of a cat`, `photo of a dog`, `painting of a cat`,
 * `painting of a dog`. A prompt with no braces returns a single-element array.
 * The result is capped at MAX_GRID_CELLS. Attention weights and prompt `--flags`
 * pass through untouched (same brace-only transform as expandDynamicPrompt).
 */
export function expandDynamicPromptGrid(prompt: string): string[] {
  if (!prompt) return [prompt];
  const matches = buildBraceMatches(prompt);
  const out = expandRangeAll(prompt, 0, prompt.length, matches);
  return out.length ? out : [prompt];
}

export default expandDynamicPrompt;

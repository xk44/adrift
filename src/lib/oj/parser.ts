import registry from "./registry.json";
import { parseRegions } from "./regionalPrompt";
import type { ParamKind, ParamDef, ParseResult } from "@/types";

// Build flag index from registry.
// Sort all (flag, id, def) tuples by flag length ascending so that longer
// flags are inserted last and therefore win on any key collision.  This
// prevents a shorthand like --s from shadowing a longer flag like --seed or
// --stop when both happen to share a key (e.g. if the registry is extended).
const FLAG_INDEX = new Map<string, { id: string; def: ParamDef }>();

const _flagEntries: Array<{ flag: string; id: string; def: ParamDef }> = [];
for (const [id, def] of Object.entries(
  registry.params as Record<string, ParamDef>,
)) {
  for (const flag of def.flags) {
    _flagEntries.push({ flag: flag.toLowerCase(), id, def });
  }
}
_flagEntries.sort((a, b) => a.flag.length - b.flag.length);
for (const { flag, id, def } of _flagEntries) {
  FLAG_INDEX.set(flag, { id, def });
}

/**
 * Tokenize input string respecting quotes and escape sequences
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && quote) {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if ((ch === '"' || ch === "'") && current.length === 0) {
      // Only open a quoted span when we are at the start of a new token.
      // Mid-word apostrophes (e.g. "dog's") are treated as literal characters.
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Coerce string value to appropriate type based on param kind
 */
function coerce(kind: ParamKind, raw: string): unknown {
  switch (kind) {
    case "int": {
      const v = Number.parseInt(raw, 10);
      return Number.isFinite(v) ? v : undefined;
    }
    case "float": {
      const v = Number.parseFloat(raw);
      return Number.isFinite(v) ? v : undefined;
    }
    case "flag":
      return true;
    case "aspect":
    case "string":
    default:
      return raw;
  }
}

/**
 * Validate a parameter value against its definition constraints
 */
function validate(
  def: ParamDef,
  value: unknown,
): { valid: boolean; error?: string } {
  if (value === undefined || value === null) {
    return { valid: false, error: "Value is required" };
  }

  if (def.kind === "int" || def.kind === "float") {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return { valid: false, error: `Invalid number: ${value}` };
    }
    if (def.min !== undefined && num < def.min) {
      return {
        valid: false,
        error: `Value ${num} is below minimum ${def.min}`,
      };
    }
    if (def.max !== undefined && num > def.max) {
      return {
        valid: false,
        error: `Value ${num} is above maximum ${def.max}`,
      };
    }
  }

  if (def.kind === "aspect") {
    const str = String(value);
    // Integer or decimal W:H — the API accept ratios like 2.35:1 or 1.85:1.
    if (!/^\d+(\.\d+)?:\d+(\.\d+)?$/.test(str)) {
      return {
        valid: false,
        error: `Invalid aspect ratio format: ${str}. Use W:H format (e.g., 16:9 or 2.35:1)`,
      };
    }
    const [w, h] = str.split(":").map(Number);
    if (w <= 0 || h <= 0) {
      return {
        valid: false,
        error: `Invalid aspect ratio: ${str}. Both sides must be positive.`,
      };
    }
  }

  return { valid: true };
}

/**
 * Parse a prompt input into prompt text and parameters
 */
export function parseImagineInput(input: string): ParseResult {
  const tokens = tokenize(input);
  const promptParts: string[] = [];
  const params: Record<string, unknown> = {};
  const unknownFlags: string[] = [];
  const errors: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (!token.startsWith("--")) {
      promptParts.push(token);
      continue;
    }

    const flagLower = token.toLowerCase();
    const hit = FLAG_INDEX.get(flagLower);

    if (!hit || hit.def.unsupported) {
      unknownFlags.push(token);
      // Consume any immediately following non-flag tokens so they don't
      // bleed into the prompt text (same convention as known value params).
      while (i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
        i++;
      }
      continue;
    }

    const { id, def } = hit;

    // Boolean flag - no value needed
    if (def.kind === "flag") {
      params[id] = true;
      continue;
    }

    const nextToken = tokens[i + 1];

    if (!nextToken || nextToken.startsWith("--")) {
      errors.push(`Parameter ${token} requires a value`);
      continue;
    }

    // Handle multi-value parameters (like --no)
    if (def.multi) {
      const parts: string[] = [];
      let j = i + 1;

      while (j < tokens.length && !tokens[j].startsWith("--")) {
        parts.push(tokens[j]);
        j++;
      }

      i = j - 1;
      const rawValue = parts.join(" ").trim();

      if (rawValue.length) {
        const coerced = coerce(def.kind, rawValue);
        if (id === "sref") {
          params[id] = coerced;
          continue;
        }
        const existing = params[id];

        if (Array.isArray(existing)) {
          existing.push(coerced);
        } else if (existing !== undefined) {
          params[id] = [existing, coerced];
        } else {
          params[id] = [coerced];
        }
      }
      continue;
    }

    const coerced = coerce(def.kind, nextToken);
    const validation = validate(def, coerced);

    if (!validation.valid) {
      errors.push(`${token}: ${validation.error}`);
    } else {
      params[id] = coerced;
    }

    i++;
  }

  // --region values are "<area>[::strength] <prompt>"; reject bad specs here
  // so the request fails loudly instead of the engine dropping the box.
  if (params.region !== undefined) {
    errors.push(...parseRegions(params.region).errors);
  }

  return {
    prompt: promptParts.join(" ").trim(),
    params,
    unknownFlags,
    errors,
  };
}

/**
 * Format parameters back into a shortcode string
 */
export function formatParams(params: Record<string, unknown>): string {
  const parts: string[] = [];

  for (const [id, value] of Object.entries(params)) {
    const def = registry.params[id as keyof typeof registry.params] as
      ParamDef | undefined;
    if (!def) continue;

    const flag = def.flags[0];

    if (def.kind === "flag" && value === true) {
      parts.push(flag);
    } else if (Array.isArray(value)) {
      for (const v of value) {
        parts.push(`${flag} ${v}`);
      }
    } else if (value !== undefined && value !== null) {
      parts.push(`${flag} ${value}`);
    }
  }

  return parts.join(" ");
}

/**
 * Build full prompt string from text and parameters
 */
export function buildFullPrompt(
  prompt: string,
  params: Record<string, unknown>,
): string {
  const paramString = formatParams(params);
  return paramString ? `${prompt} ${paramString}` : prompt;
}

export function getParamDef(id: string): ParamDef | undefined {
  return registry.params[id as keyof typeof registry.params] as
    ParamDef | undefined;
}

export function getAllParams(): Record<string, ParamDef> {
  return registry.params as Record<string, ParamDef>;
}

/**
 * Get autocomplete suggestions for a partial flag
 */
export function getAutocompleteSuggestions(partial: string): Array<{
  flag: string;
  id: string;
  description: string;
  kind: ParamKind;
}> {
  const lowerPartial = partial.toLowerCase();
  const suggestions: Array<{
    flag: string;
    id: string;
    description: string;
    kind: ParamKind;
  }> = [];

  for (const [id, def] of Object.entries(
    registry.params as Record<string, ParamDef>,
  )) {
    for (const flag of def.flags) {
      if (flag.toLowerCase().startsWith(lowerPartial)) {
        suggestions.push({
          flag,
          id,
          description: def.description || "",
          kind: def.kind,
        });
        break; // Only add once per param
      }
    }
  }

  return suggestions.sort((a, b) => a.flag.length - b.flag.length);
}

export default {
  parseImagineInput,
  formatParams,
  buildFullPrompt,
  getParamDef,
  getAllParams,
  getAutocompleteSuggestions,
};

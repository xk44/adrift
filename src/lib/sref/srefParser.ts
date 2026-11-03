/**
 * SREF Parser
 * Extended parser for --sref syntax with per-item weights.
 * 
 * Supports:
 * - --sref <image_url_or_code> [<image_url_or_code>...]
 * - Per-item weights: item::weight (e.g., --sref img1::2 img2::1)
 * - --sw N (style weight 0-1000, default 100)
 * - --sref random (generates random style code)
 * - Multiple sref items mixed (codes and images)
 * 
 * Acronyms:
 * - SREF = Style Reference
 * - SW = Style Weight
 * - SC = Style Code
 */

export interface SREFItem {
  value: string;           // URL or numeric code
  type: "url" | "code" | "random";
  weight: number;          // Per-item weight (default 1.0)
  resolved?: string;       // For "random", stores resolved code
}

export interface SREFParams {
  items: SREFItem[];
  styleWeight: number;     // Global SW value (0-1000)
  styleVersion?: number;   // --sv parameter (1-5)
}

export interface LoRAItem {
  name: string;            // Shortcode or filename
  strength: number;        // Model strength
  clipStrength?: number;   // CLIP strength (defaults to strength)
  isRandom?: boolean;      // Was this from --lora random
  triggers?: string[];     // Auto-loaded triggers
}

export interface LoRAParams {
  items: LoRAItem[];
  autoTrigger: boolean;
  triggerPosition: "beginning" | "middle" | "end";
}

export interface ExtendedParseResult {
  prompt: string;
  sref: SREFParams | null;
  lora: LoRAParams | null;
  otherParams: Record<string, unknown>;
  errors: string[];
  warnings: string[];
}

function isUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isStyleCode(str: string): boolean {
  return /^\d{6,12}$/.test(str);
}

/**
 * Parse a single SREF item which may include weight (item::weight)
 */
function parseSREFItem(raw: string): SREFItem {
  // Check for weight suffix
  const weightMatch = raw.match(/^(.+)::(\d+(?:\.\d+)?)$/);
  
  let value: string;
  let weight = 1.0;
  
  if (weightMatch) {
    value = weightMatch[1];
    weight = parseFloat(weightMatch[2]);
    if (isNaN(weight) || weight < 0) weight = 1.0;
  } else {
    value = raw;
  }
  
  let type: "url" | "code" | "random";
  if (value.toLowerCase() === "random") {
    type = "random";
  } else if (isUrl(value)) {
    type = "url";
  } else if (isStyleCode(value)) {
    type = "code";
  } else {
    // Assume it's a code if it's not a URL
    type = "code";
  }
  
  return { value, type, weight };
}

/**
 * Parse a single LoRA item which may include strength (name::strength)
 */
function parseLoRAItem(raw: string): LoRAItem {
  const parts = raw.split("::");
  const name = parts[0].trim();
  let strength = 1.0;
  let clipStrength: number | undefined;
  
  if (parts.length >= 2) {
    strength = parseFloat(parts[1]);
    if (isNaN(strength)) strength = 1.0;
  }
  
  if (parts.length >= 3) {
    clipStrength = parseFloat(parts[2]);
    if (isNaN(clipStrength)) clipStrength = strength;
  }
  
  const isRandom = name.toLowerCase() === "random";
  
  return {
    name,
    strength: Math.max(-2, Math.min(2, strength)),
    clipStrength: clipStrength !== undefined ? Math.max(-2, Math.min(2, clipStrength)) : undefined,
    isRandom,
  };
}

/**
 * Tokenize input preserving quoted strings and respecting --flag boundaries
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

    if (ch === '"' || ch === "'") {
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
 * Parse extended prompt with SREF support
 */
export function parseExtendedPrompt(input: string): ExtendedParseResult {
  const tokens = tokenize(input);
  const promptParts: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const otherParams: Record<string, unknown> = {};
  
  let sref: SREFParams | null = null;
  let lora: LoRAParams | null = null;
  
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const tokenLower = token.toLowerCase();
    
    // Handle --sref
    if (tokenLower === "--sref") {
      const srefItems: SREFItem[] = [];
      i++;
      
      // Collect all following items until next flag
      while (i < tokens.length && !tokens[i].startsWith("--")) {
        srefItems.push(parseSREFItem(tokens[i]));
        i++;
      }
      
      if (srefItems.length === 0) {
        errors.push("--sref requires at least one image URL");
      } else {
        if (!sref) {
          sref = {
            items: [],
            styleWeight: 100, // Default
          };
        }
        sref.items.push(...srefItems);
      }
      continue;
    }
    
    // Handle --sw (style weight)
    if (tokenLower === "--sw") {
      i++;
      if (i < tokens.length && !tokens[i].startsWith("--")) {
        const sw = parseInt(tokens[i], 10);
        if (!isNaN(sw) && sw >= 0 && sw <= 1000) {
          if (!sref) {
            sref = { items: [], styleWeight: sw };
          } else {
            sref.styleWeight = sw;
          }
        } else {
          errors.push("--sw must be a number between 0 and 1000");
        }
        i++;
      } else {
        errors.push("--sw requires a value");
      }
      continue;
    }
    
    // Handle --sv (style version)
    if (tokenLower === "--sv") {
      i++;
      if (i < tokens.length && !tokens[i].startsWith("--")) {
        const sv = parseInt(tokens[i], 10);
        if (!isNaN(sv) && sv >= 1 && sv <= 5) {
          if (!sref) {
            sref = { items: [], styleWeight: 100, styleVersion: sv };
          } else {
            sref.styleVersion = sv;
          }
        } else {
          errors.push("--sv must be a number between 1 and 5");
        }
        i++;
      } else {
        errors.push("--sv requires a value");
      }
      continue;
    }
    
    // Handle --lora
    if (tokenLower === "--lora") {
      const loraItems: LoRAItem[] = [];
      i++;
      
      // Collect all following items until next flag
      while (i < tokens.length && !tokens[i].startsWith("--")) {
        loraItems.push(parseLoRAItem(tokens[i]));
        i++;
      }
      
      if (loraItems.length === 0) {
        errors.push("--lora requires at least one LoRA name");
      } else {
        if (!lora) {
          lora = {
            items: [],
            autoTrigger: false,
            triggerPosition: "beginning",
          };
        }
        lora.items.push(...loraItems);
      }
      continue;
    }
    
    // Handle --autotrigger (auto trigger insertion)
    if (tokenLower === "--autotrigger") {
      if (!lora) {
        lora = { items: [], autoTrigger: true, triggerPosition: "beginning" };
      } else {
        lora.autoTrigger = true;
      }
      i++;
      
      // Check for position parameter
      if (i < tokens.length && !tokens[i].startsWith("--")) {
        const pos = tokens[i].toLowerCase();
        if (pos === "beg" || pos === "beginning") {
          lora.triggerPosition = "beginning";
          i++;
        } else if (pos === "mid" || pos === "middle") {
          lora.triggerPosition = "middle";
          i++;
        } else if (pos === "end") {
          lora.triggerPosition = "end";
          i++;
        }
      }
      continue;
    }
    
    // Handle other known flags (pass through to otherParams)
    if (token.startsWith("--")) {
      const flag = token.slice(2).toLowerCase();
      i++;
      
      // Check if next token is a value or another flag
      if (i < tokens.length && !tokens[i].startsWith("--")) {
        otherParams[flag] = tokens[i];
        i++;
      } else {
        // Boolean flag
        otherParams[flag] = true;
      }
      continue;
    }
    
    // Not a flag - add to prompt
    promptParts.push(token);
    i++;
  }
  
  return {
    prompt: promptParts.join(" ").trim(),
    sref,
    lora,
    otherParams,
    errors,
    warnings,
  };
}

/**
 * Format SREF params back to string
 */
export function formatSREF(sref: SREFParams): string {
  const parts: string[] = [];
  
  const itemStrs = sref.items.map((item) => {
    if (item.weight !== 1.0) {
      return `${item.value}::${item.weight}`;
    }
    return item.value;
  });
  
  if (itemStrs.length > 0) {
    parts.push(`--sref ${itemStrs.join(" ")}`);
  }
  
  if (sref.styleWeight !== 100) {
    parts.push(`--sw ${sref.styleWeight}`);
  }
  
  if (sref.styleVersion) {
    parts.push(`--sv ${sref.styleVersion}`);
  }
  
  return parts.join(" ");
}

/**
 * Format LoRA params back to string
 */
export function formatLoRA(lora: LoRAParams): string {
  const parts: string[] = [];
  
  const itemStrs = lora.items.map((item) => {
    if (item.clipStrength !== undefined && item.clipStrength !== item.strength) {
      return `${item.name}::${item.strength}::${item.clipStrength}`;
    } else if (item.strength !== 1.0) {
      return `${item.name}::${item.strength}`;
    }
    return item.name;
  });
  
  if (itemStrs.length > 0) {
    parts.push(`--lora ${itemStrs.join(" ")}`);
  }
  
  if (lora.autoTrigger) {
    if (lora.triggerPosition !== "beginning") {
      parts.push(`--autotrigger ${lora.triggerPosition}`);
    } else {
      parts.push("--autotrigger");
    }
  }
  
  return parts.join(" ");
}

/**
 * Generate a random style code (numeric)
 */
export function generateRandomStyleCode(): string {
  // Generate a 10-digit code
  const min = 1000000000;
  const max = 9999999999;
  return String(Math.floor(Math.random() * (max - min + 1)) + min);
}

/**
 * Resolve "random" SREF items to actual codes
 */
export function resolveRandomSREFs(sref: SREFParams): SREFParams {
  return {
    ...sref,
    items: sref.items.map((item) => {
      if (item.type === "random" && !item.resolved) {
        return {
          ...item,
          resolved: generateRandomStyleCode(),
        };
      }
      return item;
    }),
  };
}

/**
 * Get effective style code/URL from SREF item
 */
export function getSREFValue(item: SREFItem): string {
  if (item.type === "random" && item.resolved) {
    return item.resolved;
  }
  return item.value;
}

export default {
  parseExtendedPrompt,
  formatSREF,
  formatLoRA,
  generateRandomStyleCode,
  resolveRandomSREFs,
  getSREFValue,
};

/**
 * Pure input validators — no side effects, no external dependencies.
 */

import { isBlockedHostname } from "@/lib/net/addressPolicy";

// Prompt

const PROMPT_MAX_CHARS = 10_000;

// Control characters (C0 + C1 ranges) excluding safe whitespace (\t, \n, \r)
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

export type PromptResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * Validate and sanitize a prompt string.
 *  - Trims whitespace
 *  - Strips null bytes and control characters
 *  - Rejects empty strings
 *  - Enforces max length (10,000 chars, checked after trim)
 */
function sanitizeText(text: string): string {
  return text.replace(CONTROL_CHAR_RE, "").trim();
}

export function validatePrompt(text: string): PromptResult {
  if (typeof text !== "string") {
    return { ok: false, error: "Prompt must be a string" };
  }

  const sanitized = sanitizeText(text);

  if (sanitized.length === 0) {
    return { ok: false, error: "Prompt cannot be empty" };
  }

  if (sanitized.length > PROMPT_MAX_CHARS) {
    return {
      ok: false,
      error: `Prompt exceeds maximum length of ${PROMPT_MAX_CHARS} characters`,
    };
  }

  return { ok: true, text: sanitized };
}

export type StringResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

export function validateRequiredString(
  value: unknown,
  field: string,
  maxChars = 512,
): StringResult {
  if (typeof value !== "string") {
    return { ok: false, error: `Missing ${field}` };
  }
  const sanitized = sanitizeText(value);
  if (!sanitized) {
    return { ok: false, error: `Missing ${field}` };
  }
  if (sanitized.length > maxChars) {
    return {
      ok: false,
      error: `${field} exceeds maximum length of ${maxChars} characters`,
    };
  }
  return { ok: true, text: sanitized };
}

export function validateNonNegativeInteger(
  value: unknown,
  field: string,
): number | string {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return `${field} must be a non-negative integer`;
  }
  return value;
}

export function validatePlainObject(
  value: unknown,
  field: string,
): Record<string, unknown> | string {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    return `${field} must be an object`;
  }
  return value as Record<string, unknown>;
}

// Bounded integer (query param / body field)

/**
 * Parse and clamp an integer from a query param or body field.
 * Accepts numbers or numeric strings; falls back to `fallback` on invalid input.
 * Always returns an integer in [min, max].
 */
export function validateBoundedInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

// Batch size

const BATCH_SIZE_MIN = 1;
const BATCH_SIZE_MAX = 16;
const BATCH_SIZE_DEFAULT = 1;

/**
 * Validate and clamp a batch size value.
 * Accepts numbers or numeric strings; falls back to default on invalid input.
 * Always returns an integer in [1, 16].
 */
export function validateBatchSize(n: unknown): number {
  const parsed = typeof n === "number" ? n : Number(n);

  if (!Number.isFinite(parsed)) return BATCH_SIZE_DEFAULT;

  return Math.max(BATCH_SIZE_MIN, Math.min(BATCH_SIZE_MAX, Math.round(parsed)));
}

// Dimensions

const DIM_MIN = 64;
const DIM_MAX = 4096;
const DIM_MULTIPLE = 8;

/**
 * Clamp a single dimension value to [64, 4096] and round to nearest multiple of 8.
 */
function clampDimension(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;

  const clamped = Math.max(DIM_MIN, Math.min(DIM_MAX, Math.round(parsed)));
  return Math.floor(clamped / DIM_MULTIPLE) * DIM_MULTIPLE;
}

/**
 * Validate and normalise width/height dimensions.
 * Each is clamped to [64, 4096] and made divisible by 8.
 */
export function validateDimensions(
  w: unknown,
  h: unknown,
): { width: number; height: number } {
  return {
    width: clampDimension(w, 512),
    height: clampDimension(h, 512),
  };
}

// Seed

/**
 * Validate a seed value.
 * Returns a non-negative integer, or undefined if the input is absent/invalid.
 */
export function validateSeed(seed: unknown): number | undefined {
  if (seed === undefined || seed === null) return undefined;

  const parsed = typeof seed === "number" ? seed : Number(seed);

  if (!Number.isFinite(parsed)) return undefined;
  if (!Number.isInteger(parsed)) return undefined;
  if (parsed < 0) return undefined;

  return parsed;
}

// Server-side fetch URL allowlists

export function hostMatchesAllowlist(
  hostname: string,
  allowlist: string[],
): boolean {
  const host = hostname.toLowerCase();
  return allowlist.some((allowed) => {
    const rule = allowed.toLowerCase();
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(2);
      return host !== suffix && host.endsWith(`.${suffix}`);
    }
    return host === rule;
  });
}

export function isAllowedHttpsFetchUrl(
  url: string,
  hostAllowlist: string[],
): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      hostMatchesAllowlist(parsed.hostname, hostAllowlist)
    );
  } catch {
    return false;
  }
}

export const CIVITAI_IMAGE_HOST_ALLOWLIST = [
  "civitai.com",
  "*.civitai.com",
  "civitai.red",
  "*.civitai.red",
];

export function isAllowedCivitaiImageUrl(url: string): boolean {
  return isAllowedHttpsFetchUrl(url, CIVITAI_IMAGE_HOST_ALLOWLIST);
}

/** Hugging Face Hub API — exact host only (no *.hf.co CDN/space subdomains). */
export const HUGGINGFACE_API_HOST_ALLOWLIST = ["huggingface.co"];

/** Read-only Hub API: https://huggingface.co/api/... only. */
export function isAllowedHuggingFaceApiUrl(url: string): boolean {
  if (!isAllowedHttpsFetchUrl(url, HUGGINGFACE_API_HOST_ALLOWLIST)) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.pathname.startsWith("/api/") &&
      !parsed.username &&
      !parsed.password &&
      parsed.port === ""
    );
  } catch {
    return false;
  }
}

export function isAllowedInpaintImageSource(
  url: string,
  comfyHttpUrl: string,
): boolean {
  return resolveAllowedInpaintImageFetchUrl(url, comfyHttpUrl) !== null;
}

// Optional string (query params that may be absent)

/**
 * Validate an optional string query parameter.
 * Returns undefined if absent/empty, or the trimmed+sanitized string if valid.
 * Rejects values exceeding maxChars.
 */
export function validateOptionalString(
  value: string | null | undefined,
  maxChars = 256,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") return undefined;
  const sanitized = value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")
    .trim();
  if (!sanitized) return undefined;
  // Silently truncate rather than reject — these are filter/search params
  return sanitized.slice(0, maxChars);
}

// Enum validator

/**
 * Validate a string against a set of allowed values.
 * Returns the value if valid, or the fallback if not.
 */
export function validateEnum<T extends string>(
  value: string | null | undefined,
  allowed: Set<T>,
  fallback: T,
): T {
  if (!value) return fallback;
  return allowed.has(value as T) ? (value as T) : fallback;
}

// Identifier validator (UUIDs, prompt IDs, client IDs)

/**
 * Validate an identifier string (alphanumeric + hyphens + underscores + dots).
 * Rejects control chars, path separators, and overly long values.
 */
export function validateIdentifier(
  value: string | null | undefined,
  field: string,
  maxChars = 200,
): StringResult {
  if (!value || typeof value !== "string") {
    return { ok: false, error: `Missing ${field}` };
  }
  if (value.length > maxChars) {
    return {
      ok: false,
      error: `${field} exceeds maximum length of ${maxChars}`,
    };
  }
  // Block control chars, path separators, and whitespace-only
  if (/[\x00-\x1f\x7f/\\]/.test(value) || !value.trim()) {
    return { ok: false, error: `Invalid ${field}` };
  }
  return { ok: true, text: value.trim() };
}

export function resolveAllowedInpaintImageFetchUrl(
  url: string,
  comfyHttpUrl: string,
  appOrigin?: string,
): string | null {
  if (url.startsWith("data:")) return url;

  try {
    const comfy = new URL(comfyHttpUrl);
    if (url.startsWith("/")) {
      if (!appOrigin || !url.startsWith("/api/comfy/")) return null;
      return new URL(url, appOrigin).toString();
    }

    const parsed = new URL(url);
    return parsed.host === comfy.host ? parsed.toString() : null;
  } catch {
    return null;
  }
}

// Style-reference image fetch (imagine --sv2): SSRF guard

/**
 * Returns the URL if the server may fetch it as a style-ref image, else null.
 * Allowed: data: URLs, the configured ComfyUI / StyleVault hosts, and
 * http(s) URLs whose host is not a private/loopback/link-local address.
 */
export function resolveAllowedStyleRefFetchUrl(
  url: string,
  trustedBaseUrls: string[],
): string | null {
  if (url.startsWith("data:")) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    for (const base of trustedBaseUrls) {
      try {
        if (new URL(base).host === parsed.host) return parsed.toString();
      } catch {
        /* ignore malformed trusted base */
      }
    }
    return isBlockedHostname(parsed.hostname) ? null : parsed.toString();
  } catch {
    return null;
  }
}

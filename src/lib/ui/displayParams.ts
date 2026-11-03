/**
 * Shared filter for user-facing prompt-param chips (create feed, lightbox,
 * organize). Run params carry bookkeeping the server needs (source run ids,
 * absolute workflow paths, pack routing, structured sref/layout payloads) that
 * must never render as chips — the prompt display only shows the
 * prompt plus params the user could type (--ar, --sref, --s, --chaos, --seed…).
 *
 * The full params map is NOT dropped: it stays on `GalleryImage.paramsMap` and
 * is still available through the lightbox's Copy/Download Metadata actions.
 *
 * A key is hidden when ANY of these hold:
 *   1. it is in INTERNAL_PARAM_KEYS (explicit list — add new bookkeeping here);
 *   2. it starts with one of INTERNAL_PARAM_PREFIXES (`action_`, `_`);
 *   3. it contains one of INTERNAL_PARAM_SUBSTRINGS (case-insensitive:
 *      `path`, `workflow`, `run_id`, `runid`) — catches future leaks of
 *      filesystem paths / run bookkeeping without a list edit;
 * A value is hidden when it is a no-op (see isNoopParamValue): null/undefined,
 * empty string/array, `false`, "off"/"none", or a structured object (which
 * would otherwise render as "[object Object]").
 */

/** Exact keys that are internal bookkeeping, never user-facing chips. */
export const INTERNAL_PARAM_KEYS: ReadonlySet<string> = new Set([
  "packId", // workflow pack routing (auto-selected or --pack override)
  "pack_id",
  "mossLayout", // MOSS layout boxes (structured canvas payload)
  "srefParams", // resolved StyleVault sref payload (structured)
  "editMode", // krea2 grounded edit mode chosen by the tools page
  "wildcards", // wildcard expansion record
  "auto_detail_summary", // rendered separately in the lightbox
  "fullPrompt",
  "action",
  "negativePrompt",
  "tool_id", // shown as the feed's tool chip (runProvenance) instead
]);

export const INTERNAL_PARAM_PREFIXES: readonly string[] = ["action_", "_"];

export const INTERNAL_PARAM_SUBSTRINGS: readonly string[] = [
  "path",
  "workflow",
  "run_id",
  "runid",
];

/** Values that mean "nothing set" and add no information as a chip. */
const NOOP_STRING_VALUES = new Set([
  "",
  "off",
  "none",
  "null",
  "undefined",
  "[object object]",
]);

/** Internal key → the user-typeable flag name it was parsed from. */
export const DISPLAY_KEY_ALIASES: Readonly<Record<string, string>> = {
  mossSpeed: "speed",
  h3Speed: "speed",
};

export function isInternalParamKey(key: string): boolean {
  if (INTERNAL_PARAM_KEYS.has(key)) return true;
  if (INTERNAL_PARAM_PREFIXES.some((p) => key.startsWith(p))) return true;
  const lower = key.toLowerCase();
  return INTERNAL_PARAM_SUBSTRINGS.some((s) => lower.includes(s));
}

export function isNoopParamValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return true;
  if (typeof value === "string") {
    return NOOP_STRING_VALUES.has(value.trim().toLowerCase());
  }
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) {
    return (
      value.length === 0 ||
      value.some((v) => v !== null && typeof v === "object")
    );
  }
  return typeof value === "object";
}

/** True when a key/value pair should render as a user-facing chip. */
export function isDisplayableParam(key: string, value: unknown): boolean {
  return !isInternalParamKey(key) && !isNoopParamValue(value);
}

export function displayParamKey(key: string): string {
  return DISPLAY_KEY_ALIASES[key] ?? key;
}

/** Split a params map into user-facing entries and internal/no-op entries. */
export function partitionDisplayParams(params: Record<string, unknown>): {
  visible: [string, unknown][];
  hidden: [string, unknown][];
} {
  const visible: [string, unknown][] = [];
  const hidden: [string, unknown][] = [];
  for (const entry of Object.entries(params ?? {})) {
    (isDisplayableParam(entry[0], entry[1]) ? visible : hidden).push(entry);
  }
  return { visible, hidden };
}

/**
 * Filter already-built chip strings ("key value", "--seed 42", "raw", "16:9").
 * Needed because gallery images persist their chips, so older entries still
 * carry leaked keys. Chips that don't start with a key (e.g. bare "16:9") pass.
 */
export function filterParamChips(chips: readonly string[]): string[] {
  const out: string[] = [];
  for (const chip of chips) {
    const match = chip.trim().match(/^(--?)?([A-Za-z_][\w-]*)(?:\s+(.*))?$/);
    if (!match) {
      out.push(chip);
      continue;
    }
    const [, dashes = "", key, rawValue] = match;
    const value = rawValue === undefined ? true : rawValue.trim();
    if (!isDisplayableParam(key, value)) continue;
    const alias = displayParamKey(key);
    out.push(
      alias === key
        ? chip
        : `${dashes}${alias}${rawValue === undefined ? "" : ` ${value}`}`,
    );
  }
  return out;
}

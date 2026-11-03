/**
 * Character LoRAs for the Create prompt bar's "Character" picker.
 *
 * Pure (no React, no fetch, no Node APIs):
 * - classify an installed LoRA as a character (sidecar tags, Adrift trainer
 *   tag, then a conservative filename guess as the last resort);
 * - merge the server listing with client-side knowledge (trainer shortcodes,
 *   Civitai downloads);
 * - turn the selection into prompt flags the same way style LoRAs travel
 *   (`--lora <file>::<strength>`, one flag per LoRA), with trigger words
 *   prepended and family mismatches held back unless the user opts in.
 */

import { normalizeBaseFamily, packFamilyToGroup } from "@/lib/loraMetadata";

/** At most this many characters at once (two-person scenes). */
export const MAX_CHARACTERS = 2;
/** Character LoRAs usually want a little under full strength. */
export const DEFAULT_CHARACTER_STRENGTH = 0.9;
export const MIN_CHARACTER_STRENGTH = 0.1;
export const MAX_CHARACTER_STRENGTH = 1.5;

export type CharacterReason = "tag" | "trained" | "name" | null;

/** One installed LoRA as the picker sees it. */
export interface CharacterLoraEntry {
  /** Exact ComfyUI lora_name (may include a subfolder). */
  filename: string;
  /** Friendly label (Civitai model name, trainer run name, or file stem). */
  label: string;
  tags: string[];
  /** Raw base-model string, when known. */
  baseModel: string | null;
  /** Normalized family group (see loraMetadata FAMILY groups) or null. */
  baseFamily: string | null;
  triggers: string[];
  /** Suggested strength from metadata (A1111 "preferred weight", trainer). */
  strength: number | null;
  /** A preview image sits next to the file (served by /api/comfy/lora-preview). */
  hasPreview: boolean;
  /** Why this counts as a character; null = not a character. */
  characterReason: CharacterReason;
}

/** What the server route knows about one installed LoRA. */
export interface ServerLoraInfo {
  filename: string;
  modelName?: string | null;
  tags?: string[];
  baseModel?: string | null;
  triggers?: string[];
  preferredWeight?: number | null;
  hasPreview?: boolean;
}

/** Adrift trainer / LoRA-panel shortcode (styleStore.loraShortcodes). */
export interface ShortcodeLike {
  shortcode: string;
  filename: string;
  displayName?: string;
  tags?: string[];
  triggers?: string[];
  defaultStrength: number;
}

/** Civitai download record (downloadStore.downloads). */
export interface DownloadLike {
  filename: string;
  modelName: string;
  type: string;
  trainedWords: string[];
}

/** A picked character, persisted between visits. */
export interface CharacterSelection {
  filename: string;
  label: string;
  strength: number;
  /** Trigger words still on (removing a chip drops it from here). */
  triggers: string[];
  baseFamily: string | null;
  /** User chose to apply despite a different model family. */
  applyAnyway?: boolean;
}

// Classification

/** Civitai / LoRA Manager tags that mean "this is a character or a person". */
const CHARACTER_TAGS = new Set([
  "character",
  "characters",
  "anime character",
  "game character",
  "cartoon character",
  "original character",
  "oc",
  "person",
  "people",
  "celebrity",
  "real person",
  "actor",
  "actress",
  "vtuber",
]);

/** Tool / speed / edit LoRAs that only mention "character" in passing. */
const NOT_CHARACTER_NAME =
  /swap|sheet|edit|remov|turbo|lightning|\d+[-_ ]?steps?|distill|control|inpaint|outpaint|upscal|restor|consisten|angle|camera|motion|relight|bypass|adapter|detail|lcm|hyper|anything2|style/;

const CHARACTER_NAME =
  /(^|[^a-z])(char|character|characters|oc|person|celeb|celebrity|actor|actress|waifu|vtuber)([^a-z]|$)/;

/** Folders whose LoRAs are always tools, never characters. */
const TOOL_FOLDERS = /(^|\/)(edit_tools|krea2_control|controlnet|tools)\//i;

function normTags(tags: readonly string[] | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const s = t.trim().toLowerCase();
    if (s && s.length <= 60 && !out.includes(s)) out.push(s);
  }
  return out;
}

export function fileStem(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  return base.replace(/\.(safetensors|ckpt|pt|pth|bin)$/i, "");
}

/** "my_oc-v2" → "my oc v2" for display. */
export function labelFromFilename(filename: string): string {
  return fileStem(filename).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Character or not, and why. Tags win (they come from the LoRA's author or
 * Adrift's trainer); the filename is only consulted when no tags are known.
 */
export function classifyCharacterLora(input: {
  filename: string;
  tags?: readonly string[];
  trained?: boolean;
}): CharacterReason {
  const tags = normTags(input.tags as string[] | undefined);
  if (tags.some((t) => CHARACTER_TAGS.has(t))) {
    return input.trained ? "trained" : "tag";
  }
  if (tags.length > 0) return null;
  if (TOOL_FOLDERS.test(input.filename)) return null;
  const stem = fileStem(input.filename).toLowerCase();
  if (NOT_CHARACTER_NAME.test(stem)) return null;
  return CHARACTER_NAME.test(stem) ? "name" : null;
}

// Merge server listing + client knowledge

function baseName(p: string): string {
  return (p.split(/[\\/]/).pop() ?? p).toLowerCase();
}

function cleanStrength(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 2
    ? n
    : null;
}

/**
 * One entry per installed LoRA. Shortcodes and downloads only enrich files
 * the backend actually has (matched by base filename).
 */
export function buildCharacterEntries(
  server: readonly ServerLoraInfo[],
  shortcodes: readonly ShortcodeLike[] = [],
  downloads: readonly DownloadLike[] = [],
): CharacterLoraEntry[] {
  const byBase = <T>(items: readonly T[], key: (t: T) => string) => {
    const m = new Map<string, T>();
    for (const it of items) {
      const k = baseName(key(it));
      if (k && !m.has(k)) m.set(k, it);
    }
    return m;
  };
  const codes = byBase(shortcodes, (s) => s.filename || s.shortcode);
  const dls = byBase(downloads, (d) => d.filename);

  return server
    .filter((s) => typeof s.filename === "string" && s.filename)
    .map((s) => {
      const b = baseName(s.filename);
      // Shortcodes without an extension (trainer deploys "my_oc") still match.
      const code = codes.get(b) ?? codes.get(b.replace(/\.safetensors$/i, ""));
      const dl = dls.get(b);
      const trained = Boolean(code && normTags(code.tags).length > 0);
      const tags = normTags([...(s.tags ?? []), ...(code?.tags ?? [])]);
      const triggers = [
        ...(s.triggers ?? []),
        ...(dl?.trainedWords ?? []),
        ...(code?.triggers ?? []),
      ]
        .map((t) => (typeof t === "string" ? t.trim() : ""))
        .filter((t, i, all) => t && t.length <= 80 && all.indexOf(t) === i)
        .slice(0, 6);
      const baseModel = s.baseModel ?? null;
      return {
        filename: s.filename,
        label:
          code?.displayName?.trim() ||
          s.modelName?.trim() ||
          dl?.modelName?.trim() ||
          labelFromFilename(s.filename),
        tags,
        baseModel,
        baseFamily: normalizeBaseFamily(baseModel),
        triggers,
        strength:
          cleanStrength(s.preferredWeight) ??
          cleanStrength(code?.defaultStrength),
        hasPreview: Boolean(s.hasPreview),
        characterReason: classifyCharacterLora({
          filename: s.filename,
          tags,
          trained,
        }),
      };
    });
}

/** Search + "characters only" filter; characters first, then by label. */
export function filterCharacterEntries(
  entries: readonly CharacterLoraEntry[],
  opts: { query?: string; showAll?: boolean },
): CharacterLoraEntry[] {
  const q = (opts.query ?? "").trim().toLowerCase();
  return entries
    .filter((e) => opts.showAll || e.characterReason !== null)
    .filter(
      (e) =>
        !q ||
        e.label.toLowerCase().includes(q) ||
        e.filename.toLowerCase().includes(q) ||
        e.triggers.some((t) => t.toLowerCase().includes(q)) ||
        e.tags.some((t) => t.includes(q)),
    )
    .sort(
      (a, b) =>
        Number(b.characterReason !== null) -
          Number(a.characterReason !== null) || a.label.localeCompare(b.label),
    );
}

// Selection

export function clampStrength(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_CHARACTER_STRENGTH;
  const c = Math.min(
    MAX_CHARACTER_STRENGTH,
    Math.max(MIN_CHARACTER_STRENGTH, n),
  );
  return Math.round(c * 100) / 100;
}

export function selectionFromEntry(e: CharacterLoraEntry): CharacterSelection {
  return {
    filename: e.filename,
    label: e.label,
    strength: clampStrength(e.strength ?? DEFAULT_CHARACTER_STRENGTH),
    triggers: [...e.triggers],
    baseFamily: e.baseFamily,
  };
}

/** Add or remove; adding past MAX_CHARACTERS is refused (returns same list). */
export function toggleSelection(
  list: readonly CharacterSelection[],
  item: CharacterSelection,
): CharacterSelection[] {
  if (list.some((s) => s.filename === item.filename)) {
    return list.filter((s) => s.filename !== item.filename);
  }
  if (list.length >= MAX_CHARACTERS) return [...list];
  return [...list, item];
}

/** Drop malformed persisted rows (old versions, hand-edited storage). */
export function sanitizeSelections(raw: unknown): CharacterSelection[] {
  if (!Array.isArray(raw)) return [];
  const out: CharacterSelection[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.filename !== "string" || !o.filename) continue;
    if (out.some((s) => s.filename === o.filename)) continue;
    out.push({
      filename: o.filename,
      label:
        typeof o.label === "string" && o.label
          ? o.label
          : labelFromFilename(o.filename),
      strength: clampStrength(
        typeof o.strength === "number"
          ? o.strength
          : DEFAULT_CHARACTER_STRENGTH,
      ),
      triggers: Array.isArray(o.triggers)
        ? o.triggers
            .filter((t): t is string => typeof t === "string" && !!t.trim())
            .slice(0, 6)
        : [],
      baseFamily: typeof o.baseFamily === "string" ? o.baseFamily : null,
      ...(o.applyAnyway === true ? { applyAnyway: true } : {}),
    });
    if (out.length >= MAX_CHARACTERS) break;
  }
  return out;
}

// Model family

/**
 * Family group of what Create will run, or null when unknown (no warning).
 * `modelFamily` is detectModelFamilyStrict(model) for the chosen checkpoint
 * (the caller passes it so this module stays free of the pack registry).
 */
export function activeFamilyGroup(opts: {
  modelVersion?: string;
  modelFamily?: string | null;
  workflowName?: string | null;
}): string | null {
  const v = opts.modelVersion ?? "";
  if (v.startsWith("krea-2")) return "krea2";
  if (v === "zimage-turbo") return "zimage";
  if (v === "ideogram4") return "ideogram4";
  if (v === "h3-image") return "minimax";
  const fam = opts.modelFamily;
  if (fam && fam !== "unknown") {
    return packFamilyToGroup(fam);
  }
  return normalizeBaseFamily(opts.workflowName ?? null);
}

/** True when both families are known and differ. */
export function isFamilyMismatch(
  sel: Pick<CharacterSelection, "baseFamily">,
  activeFamily: string | null,
): boolean {
  return Boolean(
    sel.baseFamily && activeFamily && sel.baseFamily !== activeFamily,
  );
}

// Prompt wiring

/** Characters that will actually be applied with this model family. */
export function appliedSelections(
  list: readonly CharacterSelection[],
  activeFamily: string | null,
): CharacterSelection[] {
  return list.filter(
    (s) => s.applyAnyway || !isFamilyMismatch(s, activeFamily),
  );
}

function fmtStrength(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Prompt flags split on spaces, so a file name with one can't be passed. */
export function isPromptSafeLoraName(filename: string): boolean {
  return Boolean(filename) && !/\s/.test(filename);
}

/** `--lora <file>::<strength>` per applied character (one flag each). */
export function characterLoraFlags(
  list: readonly CharacterSelection[],
): string {
  return list
    .filter((s) => isPromptSafeLoraName(s.filename))
    .map((s) => `--lora ${s.filename}::${fmtStrength(s.strength)}`)
    .join(" ");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Prompt with the selected characters applied: trigger words not already in
 * the text go in front, LoRA flags at the end. A file the user already typed
 * as `--lora` is left alone (their strength wins).
 */
export function applyCharactersToPrompt(
  prompt: string,
  list: readonly CharacterSelection[],
  activeFamily: string | null,
): string {
  const applied = appliedSelections(list, activeFamily).filter(
    (s) =>
      isPromptSafeLoraName(s.filename) &&
      !new RegExp(`--lora\\s+${escapeRe(s.filename)}(?=$|\\s|::)`, "i").test(
        prompt,
      ),
  );
  if (applied.length === 0) return prompt;
  const text = prompt.trim();
  const lower = text.toLowerCase();
  const triggers: string[] = [];
  for (const s of applied) {
    for (const t of s.triggers) {
      const w = t.trim();
      if (w && !lower.includes(w.toLowerCase()) && !triggers.includes(w)) {
        triggers.push(w);
      }
    }
  }
  const head = triggers.length > 0 ? `${triggers.join(", ")}, ${text}` : text;
  const flags = characterLoraFlags(applied);
  return flags ? `${head} ${flags}` : head;
}

/**
 * True when the prompt names a LoRA by itself (typed `--lora`, a style LoRA),
 * ignoring the character flags. useImagine only adds the Settings/default
 * LoRAs when this is false, so picking a character never drops them.
 */
export function promptHasOwnLora(
  prompt: string,
  characterFiles: readonly string[],
): boolean {
  const re = /--lora\s+(\S+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) {
    const name = m[1].split("::")[0];
    if (name.startsWith("--")) continue;
    if (!characterFiles.includes(name)) return true;
  }
  return false;
}

// Reference-image characters (ComfyUI-Anima-Ref-Adapter)

/** Pilot adapter loader (any installed version has it). */
export const ANIMA_REF_ADAPTER_NODE = "AnimaRefAdapterLoader";
/** v2 one-node adapter (fb587d2+): faster, and takes two stitched references. */
export const ANIMA_REF_ADAPTER_V2_NODE = "AnimaRefAdapter";

function lists(objectInfo: unknown, node: string): boolean {
  return Boolean(
    objectInfo &&
    typeof objectInfo === "object" &&
    !Array.isArray(objectInfo) &&
    Object.prototype.hasOwnProperty.call(objectInfo, node),
  );
}

/** /object_info (full or /object_info/<node>) lists an Anima ref adapter (pilot or v2). */
export function hasAnimaRefAdapter(objectInfo: unknown): boolean {
  return (
    lists(objectInfo, ANIMA_REF_ADAPTER_NODE) ||
    lists(objectInfo, ANIMA_REF_ADAPTER_V2_NODE)
  );
}

/** /object_info lists the v2 adapter (two-character references). */
export function hasAnimaRefAdapterV2(objectInfo: unknown): boolean {
  return lists(objectInfo, ANIMA_REF_ADAPTER_V2_NODE);
}

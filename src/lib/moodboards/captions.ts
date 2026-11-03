/** Sidecar text: trigger word first (kohya/musubi/ai-toolkit convention).
 * Lives in lib (not the train route) because Next.js route files may only
 * export route handlers. */
export function captionText(caption: string, triggerWord: string): string {
  const trimmed = caption.trim();
  const trigger = triggerWord.trim();
  if (!trigger) return trimmed;
  if (!trimmed) return trigger;
  // Only skip the activation prefix when the caption ALREADY LEADS with the
  // exact trigger token — a substring match would suppress it (trigger
  // "cat" + caption "catwalk photo" would leave the LoRA with no "cat, ..." token).
  const lc = trimmed.toLowerCase();
  const lt = trigger.toLowerCase();
  const alreadyPrefixed =
    lc === lt || lc.startsWith(`${lt},`) || lc.startsWith(`${lt} `);
  return alreadyPrefixed ? trimmed : `${trigger}, ${trimmed}`;
}

// ---------------------------------------------------------------------------
// Dataset caption knobs (trigger word, dropout, shuffle) + batch edit + export.
// Pure helpers shared by the dataset board UI and the train route.
// ---------------------------------------------------------------------------

/** Per-board caption training knobs, stored on the board (`captionSettings`). */
export interface CaptionSettings {
  /** Default trigger word for training runs of this dataset. */
  triggerWord?: string;
  /** Fraction (0–1) of steps that train with an empty caption. */
  dropoutRate?: number;
  /** Shuffle comma-separated caption tags every epoch. */
  shuffle?: boolean;
  /** With shuffle on, keep the first N tags fixed (trigger stays first). */
  keepTokens?: number;
}

export const MAX_CAPTION_DROPOUT = 1;
export const MAX_KEEP_TOKENS = 32;

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(Math.max(n, min), max);
}

/** Coerce arbitrary input into clean settings; empty/default fields are dropped. */
export function normalizeCaptionSettings(raw: unknown): CaptionSettings {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: CaptionSettings = {};
  const trigger =
    typeof r.triggerWord === "string" ? r.triggerWord.trim().slice(0, 100) : "";
  if (trigger) out.triggerWord = trigger;
  const dropout = clampNumber(r.dropoutRate, 0, MAX_CAPTION_DROPOUT);
  if (dropout !== undefined && dropout > 0) {
    out.dropoutRate = Math.round(dropout * 1000) / 1000;
  }
  if (r.shuffle === true) {
    out.shuffle = true;
    const keep = clampNumber(r.keepTokens, 0, MAX_KEEP_TOKENS);
    if (keep !== undefined && keep > 0) out.keepTokens = Math.floor(keep);
  }
  return out;
}

/**
 * Trainer params (kohya / musubi-tuner / ai-toolkit names) for the knobs.
 * Only set knobs are emitted so trainer defaults stay in charge otherwise.
 */
export function captionTrainingParams(
  settings: CaptionSettings | undefined,
): Record<string, number | boolean> {
  const s = normalizeCaptionSettings(settings);
  const params: Record<string, number | boolean> = {};
  if (s.dropoutRate) params.caption_dropout_rate = s.dropoutRate;
  if (s.shuffle) {
    params.shuffle_caption = true;
    if (s.keepTokens) params.keep_tokens = s.keepTokens;
  }
  return params;
}

export type CaptionBatchOp =
  | { kind: "replace"; find: string; replace: string; caseSensitive?: boolean }
  | { kind: "prepend"; token: string }
  | { kind: "append"; token: string };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Tidy separators left behind by replace-with-empty ("a, , b" → "a, b"). */
function tidyCaption(value: string): string {
  return value
    .replace(/\s*,\s*(,\s*)+/g, ", ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,]+|[\s,]+$/g, "");
}

function leadingTag(caption: string): string {
  return caption.split(",")[0]!.trim().toLowerCase();
}

function trailingTag(caption: string): string {
  const parts = caption.split(",");
  return parts[parts.length - 1]!.trim().toLowerCase();
}

/** Apply one batch op to a caption; returns the new caption ("" = cleared). */
export function editCaption(caption: string, op: CaptionBatchOp): string {
  const current = caption.trim();
  if (op.kind === "replace") {
    if (!op.find) return current;
    const re = new RegExp(escapeRegExp(op.find), op.caseSensitive ? "g" : "gi");
    const replaced = current.replace(re, () => op.replace);
    return replaced === current ? current : tidyCaption(replaced);
  }
  const token = op.token.trim().replace(/^,+|,+$/g, "").trim();
  if (!token) return current;
  if (!current) return token;
  const lt = token.toLowerCase();
  if (op.kind === "prepend") {
    return leadingTag(current) === lt ? current : `${token}, ${current}`;
  }
  return trailingTag(current) === lt ? current : `${current}, ${token}`;
}

/**
 * Apply a batch op to the selected image indices. Edited captions become
 * "manual" (auto-caption never overwrites them); a caption edited to empty is
 * cleared. Returns the same array instance when nothing changed.
 */
export function applyCaptionBatchEdit<
  T extends { caption?: string; captionSource?: string },
>(
  images: T[],
  selected: Iterable<number>,
  op: CaptionBatchOp,
): { images: T[]; changed: number } {
  const picked = new Set(selected);
  let changed = 0;
  const next = images.map((image, index) => {
    if (!picked.has(index)) return image;
    const before = image.caption?.trim() ?? "";
    const after = editCaption(before, op);
    if (after === before) return image;
    changed += 1;
    return after
      ? { ...image, caption: after, captionSource: "manual" }
      : { ...image, caption: undefined, captionSource: undefined };
  });
  return { images: changed ? next : images, changed };
}

/** Stable dataset file name for an image URL (export side; trainer re-materializes). */
export function datasetFileName(url: string, index: number): string {
  let base = "";
  try {
    const parsed = new URL(url, "http://local.invalid");
    base = parsed.searchParams.get("file") ?? parsed.pathname;
  } catch {
    base = url;
  }
  base = base.split(/[\\/]/).pop() ?? "";
  base = base.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[._]+/, "");
  if (!/\.[A-Za-z0-9]{2,5}$/.test(base)) base = `${base || "image"}.png`;
  return `${String(index + 1).padStart(4, "0")}-${base}`.slice(0, 120);
}

/**
 * HuggingFace imagefolder / ai-toolkit `metadata.jsonl`: one
 * `{"file_name","text"}` object per line. Uncaptioned rows are skipped so
 * auto-captioning (which only fills images without a caption) can fill them.
 */
export function buildMetadataJsonl(
  rows: { fileName: string; caption?: string }[],
  triggerWord = "",
): string {
  const lines: string[] = [];
  for (const row of rows) {
    const caption = row.caption?.trim() ?? "";
    if (!caption) continue;
    const text = captionText(caption, triggerWord);
    lines.push(JSON.stringify({ file_name: row.fileName, text }));
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

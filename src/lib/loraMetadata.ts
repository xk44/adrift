/**
 * LoRA safetensors-header metadata parsing (ComfyUI /view_metadata/loras).
 *
 * The header is UNTRUSTED (authored by whoever trained/uploaded the LoRA).
 * Everything returned here is plain, length-capped text/numbers; callers must
 * render it as text only (React text nodes), never as HTML.
 */

export type LoraTrigger = { word: string; count: number };

export type LoraMetadata = {
  title: string | null;
  /** Raw base-model string as found in the header. */
  baseModel: string | null;
  /** Normalized family group (see FAMILY_GROUPS) or null if unknown. */
  baseFamily: string | null;
  networkDim: number | null;
  networkAlpha: number | null;
  triggers: LoraTrigger[];
};

const MAX_TEXT = 200;
const MAX_TRIGGERS = 12;

function cleanText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_TEXT);
  return s || null;
}

function cleanNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 && n < 1e6 ? n : null;
}

/** Parse ss_tag_frequency ({dataset: {tag: count}}); tolerant of garbage. */
export function parseTagFrequency(raw: unknown, limit = MAX_TRIGGERS): LoraTrigger[] {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  const totals = new Map<string, number>();
  for (const dataset of Object.values(obj as Record<string, unknown>)) {
    if (!dataset || typeof dataset !== "object" || Array.isArray(dataset)) continue;
    for (const [tag, count] of Object.entries(dataset as Record<string, unknown>)) {
      const word = cleanText(tag);
      const n = typeof count === "number" ? count : Number(count);
      if (!word || word.length > 60 || !Number.isFinite(n) || n <= 0) continue;
      totals.set(word, (totals.get(word) ?? 0) + n);
    }
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));
}

/** Map a header base-model string to a family group, or null. */
export function normalizeBaseFamily(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (/sdxl|stable[-_ ]diffusion[-_ ]xl|sd[-_]xl|pony|illustrious/.test(s)) return "sdxl";
  if (/sd3|stable[-_ ]diffusion[-_ ]3/.test(s)) return "sd3";
  if (/flux[-_. ]?(2|3)/.test(s)) return "flux3";
  if (/flux/.test(s)) return "flux";
  if (/krea/.test(s)) return "krea2";
  if (/qwen/.test(s)) return "qwen-image";
  if (/ideogram/.test(s)) return "ideogram4";
  if (/ltx/.test(s)) return "ltxv";
  if (/wan/.test(s)) return "wan";
  if (/z[-_ ]?image/.test(s)) return "zimage";
  if (/sd[-_ ]?v?2|stable[-_ ]diffusion[-_ ]v?2/.test(s)) return "sd2";
  if (/sd[-_ ]?v?1|sd15|sd1\.5|stable[-_ ]diffusion[-_ ]v?1/.test(s)) return "sd15";
  return null;
}

/** Map a pack modelFamily (detectModelFamily output) to the same groups. */
export function packFamilyToGroup(family: string | null | undefined): string | null {
  if (!family || family === "unknown") return null;
  if (family.startsWith("krea2")) return "krea2";
  if (family.startsWith("qwen-image")) return "qwen-image";
  return normalizeBaseFamily(family) ?? family;
}

export type BaseMismatch = {
  mismatch: boolean;
  loraFamily: string | null;
  modelFamily: string | null;
};

/** Mismatch only when BOTH sides are known and differ. */
export function loraBaseMismatch(
  loraBase: string | null | undefined,
  selectedModelFamily: string | null | undefined,
): BaseMismatch {
  const loraFamily = normalizeBaseFamily(loraBase);
  const modelFamily = packFamilyToGroup(selectedModelFamily);
  return {
    mismatch: Boolean(loraFamily && modelFamily && loraFamily !== modelFamily),
    loraFamily,
    modelFamily,
  };
}

/** Parse the header object returned by /view_metadata/loras. */
export function parseLoraMetadata(raw: unknown): LoraMetadata {
  const h: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const baseModel =
    cleanText(h["ss_base_model_version"]) ?? cleanText(h["modelspec.architecture"]);
  return {
    title: cleanText(h["modelspec.title"]),
    baseModel,
    baseFamily:
      normalizeBaseFamily(cleanText(h["ss_base_model_version"])) ??
      normalizeBaseFamily(cleanText(h["modelspec.architecture"])),
    networkDim: cleanNumber(h["ss_network_dim"]),
    networkAlpha: cleanNumber(h["ss_network_alpha"]),
    triggers: parseTagFrequency(h["ss_tag_frequency"]),
  };
}

/** LoRA names may live in subfolders; reject anything that could escape. */
export function isSafeLoraFilename(name: string): boolean {
  if (!name || name.length > 300) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(name)) return false;
  if (name.startsWith("/")) return false;
  return !name.split("/").some((seg) => seg === ".." || seg === "." || seg === "");
}


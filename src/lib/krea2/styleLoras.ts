/**
 * Krea 2 Style-LoRA catalog
 * A browsable index of the fal `Krea-2-Style-LoRAs` collection
 * (ilkerzgi/fal-Krea-2-Style-LoRAs on Hugging Face) — ~1,459 style LoRAs
 * trained on Krea 2 Turbo. Each entry carries a trigger phrase (derived from
 * the style slug) that is auto-appended to the prompt when the LoRA is applied,
 * via the existing `injectTriggerWords` / `getTriggersForLora` path.
 *
 * The catalog is metadata only. Weights are pulled on demand
 * (`/api/krea2-style-loras/download`) into `ComfyUI/models/loras/<id>.safetensors`;
 * we never ship 1,459 files.
 */

import catalog from "./styleLoraCatalog.json";

export interface Krea2StyleLora {
  /** Style slug, e.g. "acid-horror-manga" — also the LoRA basename (minus ext) */
  id: string;
  /** Repo-relative path, e.g. "comfy/acid-horror-manga.safetensors" */
  file: string;
  /** Title-cased display name */
  name: string;
  /** Trigger phrase appended to the prompt when applied */
  trigger: string;
}

interface Catalog {
  source: string;
  base: string;
  count: number;
  loras: Krea2StyleLora[];
}

const CATALOG = catalog as Catalog;

/** Local filename a downloaded style LoRA lands under (in models/loras). */
export function styleLoraFilename(id: string): string {
  return `${id}.safetensors`;
}

const BY_BASENAME = new Map<string, Krea2StyleLora>();
for (const lora of CATALOG.loras) {
  BY_BASENAME.set(styleLoraFilename(lora.id).toLowerCase(), lora);
}

/** Hugging Face repo the weights are pulled from. */
export const STYLE_LORA_REPO = CATALOG.source;

export function getStyleLoraCatalog(): Krea2StyleLora[] {
  return CATALOG.loras;
}

export function getStyleLoraCount(): number {
  return CATALOG.count;
}

/**
 * Resolve a catalog entry by style id or by a (possibly path-prefixed) LoRA
 * filename such as "acid-horror-manga.safetensors" or
 * "loras/acid-horror-manga.safetensors".
 */
export function findStyleLora(idOrFile: string): Krea2StyleLora | undefined {
  const base = (idOrFile.split(/[\\/]/).pop() ?? idOrFile).toLowerCase();
  const withExt = base.endsWith(".safetensors") ? base : `${base}.safetensors`;
  return BY_BASENAME.get(withExt);
}

/**
 * Trigger words for a LoRA filename — the resolver plugged into
 * `downloadStore.getTriggersForLora` so applied style LoRAs auto-append
 * their trigger phrase. Returns [] for non-catalog LoRAs.
 */
export function getStyleLoraTriggers(filename: string): string[] {
  const match = findStyleLora(filename);
  return match ? [match.trigger] : [];
}

/** Case-insensitive substring search over id + display name. */
export function searchStyleLoras(query: string, limit = 60): Krea2StyleLora[] {
  const q = query.trim().toLowerCase();
  if (!q) return CATALOG.loras.slice(0, limit);
  const out: Krea2StyleLora[] = [];
  for (const lora of CATALOG.loras) {
    if (lora.id.includes(q) || lora.name.toLowerCase().includes(q)) {
      out.push(lora);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * Pure helpers for UpscaleModelPicker: grouping + search of the live options
 * and the "which model will this run use" line.
 */
import type { UpscaleModelOption } from "./upscaleModels";
import { upscaleModelScale } from "./upscaleModels";
import {
  UPSCALER_CATEGORIES,
  canBeDefault,
  describeUpscaler,
  type UpscaleContent,
  type UpscalerCategory,
} from "./upscalerCatalog";
import type { UpscalerDefaults } from "./upscalerDefaultsClient";

export interface UpscalerGroup {
  category: UpscalerCategory;
  label: string;
  options: UpscaleModelOption[];
}

function haystack(o: UpscaleModelOption, groupLabel: string): string {
  return [o.name, o.file, groupLabel, ...o.tags, o.scale ? `${o.scale}x` : ""]
    .join(" ")
    .toLowerCase();
}

/**
 * Options grouped in catalog order. `query` matches every word against name,
 * file, group and tags; `defaultsOnly` drops 1× cleanup and face models.
 */
export function groupUpscalerOptions(
  options: readonly UpscaleModelOption[],
  { query = "", defaultsOnly = false } = {},
): UpscalerGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const groups: UpscalerGroup[] = [];
  for (const c of UPSCALER_CATEGORIES) {
    const opts = options.filter((o) => {
      if (o.category !== c.id) return false;
      if (defaultsOnly && !canBeDefault(o)) return false;
      const h = haystack(o, c.label);
      return words.every((w) => h.includes(w));
    });
    if (opts.length > 0)
      groups.push({ category: c.id, label: c.label, options: opts });
  }
  return groups;
}

export interface UpscalerUsage {
  file: string;
  name: string;
  scale: number | null;
  /** override = picked for this run; choice / table = Settings default. */
  source: "override" | "choice" | "table";
  locked: boolean;
}

/** The model a run will use, or null when unknown (server unreachable). */
export function upscalerUsage(
  value: string,
  content: UpscaleContent,
  defaults: UpscalerDefaults | null,
): UpscalerUsage | null {
  const locked = defaults?.locked ?? true;
  const pick = (file: string, source: UpscalerUsage["source"]) => {
    const live = defaults?.models?.find((o) => o.file === file);
    const info = live ?? describeUpscaler(file, upscaleModelScale(file));
    return { file, name: info.name, scale: info.scale, source, locked };
  };
  if (value) return pick(value, "override");
  const r = defaults?.resolved?.[content];
  return r ? pick(r.file, r.source) : null;
}

export function usageText(u: UpscalerUsage | null): string {
  if (!u) return "Uses the default upscaler from Settings.";
  const what = `${u.name}${u.scale ? ` ${u.scale}×` : ""}`;
  if (u.source === "override") return `Uses ${what} for this run only.`;
  const src = u.source === "choice" ? "your default" : "recommended default";
  return `Uses ${what} · ${src}${u.locked ? " · locked" : ""}`;
}

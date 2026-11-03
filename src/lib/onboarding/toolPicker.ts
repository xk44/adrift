/**
 * The wizard's per-tool model picker: each Tools-page card with its files,
 * sizes and whether they fit this GPU, and the fetch-models command for a
 * selection. Pure; /api/onboarding/tools supplies the inputs.
 *
 * A card's file list can hold alternatives (Krea 2 and Qwen for Edit photo),
 * and the tool map doesn't say which, so a card counts as runnable when ANY of
 * its main models fits, and the files too big for the card start unticked.
 */
import {
  checkCompat,
  type BackendProfile,
  type CompatVerdict,
} from "@/lib/models/compat";
import {
  COMFY_DIR_PLACEHOLDER,
  isInstalled,
  sh,
  type LicenseInfo,
  type Listings,
} from "./starterPacks";

export interface ToolMapEntry {
  id: string;
  kind: string;
  title: string;
  category: string;
  files: string[];
  dirs?: string[];
}

export interface ToolFile {
  dest: string;
  bytes: number | null;
  installed: boolean | null;
  verdict: CompatVerdict | null;
  reason: string | null;
  /** On the pinned download list. Others can't come from the command. */
  listed: boolean;
  gated: boolean;
  /** Ticked when the tool is. */
  byDefault: boolean;
}

export interface ToolRow {
  key: string;
  /** What --tool takes: the bare id unless another kind shares it. */
  arg: string;
  title: string;
  category: string;
  files: ToolFile[];
  /** Model folders the tool also loads; sizes come with the command's plan. */
  dirs: string[];
  fit: CompatVerdict | null;
  fitReason: string | null;
  allInstalled: boolean;
  nonCommercial: boolean;
}

export interface ToolPicks {
  tools: string[];
  /** Files the user ticked or unticked by hand, over each file's default. */
  files: Record<string, boolean>;
}

export const NO_TOOL_PICKS: ToolPicks = { tools: [], files: {} };

const WORST_LAST: CompatVerdict[] = [
  "fits",
  "tight",
  "unknown",
  "too_big",
  "unsupported",
];
const rank = (v: CompatVerdict) => WORST_LAST.indexOf(v);

const MAIN_FOLDER = /^(diffusion_models|checkpoints|unet)\//;
const TEXT_ENCODER_FOLDER = /^(text_encoders|clip)\//;
/** SAM ships as a checkpoint but is a helper, never what makes a tool fit. */
const HELPER_MODEL = /\/sam[\d.]*_/;
/** Model folders the download list can't fetch: see docs/models.md. */
const HAND_DIRS = /^SeeThrough\//;

export function isHandDir(dir: string): boolean {
  return HAND_DIRS.test(dir);
}

export function tooBig(v: CompatVerdict | null): boolean {
  return v === "too_big" || v === "unsupported";
}

/** Best main model (they may be alternatives); no main model: the worst file. */
function toolFit(files: ToolFile[]): ToolFile | null {
  const judged = files.filter((f) => f.verdict);
  if (!judged.length) return null;
  // No text encoder this machine can load: the tool can't run, whatever fits.
  const encoders = judged.filter((f) => TEXT_ENCODER_FOLDER.test(f.dest));
  if (encoders.length && encoders.every((f) => f.verdict === "unsupported"))
    return encoders[0];
  const mains = judged.filter(
    (f) => MAIN_FOLDER.test(f.dest) && !HELPER_MODEL.test(f.dest),
  );
  const byRank = (a: ToolFile, b: ToolFile) =>
    rank(a.verdict!) - rank(b.verdict!);
  return mains.length
    ? [...mains].sort(byRank)[0]
    : [...judged].sort(byRank)[judged.length - 1];
}

export function resolveToolRows(
  tools: ToolMapEntry[],
  sizes: Record<
    string,
    | { bytes?: number | null; set?: string | null; gated?: boolean; source?: string | null }
    | undefined
  >,
  profile: BackendProfile | null,
  listings: Listings | null,
  licenseFor?: (dest: string) => LicenseInfo | undefined,
): ToolRow[] {
  const seen = new Map<string, number>();
  for (const t of tools) seen.set(t.id, (seen.get(t.id) ?? 0) + 1);
  const rows: ToolRow[] = [];
  for (const t of tools) {
    if (!t.files.length && !t.dirs?.length) continue; // needs no weights
    const files: ToolFile[] = t.files.map((dest) => {
      const size = sizes[dest.split("/").pop() ?? dest];
      const bytes = size?.bytes ?? null;
      const compat = profile
        ? checkCompat({ fileName: dest, bytes }, profile)
        : null;
      return {
        dest,
        bytes,
        installed: isInstalled(dest, listings),
        verdict: compat?.verdict ?? null,
        reason: compat?.reason ?? null,
        listed: !!size?.set && !/^https?:/.test(size.source ?? ""),
        gated: !!size?.gated,
        byDefault: true,
      };
    });
    const worst = toolFit(files);
    const fit = worst?.verdict ?? null;
    for (const f of files)
      f.byDefault =
        f.listed &&
        f.verdict !== "unsupported" &&
        // A tool whose main model is too big was picked knowingly: leave it.
        !(f.verdict === "too_big" && !tooBig(fit));
    rows.push({
      key: `${t.kind}:${t.id}`,
      arg: seen.get(t.id) === 1 ? t.id : `${t.kind}:${t.id}`,
      title: t.title,
      category: t.category,
      files,
      dirs: t.dirs ?? [],
      fit,
      fitReason: worst?.reason ?? null,
      allInstalled:
        !t.dirs?.length && files.every((f) => f.installed === true),
      nonCommercial: files.some((f) => {
        const l = licenseFor?.(f.dest);
        return !!l && l.commercial !== "yes";
      }),
    });
  }
  return rows;
}

export function isFileWanted(
  file: ToolFile,
  picks: ToolPicks,
): boolean {
  return picks.files[file.dest] ?? file.byDefault;
}

export interface ToolSelection {
  chosen: ToolRow[];
  /** What the download costs: each wanted missing file once. */
  needBytes: number;
  /** Wanted files whose size we don't know. */
  unknownSizes: number;
  /** Files another pick of this wizard already fetches. */
  sharedBytes: number;
  /** Listed files left out, for --skip. */
  skip: string[];
  /** Files the tools load that the command can't fetch. */
  manual: string[];
  gated: boolean;
  dirs: string[];
}

export function toolSelection(
  rows: ToolRow[],
  picks: ToolPicks,
  alreadyFetched: string[] = [],
): ToolSelection {
  const chosen = rows.filter((r) => picks.tools.includes(r.key));
  // A file another chosen tool still wants stays in, whatever this one says.
  const byDest = new Map<string, { file: ToolFile; wanted: boolean }>();
  for (const r of chosen)
    for (const f of r.files) {
      const wanted = isFileWanted(f, picks);
      const had = byDest.get(f.dest);
      byDest.set(f.dest, { file: f, wanted: wanted || !!had?.wanted });
    }
  const fetched = new Set(alreadyFetched);
  const out: ToolSelection = {
    chosen,
    needBytes: 0,
    unknownSizes: 0,
    sharedBytes: 0,
    skip: [],
    manual: [],
    gated: false,
    dirs: [...new Set(chosen.flatMap((r) => r.dirs))].filter((d) => !HAND_DIRS.test(d)),
  };
  for (const r of chosen)
    for (const d of r.dirs)
      if (HAND_DIRS.test(d) && !out.manual.includes(d)) out.manual.push(d);
  for (const { file: f, wanted } of byDest.values()) {
    if (!f.listed) {
      if (f.installed !== true) out.manual.push(f.dest);
      continue;
    }
    if (!wanted) {
      out.skip.push(f.dest);
      continue;
    }
    if (f.installed === true) continue;
    if (fetched.has(f.dest)) out.sharedBytes += f.bytes ?? 0;
    else if (f.bytes === null) out.unknownSizes += 1;
    else out.needBytes += f.bytes;
    if (f.gated) out.gated = true;
  }
  return out;
}

/** The command for a selection; null when it has nothing left to fetch. */
export function toolFetchCommand(
  sel: ToolSelection,
  comfyDir: string = COMFY_DIR_PLACEHOLDER,
): string | null {
  const left = sel.chosen.some(
    (r) =>
      r.dirs.some((d) => !HAND_DIRS.test(d)) ||
      r.files.some((f) => f.listed && f.installed !== true && !sel.skip.includes(f.dest)),
  );
  if (!left) return null;
  return [
    "node scripts/fetch-models.mjs",
    `--tool ${sel.chosen.map((r) => sh(r.arg)).join(",")}`,
    ...sel.skip.map((d) => `--skip ${sh(d)}`),
    `--comfy ${sh(comfyDir)}`,
    "--yes",
  ].join(" ");
}

/** Filter by words in the title or category, and optionally by what fits. */
export function visibleToolRows(
  rows: ToolRow[],
  query: string,
  onlyFits: boolean,
  picked: string[] = [],
): ToolRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    const hay = `${r.title} ${r.category}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) return false;
    return picked.includes(r.key) || !onlyFits || !tooBig(r.fit);
  });
}

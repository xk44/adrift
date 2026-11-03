/**
 * Starter packs for the first-run wizard: which model files to fetch for a
 * given GPU, which are already installed, and the exact command to fetch the
 * rest. Pure (no fetch, no fs): the /api/onboarding/packs route feeds it the
 * backend profile and the ComfyUI model listings.
 *
 * Data: starterPacks.json (shared with `scripts/fetch-models.mjs --pack`).
 */
import packsJson from "./starterPacks.json";
import {
  checkCompat,
  combineVerdicts,
  pickBestCandidate,
  type BackendProfile,
  type CompatResult,
  type CompatVerdict,
  type ModelRole,
} from "@/lib/models/compat";
import { licenseUrlFor } from "@/lib/models/licenseLinks";

export type PackKind = "image" | "edit" | "video" | "upscale" | "audio";

export interface PackFileDef {
  /** Path under ComfyUI/models/ ("diffusion_models/x.safetensors"). */
  dest: string;
  role: ModelRole;
  bytes: number;
  /** Hugging Face repo; absent for non-HF files (then `page` is set). */
  repo?: string;
  repoPath?: string;
  revision?: string;
  /** Download page for files not on Hugging Face. */
  page?: string;
  /** Gated repo: accept its terms on Hugging Face and log in first. */
  gated?: boolean;
  /**
   * Extra file the pack works without (SA3's Quality checkpoint): left out of
   * the size, the fit verdict and the default download (`--use <dest>`
   * fetches it).
   */
  optional?: boolean;
  /** What the optional file adds, one plain line. */
  optionalNote?: string;
  /** License name (same as its MODEL_FAMILIES entry). */
  licenseName?: string;
  /** Link to the license text; null = no verified link (shown unlinked). */
  licenseUrl?: string | null;
}

export interface PackSlotDef {
  role: ModelRole;
  /** Drop-in alternatives; the first is the default. */
  options: PackFileDef[];
}

export interface PackDef {
  id: string;
  kind: PackKind;
  title: string;
  blurb: string;
  unlocks: string[];
  files: (PackFileDef | PackSlotDef)[];
  /** Other packs this one builds on (e.g. edit LoRAs on the base model). */
  requires?: string[];
  /** ComfyUI node packs needed besides the models. */
  nodePacks?: string[];
  /** The license terms in plain words (shown on the pack card). */
  licenseNote?: string;
  /** The main model's license name and link (null = no verified link). */
  licenseName?: string;
  licenseUrl?: string | null;
}

export type Tier = "le8" | "12" | "16" | "24plus" | "mac";

export interface StarterPacksDoc {
  version: number;
  tiers: Record<Tier, string[]>;
  packs: PackDef[];
}

export const STARTER_PACKS = packsJson as unknown as StarterPacksDoc;

const GiB = 1024 ** 3;

export const TIER_LABEL: Record<Tier, string> = {
  le8: "up to 8 GB",
  "12": "about 12 GB",
  "16": "about 16 GB",
  "24plus": "24 GB or more",
  mac: "Apple Silicon (shared memory)",
};

/**
 * VRAM tier for pre-selection. Apple GPUs share system RAM, so they get their
 * own tier. Boundaries sit between common card sizes (8 / 12 / 16 / 24 GB,
 * which torch reports a little under the label). No GPU (CPU only) maps to the
 * smallest tier. Null profile (not connected) -> null.
 */
export function vramTier(profile: BackendProfile | null): Tier | null {
  if (!profile) return null;
  if (profile.unified) return "mac";
  if (profile.device === "cpu") return "le8";
  const gb = profile.memoryTotalBytes / GiB;
  if (gb < 10) return "le8";
  if (gb < 14) return "12";
  if (gb < 20) return "16";
  return "24plus";
}

export function isSlot(f: PackFileDef | PackSlotDef): f is PackSlotDef {
  return Array.isArray((f as PackSlotDef).options);
}

export function slotOptions(f: PackFileDef | PackSlotDef): PackFileDef[] {
  return isSlot(f) ? f.options : [f];
}

// Installed check

/** ComfyUI folder type of a dest ("loras/edit_tools/x" -> "loras"). */
export function folderOf(dest: string): string {
  return dest.split("/")[0];
}

/** Listings keyed by folder type: names relative to it, lower-case, "/"-separated. */
export type Listings = Record<string, Set<string> | null | undefined>;

/**
 * Whether a file is installed. A same-named file in another subfolder of the
 * same type counts (it only needs moving). Null = could not check.
 */
export function isInstalled(
  dest: string,
  listings: Listings | null,
): boolean | null {
  if (!listings) return null;
  const listing = listings[folderOf(dest)];
  if (!listing) return null;
  const rel = dest.split("/").slice(1).join("/").toLowerCase();
  if (listing.has(rel)) return true;
  const base = rel.split("/").pop() ?? rel;
  for (const n of listing)
    if (n === base || n.endsWith(`/${base}`)) return true;
  return false;
}

// Resolution

export interface LicenseInfo {
  license: string;
  commercial: "yes" | "restricted" | "no" | "unverified";
  /** Link to the license text; null = none verified. */
  url?: string | null;
}

export interface ResolvedFile extends PackFileDef {
  installed: boolean | null;
  compat: CompatResult | null;
  /** Chosen instead of the slot's first option. */
  alternative: boolean;
  /** Other options for this slot (for the "why this file" hint). */
  otherOptions: string[];
  license?: LicenseInfo;
}

export interface ResolvedPack {
  id: string;
  kind: PackKind;
  title: string;
  blurb: string;
  unlocks: string[];
  requires: string[];
  nodePacks: string[];
  files: ResolvedFile[];
  /** Worst verdict over the files; null without a profile. */
  verdict: CompatVerdict | null;
  /** The reason behind the worst file's verdict. */
  verdictReason: string | null;
  totalBytes: number;
  /** Bytes still to download (installed files skipped). */
  needBytes: number;
  allInstalled: boolean;
  gated: boolean;
  licenses: LicenseInfo[];
  /** Any file is not cleared for commercial use. */
  nonCommercial: boolean;
  licenseNote: string | null;
  /** The main model's license and its link (null when unknown). */
  licenseName: string | null;
  licenseUrl: string | null;
  /** Size of the optional files not installed yet (not in needBytes). */
  optionalBytes: number;
}

function pickOption(
  options: PackFileDef[],
  profile: BackendProfile | null,
  listings: Listings | null,
): PackFileDef {
  const installed = options.find((o) => isInstalled(o.dest, listings) === true);
  if (installed) return installed;
  if (!profile || options.length === 1) return options[0];
  const best = pickBestCandidate(
    options.map((o) => ({
      fileName: o.dest,
      bytes: o.bytes,
      role: o.role,
      def: o,
    })),
    profile,
  );
  return best ? best.candidate.def : options[0];
}

/** The file's own licenseUrl wins; else the shared license-name table. */
function withLicenseUrl(
  info: LicenseInfo | undefined,
  f: PackFileDef,
): LicenseInfo | undefined {
  if (!info) return undefined;
  return {
    ...info,
    url: f.licenseUrl !== undefined ? f.licenseUrl : licenseUrlFor(info.license),
  };
}

export function resolvePack(
  pack: PackDef,
  profile: BackendProfile | null,
  listings: Listings | null,
  licenseFor?: (dest: string) => LicenseInfo | undefined,
): ResolvedPack {
  const files: ResolvedFile[] = pack.files.map((slot) => {
    const options = slotOptions(slot);
    const chosen = pickOption(options, profile, listings);
    return {
      ...chosen,
      installed: isInstalled(chosen.dest, listings),
      compat: profile
        ? checkCompat(
            { fileName: chosen.dest, bytes: chosen.bytes, role: chosen.role },
            profile,
          )
        : null,
      alternative: chosen !== options[0],
      otherOptions: options.filter((o) => o !== chosen).map((o) => o.dest),
      license: withLicenseUrl(licenseFor?.(chosen.dest), chosen),
    };
  });
  // Optional files never hold a pack back: not in the size, fit or "done".
  const required = files.filter((f) => !f.optional);
  let verdict: CompatVerdict | null = null;
  let verdictReason: string | null = null;
  if (profile) {
    verdict = combineVerdicts(required.map((f) => f.compat!.verdict));
    const worst = required.find((f) => f.compat!.verdict === verdict);
    verdictReason = worst?.compat?.reason ?? null;
  }
  const licenses: LicenseInfo[] = [];
  for (const f of files)
    if (f.license && !licenses.some((l) => l.license === f.license!.license))
      licenses.push(f.license);
  return {
    id: pack.id,
    kind: pack.kind,
    title: pack.title,
    blurb: pack.blurb,
    unlocks: pack.unlocks,
    requires: pack.requires ?? [],
    nodePacks: pack.nodePacks ?? [],
    files,
    verdict,
    verdictReason,
    totalBytes: required.reduce((s, f) => s + f.bytes, 0),
    needBytes: required.reduce((s, f) => s + (f.installed ? 0 : f.bytes), 0),
    allInstalled: required.every((f) => f.installed === true),
    gated: required.some((f) => f.gated && f.installed !== true),
    licenses,
    nonCommercial: licenses.some((l) => l.commercial !== "yes"),
    licenseNote: pack.licenseNote ?? null,
    licenseName: pack.licenseName ?? null,
    licenseUrl:
      pack.licenseUrl !== undefined
        ? pack.licenseUrl
        : licenseUrlFor(pack.licenseName),
    optionalBytes: files.reduce(
      (s, f) => s + (f.optional && f.installed !== true ? f.bytes : 0),
      0,
    ),
  };
}

export function resolveAllPacks(
  profile: BackendProfile | null,
  listings: Listings | null,
  licenseFor?: (dest: string) => LicenseInfo | undefined,
  doc: StarterPacksDoc = STARTER_PACKS,
): ResolvedPack[] {
  return doc.packs.map((p) => resolvePack(p, profile, listings, licenseFor));
}

/**
 * Packs to tick by default: the tier's recommendations that fit and are not
 * fully installed yet. If no image pack made it (nothing fits outright), the
 * first recommended image pack that at least runs ("tight") is added, so a
 * new user always ends up able to make a picture. A pack whose `requires`
 * is neither installed nor selected is dropped.
 */
export function preselectPacks(
  tier: Tier | null,
  packs: ResolvedPack[],
  doc: StarterPacksDoc = STARTER_PACKS,
): string[] {
  if (!tier) return [];
  const byId = new Map(packs.map((p) => [p.id, p]));
  const rec = (doc.tiers[tier] ?? [])
    .map((id) => byId.get(id))
    .filter(Boolean) as ResolvedPack[];
  const picked: string[] = [];
  const anyImageReady = packs.some((p) => p.kind === "image" && p.allInstalled);
  for (const p of rec)
    if (!p.allInstalled && p.verdict === "fits") picked.push(p.id);
  if (!anyImageReady && !picked.some((id) => byId.get(id)?.kind === "image")) {
    const fallback = rec.find(
      (p) =>
        p.kind === "image" &&
        !p.allInstalled &&
        (p.verdict === "tight" || p.verdict === "fits"),
    );
    if (fallback) picked.push(fallback.id);
  }
  return picked.filter((id) =>
    (byId.get(id)?.requires ?? []).every(
      (r) => picked.includes(r) || byId.get(r)?.allInstalled === true,
    ),
  );
}

/** Packs a selection needs but did not pick (edit -> images-best). */
export function missingRequirements(
  selected: string[],
  packs: ResolvedPack[],
): string[] {
  const byId = new Map(packs.map((p) => [p.id, p]));
  const out: string[] = [];
  for (const id of selected)
    for (const r of byId.get(id)?.requires ?? [])
      if (
        !selected.includes(r) &&
        !byId.get(r)?.allInstalled &&
        !out.includes(r)
      )
        out.push(r);
  return out;
}

// Selection

/** Files picked instead of a slot's default: the `--use` list. */
function alternativeUses(packs: ResolvedPack[]): string[] {
  const uses: string[] = [];
  for (const p of packs)
    for (const f of p.files)
      if (f.alternative && !uses.includes(f.dest)) uses.push(f.dest);
  return uses;
}

export interface SelectionFile {
  dest: string;
  bytes: number;
  installed: boolean | null;
  /** Ids of the packs (of the selection) that use this file. */
  packs: string[];
}

export interface SelectionDownload {
  /** Each file once, in pack order. */
  files: SelectionFile[];
  /** Bytes still to download, each file counted once. */
  needBytes: number;
  /** What adding up the packs one by one would count twice. */
  savedBytes: number;
}

/**
 * The files `fetchCommand(packs)` downloads, each once. Same picks as
 * `fetch-models.mjs --pack` (packTool): an alternative named by --use, else
 * a drop-in option another pack of the selection already fetches, else the
 * slot's default; optional files only when named.
 */
export function selectionDownload(
  packs: ResolvedPack[],
  doc: StarterPacksDoc = STARTER_PACKS,
): SelectionDownload {
  const uses = alternativeUses(packs);
  const installed = new Map<string, boolean | null>();
  for (const p of packs)
    for (const f of p.files)
      if (installed.get(f.dest) !== true) installed.set(f.dest, f.installed);
  const out = new Map<string, SelectionFile>();
  for (const p of packs) {
    const def = doc.packs.find((d) => d.id === p.id);
    if (!def) continue;
    for (const slot of def.files) {
      const options = slotOptions(slot);
      const named = options.find((o) => uses.includes(o.dest));
      const pick = named ?? options.find((o) => out.has(o.dest)) ?? options[0];
      if (!isSlot(slot) && slot.optional && !named) continue;
      const row = out.get(pick.dest);
      if (row) {
        if (!row.packs.includes(p.id)) row.packs.push(p.id);
      } else
        out.set(pick.dest, {
          dest: pick.dest,
          bytes: pick.bytes,
          installed: installed.get(pick.dest) ?? null,
          packs: [p.id],
        });
    }
  }
  const files = [...out.values()];
  const needBytes = files.reduce(
    (n, f) => n + (f.installed === true ? 0 : f.bytes),
    0,
  );
  const separate = packs.reduce((n, p) => n + p.needBytes, 0);
  return { files, needBytes, savedBytes: Math.max(0, separate - needBytes) };
}

// Commands

/** Single-quote for POSIX shells only when needed. */
export function sh(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export const COMFY_DIR_PLACEHOLDER = "/path/to/ComfyUI";

/**
 * One `node scripts/fetch-models.mjs` line for the selection (run from the
 * Adrift folder). Files chosen instead of a slot's default are passed with
 * --use so the script fetches the same file the wizard showed. Null when
 * nothing is left to fetch.
 */
export function fetchCommand(
  selected: ResolvedPack[],
  comfyDir: string = COMFY_DIR_PLACEHOLDER,
): string | null {
  const todo = selected.filter((p) => !p.allInstalled);
  if (!todo.length) return null;
  const uses = alternativeUses(todo);
  const parts = [
    "node scripts/fetch-models.mjs",
    `--pack ${todo.map((p) => p.id).join(",")}`,
    ...uses.map((u) => `--use ${sh(u)}`),
    `--comfy ${sh(comfyDir)}`,
    "--yes",
  ];
  return parts.join(" ");
}

/**
 * Per-file fallback with the Hugging Face CLI (pinned revision), for people
 * who would rather not run the script. Null for non-HF files (use `page`).
 */
export function hfCommand(f: PackFileDef): string | null {
  if (!f.repo || !f.repoPath || !f.revision) return null;
  const base = `hf download ${sh(f.repo)} ${sh(f.repoPath)} --revision ${f.revision}`;
  if (f.repoPath === f.dest) return `${base} --local-dir "$COMFYUI/models"`;
  const stage = '"$COMFYUI/models/.fetch-models"';
  return (
    `${base} --local-dir ${stage} && ` +
    `mkdir -p "$COMFYUI/models/${f.dest.slice(0, f.dest.lastIndexOf("/"))}" && ` +
    `mv "$COMFYUI/models/.fetch-models/${f.repoPath}" "$COMFYUI/models/${f.dest}"`
  );
}

export function formatGb(bytes: number): string {
  if (bytes <= 0) return "0 GB";
  const gb = bytes / 1e9;
  return gb < 0.1
    ? `${Math.max(1, Math.round(bytes / 1e6))} MB`
    : `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
}

/**
 * Explore → Models compat mapping: turns Civitai model versions and Hugging
 * Face repos into compat.ts candidates, then into the per-card chip, the
 * "Best: Q6_K" badge, per-file verdicts and the "Fits my GPU" filter.
 *
 * Pure: no React, no fetch. Verdicts are ballpark hints, never blocks: a
 * "too big" file can still be downloaded; the filter is opt-in.
 */
import type { CivitaiModel, CivitaiModelVersion } from "@/lib/civitai";
import type { HfModelSummary } from "@/lib/hfModels";
import {
  memoryGb,
  pickBestCandidate,
  rankCandidates,
  roleForFamily,
  type BackendProfile,
  type CompatResult,
  type CompatVerdict,
  type ModelCandidate,
  type ModelRole,
  type QuantInfo,
} from "./compat";

type CivitaiFile = CivitaiModelVersion["files"][number];

const WEIGHT_EXT = /\.(safetensors|sft|gguf|ckpt|pt|pth|bin)$/i;
const PICKLE_EXT = /\.(ckpt|pt|pth|bin)$/i;
/** HF: only single-file weights ComfyUI can load (no diffusers shards). */
const HF_WEIGHT_EXT = /\.(safetensors|sft|gguf)$/i;
const HF_SHARD = /-\d{5}-of-\d{5}\./;

/**
 * Civitai types that ride on a base model (or aren't weights at all). Their
 * own size says nothing about whether the job fits, so they get no verdict.
 */
const ADD_ON_TYPES = new Set([
  "lora",
  "locon",
  "dora",
  "lycoris",
  "textualinversion",
  "hypernetwork",
  "aestheticgradient",
  "controlnet",
  "motionmodule",
  "poses",
  "wildcards",
  "workflows",
  "detection",
]);

export interface ExploreCandidate extends ModelCandidate {
  /** Civitai file name / HF repo path; the key for per-file verdicts. */
  key: string;
}

/** Role for a Civitai model type + base model; null = add-on, no verdict. */
export function civitaiRole(
  modelType: string | undefined,
  baseModel: string | undefined,
  isGguf = false,
): ModelRole | null {
  const t = (modelType ?? "").toLowerCase().replace(/\s+/g, "");
  if (ADD_ON_TYPES.has(t)) return null;
  if (t === "vae") return "vae";
  if (t === "upscaler") return "upscale";
  const fam = roleForFamily(baseModel);
  if (t === "checkpoint") {
    if (fam === "video" || fam === "audio") return fam;
    // A GGUF "checkpoint" is a bare diffusion model, not an all-in-one.
    return isGguf ? (fam ?? "image") : "checkpoint";
  }
  return fam ?? "other";
}

function civitaiFormatHint(file: CivitaiFile): {
  hint: string | undefined;
  gguf: boolean;
} {
  const md = file.metadata ?? {};
  const gguf = /gguf/i.test(md.format ?? "") || /\.gguf$/i.test(file.name);
  // Civitai's `fp` on a GGUF is the SOURCE precision, not the quant: ignore it.
  // `size` ("full" / "pruned") is not a precision either ("full" would read as fp32).
  const hint = gguf
    ? "gguf"
    : [md.fp, md.format].filter((s): s is string => !!s).join(" ") || undefined;
  return { hint, gguf };
}

/** Model-weight files of one Civitai version as compat candidates. */
export function civitaiVersionCandidates(
  modelType: string | undefined,
  version: Pick<CivitaiModelVersion, "files" | "baseModel">,
): ExploreCandidate[] {
  const files = (version.files ?? []).filter(
    (f) =>
      f &&
      typeof f.name === "string" &&
      WEIGHT_EXT.test(f.name) &&
      (!f.type || f.type === "Model" || f.type === "Pruned Model"),
  );
  const out: ExploreCandidate[] = [];
  for (const f of files) {
    const { hint, gguf } = civitaiFormatHint(f);
    const role = civitaiRole(modelType, version.baseModel, gguf);
    if (role === null) return [];
    const kb =
      typeof f.sizeKB === "number" && Number.isFinite(f.sizeKB) ? f.sizeKB : 0;
    out.push({
      key: f.name,
      fileName: f.name,
      bytes: kb > 0 ? Math.round(kb * 1024) : null,
      formatHint: hint,
      role,
      family: version.baseModel,
    });
  }
  // Prefer safetensors/GGUF: only fall back to pickle files when that's all there is.
  const safe = out.filter((c) => !PICKLE_EXT.test(c.fileName));
  return safe.length ? safe : out;
}

export interface VersionCompat {
  /** Top-ranked file (may be too big) — drives the card chip and the filter. */
  verdict: CompatVerdict;
  top: CompatResult;
  topKey: string;
  /** What pickBestCandidate recommends (fits / tight), else null. */
  recommendedKey: string | null;
  /** "Q6_K" etc. when the version offers 2+ distinct quants and one runs. */
  bestQuantLabel: string | null;
  /** Distinct quant labels offered, best first. */
  quantLabels: string[];
  perFile: Record<string, CompatResult>;
}

/** Short display name for a weight format ("Q6_K", "FP8", "BF16"). */
export function quantLabel(q: QuantInfo): string | null {
  switch (q.kind) {
    case "gguf":
      return q.id === "gguf"
        ? "GGUF"
        : q.id.replace(/^gguf_/, "").toUpperCase();
    case "float":
    case "int8":
      return q.id.toUpperCase();
    case "fp8":
      return q.id === "fp8_scaled" ? "FP8 scaled" : "FP8";
    case "fp4":
      return q.id.toUpperCase();
    case "svdq":
      return q.id === "svdq_fp4" ? "SVDQ FP4" : "SVDQ INT4";
    case "awq":
      return "AWQ";
    default:
      return null;
  }
}

/** Rank a set of candidates (one version / one repo) against the backend. */
export function candidatesCompat(
  candidates: ExploreCandidate[],
  profile: BackendProfile,
): VersionCompat | null {
  if (candidates.length === 0) return null;
  const ranked = rankCandidates(candidates, profile);
  const top = ranked[0];
  const best = pickBestCandidate(candidates, profile);
  const perFile: Record<string, CompatResult> = {};
  for (const r of ranked) perFile[r.candidate.key] = r.compat;
  const labels: string[] = [];
  for (const r of [...ranked].sort(
    (a, b) => b.compat.quant.quality - a.compat.quant.quality,
  )) {
    const l = quantLabel(r.compat.quant);
    if (l && !labels.includes(l)) labels.push(l);
  }
  return {
    verdict: top.compat.verdict,
    top: top.compat,
    topKey: top.candidate.key,
    recommendedKey: best?.candidate.key ?? null,
    bestQuantLabel:
      best && labels.length >= 2 ? quantLabel(best.compat.quant) : null,
    quantLabels: labels,
    perFile,
  };
}

export function civitaiVersionCompat(
  modelType: string | undefined,
  version: CivitaiModelVersion | undefined,
  profile: BackendProfile,
): VersionCompat | null {
  if (!version) return null;
  return candidatesCompat(
    civitaiVersionCandidates(modelType, version),
    profile,
  );
}

const VERDICT_RANK: Record<CompatVerdict, number> = {
  fits: 0,
  tight: 1,
  unknown: 2,
  too_big: 3,
  unsupported: 4,
};

/**
 * Best compat across ALL versions (what the card chip and the "Fits my GPU"
 * filter judge): a model whose latest version is fp16-only but which also
 * ships a Q4 / fp8 version that fits is not hidden. Ties keep the newest
 * version (Civitai lists newest first).
 */
export function civitaiModelCompat(
  model: Pick<CivitaiModel, "type" | "modelVersions">,
  profile: BackendProfile,
): VersionCompat | null {
  let best: VersionCompat | null = null;
  for (const version of model.modelVersions ?? []) {
    const c = civitaiVersionCompat(model.type, version, profile);
    if (!c) continue;
    if (!best || VERDICT_RANK[c.verdict] < VERDICT_RANK[best.verdict]) {
      best = c;
    }
    if (best.verdict === "fits") break;
  }
  return best;
}

/** Role for an HF repo; null = adapter (LoRA) or not a weights repo we judge. */
export function hfRole(m: HfModelSummary): ModelRole | null {
  const tags = m.tags.map((t) => t.toLowerCase());
  if (m.library === "peft" || tags.includes("lora")) return null;
  const task = m.pipelineTag ?? "";
  if (/video/.test(task)) return "video";
  if (/audio|speech/.test(task)) return "audio";
  if (tags.includes("super-resolution")) return "upscale";
  if (task === "text-to-image" || task === "image-to-image") return "image";
  return roleForFamily(m.id) ?? "other";
}

export function hfCandidates(m: HfModelSummary): ExploreCandidate[] {
  const role = hfRole(m);
  if (role === null) return [];
  return (m.files ?? [])
    .filter((f) => HF_WEIGHT_EXT.test(f.name) && !HF_SHARD.test(f.name))
    .map((f) => ({
      key: f.name,
      fileName: f.name,
      bytes: typeof f.bytes === "number" && f.bytes > 0 ? f.bytes : null,
      role,
      family: m.id,
    }));
}

export function hfModelCompat(
  m: HfModelSummary,
  profile: BackendProfile,
): VersionCompat | null {
  return candidatesCompat(hfCandidates(m), profile);
}

// UI helpers

export type ChipTone = "good" | "warn" | "bad";

export interface CompatChip {
  label: string;
  tone: ChipTone;
  /** Tooltip: the engine's plain-language reason. */
  title: string;
}

/**
 * Card chip. "Size unknown" (Hugging Face list results, Civitai files with no
 * size) is shown explicitly so "Fits my GPU" never looks like it vetted a card
 * it couldn't judge.
 */
export function compatChip(
  c: VersionCompat | null,
  profile: BackendProfile | null,
): CompatChip | null {
  if (!c || !profile) return null;
  const title = `${c.top.reason} (Ballpark estimate.)`;
  switch (c.verdict) {
    case "fits":
      return { label: "Fits", tone: "good", title };
    case "tight":
      return { label: "Tight", tone: "warn", title };
    case "too_big":
      return {
        label: `Too big for ${memoryGb(profile)} GB`,
        tone: "bad",
        title,
      };
    case "unsupported":
      return { label: "Won't run here", tone: "bad", title };
    case "unknown":
      return {
        label: "Size unknown",
        tone: "warn",
        title:
          "No file size listed, so we can't tell if it fits. \u201cFits my GPU\u201d can't filter it.",
      };
    default:
      return null;
  }
}

/** Short per-file verdict for the file picker ("fits", "too big"). */
export const FILE_VERDICT_SHORT: Record<CompatVerdict, string> = {
  fits: "fits",
  tight: "tight",
  too_big: "too big",
  unsupported: "won't run here",
  unknown: "",
};

/**
 * How many of these the fits filter couldn't judge (no sizes): drives the
 * "can't check sizes here" hint so an on toggle doesn't look like it vetted them.
 */
export function unsizedCount(compats: (VersionCompat | null)[]): number {
  return compats.filter((c) => c?.verdict === "unknown").length;
}

/** "Fits my GPU" hides cards whose best file is too big or can't load. */
export function hiddenByFitsFilter(c: VersionCompat | null): boolean {
  return c?.verdict === "too_big" || c?.verdict === "unsupported";
}

/**
 * Model overrides for imported workflows: when a graph pins a model file the
 * backend does not have, offer the installed files for that same loader input
 * (from /object_info COMBO options), ranked so the closest stand-in comes
 * first ("flux1-dev-Q8_0.gguf" missing -> "flux1-dev-Q6_K.gguf" before an
 * SDXL checkpoint), and validate / apply the user's picks on save.
 *
 * Ranking: match tier (same file in another folder > same model in another
 * quant/precision > same family > similar name > other), then the compat
 * engine's verdict for the backend (files that won't run here sink), then
 * name similarity, then quant quality (Q8 > Q6 > Q5 > Q4 ...).
 *
 * Installed files carry no size in /object_info, so verdicts are mostly
 * "unknown"; only hard format blockers (fp8 on Apple, fp4 off Blackwell...)
 * change the order. Verdicts are hints, never blocks.
 *
 * Persistence: overrides rewrite the graph on save (POST /api/user-tools), so
 * a saved tool is a plain graph with no run-time indirection.
 *
 * Pure: object_info and the backend profile are passed in.
 */

import type { Workflow } from "@/types";
import { comboOptions } from "@/lib/comfy/validatePrompt";
import {
  checkCompat,
  detectQuant,
  roleForFamily,
  type BackendProfile,
  type CompatVerdict,
  type ModelRole,
} from "@/lib/models/compat";
import { UserToolInputError } from "./build";

export type OverrideMatch =
  "same_file" | "same_model" | "same_family" | "similar" | "other";

export interface ModelOverrideCandidate {
  /** Exact combo option string (what goes into the graph). */
  value: string;
  match: OverrideMatch;
  /** 0..1 name similarity, for ordering within a tier. */
  score: number;
  /** Detected weight format id ("gguf_q6_k", "fp8_e4m3fn", "bf16"...). */
  quant?: string;
  /** Compat verdict on this backend (absent when the profile is unknown). */
  verdict?: CompatVerdict;
  reason?: string;
}

/** Most options listed per missing model (a LoRA folder can hold hundreds). */
export const MAX_OVERRIDE_CANDIDATES = 300;
/** Most overrides accepted in one save. */
export const MAX_OVERRIDES = 100;

const MODEL_FILE_RE = /\.(safetensors|gguf|ckpt|pt|pth|bin|sft|onnx)$/i;

const TIER: Record<OverrideMatch, number> = {
  same_file: 0,
  same_model: 1,
  same_family: 2,
  similar: 3,
  other: 4,
};

const VERDICT_ORDER: Record<CompatVerdict, number> = {
  fits: 0,
  tight: 1,
  unknown: 2,
  too_big: 3,
  unsupported: 4,
};

/** Tokens that describe precision / packaging, not which model it is. */
const FORMAT_TOKENS = new Set([
  "fp8",
  "fp16",
  "bf16",
  "fp32",
  "f16",
  "f32",
  "fp4",
  "nvfp4",
  "mxfp4",
  "int8",
  "int4",
  "e4m3fn",
  "e4m3",
  "e5m2",
  "scaled",
  "mixed",
  "fast",
  "convrot",
  "svdq",
  "awq",
  "gguf",
  "half",
  "full",
  "pruned",
  "emaonly",
  "ema",
]);
const GGUF_QUANT_RE = /^i?q[2-8]$/;
const GGUF_SUFFIX = new Set(["0", "1", "k", "m", "s", "l", "xs", "xxs", "nl"]);

/** Lowercased, separators collapsed to "_". */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function baseName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

function stemOf(file: string): string {
  return baseName(file).replace(MODEL_FILE_RE, "");
}

/** Name tokens with quant / precision tokens removed. */
export function modelTokens(file: string): string[] {
  const raw = norm(stemOf(file)).split("_").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (FORMAT_TOKENS.has(t)) continue;
    if (GGUF_QUANT_RE.test(t)) {
      let j = 0;
      while (j < 2 && GGUF_SUFFIX.has(raw[i + 1] ?? "")) {
        i++;
        j++;
      }
      continue;
    }
    out.push(t);
  }
  return out;
}

/** Family patterns, first match wins (text encoders before "xl" checks). */
const FAMILIES: Array<[string, RegExp]> = [
  ["umt5", /umt5/],
  ["t5", /t5_?xxl|(^|_)t5(_|$)|t5_?v1/],
  ["clip_l", /clip_?l(_|$)|vit_l_14/],
  ["clip_g", /clip_?g(_|$)/],
  ["gemma", /gemma/],
  ["flux2", /flux_?2(?!\d)/],
  ["krea2", /krea_?2(?!\d)/],
  ["flux1", /flux/],
  ["qwen_image", /qwen_?image/],
  ["hidream", /hidream/],
  ["chroma", /chroma/],
  ["lumina", /lumina/],
  ["z_image", /(^|_)z_?image/],
  ["hunyuan", /hunyuan/],
  ["wan", /(^|_)wan_?\d|(^|_)wan(_|$)|wan_?video/],
  ["ltx", /ltx/],
  ["cosmos", /cosmos/],
  ["stable_audio", /stable_?audio/],
  ["ace_step", /ace_?step/],
  ["sd3", /(^|_)sd_?3/],
  ["sd15", /(^|_)sd_?1_?5|(^|_)sd15|(^|_)v1_5(_|$)/],
  ["sdxl", /sdxl|(^|_)xl(_|$)|pony|illustrious|noobai|[a-z]{3,}xl(_|$|v\d)/],
];

/** Coarse model family from a file path ("flux1", "sdxl", "wan", ...). */
export function modelFamily(file: string): string | null {
  const n = norm(file.replace(/\\/g, "/"));
  for (const [id, re] of FAMILIES) if (re.test(n)) return id;
  return null;
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** How close an installed file is to the missing one. */
export function matchModelName(
  missing: string,
  candidate: string,
): { match: OverrideMatch; score: number } {
  if (baseName(missing).toLowerCase() === baseName(candidate).toLowerCase())
    return { match: "same_file", score: 1 };
  const ta = modelTokens(missing);
  const tb = modelTokens(candidate);
  if (ta.length && ta.join("_") === tb.join("_"))
    return { match: "same_model", score: 0.9 };
  const j = jaccard(ta, tb);
  const fa = modelFamily(missing);
  const fb = modelFamily(candidate);
  if (fa && fa === fb)
    return { match: "same_family", score: round(0.4 + 0.3 * j) };
  if (fa && fb) return { match: "other", score: round(0.15 * j) };
  const s = round(0.6 * j);
  return { match: s >= 0.2 ? "similar" : "other", score: s };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Compat role for a loader input. */
export function roleForLoaderInput(
  classType: string,
  input: string,
  file: string,
): ModelRole {
  if (/^ckpt_name$/.test(input)) return "checkpoint";
  if (/lora/i.test(input) || /lora/i.test(classType)) return "lora";
  if (/^vae_name$/.test(input) || /vae/i.test(classType)) return "vae";
  if (/^clip_name\d*$/.test(input) || /clip|textencoder/i.test(classType))
    return "text_encoder";
  if (/upscale/i.test(classType)) return "upscale";
  const fam = roleForFamily(modelFamily(file) ?? undefined);
  if (/unet|diffusion/i.test(input) || /unet|diffusion/i.test(classType))
    return fam === "video" ? "video" : "image";
  return fam ?? "other";
}

export interface RankOverrideContext {
  classType: string;
  input: string;
  profile?: BackendProfile | null;
  limit?: number;
}

/** Installed options for a missing file, best stand-in first. */
export function rankOverrideCandidates(
  missing: string,
  options: readonly unknown[],
  ctx: RankOverrideContext,
): ModelOverrideCandidate[] {
  const seen = new Set<string>();
  const rows: Array<ModelOverrideCandidate & { quality: number }> = [];
  for (const o of options) {
    if (typeof o !== "string" || !o || o === missing || seen.has(o)) continue;
    seen.add(o);
    const { match, score } = matchModelName(missing, o);
    const quant = detectQuant(o);
    const row: ModelOverrideCandidate & { quality: number } = {
      value: o,
      match,
      score,
      quality: quant.quality,
    };
    if (quant.id !== "unknown") row.quant = quant.id;
    if (ctx.profile) {
      const c = checkCompat(
        {
          fileName: o,
          role: roleForLoaderInput(ctx.classType, ctx.input, o),
        },
        ctx.profile,
      );
      row.verdict = c.verdict;
      row.reason = c.reason;
    }
    rows.push(row);
  }
  rows.sort((a, b) => {
    const t = TIER[a.match] - TIER[b.match];
    if (t) return t;
    const v =
      VERDICT_ORDER[a.verdict ?? "unknown"] -
      VERDICT_ORDER[b.verdict ?? "unknown"];
    if (v) return v;
    const s = b.score - a.score;
    if (s) return s;
    const q = b.quality - a.quality;
    if (q) return q;
    return a.value.localeCompare(b.value);
  });
  return rows
    .slice(0, ctx.limit ?? MAX_OVERRIDE_CANDIDATES)
    .map(({ quality: _q, ...rest }) => rest);
}

/**
 * The pick to pre-select: only a confident match (same file elsewhere, or
 * the same model in another quant) that the compat engine does not rule out.
 * A different model of the same family is offered, never auto-picked.
 */
export function suggestOverride(
  ranked: readonly ModelOverrideCandidate[],
): string | null {
  const top = ranked.find(
    (c) =>
      (c.match === "same_file" || c.match === "same_model") &&
      c.verdict !== "unsupported" &&
      c.verdict !== "too_big",
  );
  return top?.value ?? null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** COMBO options of one node input, or null (unknown class / not a combo). */
export function loaderInputOptions(
  objectInfo: Record<string, unknown>,
  classType: string,
  input: string,
): unknown[] | null {
  const def = objectInfo[classType];
  if (!isRecord(def) || !isRecord(def.input)) return null;
  const req = isRecord(def.input.required) ? def.input.required : {};
  const opt = isRecord(def.input.optional) ? def.input.optional : {};
  const spec = req[input] ?? opt[input];
  return Array.isArray(spec) ? comboOptions(spec) : null;
}

export interface ModelOverride {
  nodeId: string;
  input: string;
  value: string;
}

/**
 * Validate overrides from the client and return a rewritten copy of the
 * graph. Each value must be an exact COMBO option of that node's input in
 * the live object_info, and only inputs that pin a model file can be
 * overridden. Other nodes with the same input pinned to the same missing
 * file get the same pick (when it is valid for them too).
 * Empty / null values mean "keep as-is" and are skipped.
 */
export function applyModelOverrides(
  workflow: unknown,
  overrides: unknown,
  objectInfo: Record<string, unknown>,
): Workflow {
  if (!isRecord(workflow))
    throw new UserToolInputError("workflow must be an object");
  if (!Array.isArray(overrides))
    throw new UserToolInputError("modelOverrides must be a list");
  if (overrides.length > MAX_OVERRIDES)
    throw new UserToolInputError("Too many model choices");
  const out = structuredClone(workflow) as Workflow;
  for (const raw of overrides) {
    if (!isRecord(raw))
      throw new UserToolInputError("Each model choice must be an object");
    const { nodeId, input, value } = raw;
    if (value === "" || value === null || value === undefined) continue;
    if (
      typeof nodeId !== "string" ||
      typeof input !== "string" ||
      typeof value !== "string"
    ) {
      throw new UserToolInputError(
        "Each model choice needs a node, input and file",
      );
    }
    const node = Object.prototype.hasOwnProperty.call(workflow, nodeId)
      ? (workflow as Workflow)[nodeId]
      : undefined;
    const original =
      isRecord(node) && isRecord(node.inputs) ? node.inputs[input] : undefined;
    if (
      !isRecord(node) ||
      typeof node.class_type !== "string" ||
      typeof original !== "string" ||
      !Object.prototype.hasOwnProperty.call(node.inputs, input) ||
      !MODEL_FILE_RE.test(original)
    ) {
      throw new UserToolInputError(
        `Node ${nodeId} has no model file input "${input}"`,
      );
    }
    const options = loaderInputOptions(objectInfo, node.class_type, input);
    if (!options || !options.includes(value)) {
      throw new UserToolInputError(
        `"${value}" is not installed for ${node.class_type}. Pick a file from the list.`,
      );
    }
    for (const [id, other] of Object.entries(workflow as Workflow)) {
      if (!isRecord(other) || !isRecord(other.inputs)) continue;
      if (other.inputs[input] !== original) continue;
      if (id !== nodeId) {
        if (typeof other.class_type !== "string") continue;
        const opts = loaderInputOptions(objectInfo, other.class_type, input);
        if (!opts || !opts.includes(value)) continue;
      }
      out[id].inputs[input] = value;
    }
  }
  return out;
}

/**
 * After overrides, refresh auto "LoRA strength · <file>" param labels whose
 * node's lora_name was swapped, so the runner never names a file it no
 * longer uses. Labels the user changed are left alone. Params are passed
 * through untouched when they are not the expected shape (save validates).
 */
export function relabelOverriddenLoraParams(
  params: unknown,
  before: unknown,
  after: Workflow,
): unknown {
  if (!Array.isArray(params) || !isRecord(before)) return params;
  const stem = (f: string) => baseName(f).replace(MODEL_FILE_RE, "");
  return params.map((p) => {
    if (!isRecord(p) || p.kind !== "lora_strength") return p;
    if (typeof p.nodeId !== "string" || typeof p.label !== "string") return p;
    const was = isRecord(before[p.nodeId])
      ? (before[p.nodeId] as { inputs?: Record<string, unknown> }).inputs
          ?.lora_name
      : undefined;
    const now = after[p.nodeId]?.inputs?.lora_name;
    if (typeof was !== "string" || typeof now !== "string" || was === now)
      return p;
    if (p.label !== `LoRA strength · ${stem(was)}`) return p;
    return { ...p, label: `LoRA strength · ${stem(now)}` };
  });
}

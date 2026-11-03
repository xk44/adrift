/**
 * Analyze an imported workflow for the review screen:
 *  - node classes the connected ComfyUI does not know (custom node missing),
 *  - model files the installed loaders do not list (not downloaded),
 *  - the params worth exposing (prompt, negative, media inputs, seed, steps,
 *    cfg, size, LoRA strength, denoise), using /object_info input specs when
 *    available and input names otherwise,
 *  - a suggested name / icon / category.
 *
 * Pure: object_info and Manager mappings are passed in.
 */

import type { Workflow } from "@/types";
import type { HubCategory } from "@/lib/tools/hub";
import {
  detectWorkflowType,
  type WorkflowType,
} from "@/lib/oj/workflow-analysis";
import { parseInputSpec, type ObjectInfoIndex } from "@/lib/oj/inputSpec";
import {
  findMissingClassTypes,
  validatePrompt,
} from "@/lib/comfy/validatePrompt";
import type { BackendProfile } from "@/lib/models/compat";
import type { ExtractedWorkflow } from "./extract";
import { withOverrideCandidates } from "./overrideReport";
import type {
  MissingModelReport,
  MissingNodeReport,
  UserToolAnalysis,
  UserToolOutput,
  UserToolParam,
  UserToolParamKind,
  UserToolSource,
} from "./types";

const MODEL_FILE_RE = /\.(safetensors|gguf|ckpt|pt|pth|bin|sft|onnx)$/i;
const TEXT_KEYS = new Set([
  "text",
  "prompt",
  "text_g",
  "text_l",
  "positive",
  "negative",
  "positive_prompt",
  "negative_prompt",
  "clip_l",
  "t5xxl",
]);
const NEGATIVE_KEY_RE = /neg/i;

/** Media inputs by class when object_info is unavailable. */
const MEDIA_FALLBACK: Record<string, Record<string, UserToolParamKind>> = {
  LoadImage: { image: "image" },
  LoadImageMask: { image: "mask" },
  LoadImageOutput: { image: "image" },
  VHS_LoadVideo: { video: "video" },
  LoadVideo: { file: "video" },
  LoadAudio: { audio: "audio" },
  VHS_LoadAudioUpload: { audio: "audio" },
};

type Mappings = Record<string, { id: string; label: string }[]>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isLink(v: unknown): v is [string | number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    (typeof v[0] === "string" || typeof v[0] === "number") &&
    typeof v[1] === "number"
  );
}

/** Node ids in stable numeric-then-lexical order. */
export function orderedNodeIds(workflow: Workflow): string[] {
  return Object.keys(workflow).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a.localeCompare(b, undefined, { numeric: true });
  });
}

/** Nodes upstream of every `<input>` link (positive/negative), a few hops. */
function conditioningSources(
  workflow: Workflow,
  input: "positive" | "negative",
): Set<string> {
  const out = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [];
  for (const node of Object.values(workflow)) {
    const v = node?.inputs?.[input];
    if (isLink(v)) queue.push({ id: String(v[0]), depth: 0 });
  }
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (out.has(id)) continue;
    out.add(id);
    if (depth >= 4) continue;
    const node = workflow[id];
    if (!node) continue;
    for (const [k, v] of Object.entries(node.inputs ?? {})) {
      if (isLink(v) && /cond|positive|negative/i.test(k)) {
        queue.push({ id: String(v[0]), depth: depth + 1 });
      }
    }
  }
  return out;
}

function nodeTitle(node: Workflow[string]): string | null {
  const t = node?._meta?.title;
  if (typeof t !== "string" || !t.trim()) return null;
  if (t === node.class_type) return null;
  return t.trim();
}

function specFor(
  oi: ObjectInfoIndex | null,
  classType: string,
  input: string,
): unknown[] | null {
  const def = oi?.[classType];
  const spec = def?.input?.required?.[input] ?? def?.input?.optional?.[input];
  return Array.isArray(spec) ? spec : null;
}

function basename(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

const KIND_LABELS: Record<UserToolParamKind, string> = {
  prompt: "Prompt",
  negative: "Negative prompt",
  image: "Image",
  mask: "Mask",
  video: "Video",
  audio: "Audio",
  seed: "Seed",
  steps: "Steps",
  cfg: "Guidance (CFG)",
  width: "Width",
  height: "Height",
  lora_strength: "LoRA strength",
  denoise: "Change amount (denoise)",
};

/** Discover the params of an API graph worth exposing in a tool runner. */
export function discoverParams(
  workflow: Workflow,
  objectInfo: ObjectInfoIndex | null,
): UserToolParam[] {
  const params: UserToolParam[] = [];
  const negSources = conditioningSources(workflow, "negative");
  const posSources = conditioningSources(workflow, "positive");

  for (const nodeId of orderedNodeIds(workflow)) {
    const node = workflow[nodeId];
    if (!node || typeof node.class_type !== "string" || !isRecord(node.inputs))
      continue;
    const ct = node.class_type;
    const title = nodeTitle(node);

    for (const [input, value] of Object.entries(node.inputs)) {
      if (isLink(value)) continue;
      const rawSpec = specFor(objectInfo, ct, input);
      const meta = rawSpec ? parseInputSpec(rawSpec) : null;
      let kind: UserToolParamKind | null = null;

      // Media inputs
      const fallbackMedia = MEDIA_FALLBACK[ct]?.[input];
      if (
        meta?.upload === "image" ||
        meta?.upload === "video" ||
        meta?.upload === "audio"
      ) {
        kind = ct === "LoadImageMask" ? "mask" : meta.upload;
      } else if (fallbackMedia) {
        kind = fallbackMedia;
      } else if (typeof value === "string") {
        const textish =
          TEXT_KEYS.has(input) || (meta?.type === "STRING" && meta.multiline);
        if (textish && !/Loader|Load/.test(ct)) {
          const neg =
            NEGATIVE_KEY_RE.test(input) ||
            (title !== null && /negative/i.test(title)) ||
            (negSources.has(nodeId) && !posSources.has(nodeId));
          kind = neg ? "negative" : "prompt";
        }
      } else if (typeof value === "number") {
        if (input === "seed" || input === "noise_seed") kind = "seed";
        else if (input === "steps") kind = "steps";
        else if (
          input === "cfg" ||
          (input === "guidance" && /Guidance/i.test(ct))
        )
          kind = "cfg";
        else if (input === "denoise") kind = "denoise";
        else if (
          (input === "width" || input === "height") &&
          /Latent|Empty/i.test(ct)
        )
          kind = input;
        else if (
          (input === "strength_model" || input === "strength") &&
          /lora/i.test(ct)
        )
          kind = "lora_strength";
      }
      if (!kind) continue;

      let label = KIND_LABELS[kind];
      if (kind === "lora_strength") {
        const lora = node.inputs.lora_name;
        if (typeof lora === "string" && lora)
          label = `LoRA strength · ${basename(lora).replace(MODEL_FILE_RE, "")}`;
      } else if (
        title &&
        (kind === "prompt" ||
          kind === "negative" ||
          kind === "image" ||
          kind === "video" ||
          kind === "audio")
      ) {
        if (
          !/^(CLIP Text Encode|Load Image|Load Video|Load Audio)/i.test(title)
        )
          label = title;
      }

      const param: UserToolParam = {
        key: `${nodeId}.${input}`,
        nodeId,
        input,
        kind,
        label,
        exposed: false,
      };
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        param.default = value;
      }
      if (meta) {
        if (typeof meta.min === "number") param.min = meta.min;
        if (typeof meta.max === "number") param.max = meta.max;
        if (typeof meta.step === "number") param.step = meta.step;
      }
      params.push(param);
    }
  }
  disambiguateLabels(params);
  autoSelect(params);
  return params;
}

function disambiguateLabels(params: UserToolParam[]): void {
  const counts = new Map<string, number>();
  for (const p of params) counts.set(p.label, (counts.get(p.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const p of params) {
    if ((counts.get(p.label) ?? 0) < 2) continue;
    const n = (seen.get(p.label) ?? 0) + 1;
    seen.set(p.label, n);
    p.label = `${p.label} ${n}`;
  }
}

/**
 * Sensible defaults: every media input (the graph's own files are not on
 * this machine), the first prompt + negative, first seed, steps, cfg, the
 * first latent size, and denoise when the tool edits an input image.
 */
export function autoSelect(params: UserToolParam[]): void {
  const firstOf = new Set<UserToolParamKind>();
  const hasImage = params.some((p) => p.kind === "image" || p.kind === "video");
  for (const p of params) {
    switch (p.kind) {
      case "image":
      case "mask":
      case "video":
      case "audio":
        p.exposed = true;
        break;
      case "prompt":
      case "negative":
      case "seed":
      case "steps":
      case "cfg":
      case "width":
      case "height":
        if (!firstOf.has(p.kind)) {
          p.exposed = true;
          firstOf.add(p.kind);
        }
        break;
      case "denoise":
        if (hasImage && !firstOf.has("denoise")) {
          p.exposed = true;
          firstOf.add("denoise");
        }
        break;
      default:
        break;
    }
  }
}

/** Distinct class_types unknown to ComfyUI, with candidate node packs. */
export function findMissingNodes(
  workflow: Workflow,
  objectInfo: ObjectInfoIndex,
  mappings: Mappings | null = null,
): MissingNodeReport[] {
  return findMissingClassTypes(workflow, objectInfo).map((classType) => ({
    classType,
    packs: mappings?.[classType] ?? [],
  }));
}

export function civitaiModelSearchUrl(file: string): string {
  const q = basename(file).replace(MODEL_FILE_RE, "");
  return `https://civitai.com/search/models?query=${encodeURIComponent(q)}`;
}

/** Model files pinned in the graph that installed loaders do not list. */
export function findMissingModels(
  workflow: Workflow,
  objectInfo: ObjectInfoIndex,
): MissingModelReport[] {
  const out: MissingModelReport[] = [];
  const seen = new Set<string>();
  for (const p of validatePrompt(workflow, objectInfo)) {
    if (p.kind !== "invalid_combo_value" || !p.input) continue;
    const node = workflow[p.nodeId];
    const value = node?.inputs?.[p.input];
    if (typeof value !== "string" || !MODEL_FILE_RE.test(value)) continue;
    const key = `${p.input}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      nodeId: p.nodeId,
      classType: node.class_type,
      input: p.input,
      file: value,
      searchUrl: civitaiModelSearchUrl(value),
    });
  }
  return out;
}

export function outputForType(type: WorkflowType): UserToolOutput {
  if (type === "t2v" || type === "i2v" || type === "r2v") return "video";
  if (type === "t2a") return "audio";
  if (type === "t23d" || type === "i23d") return "mesh";
  return "image";
}

export function suggestCategory(type: WorkflowType): HubCategory {
  switch (type) {
    case "t2v":
    case "i2v":
    case "r2v":
      return "Video";
    case "t2a":
      return "Audio";
    case "upscale":
      return "Enhance";
    case "i2i":
    case "inpaint":
    case "outpaint":
    case "controlnet":
      return "Edit";
    default:
      return "Image";
  }
}

export function suggestIcon(category: HubCategory): string {
  switch (category) {
    case "Video":
    case "VFX":
      return "Film";
    case "Audio":
      return "Music";
    case "Edit":
      return "Brush";
    case "Enhance":
      return "Sparkles";
    case "Identity":
      return "Users";
    case "Image":
      return "WandSparkles";
    default:
      return "Wrench";
  }
}

/** Human tool name from a file name or Civitai title. */
export function suggestName(raw: string | undefined, fallback: string): string {
  const base = (raw ?? "")
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(json|png|zip)$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const name = base || fallback;
  return name.length > 60 ? `${name.slice(0, 57).trimEnd()}...` : name;
}

export interface AnalyzeOptions {
  objectInfo: ObjectInfoIndex | null;
  mappings?: Mappings | null;
  source: UserToolSource;
  /** Preferred display name (e.g. Civitai model title). */
  title?: string;
  /** Backend GPU profile, to rank model stand-ins (optional). */
  profile?: BackendProfile | null;
}

export function analyzeWorkflow(
  extracted: ExtractedWorkflow,
  opts: AnalyzeOptions,
): UserToolAnalysis {
  const { workflow } = extracted;
  const type = detectWorkflowType(workflow);
  const category = suggestCategory(type);
  const oi = opts.objectInfo;
  return {
    workflow,
    format: extracted.format,
    sourceFile: extracted.sourceFile,
    otherFiles: extracted.otherFiles,
    workflowType: type,
    output: outputForType(type),
    params: discoverParams(workflow, oi),
    checked: !!oi,
    missingNodes: oi
      ? findMissingNodes(workflow, oi, opts.mappings ?? null)
      : [],
    missingModels: oi
      ? withOverrideCandidates(
          findMissingModels(workflow, oi),
          oi,
          opts.profile ?? null,
        )
      : [],
    suggested: {
      name: suggestName(opts.title ?? extracted.sourceFile, "My workflow"),
      icon: suggestIcon(category),
      category,
    },
    source: opts.source,
  };
}

/**
 * Adrift recipe: a versioned, portable description of how an output was
 * made (tool / mode, user params, prompt, seeds, model + LoRA filenames,
 * input assets by content hash). Embedded in outputs as the PNG text chunk
 * / video metadata key "adrift_recipe" and kept in the DB (recipes table).
 *
 * Portable means scrubbed: no absolute paths, hostnames, URLs, usernames or
 * keys. Pure and client-safe; files from elsewhere go through parseRecipe.
 */

export const RECIPE_SCHEMA = "adrift.recipe";
export const RECIPE_VERSION = 1;
/** PNG text chunk / video metadata key. */
export const RECIPE_KEY = "adrift_recipe";

export type RecipeToolKind =
  | "create"
  | "action"
  | "tool"
  | "user_tool"
  | "inpaint"
  | "video_editor"
  | "workflow";

const TOOL_KINDS: ReadonlySet<string> = new Set<RecipeToolKind>([
  "create",
  "action",
  "tool",
  "user_tool",
  "inpaint",
  "video_editor",
  "workflow",
]);

export interface RecipeTool {
  kind: RecipeToolKind;
  /** Action / tool id ("upscale_creative", "object_remover"); "imagine" for Create. */
  id: string;
  label?: string;
  /** Tools page card an action was queued from. */
  via?: string;
  /** Create mode when not a still: "video" | "3d" | "audio". */
  mode?: string;
}

export interface RecipeModel {
  /** ComfyUI model name (relative to its models folder, may hold a subfolder). */
  name: string;
  kind: string;
  /** Short sha256 when Adrift already knew it (never hashed at runtime). */
  sha?: string;
}

export interface RecipeLora {
  name: string;
  strength?: number;
  clipStrength?: number;
}

export interface RecipeInput {
  /** What the input fed ("image", "video", "audio", "mask"). */
  role: string;
  /** First 16 hex chars of the file's sha256; absent when unknown. */
  sha256?: string;
  ext?: string;
}

export interface AdriftRecipe {
  schema: typeof RECIPE_SCHEMA;
  v: number;
  /** Adrift version that wrote it. */
  adrift: string;
  createdAt: string;
  tool: RecipeTool;
  /** Full prompt as typed (flags included). */
  prompt?: string;
  seeds: number[];
  params: Record<string, unknown>;
  models: RecipeModel[];
  loras: RecipeLora[];
  inputs: RecipeInput[];
  /** Workflow file name (no folder). */
  workflow?: string;
  sourceRunId?: string;
  sourceJobIndex?: number;
}

// Scrubbing

const SECRET_KEY_RE =
  /(key|token|secret|password|passwd|auth|cookie|bearer|credential|session)/i;
/** Keys that name a machine or connection, or are internal plumbing. */
const DROP_KEY_RE =
  /^(client_?id|request_?id|host|hostname|base_?url|url|comfy_backend|ip|user(name)?|email|home)$/i;
/** Keys the recipe lifts out of params into its own fields. */
const LIFTED_KEYS = new Set([
  "fullPrompt",
  "seed",
  "seeds",
  "action",
  "action_provenance",
  "action_source_run_id",
  "action_source_job_index",
  "action_workflow_path",
  "workflow_path",
]);

const MAX_STR = 4000;
const MAX_DEPTH = 6;
const MAX_ARRAY = 64;
const MAX_PARAMS_JSON = 64_000;

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const ABS_PATH_RE =
  /(?:^|(?<=[\s"'=(]))(?:~[\\/]|\/(?:Users|home|mnt|media|Volumes|private|var|tmp|opt|srv|root|data|run)\/|[A-Za-z]:[\\/]|\\\\)[^\s"'<>]*/g;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g;

function isAbsPath(s: string): boolean {
  return /^(?:~[\\/]|\/|[A-Za-z]:[\\/]|\\\\)/.test(s.trim());
}

/** Remove URLs, absolute paths, emails and IPs from free text. */
export function scrubText(s: string): string {
  return s
    .replace(URL_RE, " ")
    .replace(ABS_PATH_RE, " ")
    .replace(EMAIL_RE, " ")
    .replace(IPV4_RE, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function scrubValue(v: unknown, depth: number): unknown {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    if (v.startsWith("data:") || v.startsWith("blob:") || v.length > MAX_STR)
      return undefined;
    if (isAbsPath(v) || /^[a-z][a-z0-9+.-]*:\/\//i.test(v.trim()))
      return undefined;
    return scrubText(v) === v.trim() ? v : scrubText(v);
  }
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(v)) {
    return v
      .slice(0, MAX_ARRAY)
      .map((x) => scrubValue(x, depth + 1))
      .filter((x) => x !== undefined);
  }
  if (typeof v === "object")
    return scrubParams(v as Record<string, unknown>, depth + 1);
  return undefined;
}

/**
 * User params safe to share: secrets, connection details, absolute paths,
 * URLs, data URIs and oversized strings are removed.
 */
export function scrubParams(
  params: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (SECRET_KEY_RE.test(k) || DROP_KEY_RE.test(k)) continue;
    if (/(^|_)(path|dir|folder)$/i.test(k)) continue;
    const clean = scrubValue(v, depth);
    if (clean !== undefined) out[k] = clean;
  }
  return out;
}

/** Model / workflow name without any absolute folder ("C:\\m\\x.safetensors" -> "x.safetensors"). */
export function portableName(name: string): string {
  const n = name.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (isAbsPath(name) || n.startsWith("/") || n.split("/").includes(".."))
    return n.split("/").pop() ?? "";
  return n;
}

// Graph extraction

type GraphNode = { class_type?: unknown; inputs?: Record<string, unknown> };

const MODEL_EXT = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx|pkl)$/i;
const MEDIA_EXT: Record<string, string> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  mp4: "video",
  mov: "video",
  m4v: "video",
  webm: "video",
  mkv: "video",
  wav: "audio",
  mp3: "audio",
  m4a: "audio",
  flac: "audio",
  ogg: "audio",
};
/** Upload names carry a content hash: "<stem>_<sha256:16>.<ext>" (lib/comfy/contentName.ts). */
export const HASHED_NAME_RE = /_([0-9a-f]{16})\.[A-Za-z0-9]+$/;

function modelKind(input: string, classType: string): string {
  const k = input.toLowerCase();
  const c = classType.toLowerCase();
  if (k.includes("ckpt")) return "checkpoint";
  if (k.includes("unet") || (c.includes("unet") && k.includes("name")))
    return "diffusion_model";
  if (k.includes("vae")) return "vae";
  if (k.includes("clip")) return "text_encoder";
  if (k.includes("control")) return "controlnet";
  if (k.includes("ipadapter") || c.includes("ipadapter")) return "ipadapter";
  if (c.includes("upscale")) return "upscale_model";
  return "model";
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export interface GraphFacts {
  models: RecipeModel[];
  loras: RecipeLora[];
  inputs: RecipeInput[];
  seeds: number[];
}

/** Models, LoRAs, input files and seeds referenced by an API-format graph. */
export function graphFacts(graph: unknown): GraphFacts {
  const facts: GraphFacts = { models: [], loras: [], inputs: [], seeds: [] };
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) return facts;
  const seenModel = new Set<string>();
  const seenLora = new Set<string>();
  const seenInput = new Set<string>();
  const addLora = (name: string, strength?: number, clip?: number) => {
    const n = portableName(name);
    const key = `${n}|${strength ?? ""}|${clip ?? ""}`;
    if (!n || seenLora.has(key)) return;
    seenLora.add(key);
    facts.loras.push({
      name: n,
      ...(strength !== undefined ? { strength } : {}),
      ...(clip !== undefined ? { clipStrength: clip } : {}),
    });
  };
  for (const node of Object.values(graph as Record<string, GraphNode>)) {
    if (!node || typeof node !== "object") continue;
    const classType =
      typeof node.class_type === "string" ? node.class_type : "";
    const inputs =
      node.inputs && typeof node.inputs === "object" ? node.inputs : {};
    const isLoraNode = /lora/i.test(classType);
    for (const [k, v] of Object.entries(inputs)) {
      if (typeof v === "string") {
        const file = v.replace(/\s*\[(input|output|temp)\]$/, "");
        if (MODEL_EXT.test(file)) {
          if (/lora/i.test(k) || (isLoraNode && /name$/i.test(k))) {
            addLora(
              file,
              num(inputs.strength_model) ??
                num(inputs.strength) ??
                num(inputs.lora_strength) ??
                num(inputs.model_strength),
              num(inputs.strength_clip),
            );
          } else {
            const name = portableName(file);
            const kind = modelKind(k, classType);
            const key = `${kind}|${name}`;
            if (name && !seenModel.has(key)) {
              seenModel.add(key);
              facts.models.push({ name, kind });
            }
          }
          continue;
        }
        const ext = file.split(".").pop()?.toLowerCase() ?? "";
        const media = MEDIA_EXT[ext];
        if (media && /^(image|video|audio|file|mask|upload|clip)/i.test(k)) {
          const hash = HASHED_NAME_RE.exec(file)?.[1];
          const role =
            /mask/i.test(k) || /mask/i.test(classType) ? "mask" : media;
          const key = `${role}|${hash ?? file}`;
          if (!seenInput.has(key)) {
            seenInput.add(key);
            facts.inputs.push({ role, ...(hash ? { sha256: hash } : {}), ext });
          }
        }
      } else if (v && typeof v === "object" && !Array.isArray(v)) {
        // rgthree Power Lora Loader rows: { on, lora, strength, strengthTwo }.
        const row = v as Record<string, unknown>;
        const lora = str(row.lora);
        if (lora && MODEL_EXT.test(lora) && row.on !== false) {
          addLora(lora, num(row.strength), num(row.strengthTwo));
        }
      } else if (/^(noise_)?seed$/i.test(k)) {
        const s = num(v);
        if (s !== undefined && !facts.seeds.includes(s)) facts.seeds.push(s);
      }
    }
  }
  return facts;
}

// Building

function toolFromParams(p: Record<string, unknown>): RecipeTool {
  const action = str(p.action);
  const stamp =
    p.action_provenance && typeof p.action_provenance === "object"
      ? (p.action_provenance as Record<string, unknown>)
      : null;
  const stampId = str(stamp?.id);
  const label = str(stamp?.label);
  if (p.user_tool_values && typeof p.user_tool_values === "object") {
    return {
      kind: "user_tool",
      id: stampId ?? str(p.tool_id) ?? "",
      ...(label ? { label } : {}),
    };
  }
  if (stamp?.kind === "tool" || action?.startsWith("tool_")) {
    const id = stampId ?? str(p.tool_id) ?? action?.slice("tool_".length) ?? "";
    return { kind: "tool", id, ...(label ? { label } : {}) };
  }
  if (action === "inpaint") return { kind: "inpaint", id: "inpaint" };
  if (stamp?.kind === "action" && stampId) {
    const via = str(stamp.via);
    return { kind: "action", id: stampId, ...(via ? { via } : {}) };
  }
  if (action && action !== "imagine" && action !== "rerun") {
    return { kind: "action", id: action };
  }
  const mode = p.video
    ? "video"
    : p["3d"]
      ? "3d"
      : p.audio
        ? "audio"
        : undefined;
  return { kind: "create", id: "imagine", ...(mode ? { mode } : {}) };
}

function workflowName(p: Record<string, unknown>): string | undefined {
  const raw = str(p.action_workflow_path) ?? str(p.workflow_path);
  if (!raw) return undefined;
  const base = raw.replace(/\\/g, "/").split("/").pop();
  return base && !base.startsWith("__") ? base : undefined;
}

export interface BuildRecipeInput {
  /** Job params as the routes hand them to buildExtraData (cj params). */
  params?: Record<string, unknown> | null;
  /** Final API graph as queued. */
  graph?: unknown;
  adriftVersion: string;
  now?: Date;
  /** Override for routes whose params do not say (video editor). */
  tool?: RecipeTool;
  /** Known short sha for a model name (no hashing). */
  shaFor?: (name: string) => string | undefined;
}

/** Fit the scrubbed params under the size cap, dropping the largest keys first. */
function capParams(params: Record<string, unknown>): Record<string, unknown> {
  let out = params;
  while (JSON.stringify(out).length > MAX_PARAMS_JSON) {
    const entries = Object.entries(out);
    if (entries.length === 0) break;
    const largest = entries.reduce((a, b) =>
      JSON.stringify(b[1]).length > JSON.stringify(a[1]).length ? b : a,
    );
    out = Object.fromEntries(entries.filter(([k]) => k !== largest[0]));
  }
  return out;
}

export function buildRecipe(input: BuildRecipeInput): AdriftRecipe {
  const p = input.params ?? {};
  const facts = graphFacts(input.graph);
  const seeds: number[] = [];
  const pSeed =
    num(p.seed) ??
    (typeof p.seed === "string" && /^\d+$/.test(p.seed)
      ? Number(p.seed)
      : undefined);
  if (pSeed !== undefined) seeds.push(pSeed);
  for (const s of facts.seeds) if (!seeds.includes(s)) seeds.push(s);
  const rest = Object.fromEntries(
    Object.entries(p).filter(([k]) => !LIFTED_KEYS.has(k)),
  );
  const prompt = str(p.fullPrompt) ?? str(p.prompt);
  const workflow = workflowName(p);
  const sourceRunId = str(p.action_source_run_id);
  const sourceJobIndex = num(p.action_source_job_index);
  const models = input.shaFor
    ? facts.models.map((m) => {
        const sha = input.shaFor?.(m.name);
        return sha ? { ...m, sha } : m;
      })
    : facts.models;
  return {
    schema: RECIPE_SCHEMA,
    v: RECIPE_VERSION,
    adrift: input.adriftVersion,
    createdAt: (input.now ?? new Date()).toISOString(),
    tool: input.tool ?? toolFromParams(p),
    ...(prompt ? { prompt: scrubText(prompt) } : {}),
    seeds,
    params: capParams(scrubParams(rest)),
    models,
    loras: facts.loras,
    inputs: facts.inputs,
    ...(workflow ? { workflow } : {}),
    ...(sourceRunId && /^[\w-]{1,80}$/.test(sourceRunId)
      ? { sourceRunId }
      : {}),
    ...(sourceJobIndex !== undefined ? { sourceJobIndex } : {}),
  };
}

/**
 * JSON with every non-ASCII character escaped, so it fits a Latin-1 PNG
 * tEXt chunk and survives any metadata writer unchanged.
 */
export function recipeJson(recipe: AdriftRecipe): string {
  return JSON.stringify(recipe).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

// Parsing (files from anywhere)

export type ParsedRecipe =
  | { ok: true; recipe: AdriftRecipe; warnings: string[] }
  | { ok: false; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parseTool(v: unknown): RecipeTool {
  if (!isObj(v)) return { kind: "create", id: "imagine" };
  const kind = TOOL_KINDS.has(v.kind as string)
    ? (v.kind as RecipeToolKind)
    : "workflow";
  const id = str(v.id)?.slice(0, 120) ?? "";
  const out: RecipeTool = { kind, id };
  for (const k of ["label", "via", "mode"] as const) {
    const s = str(v[k]);
    if (s) out[k] = scrubText(s).slice(0, 120);
  }
  return out;
}

function parseList<T>(
  v: unknown,
  item: (x: Record<string, unknown>) => T | null,
): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const x of v.slice(0, 128)) {
    if (!isObj(x)) continue;
    const parsed = item(x);
    if (parsed) out.push(parsed);
  }
  return out;
}

const SHA_RE = /^[0-9a-f]{8,64}$/i;

function normalize(
  raw: Record<string, unknown>,
  warnings: string[],
): AdriftRecipe {
  const seeds = Array.isArray(raw.seeds)
    ? raw.seeds
        .filter((s): s is number => typeof s === "number" && Number.isFinite(s))
        .slice(0, 64)
    : [];
  const prompt = str(raw.prompt);
  const workflow = str(raw.workflow);
  const sourceRunId = str(raw.sourceRunId);
  const sourceJobIndex = num(raw.sourceJobIndex);
  return {
    schema: RECIPE_SCHEMA,
    v: typeof raw.v === "number" ? raw.v : RECIPE_VERSION,
    adrift: str(raw.adrift)?.slice(0, 40) ?? "unknown",
    createdAt: str(raw.createdAt)?.slice(0, 40) ?? "",
    tool: parseTool(raw.tool),
    ...(prompt ? { prompt: scrubText(prompt).slice(0, MAX_STR) } : {}),
    seeds,
    params: isObj(raw.params) ? capParams(scrubParams(raw.params)) : {},
    models: parseList(raw.models, (m) => {
      const name = str(m.name);
      if (!name) return null;
      const sha = str(m.sha);
      return {
        name: portableName(name),
        kind: str(m.kind) ?? "model",
        ...(sha && SHA_RE.test(sha) ? { sha } : {}),
      };
    }),
    loras: parseList(raw.loras, (l) => {
      const name = str(l.name);
      if (!name) return null;
      const strength = num(l.strength);
      const clipStrength = num(l.clipStrength);
      return {
        name: portableName(name),
        ...(strength !== undefined ? { strength } : {}),
        ...(clipStrength !== undefined ? { clipStrength } : {}),
      };
    }),
    inputs: parseList(raw.inputs, (i) => {
      const role = str(i.role) ?? "image";
      const sha = str(i.sha256);
      const ext = str(i.ext);
      return {
        role: role.slice(0, 32),
        ...(sha && SHA_RE.test(sha) ? { sha256: sha } : {}),
        ...(ext && /^[a-z0-9]{1,8}$/i.test(ext) ? { ext } : {}),
      };
    }),
    ...(workflow ? { workflow: portableName(workflow).split("/").pop() } : {}),
    ...(sourceRunId && /^[\w-]{1,80}$/.test(sourceRunId)
      ? { sourceRunId }
      : {}),
    ...(sourceJobIndex !== undefined ? { sourceJobIndex } : {}),
  } as AdriftRecipe;
}

/**
 * Read a recipe from a chunk / metadata value or a parsed object. Accepts
 * this version, newer versions (best effort, with a warning) and the older
 * "cj" chunk ({ v: 1, params }) every Adrift PNG already carries.
 */
export function parseRecipe(raw: unknown): ParsedRecipe {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, error: "Recipe is not valid JSON" };
    }
  }
  if (!isObj(value)) return { ok: false, error: "No recipe found" };
  const warnings: string[] = [];
  if (value.schema === RECIPE_SCHEMA) {
    const v = value.v;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      return { ok: false, error: "Unsupported recipe version" };
    }
    if (v > RECIPE_VERSION) {
      warnings.push(
        `Made by a newer Adrift (recipe v${v}); settings it added are ignored.`,
      );
    }
    return { ok: true, recipe: normalize(value, warnings), warnings };
  }
  // Older Adrift outputs: the "cj" chunk carries only the job params.
  if (
    isObj(value.params) &&
    (value.v === 1 || value.v === undefined) &&
    !("schema" in value)
  ) {
    warnings.push("Older Adrift file: models and LoRAs were not recorded.");
    const recipe = buildRecipe({
      params: value.params,
      adriftVersion: "legacy",
    });
    return { ok: true, recipe: { ...recipe, createdAt: "" }, warnings };
  }
  return { ok: false, error: "Not an Adrift recipe" };
}

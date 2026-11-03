import fs from "fs/promises";
import path from "path";
import type { Workflow, WorkflowNode } from "@/types";
import { env } from "@/lib/env";
import { stripWorkflowMetaKeys } from "./workflowMeta";
import { getObjectInfoCached } from "./objectInfoCache";
import { findMissingClassTypes } from "./validatePrompt";
import { bypassMissingOptionalNodes } from "./optionalNodes";

export { stripWorkflowMetaKeys };

// The one ComfyUI root the whole app uses (COMFY_ROOT, see lib/env.ts).
const COMFY_ROOT = env.COMFY_ROOT;
const SAVED_WORKFLOWS_DIR = path.join(COMFY_ROOT, "user/default/workflows");

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function resolveSavedWorkflowPath(selection: string): string {
  const savedPath = selection.slice("saved:".length);
  const segments = savedPath.split(/[\\/]+/).filter(Boolean);
  if (
    !savedPath ||
    path.isAbsolute(savedPath) ||
    path.win32.isAbsolute(savedPath) ||
    segments.some((segment) => segment === "..")
  ) {
    throw new Error("Invalid saved workflow path");
  }

  const baseDir = path.resolve(SAVED_WORKFLOWS_DIR);
  const resolvedPath = path.resolve(baseDir, savedPath);
  if (!isPathInside(baseDir, resolvedPath) || !resolvedPath.toLowerCase().endsWith(".json")) {
    throw new Error("Invalid saved workflow path");
  }

  return resolvedPath;
}

/**
 * The lexical check above can't see symlinks: a link inside the workflows
 * folder (or a linked sub-folder) could point anywhere. Re-check with
 * realpath; the workflows folder itself may be a link.
 */
async function realSavedWorkflowPath(resolvedPath: string): Promise<string> {
  const realBase = await fs.realpath(path.resolve(SAVED_WORKFLOWS_DIR));
  const real = await fs.realpath(resolvedPath);
  if (!isPathInside(realBase, real) || real === realBase) {
    throw new Error("Invalid saved workflow path");
  }
  return real;
}

interface SavedWorkflowInput {
  name: string;
  type: string;
  link?: number | null;
  widget?: { name?: string };
}

interface SavedWorkflowNode {
  id: number;
  type: string;
  inputs?: SavedWorkflowInput[];
  outputs?: Array<{ name?: string; type?: string; links?: number[] | null }>;
  widgets_values?: unknown[];
  /** LiteGraph mode: 0 always, 2 never (muted), 4 bypass */
  mode?: number;
  properties?: Record<string, unknown>;
}

interface SavedWorkflowLinkObject {
  id: number;
  origin_id: number;
  origin_slot: number;
  target_id: number;
  target_slot: number;
  type: string;
}

type SavedWorkflowLink =
  [number, number, number, number, number, string] | SavedWorkflowLinkObject;

interface SavedSubgraphInput {
  id: string;
  name: string;
  type: string;
  linkIds?: number[];
  label?: string;
  pos?: number[];
}

interface SavedSubgraph {
  id: string;
  name?: string;
  nodes: SavedWorkflowNode[];
  links: SavedWorkflowLink[];
  inputs?: SavedSubgraphInput[];
  outputs?: Array<{ name?: string; type?: string }>;
  inputNode?: { id: number };
  outputNode?: { id: number };
}

interface SavedWorkflowFile {
  nodes?: SavedWorkflowNode[];
  links?: SavedWorkflowLink[];
  definitions?: {
    subgraphs?: SavedSubgraph[];
  };
}

export interface WorkflowDefaultParams {
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  denoise?: number;
  width?: number;
  height?: number;
  checkpoint?: string;
}

export interface WorkflowCapabilities {
  kind:
    | "t2i"
    | "i2i"
    | "upscale"
    | "inpaint"
    | "outpaint"
    | "t2v"
    | "i2v"
    | "t23d"
    | "i23d"
    | "t2a"
    | "unknown";
  hasSampler: boolean;
  loaderType: "checkpoint" | "unet" | "none";
  hasVaeLoader: boolean;
  hasLatentDims: boolean;
  hasImageInput: boolean;
  hasMask: boolean;
  canAddLoras: boolean;
  hasExistingLoras: boolean;
  defaults: WorkflowDefaultParams;
}

export interface SavedWorkflowSummary {
  id: string;
  name: string;
  file: string;
  path: string;
  source: "saved" | "local";
  kind?:
    | "t2i"
    | "i2i"
    | "upscale"
    | "inpaint"
    | "outpaint"
    | "t2v"
    | "i2v"
    | "t23d"
    | "i23d"
    | "t2a"
    | "unknown";
  defaultParams?: WorkflowDefaultParams;
}

export function getSavedWorkflowsDir(): string {
  return SAVED_WORKFLOWS_DIR;
}

async function listJsonFilesRecursive(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return listJsonFilesRecursive(fullPath);
      if (entry.isFile() && entry.name.endsWith(".json")) return [fullPath];
      return [];
    }),
  );
  return nested.flat();
}

export async function listSavedWorkflows(): Promise<SavedWorkflowSummary[]> {
  const files = await listJsonFilesRecursive(SAVED_WORKFLOWS_DIR).catch(
    (err: NodeJS.ErrnoException) => {
      // A fresh ComfyUI has no saved workflows folder yet: that is an empty list.
      if (err?.code === "ENOENT") return [] as string[];
      throw err;
    },
  );

  const summaries = await Promise.all(
    files.map(async (fullPath) => {
      const relativePath = path.relative(SAVED_WORKFLOWS_DIR, fullPath);
      const normalizedFile = relativePath.split(path.sep).join("/");
      const fallbackName = path
        .basename(normalizedFile, ".json")
        .replace(/[_-]+/g, " ");
      try {
        const raw = await fs.readFile(fullPath, "utf-8");
        const parsed = JSON.parse(raw) as SavedWorkflowFile;
        const topNode = parsed.nodes?.find(
          (node) => typeof node.type === "string",
        );
        const subgraph =
          parsed.definitions?.subgraphs?.find(
            (sg) => sg.id === topNode?.type,
          ) ?? parsed.definitions?.subgraphs?.[0];

        const apiWorkflow = savedToApiWorkflow(parsed);
        const metadata = apiWorkflow ? analyzeApiWorkflow(apiWorkflow) : {};

        return {
          id: normalizedFile,
          name: subgraph?.name || fallbackName,
          file: normalizedFile,
          path: fullPath,
          source: "saved" as const,
          ...metadata,
        };
      } catch {
        return {
          id: normalizedFile,
          name: fallbackName,
          file: normalizedFile,
          path: fullPath,
          source: "saved" as const,
        };
      }
    }),
  );

  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Canonical widgets_values order for common node classes.
 *
 * The new-style frontend format (subgraph templates, frontend >=1.4x) only
 * lists a widget input in a node's `inputs[]` when it is linked; unlinked
 * widget inputs exist solely as positional entries in `widgets_values`.
 * Walking `inputs[]` therefore drops them (KSampler loses steps/cfg/...,
 * CLIPLoader loses type/device, etc.), and ComfyUI rejects the prompt with
 * "Required input is missing". These tables recover the name for each
 * position. `control_after_generate` is a UI-only widget — mapped here to
 * keep positions aligned, but never emitted as an API input.
 */
const UI_ONLY_WIDGETS = new Set(["control_after_generate"]);

const NODE_WIDGET_ORDER: Record<string, string[]> = {
  KSampler: [
    "seed",
    "control_after_generate",
    "steps",
    "cfg",
    "sampler_name",
    "scheduler",
    "denoise",
  ],
  KSamplerAdvanced: [
    "add_noise",
    "noise_seed",
    "control_after_generate",
    "steps",
    "cfg",
    "sampler_name",
    "scheduler",
    "start_at_step",
    "end_at_step",
    "return_with_leftover_noise",
  ],
  CheckpointLoaderSimple: ["ckpt_name"],
  UNETLoader: ["unet_name", "weight_dtype"],
  CLIPLoader: ["clip_name", "type", "device"],
  DualCLIPLoader: ["clip_name1", "clip_name2", "type", "device"],
  VAELoader: ["vae_name"],
  CLIPTextEncode: ["text"],
  EmptyLatentImage: ["width", "height", "batch_size"],
  EmptySD3LatentImage: ["width", "height", "batch_size"],
  LoraLoader: ["lora_name", "strength_model", "strength_clip"],
  LoraLoaderModelOnly: ["lora_name", "strength_model"],
  SaveImage: ["filename_prefix"],
  PrimitiveString: ["value"],
  PrimitiveStringMultiline: ["value"],
  PrimitiveBoolean: ["value"],
  StringConcatenate: ["string_a", "string_b", "delimiter"],
  ConditioningZeroOut: [],
};

/**
 * Nodes whose widgets_values can't be mapped positionally. TextGenerate's
 * sampling_mode is a DynamicCombo: the API prompt carries the selected key
 * plus its sub-options as flat dotted keys ("sampling_mode.temperature"),
 * which ComfyUI's dynamic_paths machinery reassembles into a dict.
 */
const NODE_WIDGET_MAPPERS: Record<
  string,
  (widgets: unknown[]) => Record<string, unknown>
> = {
  TextGenerate: (w) => {
    const inputs: Record<string, unknown> = {
      prompt: w[0],
      max_length: w[1],
      sampling_mode: w[2],
      thinking: w[10],
      use_default_template: w[11],
    };
    if (w[2] === "on") {
      inputs["sampling_mode.temperature"] = w[3];
      inputs["sampling_mode.top_k"] = w[4];
      inputs["sampling_mode.top_p"] = w[5];
      inputs["sampling_mode.min_p"] = w[6];
      inputs["sampling_mode.repetition_penalty"] = w[7];
      inputs["sampling_mode.seed"] = w[8];
      inputs["sampling_mode.presence_penalty"] = w[9];
    }
    return inputs;
  },
};

function widgetValueForInput(
  node: SavedWorkflowNode,
  inputName: string,
): unknown {
  const widgets = node.widgets_values ?? [];

  const order = NODE_WIDGET_ORDER[node.type];
  if (order) {
    const idx = order.indexOf(inputName);
    if (idx >= 0) return widgets[idx];
  }

  const inputs = node.inputs ?? [];
  let widgetIndex = 0;

  for (const input of inputs) {
    const hasWidget = Boolean(input.widget);
    if (!hasWidget) continue;
    const value = widgets[widgetIndex];
    if (input.name === inputName) return value;
    widgetIndex += 1;
  }

  return undefined;
}

function ensureOutputNode(workflow: Workflow): Workflow {
  const hasOutput = Object.values(workflow).some((node) =>
    ["SaveImage", "PreviewImage"].includes(node.class_type),
  );

  if (hasOutput) {
    return workflow;
  }

  const imageSourceEntry = Object.entries(workflow).find(([, node]) =>
    ["VAEDecode", "ImageScale", "LoadImage", "ImageCompositeMasked"].includes(
      node.class_type,
    ),
  );

  if (!imageSourceEntry) {
    return workflow;
  }

  const [imageNodeId] = imageSourceEntry;
  const numericIds = Object.keys(workflow)
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));
  const nextId = String((numericIds.length ? Math.max(...numericIds) : 0) + 1);

  workflow[nextId] = {
    class_type: "SaveImage",
    inputs: {
      images: [imageNodeId, 0],
      filename_prefix: "adrift",
    },
  };

  return workflow;
}

// Display-only node types that ComfyUI doesn't recognize in API mode.
const DISPLAY_ONLY_TYPES = new Set([
  "MarkdownNote",
  "Note",
  "Reroute",
  "PrimitiveNode",
]);

/** Normalize the array- and object-form saved link encodings into one shape. */
function normalizeLink(link: SavedWorkflowLink): {
  id: number;
  oId: number;
  oSlot: number;
  tId: number;
  tSlot: number;
} {
  if (Array.isArray(link)) {
    return {
      id: link[0],
      oId: link[1],
      oSlot: link[2],
      tId: link[3],
      tSlot: link[4],
    };
  }
  return {
    id: link.id,
    oId: link.origin_id,
    oSlot: link.origin_slot,
    tId: link.target_id,
    tSlot: link.target_slot,
  };
}

/**
 * Fill a node's widget-default inputs (model names, seeds, cfg, ...).
 *
 * Two sources, in order:
 *  a) NODE_WIDGET_ORDER / mapper tables — recover widget inputs the new-style
 *     format leaves out of `inputs[]`. These are defaults; link wiring done
 *     afterwards overwrites any input fed from a real node.
 *  b) the node's `inputs[]` widget entries — legacy behavior for node types not
 *     in the tables. A widget input that is genuinely linked from another node
 *     is skipped so the wiring pass can set it.
 */
function applyNodeWidgets(
  target: { class_type: string; inputs: Record<string, unknown> },
  node: SavedWorkflowNode,
  linkById: Map<number, SavedWorkflowLink>,
): void {
  const order = NODE_WIDGET_ORDER[node.type];
  const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : [];

  const mapper = NODE_WIDGET_MAPPERS[node.type];
  if (mapper && widgets.length > 0) {
    for (const [name, value] of Object.entries(mapper(widgets))) {
      if (value !== undefined && value !== null) target.inputs[name] = value;
    }
    return;
  }

  if (order) {
    order.forEach((name, idx) => {
      if (UI_ONLY_WIDGETS.has(name)) return;
      const value = widgets[idx];
      if (value !== undefined && value !== null) target.inputs[name] = value;
    });
    return;
  }

  for (const input of node.inputs ?? []) {
    if (!input.widget) continue;
    if (input.link != null) {
      const linkedFrom = linkById.get(input.link);
      if (linkedFrom) {
        const linkedOriginId = Array.isArray(linkedFrom)
          ? linkedFrom[1]
          : linkedFrom.origin_id;
        if (linkedOriginId >= 0 && linkedOriginId !== node.id) continue;
      }
    }
    const value = widgetValueForInput(node, input.name);
    if (value !== undefined) target.inputs[input.name] = value;
  }
}

/**
 * Flatten a subgraph-composed workflow into a flat API graph.
 *
 * Modern ComfyUI (frontend >=1.4) saves a top-level canvas whose nodes may be
 * *instances* of subgraph definitions (`type` == a subgraph uuid). Each subgraph
 * has its own inner nodes/links plus boundary `inputNode` (id -10) and
 * `outputNode` (id -20).
 *
 * This walks the top graph, recursively inlines every subgraph instance under a
 * namespaced id (`<instanceGid>/<innerId>`), and resolves boundary crossings:
 * inner consumers of a subgraph input are rewired to whatever feeds the
 * instance's input slot; external consumers of an instance output are rewired to
 * whatever inner node feeds that boundary output. Handles arbitrary nesting.
 *
 * Also handles: promoted widgets (unlinked widget inputs on an instance take
 * the instance's own value, per instance — so one definition used twice keeps
 * two different values), `properties.proxyWidgets` with per-instance values,
 * Reroute pass-through, PrimitiveNode literals, muted (mode 2) and bypassed
 * (mode 4) nodes.
 *
 * Structural problems throw a WorkflowGraphError with a specific code and a
 * message naming the subgraph/node/link involved, instead of silently
 * dropping the edge (which would yield a graph that "worked" but was wrong).
 *
 * Returns null when there is nothing to flatten (e.g. a bare subgraph template
 * with no top-level nodes) so the caller can fall back to legacy handling.
 */
export type WorkflowGraphErrorCode =
  | "missing_subgraph"
  | "subgraph_cycle"
  | "dangling_link"
  | "bad_slot"
  | "unconnected_output"
  | "resolve_overflow";

export class WorkflowGraphError extends Error {
  readonly code: WorkflowGraphErrorCode;
  constructor(code: WorkflowGraphErrorCode, message: string) {
    super(message);
    this.name = "WorkflowGraphError";
    this.code = code;
  }
}

const SUBGRAPH_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FlattenPort {
  id: string;
  slot: number;
}

type FlattenSource = FlattenPort | { literal: unknown };

function isLiteral(p: FlattenSource): p is { literal: unknown } {
  return "literal" in p;
}

export interface FlattenResult {
  workflow: Workflow | null;
  /** Non-fatal oddities (stale links, unconnected optional subgraph inputs). */
  warnings: string[];
}

export function flattenComposedWorkflow(parsed: SavedWorkflowFile): Workflow | null {
  return flattenComposedWorkflowDetailed(parsed).workflow;
}

export function flattenComposedWorkflowDetailed(
  parsed: SavedWorkflowFile,
): FlattenResult {
  const warnings: string[] = [];
  const defs = new Map<string, SavedSubgraph>();
  for (const sg of parsed.definitions?.subgraphs ?? []) defs.set(sg.id, sg);
  if (defs.size === 0) return { workflow: null, warnings };

  const sgLabel = (sg: SavedSubgraph) => `"${sg.name ?? sg.id}"`;
  const levelLabel = (prefix: string) =>
    prefix ? `subgraph instance ${prefix.slice(0, -1)}` : "top-level graph";

  const realNodes = new Map<
    string,
    { raw: SavedWorkflowNode; level: string }
  >();
  const levelLinks = new Map<string, Map<number, SavedWorkflowLink>>();
  const edges: Array<{ from: FlattenPort; to: FlattenPort; linkId: number }> = [];
  const instanceOut = new Map<string, Map<number, FlattenSource>>();
  const instanceSub = new Map<string, SavedSubgraph>();
  const boundaryIn = new Map<string, Map<number, FlattenSource>>();
  const boundarySub = new Map<string, SavedSubgraph>();
  // Pass-through nodes: Reroute (input 0) and bypassed nodes (type match).
  const passThrough = new Map<string, (slot: number) => FlattenSource | null>();
  const primitives = new Map<string, unknown>();
  const muted = new Set<string>();
  const proxyValues = new Map<string, Record<string, unknown>>();

  const walk = (
    nodes: SavedWorkflowNode[] | undefined,
    links: SavedWorkflowLink[] | undefined,
    prefix: string,
    inputNodeId: number | undefined,
    outputNodeId: number | undefined,
    stack: SavedSubgraph[],
  ): void => {
    const norm = (links ?? []).map(normalizeLink);
    const linkById = new Map<number, SavedWorkflowLink>();
    const normById = new Map<number, (typeof norm)[number]>();
    (links ?? []).forEach((l, i) => {
      linkById.set(norm[i].id, l);
      normById.set(norm[i].id, norm[i]);
    });
    levelLinks.set(prefix, linkById);
    const nodeById = new Map<number, SavedWorkflowNode>();
    for (const n of nodes ?? []) nodeById.set(n.id, n);
    const gid = (localId: number) => `${prefix}${localId}`;

    // Origin port of a link at this level (boundary input or a local node).
    const originOf = (l: (typeof norm)[number], context: string): FlattenPort => {
      if (inputNodeId != null && l.oId === inputNodeId) {
        return { id: `${prefix}#in`, slot: l.oSlot };
      }
      if (!nodeById.has(l.oId)) {
        throw new WorkflowGraphError(
          "dangling_link",
          `Link ${l.id} (${context}) in the ${levelLabel(prefix)} starts at node ${l.oId}, which does not exist.`,
        );
      }
      return { id: gid(l.oId), slot: l.oSlot };
    };

    const linkedSource = (
      linkId: number,
      context: string,
    ): FlattenPort => {
      const l = normById.get(linkId);
      if (!l) {
        throw new WorkflowGraphError(
          "dangling_link",
          `${context} in the ${levelLabel(prefix)} references link ${linkId}, which is missing from the links table.`,
        );
      }
      return originOf(l, context);
    };

    for (const n of nodes ?? []) {
      const myGid = gid(n.id);
      if (n.type === "Reroute") {
        const inLink = n.inputs?.[0]?.link;
        const src =
          inLink != null ? linkedSource(inLink, `Reroute ${n.id} input`) : null;
        passThrough.set(myGid, () => src);
        continue;
      }
      if (n.type === "PrimitiveNode") {
        primitives.set(myGid, n.widgets_values?.[0]);
        continue;
      }
      if (DISPLAY_ONLY_TYPES.has(n.type)) continue;
      if (n.mode === 2) {
        muted.add(myGid);
        continue;
      }
      if (n.mode === 4) {
        // Bypass: each output forwards the first linked input of the same type.
        const ins = n.inputs ?? [];
        const outs = n.outputs ?? [];
        passThrough.set(myGid, (slot) => {
          const t = outs[slot]?.type;
          const match = ins.find(
            (inp) => inp.link != null && (t == null || inp.type === t),
          );
          return match?.link != null
            ? linkedSource(match.link, `bypassed node ${n.id} input "${match.name}"`)
            : null;
        });
        continue;
      }
      const sub = defs.get(n.type);
      if (!sub) {
        if (SUBGRAPH_ID_RE.test(n.type)) {
          throw new WorkflowGraphError(
            "missing_subgraph",
            `Node ${n.id} in the ${levelLabel(prefix)} is an instance of subgraph ${n.type}, but that subgraph is not in definitions.subgraphs (was the workflow exported without its subgraph blueprints?).`,
          );
        }
        realNodes.set(myGid, { raw: n, level: prefix });
        continue;
      }
      if (stack.some((s) => s.id === sub.id)) {
        throw new WorkflowGraphError(
          "subgraph_cycle",
          `Subgraph cycle: ${[...stack, sub].map(sgLabel).join(" → ")}. A subgraph cannot contain an instance of itself.`,
        );
      }
      // Subgraph instance: record the external source feeding each input slot,
      // recurse into the body, then record which inner node feeds each output.
      const childPrefix = `${myGid}/`;
      const inMap = new Map<number, FlattenSource>();
      const proxies = (n.properties as { proxyWidgets?: unknown } | undefined)
        ?.proxyWidgets;
      const wv = Array.isArray(n.widgets_values) ? n.widgets_values : [];
      const proxyAligned =
        Array.isArray(proxies) && proxies.length > 0 && wv.length === proxies.length;
      (n.inputs ?? []).forEach((inp, slot) => {
        if (sub.inputs && slot >= sub.inputs.length) {
          throw new WorkflowGraphError(
            "bad_slot",
            `Subgraph instance ${myGid} (${sgLabel(sub)}) has input slot ${slot} ("${inp.name}") but the subgraph only declares ${sub.inputs.length} input(s).`,
          );
        }
        if (inp.link != null) {
          inMap.set(
            slot,
            linkedSource(inp.link, `input "${inp.name}" of subgraph ${sgLabel(sub)} (node ${n.id})`),
          );
        } else if (inp.widget && !proxyAligned) {
          // Promoted widget left unlinked: the instance carries the value.
          const v = widgetValueForInput(n, inp.name);
          if (v !== undefined) inMap.set(slot, { literal: v });
        }
      });
      if (proxyAligned) {
        (proxies as unknown[]).forEach((entry, i) => {
          if (!Array.isArray(entry) || entry.length < 2) return;
          const [innerId, widgetName] = entry as [unknown, unknown];
          if (typeof widgetName !== "string" || widgetName.startsWith("$$")) return;
          if (String(innerId) === "-1") {
            const slot = (sub.inputs ?? []).findIndex((s) => s.name === widgetName);
            if (slot >= 0 && !inMap.has(slot)) inMap.set(slot, { literal: wv[i] });
            return;
          }
          const target = `${childPrefix}${String(innerId)}`;
          proxyValues.set(target, {
            ...(proxyValues.get(target) ?? {}),
            [widgetName]: wv[i],
          });
        });
      }
      boundaryIn.set(childPrefix, inMap);
      boundarySub.set(childPrefix, sub);
      instanceSub.set(myGid, sub);

      walk(
        sub.nodes,
        sub.links,
        childPrefix,
        sub.inputNode?.id,
        sub.outputNode?.id,
        [...stack, sub],
      );

      const outMap = new Map<number, FlattenSource>();
      const innerIds = new Set((sub.nodes ?? []).map((x) => x.id));
      for (const il of (sub.links ?? []).map(normalizeLink)) {
        if (sub.outputNode?.id == null || il.tId !== sub.outputNode.id) continue;
        if (il.oId === sub.inputNode?.id) {
          outMap.set(il.tSlot, { id: `${childPrefix}#in`, slot: il.oSlot });
        } else if (innerIds.has(il.oId)) {
          outMap.set(il.tSlot, { id: `${childPrefix}${il.oId}`, slot: il.oSlot });
        } else {
          throw new WorkflowGraphError(
            "dangling_link",
            `Subgraph ${sgLabel(sub)} output ${il.tSlot} is fed by link ${il.id} from node ${il.oId}, which does not exist inside the subgraph.`,
          );
        }
      }
      instanceOut.set(myGid, outMap);
    }

    // Edges at this level. Skip links consumed by boundaries (into an instance
    // input, or into this level's outputNode) — those are stitched separately.
    for (const l of norm) {
      if (outputNodeId != null && l.tId === outputNodeId) continue;
      const targetRaw = nodeById.get(l.tId);
      if (!targetRaw) {
        warnings.push(
          `Ignored stale link ${l.id} in the ${levelLabel(prefix)}: target node ${l.tId} does not exist.`,
        );
        continue;
      }
      if (
        defs.has(targetRaw.type) ||
        DISPLAY_ONLY_TYPES.has(targetRaw.type) ||
        targetRaw.mode === 2 ||
        targetRaw.mode === 4
      )
        continue;
      const input = targetRaw.inputs?.[l.tSlot];
      if (!input) {
        throw new WorkflowGraphError(
          "bad_slot",
          `Link ${l.id} in the ${levelLabel(prefix)} targets input slot ${l.tSlot} of ${targetRaw.type} (node ${l.tId}), which has no such input.`,
        );
      }
      if (input.link != null && input.link !== l.id) {
        warnings.push(
          `Ignored stale link ${l.id} in the ${levelLabel(prefix)}: ${targetRaw.type} (node ${l.tId}) input "${input.name}" is wired to link ${input.link}.`,
        );
        continue;
      }
      const from = originOf(l, `into ${targetRaw.type} (node ${l.tId}) input "${input.name}"`);
      edges.push({ from, to: { id: gid(l.tId), slot: l.tSlot }, linkId: l.id });
    }
  };

  walk(parsed.nodes, parsed.links, "", undefined, undefined, []);

  // Chase a (possibly virtual) origin port down to a concrete real-node port
  // or literal. null = legitimately unconnected (optional input left open).
  const resolve = (src: FlattenSource, depth = 0): FlattenSource | null => {
    if (depth > 4096) {
      throw new WorkflowGraphError(
        "resolve_overflow",
        "Could not resolve a link through subgraph boundaries/reroutes (more than 4096 hops — likely a reroute loop).",
      );
    }
    if (isLiteral(src)) return src;
    const port = src;
    if (port.id.endsWith("#in")) {
      const childPrefix = port.id.slice(0, -3);
      const ext = boundaryIn.get(childPrefix)?.get(port.slot);
      return ext ? resolve(ext, depth + 1) : null;
    }
    const out = instanceOut.get(port.id);
    if (out) {
      const inner = out.get(port.slot);
      if (!inner) {
        const sub = instanceSub.get(port.id)!;
        const outName =
          (sub as { outputs?: Array<{ name?: string }> }).outputs?.[port.slot]?.name ??
          `#${port.slot}`;
        throw new WorkflowGraphError(
          "unconnected_output",
          `Subgraph ${sgLabel(sub)} (instance ${port.id}) output "${outName}" is used outside the subgraph but nothing inside the subgraph is connected to it.`,
        );
      }
      return resolve(inner, depth + 1);
    }
    const pass = passThrough.get(port.id);
    if (pass) {
      const next = pass(port.slot);
      return next ? resolve(next, depth + 1) : null;
    }
    if (primitives.has(port.id)) return { literal: primitives.get(port.id) };
    if (muted.has(port.id)) return null;
    if (realNodes.has(port.id)) return port;
    throw new WorkflowGraphError(
      "dangling_link",
      `Link source ${port.id} could not be found after flattening.`,
    );
  };

  const workflow: Workflow = {};
  for (const [g, { raw }] of realNodes) {
    workflow[g] = { class_type: raw.type, inputs: {} };
  }
  for (const [g, { raw, level }] of realNodes) {
    applyNodeWidgets(workflow[g], raw, levelLinks.get(level) ?? new Map());
    const proxied = proxyValues.get(g);
    if (proxied) Object.assign(workflow[g].inputs, proxied);
  }
  for (const { from, to } of edges) {
    if (!realNodes.has(to.id)) continue;
    const raw = realNodes.get(to.id)!.raw;
    const input = raw.inputs![to.slot];
    const src = resolve(from);
    if (!src) {
      if (input.widget) continue; // keep the inner widget's own value
      const sub = from.id.endsWith("#in")
        ? boundarySub.get(from.id.slice(0, -3))
        : undefined;
      const subInput = sub?.inputs?.[from.slot]?.name;
      warnings.push(
        sub
          ? `${raw.type} (node ${to.id}) input "${input.name}" comes from subgraph ${sgLabel(sub)} input "${subInput ?? from.slot}", which nothing is connected to.`
          : `${raw.type} (node ${to.id}) input "${input.name}" is fed through a muted/bypassed/unconnected node and was left empty.`,
      );
      continue;
    }
    workflow[to.id].inputs[input.name] = isLiteral(src)
      ? src.literal
      : [src.id, src.slot];
  }

  if (Object.keys(workflow).length === 0) return { workflow: null, warnings };
  return { workflow: ensureOutputNode(workflow), warnings };
}

function subgraphToApiWorkflow(subgraph: SavedSubgraph): Workflow {
  const workflow: Workflow = {};
  const linkById = new Map<number, SavedWorkflowLink>();

  // Build link lookup
  for (const link of subgraph.links ?? []) {
    const linkId = Array.isArray(link) ? link[0] : link.id;
    linkById.set(linkId, link);
  }

  // Pass 1: Create nodes with class_type (skip display-only nodes)
  for (const node of subgraph.nodes) {
    if (DISPLAY_ONLY_TYPES.has(node.type)) continue;
    workflow[String(node.id)] = {
      class_type: node.type,
      inputs: {},
    };
  }

  // Pass 2: Set widget defaults (model selections, seeds, etc.)
  for (const node of subgraph.nodes) {
    const target = workflow[String(node.id)];
    if (!target) continue;
    applyNodeWidgets(target, node, linkById);
  }

  // Pass 3: Wire links between nodes
  for (const link of subgraph.links ?? []) {
    const originId = Array.isArray(link) ? link[1] : link.origin_id;
    const originSlot = Array.isArray(link) ? link[2] : link.origin_slot;
    const targetId = Array.isArray(link) ? link[3] : link.target_id;
    const targetSlot = Array.isArray(link) ? link[4] : link.target_slot;

    if (
      originId < 0 ||
      targetId < 0 ||
      originId === targetId ||
      !workflow[String(originId)] ||
      !workflow[String(targetId)]
    ) {
      continue;
    }

    const targetNode = subgraph.nodes.find((n) => n.id === targetId);
    if (!targetNode) continue;

    const input = targetNode.inputs?.[targetSlot];
    if (!input) continue;

    workflow[String(targetId)].inputs[input.name] = [
      String(originId),
      originSlot as number,
    ];
  }

  return ensureOutputNode(workflow);
}

function isApiFormat(parsed: unknown): parsed is Workflow {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return false;
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj.nodes) || Array.isArray(obj.links)) return false;
  // pack files lead with metadata keys ("_meta", "_comment"): judge by the first node entry
  const firstVal = Object.entries(obj).find(([k]) => !k.startsWith("_"))?.[1];
  return (
    firstVal != null &&
    typeof firstVal === "object" &&
    "class_type" in (firstVal as Record<string, unknown>)
  );
}

function uiToApiWorkflow(saved: SavedWorkflowFile): Workflow {
  const nodes = saved.nodes ?? [];
  const links = saved.links ?? [];

  if (nodes.length === 0) {
    throw new Error("UI workflow has no nodes");
  }

  return subgraphToApiWorkflow({
    id: "__top__",
    nodes,
    links,
  });
}


/**
 * Parse a raw workflow (unknown JSON) into API-format Workflow.
 * Handles API format, subgraph format, and UI format.
 * Used by both file-based loading and inline overlay workflow loading.
 */
export function parseWorkflowJson(parsed: unknown, label?: string): Workflow {
  if (isApiFormat(parsed)) {
    return stripWorkflowMetaKeys(parsed);
  }

  const saved = parsed as SavedWorkflowFile;

  if (saved.definitions?.subgraphs?.length) {
    // Flatten only real compositions (multiple top-level nodes or top-level
    // wiring): legacy expansion of a bare single-instance template keeps the
    // inner node ids callers rely on, while a canvas wiring several subgraph
    // instances together must inline all of them, not just one.
    const isComposition =
      (saved.nodes?.length ?? 0) > 1 || (saved.links?.length ?? 0) > 0;
    if (isComposition) {
      // No catch: a WorkflowGraphError (missing subgraph, cycle, dangling
      // link, unconnected output, ...) must reach the user — falling back to
      // single-subgraph expansion here would silently produce the wrong graph.
      const flat = flattenComposedWorkflow(saved);
      if (flat && Object.keys(flat).length > 1) return flat;
    }
    const topNode = saved.nodes?.find((node) => typeof node.type === "string");
    const subgraph =
      saved.definitions?.subgraphs?.find((sg) => sg.id === topNode?.type) ??
      saved.definitions?.subgraphs?.[0];

    if (!subgraph) {
      throw new Error(`No subgraph found in workflow: ${label ?? "inline"}`);
    }

    return subgraphToApiWorkflow(subgraph);
  }

  if (Array.isArray(saved.nodes) && saved.nodes.length > 0) {
    return uiToApiWorkflow(saved);
  }

  throw new Error(`Unrecognized workflow format: ${label ?? "inline"}`);
}

const WORKFLOWS_ROOT = path.join(process.cwd(), "public", "workflows");

export interface WorkflowFallbackSpec {
  /** API-format graph to use instead, relative to public/workflows. */
  file: string;
  /** Logged when the fallback is taken. */
  warning?: string;
}

/**
 * Graph-level fallback: an API graph may carry a top-level
 * `_fallback: { file, warning? }`. When the connected ComfyUI lacks one of
 * the graph's (non-optional) node classes, the fallback graph is loaded
 * instead (one level, no chaining). ComfyUI unreachable: keep the primary.
 */
export async function applyWorkflowFallback(
  parsed: unknown,
  label: string,
  objectInfo?: Record<string, unknown> | null,
): Promise<unknown> {
  const spec = (parsed as { _fallback?: unknown })?._fallback as
    | Partial<WorkflowFallbackSpec>
    | undefined;
  if (!spec || typeof spec.file !== "string" || !spec.file) return parsed;
  const info = objectInfo === undefined ? await getObjectInfoCached() : objectInfo;
  if (!info) return parsed;
  const { prompt } = bypassMissingOptionalNodes(
    stripWorkflowMetaKeys(parsed as Record<string, unknown>),
    info,
  );
  const missing = findMissingClassTypes(prompt, info);
  if (missing.length === 0) return parsed;
  const target = path.resolve(WORKFLOWS_ROOT, spec.file);
  if (!isPathInside(path.resolve(WORKFLOWS_ROOT), target)) return parsed;
  try {
    const fallback = JSON.parse(await fs.readFile(target, "utf-8")) as unknown;
    if (!isApiFormat(fallback)) return parsed;
    console.warn(
      `[workflows] ${path.basename(label)}: ComfyUI lacks ${missing.join(", ")}; using fallback ${spec.file}` +
        (spec.warning ? ` (${spec.warning})` : ""),
    );
    return fallback;
  } catch {
    return parsed; // unreadable fallback: let validation report the primary
  }
}

/** The saved workflow file as stored (UI or API format), for opening in ComfyUI's editor. */
export async function readSavedWorkflowFile(selection: string): Promise<unknown> {
  const prefixed = selection.startsWith("saved:") ? selection : `saved:${selection}`;
  const real = await realSavedWorkflowPath(resolveSavedWorkflowPath(prefixed));
  return JSON.parse(await fs.readFile(real, "utf-8")) as unknown;
}

export async function loadWorkflowFromSelection(
  selection?: string,
): Promise<Workflow> {
  if (!selection) {
    throw new Error("No workflow selection provided");
  }
  if (selection.startsWith("user:")) {
    // Imported user tool (lib/userTools); lazy so this module stays store-free.
    const { loadUserToolSelection } = await import("@/lib/userTools/selection");
    return loadUserToolSelection(selection);
  }

  const resolvedPath = selection.startsWith("saved:")
    ? await realSavedWorkflowPath(resolveSavedWorkflowPath(selection))
    : selection;

  const raw = await fs.readFile(resolvedPath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;

  if (isApiFormat(parsed)) {
    const api = await applyWorkflowFallback(parsed, resolvedPath);
    return stripWorkflowMetaKeys(isApiFormat(api) ? api : parsed);
  }

  const saved = parsed as SavedWorkflowFile;

  if (saved.definitions?.subgraphs?.length) {
    // Flatten only real compositions (multiple top-level nodes or top-level
    // wiring): legacy expansion of a bare single-instance template keeps the
    // inner node ids callers rely on, while a canvas wiring several subgraph
    // instances together must inline all of them, not just one.
    const isComposition =
      (saved.nodes?.length ?? 0) > 1 || (saved.links?.length ?? 0) > 0;
    if (isComposition) {
      // No catch: a WorkflowGraphError (missing subgraph, cycle, dangling
      // link, unconnected output, ...) must reach the user — falling back to
      // single-subgraph expansion here would silently produce the wrong graph.
      const flat = flattenComposedWorkflow(saved);
      if (flat && Object.keys(flat).length > 1) return flat;
    }
    const topNode = saved.nodes?.find((node) => typeof node.type === "string");
    const subgraph =
      saved.definitions?.subgraphs?.find((sg) => sg.id === topNode?.type) ??
      saved.definitions?.subgraphs?.[0];

    if (!subgraph) {
      throw new Error(`No subgraph found in workflow: ${resolvedPath}`);
    }

    return subgraphToApiWorkflow(subgraph);
  }

  if (Array.isArray(saved.nodes) && saved.nodes.length > 0) {
    return uiToApiWorkflow(saved);
  }

  throw new Error(`Unrecognized workflow format: ${resolvedPath}`);
}

// Workflow Metadata Extraction

const KSAMPLER_CLASSES = new Set([
  "KSampler",
  "KSamplerAdvanced",
  "SamplerCustom",
]);

const IMAGE_LOADER_CLASSES = new Set([
  "LoadImage",
  "LoadImageMask",
  "LoadImageFromUrl",
]);

const MASK_CLASSES = new Set(["LoadImageMask", "VAEEncodeForInpaint"]);

const CHECKPOINT_LOADER_CLASSES = new Set([
  "CheckpointLoaderSimple",
  "CheckpointLoader",
  "UNETLoader",
  "UNETLoaderSDXL",
  "UNETLoaderFlux",
]);

const LATENT_CLASSES = new Set([
  "EmptyLatentImage",
  "EmptySD3LatentImage",
  "EmptySDXLLatentImage",
  "EmptyLatentImageFlux",
]);

type WorkflowKind = SavedWorkflowSummary["kind"];

const VIDEO_OUTPUT_CLASSES = new Set([
  "VHS_VideoCombine",
  "SaveAnimatedWEBP",
  "SaveAnimatedPNG",
]);

const MESH_OUTPUT_CLASSES = new Set([
  "SaveGLB",
  "Save3DModel",
  "SaveOBJ",
  "SavePLY",
  "TripoSRSampler",
]);

const AUDIO_OUTPUT_CLASSES = new Set(["SaveAudio", "PreviewAudio"]);

function detectKind(workflow: Workflow): WorkflowKind {
  const classTypes = Object.values(workflow).map((n) => n.class_type);

  const hasMeshOutput = classTypes.some((ct) => MESH_OUTPUT_CLASSES.has(ct));
  if (hasMeshOutput) {
    const hasImageInput = classTypes.some((ct) => IMAGE_LOADER_CLASSES.has(ct));
    return hasImageInput ? "i23d" : "t23d";
  }

  const hasAudioOutput = classTypes.some((ct) => AUDIO_OUTPUT_CLASSES.has(ct));
  if (hasAudioOutput) {
    return "t2a";
  }

  const hasVideoOutput = classTypes.some((ct) => VIDEO_OUTPUT_CLASSES.has(ct));
  if (hasVideoOutput) {
    const hasImageInput = classTypes.some((ct) => IMAGE_LOADER_CLASSES.has(ct));
    return hasImageInput ? "i2v" : "t2v";
  }

  const hasInpaint = classTypes.some(
    (ct) =>
      ct.includes("Inpaint") || ct.includes("inpaint") || MASK_CLASSES.has(ct),
  );
  if (hasInpaint) return "inpaint";

  const hasUpscale = classTypes.some(
    (ct) => ct.includes("Upscale") || ct.includes("ESRGAN"),
  );
  const hasSampler = classTypes.some((ct) => KSAMPLER_CLASSES.has(ct));
  if (hasUpscale && !hasSampler) return "upscale";

  const hasImageInput = classTypes.some((ct) => IMAGE_LOADER_CLASSES.has(ct));
  if (hasImageInput) return "i2i";

  if (hasSampler) return "t2i";

  return "unknown";
}

function extractDefaultParams(workflow: Workflow): WorkflowDefaultParams {
  const params: WorkflowDefaultParams = {};

  for (const node of Object.values(workflow)) {
    if (KSAMPLER_CLASSES.has(node.class_type)) {
      const inp = node.inputs ?? {};
      if (typeof inp.steps === "number") params.steps = inp.steps;
      if (typeof inp.cfg === "number") params.cfg = inp.cfg;
      if (typeof inp.sampler_name === "string")
        params.sampler = inp.sampler_name;
      if (typeof inp.scheduler === "string") params.scheduler = inp.scheduler;
      if (typeof inp.denoise === "number") params.denoise = inp.denoise;
    }

    if (LATENT_CLASSES.has(node.class_type)) {
      const inp = node.inputs ?? {};
      if (typeof inp.width === "number") params.width = inp.width;
      if (typeof inp.height === "number") params.height = inp.height;
    }

    if (CHECKPOINT_LOADER_CLASSES.has(node.class_type)) {
      const inp = node.inputs ?? {};
      const ckpt = inp.ckpt_name ?? inp.model_name ?? inp.unet_name;
      if (typeof ckpt === "string") params.checkpoint = ckpt;
    }
  }

  return params;
}

function analyzeApiWorkflow(workflow: Workflow): {
  kind: WorkflowKind;
  defaultParams: WorkflowDefaultParams;
} {
  return {
    kind: detectKind(workflow),
    defaultParams: extractDefaultParams(workflow),
  };
}

const UNET_LOADER_CLASSES = new Set([
  "UNETLoader",
  "UNETLoaderSDXL",
  "UNETLoaderFlux",
]);

const CHECKPOINT_ONLY_CLASSES = new Set([
  "CheckpointLoaderSimple",
  "CheckpointLoader",
]);

const LORA_CLASSES = new Set(["LoraLoader", "LoraLoaderModelOnly"]);

const VAE_LOADER_CLASSES = new Set(["VAELoader"]);

export function extractCapabilities(workflow: Workflow): WorkflowCapabilities {
  const classTypes = Object.values(workflow).map((n) => n.class_type);

  const hasSampler = classTypes.some((ct) => KSAMPLER_CLASSES.has(ct));
  const hasCheckpoint = classTypes.some((ct) =>
    CHECKPOINT_ONLY_CLASSES.has(ct),
  );
  const hasUnet = classTypes.some((ct) => UNET_LOADER_CLASSES.has(ct));
  const hasVaeLoader = classTypes.some((ct) => VAE_LOADER_CLASSES.has(ct));
  const hasLatentDims = classTypes.some((ct) => LATENT_CLASSES.has(ct));
  const hasImageInput = classTypes.some((ct) => IMAGE_LOADER_CLASSES.has(ct));
  const hasMask = classTypes.some((ct) => MASK_CLASSES.has(ct));
  const hasExistingLoras = classTypes.some((ct) => LORA_CLASSES.has(ct));
  const canAddLoras = hasCheckpoint || hasUnet;

  return {
    kind: detectKind(workflow) ?? "unknown",
    hasSampler,
    loaderType: hasCheckpoint ? "checkpoint" : hasUnet ? "unet" : "none",
    hasVaeLoader,
    hasLatentDims,
    hasImageInput,
    hasMask,
    canAddLoras,
    hasExistingLoras,
    defaults: extractDefaultParams(workflow),
  };
}

/**
 * Convert a saved workflow file to API format for analysis.
 * Returns null if conversion fails.
 */
function savedToApiWorkflow(parsed: SavedWorkflowFile): Workflow | null {
  if (isApiFormat(parsed)) return parsed as unknown as Workflow;

  if (parsed.definitions?.subgraphs?.length) {
    // Prefer full-graph flattening: a top-level canvas that wires several
    // subgraph instances together must inline all of them, not just one. Falls
    // back to legacy single-subgraph expansion for bare subgraph templates.
    try {
      const flat = flattenComposedWorkflow(parsed);
      if (flat && Object.keys(flat).length > 1) return flat;
    } catch {
      // fall through to legacy handling
    }
    const topNode = parsed.nodes?.find((node) => typeof node.type === "string");
    const subgraph =
      parsed.definitions?.subgraphs?.find((sg) => sg.id === topNode?.type) ??
      parsed.definitions?.subgraphs?.[0];
    if (!subgraph) return null;
    try {
      return subgraphToApiWorkflow(subgraph);
    } catch {
      return null;
    }
  }

  if (Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
    try {
      return uiToApiWorkflow(parsed);
    } catch {
      return null;
    }
  }

  return null;
}

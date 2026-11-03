/**
 * Tool packs: a saved user tool exported as a .zip that the workflow importer
 * reads back (Tools > Import workflow). Layout:
 *
 *   adrift-tool.json   manifest: name, icon, category, description, params,
 *                      plus the required models / custom nodes
 *   workflow_api.json  the API-format graph (what extractWorkflow imports)
 *   preview.png        optional cover image
 *   README.txt         human notes: required models and custom nodes
 *
 * Plain ComfyUI users can still load workflow_api.json directly; Adrift sees
 * the manifest and restores the tool's own name, icon and exposed settings
 * instead of re-guessing them.
 *
 * Server-only (zip writer uses zlib).
 */

import type { Workflow } from "@/types";
import { HUB_CATEGORIES, type HubCategory } from "@/lib/tools/hub";
import { isZip, listZipEntries, readZipEntry, writeZip } from "./zip";
import { orderedNodeIds } from "./analyze";
import { validateParams } from "./store";
import {
  USER_TOOL_ICONS,
  type UserToolAnalysis,
  type UserToolOutput,
  type UserToolParam,
  type UserToolRecord,
} from "./types";

export const TOOL_PACK_MANIFEST = "adrift-tool.json";
export const TOOL_PACK_WORKFLOW = "workflow_api.json";
export const TOOL_PACK_README = "README.txt";
export const TOOL_PACK_FORMAT = "adrift-tool-pack";
export const TOOL_PACK_VERSION = 1;

const MODEL_FILE_RE = /\.(safetensors|gguf|ckpt|pt|pth|bin|sft|onnx)$/i;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const OUTPUTS: ReadonlySet<string> = new Set([
  "image",
  "video",
  "audio",
  "mesh",
]);
const ICONS: ReadonlySet<string> = new Set(USER_TOOL_ICONS);

export interface PackModel {
  file: string;
  classType: string;
  input: string;
}

export interface PackCustomNodes {
  /** False when ComfyUI was unreachable at export time. */
  checked: boolean;
  /** Custom node packs (python module) and the node types used from each. */
  packs: { module: string; classTypes: string[] }[];
  /** Node types ComfyUI did not know at export time. */
  unknown: string[];
}

export interface ToolPackManifest {
  format: typeof TOOL_PACK_FORMAT;
  version: number;
  tool: {
    name: string;
    icon: string;
    category: HubCategory;
    description?: string;
    workflowType: string;
    output: UserToolOutput;
    params: UserToolParam[];
  };
  workflow: string;
  preview?: string;
  requires: { models: PackModel[]; customNodes: PackCustomNodes };
}

export interface ToolPackPreview {
  data: Uint8Array;
  /** "png" | "jpg" | "webp" */
  ext: string;
}

type ObjectInfoLike = Record<string, unknown> | null;

/** Model files pinned in the graph (string inputs that look like weights). */
export function packModels(workflow: Workflow): PackModel[] {
  const out: PackModel[] = [];
  const seen = new Set<string>();
  for (const id of orderedNodeIds(workflow)) {
    const node = workflow[id];
    if (!node || typeof node.class_type !== "string") continue;
    for (const [input, v] of Object.entries(node.inputs ?? {})) {
      if (typeof v !== "string" || !MODEL_FILE_RE.test(v)) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      out.push({ file: v, classType: node.class_type, input });
    }
  }
  return out;
}

function isCoreModule(mod: string): boolean {
  return (
    mod === "nodes" ||
    mod.startsWith("comfy_extras") ||
    mod.startsWith("comfy_api_nodes") ||
    mod.startsWith("comfy.")
  );
}

/** Custom node packs the graph needs, from object_info's python_module. */
export function packCustomNodes(
  workflow: Workflow,
  objectInfo: ObjectInfoLike,
): PackCustomNodes {
  const classes = [
    ...new Set(
      Object.values(workflow)
        .map((n) => n?.class_type)
        .filter((c): c is string => typeof c === "string"),
    ),
  ].sort();
  if (!objectInfo) return { checked: false, packs: [], unknown: classes };
  const byModule = new Map<string, string[]>();
  const unknown: string[] = [];
  for (const ct of classes) {
    const def = objectInfo[ct] as { python_module?: unknown } | undefined;
    if (!def || typeof def !== "object") {
      unknown.push(ct);
      continue;
    }
    const mod = typeof def.python_module === "string" ? def.python_module : "";
    if (!mod || isCoreModule(mod)) continue;
    const name = mod.replace(/^custom_nodes\./, "").split(/[./]/)[0] || mod;
    byModule.set(name, [...(byModule.get(name) ?? []), ct]);
  }
  return {
    checked: true,
    packs: [...byModule.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([module, classTypes]) => ({ module, classTypes })),
    unknown,
  };
}

export function buildPackReadme(manifest: ToolPackManifest): string {
  const { tool, requires } = manifest;
  const lines: string[] = [
    tool.name,
    "=".repeat(Math.min(60, tool.name.length || 1)),
    "",
  ];
  if (tool.description) lines.push(tool.description, "");
  lines.push(
    "An Adrift tool pack. To use it in Adrift: Tools > Import workflow, then",
    "choose this .zip. In plain ComfyUI, load workflow_api.json.",
    "",
    "Files",
    `  ${TOOL_PACK_MANIFEST}  tool settings (name, icon, inputs shown)`,
    `  ${manifest.workflow}  ComfyUI workflow (API format)`,
  );
  if (manifest.preview) lines.push(`  ${manifest.preview}  preview image`);
  lines.push(`  ${TOOL_PACK_README}  this file`, "", "Required models");
  if (requires.models.length === 0) lines.push("  None found in the workflow.");
  for (const m of requires.models) {
    lines.push(`  - ${m.file}  (${m.classType} > ${m.input})`);
  }
  lines.push("", "Custom nodes");
  const cn = requires.customNodes;
  if (!cn.checked) {
    lines.push(
      "  Not checked: ComfyUI was not reachable at export time.",
      "  Node types used:",
      ...cn.unknown.map((c) => `  - ${c}`),
    );
  } else {
    if (cn.packs.length === 0 && cn.unknown.length === 0) {
      lines.push("  None. Core ComfyUI nodes only.");
    }
    for (const p of cn.packs) {
      lines.push(`  - ${p.module}: ${p.classTypes.join(", ")}`);
    }
    if (cn.unknown.length > 0) {
      lines.push(
        "  Node types that were missing when this was exported:",
        ...cn.unknown.map((c) => `  - ${c}`),
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function buildToolPackManifest(
  tool: Pick<
    UserToolRecord,
    | "name"
    | "icon"
    | "category"
    | "description"
    | "workflowType"
    | "output"
    | "workflow"
    | "params"
  >,
  opts: { objectInfo?: ObjectInfoLike; previewExt?: string } = {},
): ToolPackManifest {
  const manifest: ToolPackManifest = {
    format: TOOL_PACK_FORMAT,
    version: TOOL_PACK_VERSION,
    tool: {
      name: tool.name,
      icon: tool.icon,
      category: tool.category,
      ...(tool.description ? { description: tool.description } : {}),
      workflowType: tool.workflowType,
      output: tool.output,
      params: tool.params,
    },
    workflow: TOOL_PACK_WORKFLOW,
    requires: {
      models: packModels(tool.workflow),
      customNodes: packCustomNodes(tool.workflow, opts.objectInfo ?? null),
    },
  };
  if (opts.previewExt) manifest.preview = `preview.${opts.previewExt}`;
  return manifest;
}

/** Build the .zip bytes for a saved tool. */
export function buildToolPack(
  tool: Parameters<typeof buildToolPackManifest>[0],
  opts: { objectInfo?: ObjectInfoLike; preview?: ToolPackPreview | null } = {},
): Buffer {
  const preview = opts.preview ?? null;
  const manifest = buildToolPackManifest(tool, {
    objectInfo: opts.objectInfo,
    previewExt: preview?.ext,
  });
  const files: { name: string; data: Uint8Array | string; method?: 0 }[] = [
    { name: TOOL_PACK_MANIFEST, data: JSON.stringify(manifest, null, 2) },
    { name: TOOL_PACK_WORKFLOW, data: JSON.stringify(tool.workflow, null, 2) },
  ];
  if (preview && manifest.preview) {
    files.push({ name: manifest.preview, data: preview.data, method: 0 });
  }
  files.push({ name: TOOL_PACK_README, data: buildPackReadme(manifest) });
  return writeZip(files);
}

/** File name for the download: "<tool-name>.zip", filesystem safe. */
export function toolPackFileName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase()
    .slice(0, 60)
    .replace(/^-|-$/g, "");
  return `${slug || "adrift-tool"}.zip`;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * The tool section of an Adrift pack manifest, or null when the bytes are
 * not a zip, carry no manifest, or the manifest is unreadable. Never throws:
 * a broken manifest just means a plain workflow import.
 */
export function readToolPackManifest(
  bytes: Uint8Array,
): ToolPackManifest | null {
  if (!isZip(bytes)) return null;
  try {
    const entry = listZipEntries(bytes).find(
      (e) => e.name === TOOL_PACK_MANIFEST,
    );
    if (!entry) return null;
    const parsed: unknown = JSON.parse(
      readZipEntry(bytes, entry, {
        maxEntryBytes: MAX_MANIFEST_BYTES,
      }).toString("utf8"),
    );
    if (
      !isObj(parsed) ||
      parsed.format !== TOOL_PACK_FORMAT ||
      typeof parsed.version !== "number" ||
      parsed.version > TOOL_PACK_VERSION ||
      !isObj(parsed.tool)
    ) {
      return null;
    }
    return parsed as unknown as ToolPackManifest;
  } catch {
    return null;
  }
}

/**
 * Restore an exported tool's own settings onto a fresh import analysis.
 * Only the workflow graph comes from the archive's workflow file; each
 * manifest field is used when valid and otherwise the analysis guess stays.
 */
export function applyToolPack(
  analysis: UserToolAnalysis,
  manifest: ToolPackManifest,
): UserToolAnalysis {
  const t = manifest.tool as unknown as Record<string, unknown>;
  const next: UserToolAnalysis = {
    ...analysis,
    suggested: { ...analysis.suggested },
    fromPack: true,
  };
  if (typeof t.name === "string" && t.name.trim()) {
    next.suggested.name = t.name.trim().slice(0, 60);
  }
  if (typeof t.icon === "string" && ICONS.has(t.icon)) {
    next.suggested.icon = t.icon;
  }
  if (
    typeof t.category === "string" &&
    (HUB_CATEGORIES as readonly string[]).includes(t.category)
  ) {
    next.suggested.category = t.category as HubCategory;
  }
  if (typeof t.description === "string" && t.description.trim()) {
    next.suggested.description = t.description.trim().slice(0, 300);
  }
  if (
    typeof t.workflowType === "string" &&
    /^[\w-]{1,24}$/.test(t.workflowType)
  ) {
    next.workflowType = t.workflowType;
  }
  if (typeof t.output === "string" && OUTPUTS.has(t.output)) {
    next.output = t.output as UserToolOutput;
  }
  if (Array.isArray(t.params)) {
    try {
      next.params = validateParams(t.params, analysis.workflow);
    } catch {
      // Params do not fit this graph: keep the discovered ones.
    }
  }
  return next;
}

/**
 * Shared (client + server) types for user tools: ComfyUI workflows a user
 * imported (from a file or Civitai) and saved as their own Adrift tool.
 * Persisted in data/user_tools.json.
 */

import type { Workflow } from "@/types";
import type { HubCategory } from "@/lib/tools/hub";
import type { ModelOverrideCandidate } from "./modelOverrides";

export const USER_TOOLS_SCHEMA_VERSION = 1;

/** Prefix used for user tool keys (Tools page cards) and workflow selections. */
export const USER_TOOL_PREFIX = "user:";

export type UserToolParamKind =
  | "prompt"
  | "negative"
  | "image"
  | "mask"
  | "video"
  | "audio"
  | "seed"
  | "steps"
  | "cfg"
  | "width"
  | "height"
  | "lora_strength"
  | "denoise";

/** Media kinds a param asks the user to supply. */
export const MEDIA_PARAM_KINDS: ReadonlySet<UserToolParamKind> = new Set([
  "image",
  "mask",
  "video",
  "audio",
]);

export interface UserToolParam {
  /** `${nodeId}.${input}` — unique within a tool. */
  key: string;
  nodeId: string;
  input: string;
  kind: UserToolParamKind;
  label: string;
  /** Value in the imported graph (media params: the original file name). */
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  /** Shown in the tool runner. Unexposed params keep the graph value. */
  exposed: boolean;
}

export type UserToolSourceType = "civitai" | "file";

export interface UserToolSource {
  type: UserToolSourceType;
  /** Civitai page URL, when imported from Civitai. */
  url?: string;
  modelId?: number;
  versionId?: number;
  /** File (or archive member) the workflow came from. */
  file?: string;
}

/** Coarse output kind, from detectWorkflowType. */
export type UserToolOutput = "image" | "video" | "audio" | "mesh";

export interface UserToolRecord {
  id: string;
  name: string;
  /** lucide icon name from TOOL_ICONS. */
  icon: string;
  category: HubCategory;
  description?: string;
  /** detectWorkflowType result (t2i, i2i, i2v, …). */
  workflowType: string;
  output: UserToolOutput;
  /** API-format graph. */
  workflow: Workflow;
  params: UserToolParam[];
  source: UserToolSource;
  createdAt: string;
  updatedAt: string;
}

/** What the Tools page / lightbox need — no graph. */
export type UserToolSummary = Omit<UserToolRecord, "workflow">;

export interface UserToolsFile {
  version: number;
  tools: UserToolRecord[];
}

export interface MissingNodeReport {
  classType: string;
  /** Node packs that provide it (ComfyUI-Manager mappings), if known. */
  packs: { id: string; label: string }[];
}

export interface MissingModelReport {
  nodeId: string;
  classType: string;
  input: string;
  file: string;
  /** Civitai model search link for the file. */
  searchUrl: string;
  /** Installed files for this loader input, best stand-in first. */
  candidates?: ModelOverrideCandidate[];
  /** Pre-selected stand-in when the match is confident. */
  suggested?: string | null;
  /** How many files the loader lists in total (candidates may be capped). */
  optionCount?: number;
  /** Detected family of the missing file ("flux1", "sdxl", ...). */
  family?: string | null;
}

export interface UserToolAnalysis {
  workflow: Workflow;
  format: "api" | "ui";
  sourceFile: string;
  otherFiles: string[];
  workflowType: string;
  output: UserToolOutput;
  params: UserToolParam[];
  /** False when ComfyUI was unreachable: missing nodes/models unchecked. */
  checked: boolean;
  missingNodes: MissingNodeReport[];
  missingModels: MissingModelReport[];
  suggested: {
    name: string;
    icon: string;
    category: HubCategory;
    /** From an Adrift tool pack's manifest. */
    description?: string;
  };
  source: UserToolSource;
  /** True when the file was an Adrift tool pack (its settings were restored). */
  fromPack?: boolean;
}

export function userToolKey(id: string): string {
  return `${USER_TOOL_PREFIX}${id}`;
}

export function userToolIdFromKey(key: string): string | null {
  return key.startsWith(USER_TOOL_PREFIX)
    ? key.slice(USER_TOOL_PREFIX.length) || null
    : null;
}

/** True when a tool takes a still image (lightbox / editor can hand one off). */
export function userToolTakesImage(
  tool: Pick<UserToolRecord, "params">,
): boolean {
  return tool.params.some((p) => p.exposed && p.kind === "image");
}

/** Icons offered on the review screen (all present in ToolCover's TOOL_ICONS). */
export const USER_TOOL_ICONS = [
  "Wrench",
  "WandSparkles",
  "Sparkles",
  "Brush",
  "Paintbrush",
  "Palette",
  "Eraser",
  "Expand",
  "Maximize2",
  "Layers",
  "Camera",
  "Film",
  "Clapperboard",
  "Music",
  "Mic",
  "Users",
  "Smile",
  "Box",
  "Zap",
  "Wand",
] as const;

/**
 * True for a workflow selection that names a saved user tool ("user:<id>"),
 * as stored by the Workflows page assignments.
 */
export function isUserToolSelection(selection: unknown): selection is string {
  if (typeof selection !== "string") return false;
  const id = userToolIdFromKey(selection);
  return !!id && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

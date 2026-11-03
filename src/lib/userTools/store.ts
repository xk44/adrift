/**
 * Persistence for user tools: data/user_tools.json
 *   { "version": 1, "tools": [UserToolRecord, ...] }
 *
 * Writes are atomic (temp file + rename) and serialized with a process lock.
 * A missing file reads as empty; a corrupt or newer-schema file is an error
 * so a save never replaces it with a near-empty one.
 *
 * Server-only.
 */

import { randomUUID } from "crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import path from "path";
import type { Workflow } from "@/types";
import {
  HUB_CATEGORIES,
  LEGACY_APPS_CATEGORY,
  LEGACY_APPS_TARGET,
  type HubCategory,
} from "@/lib/tools/hub";
import { isMissingDbError } from "@/lib/jsonDbLoad";
import { withLock } from "@/lib/locks";
import {
  USER_TOOL_ICONS,
  USER_TOOLS_SCHEMA_VERSION,
  type UserToolOutput,
  type UserToolParam,
  type UserToolParamKind,
  type UserToolRecord,
  type UserToolSource,
  type UserToolSummary,
  type UserToolsFile,
} from "./types";
import { adriftDataPath } from "@/lib/paths/resolveDirs";

const LOCK_KEY = "user-tools-file";
export const MAX_USER_TOOLS = 200;
const MAX_NODES = 2000;
const MAX_PARAMS = 64;
const MAX_TOOL_JSON_BYTES = 4 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const PARAM_KINDS: ReadonlySet<UserToolParamKind> = new Set([
  "prompt",
  "negative",
  "image",
  "mask",
  "video",
  "audio",
  "seed",
  "steps",
  "cfg",
  "width",
  "height",
  "lora_strength",
  "denoise",
]);
const OUTPUTS: ReadonlySet<UserToolOutput> = new Set([
  "image",
  "video",
  "audio",
  "mesh",
]);
const ICONS: ReadonlySet<string> = new Set(USER_TOOL_ICONS);

export class UserToolsStoreError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "UserToolsStoreError";
  }
}

export function userToolsPath(): string {
  return (
    process.env.ADRIFT_USER_TOOLS_FILE ||
    adriftDataPath("user_tools.json")
  );
}

export function isValidUserToolId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function readUserToolsFile(
  file = userToolsPath(),
): Promise<UserToolsFile> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (isMissingDbError(err))
      return { version: USER_TOOLS_SCHEMA_VERSION, tools: [] };
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.tools)) {
    throw new UserToolsStoreError(
      "data/user_tools.json is not a user tools file",
      500,
    );
  }
  const version = typeof parsed.version === "number" ? parsed.version : 0;
  if (version > USER_TOOLS_SCHEMA_VERSION) {
    throw new UserToolsStoreError(
      "data/user_tools.json was saved by a newer Adrift. Update Adrift to use these tools.",
      500,
    );
  }
  return {
    version: USER_TOOLS_SCHEMA_VERSION,
    tools: parsed.tools
      .filter(
        (t): t is UserToolRecord => isRecord(t) && isValidUserToolId(t.id),
      )
      // The "Apps" section was split by job; old records land in Scenes.
      .map((t) =>
        (t.category as string) === LEGACY_APPS_CATEGORY
          ? { ...t, category: LEGACY_APPS_TARGET }
          : t,
      ),
  };
}

async function writeUserToolsFile(
  data: UserToolsFile,
  file = userToolsPath(),
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export function summarizeUserTool(tool: UserToolRecord): UserToolSummary {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { workflow, ...rest } = tool;
  return rest;
}

// Validation

function cleanText(
  v: unknown,
  field: string,
  max: number,
  required: boolean,
): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new UserToolsStoreError(`${field} is required`);
    return undefined;
  }
  if (typeof v !== "string")
    throw new UserToolsStoreError(`${field} must be text`);
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!t && required) throw new UserToolsStoreError(`${field} is required`);
  if (t.length > max)
    throw new UserToolsStoreError(
      `${field} must be ${max} characters or fewer`,
    );
  return t || undefined;
}

export function validateWorkflowGraph(v: unknown): Workflow {
  if (!isRecord(v))
    throw new UserToolsStoreError("workflow must be an API-format graph");
  const entries = Object.entries(v);
  if (entries.length === 0)
    throw new UserToolsStoreError("workflow has no nodes");
  if (entries.length > MAX_NODES)
    throw new UserToolsStoreError("workflow has too many nodes");
  for (const [id, node] of entries) {
    if (
      !isRecord(node) ||
      typeof node.class_type !== "string" ||
      !isRecord(node.inputs)
    ) {
      throw new UserToolsStoreError(
        `workflow node ${id.slice(0, 40)} is not an API-format node`,
      );
    }
  }
  return v as unknown as Workflow;
}

function finiteOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function validateParams(
  v: unknown,
  workflow: Workflow,
): UserToolParam[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new UserToolsStoreError("params must be a list");
  if (v.length > MAX_PARAMS) throw new UserToolsStoreError("too many params");
  const seen = new Set<string>();
  const out: UserToolParam[] = [];
  for (const raw of v) {
    if (!isRecord(raw))
      throw new UserToolsStoreError("each param must be an object");
    const nodeId = typeof raw.nodeId === "string" ? raw.nodeId : "";
    const input = typeof raw.input === "string" ? raw.input : "";
    const node = workflow[nodeId];
    if (!node || !(input in (node.inputs ?? {}))) {
      throw new UserToolsStoreError(
        `param ${nodeId}.${input} does not match a node input`,
      );
    }
    const kind = raw.kind as UserToolParamKind;
    if (!PARAM_KINDS.has(kind))
      throw new UserToolsStoreError(
        `param ${nodeId}.${input} has an unknown kind`,
      );
    const key = `${nodeId}.${input}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const param: UserToolParam = {
      key,
      nodeId,
      input,
      kind,
      label: cleanText(raw.label, "param label", 80, false) ?? input,
      exposed: raw.exposed === true,
    };
    if (typeof raw.default === "string")
      param.default = raw.default.slice(0, 20_000);
    else if (typeof raw.default === "number" && Number.isFinite(raw.default))
      param.default = raw.default;
    else if (typeof raw.default === "boolean") param.default = raw.default;
    const min = finiteOrUndef(raw.min);
    const max = finiteOrUndef(raw.max);
    const step = finiteOrUndef(raw.step);
    if (min !== undefined) param.min = min;
    if (max !== undefined) param.max = max;
    if (step !== undefined) param.step = step;
    out.push(param);
  }
  return out;
}

function validateSource(v: unknown): UserToolSource {
  if (!isRecord(v)) return { type: "file" };
  const type = v.type === "civitai" ? "civitai" : "file";
  const src: UserToolSource = { type };
  if (
    typeof v.url === "string" &&
    /^https:\/\//.test(v.url) &&
    v.url.length <= 500
  )
    src.url = v.url;
  const modelId = finiteOrUndef(v.modelId);
  const versionId = finiteOrUndef(v.versionId);
  if (modelId && Number.isInteger(modelId)) src.modelId = modelId;
  if (versionId && Number.isInteger(versionId)) src.versionId = versionId;
  const file = cleanText(v.file, "source file", 200, false);
  if (file) src.file = file;
  return src;
}

function validateCategory(v: unknown): HubCategory {
  if (v === LEGACY_APPS_CATEGORY) return LEGACY_APPS_TARGET;
  if (
    typeof v === "string" &&
    (HUB_CATEGORIES as readonly string[]).includes(v)
  )
    return v as HubCategory;
  throw new UserToolsStoreError(
    `category must be one of: ${HUB_CATEGORIES.join(", ")}`,
  );
}

function validateIcon(v: unknown): string {
  if (v === undefined) return "Wrench";
  if (typeof v === "string" && ICONS.has(v)) return v;
  throw new UserToolsStoreError("icon is not one of the offered icons");
}

export interface UserToolInput {
  name: unknown;
  icon?: unknown;
  category: unknown;
  description?: unknown;
  workflowType?: unknown;
  output?: unknown;
  workflow: unknown;
  params?: unknown;
  source?: unknown;
}

/** Validate a create body into a record (minus id/timestamps). */
export function validateNewUserTool(
  body: UserToolInput,
): Omit<UserToolRecord, "id" | "createdAt" | "updatedAt"> {
  const workflow = validateWorkflowGraph(body.workflow);
  const output = OUTPUTS.has(body.output as UserToolOutput)
    ? (body.output as UserToolOutput)
    : "image";
  const record = {
    name: cleanText(body.name, "name", 60, true)!,
    icon: validateIcon(body.icon),
    category: validateCategory(body.category),
    description: cleanText(body.description, "description", 300, false),
    workflowType:
      cleanText(body.workflowType, "workflowType", 24, false) ?? "unknown",
    output,
    workflow,
    params: validateParams(body.params, workflow),
    source: validateSource(body.source),
  };
  if (!record.description) delete record.description;
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_TOOL_JSON_BYTES) {
    throw new UserToolsStoreError("workflow is too large to save", 413);
  }
  return record;
}

// CRUD

export async function listUserTools(
  file = userToolsPath(),
): Promise<UserToolRecord[]> {
  return (await readUserToolsFile(file)).tools;
}

export async function getUserTool(
  id: string,
  file = userToolsPath(),
): Promise<UserToolRecord | null> {
  if (!isValidUserToolId(id)) return null;
  return (await readUserToolsFile(file)).tools.find((t) => t.id === id) ?? null;
}

export async function createUserTool(
  body: UserToolInput,
  file = userToolsPath(),
  now = new Date(),
): Promise<UserToolRecord> {
  const clean = validateNewUserTool(body);
  return withLock(LOCK_KEY, async () => {
    const data = await readUserToolsFile(file);
    if (data.tools.length >= MAX_USER_TOOLS) {
      throw new UserToolsStoreError(
        `You can save up to ${MAX_USER_TOOLS} tools. Delete one first.`,
        409,
      );
    }
    const stamp = now.toISOString();
    const tool: UserToolRecord = {
      id: randomUUID(),
      ...clean,
      createdAt: stamp,
      updatedAt: stamp,
    };
    data.tools.push(tool);
    await writeUserToolsFile(data, file);
    return tool;
  });
}

export interface UserToolPatch {
  name?: unknown;
  icon?: unknown;
  category?: unknown;
  description?: unknown;
  params?: unknown;
}

export async function updateUserTool(
  id: string,
  patch: UserToolPatch,
  file = userToolsPath(),
  now = new Date(),
): Promise<UserToolRecord | null> {
  if (!isValidUserToolId(id)) return null;
  return withLock(LOCK_KEY, async () => {
    const data = await readUserToolsFile(file);
    const idx = data.tools.findIndex((t) => t.id === id);
    if (idx < 0) return null;
    const cur = data.tools[idx];
    const next: UserToolRecord = { ...cur };
    if (patch.name !== undefined)
      next.name = cleanText(patch.name, "name", 60, true)!;
    if (patch.icon !== undefined) next.icon = validateIcon(patch.icon);
    if (patch.category !== undefined)
      next.category = validateCategory(patch.category);
    if (patch.description !== undefined) {
      const d = cleanText(patch.description, "description", 300, false);
      if (d) next.description = d;
      else delete next.description;
    }
    if (patch.params !== undefined)
      next.params = validateParams(patch.params, cur.workflow);
    next.updatedAt = now.toISOString();
    data.tools[idx] = next;
    await writeUserToolsFile(data, file);
    return next;
  });
}

export async function deleteUserTool(
  id: string,
  file = userToolsPath(),
): Promise<boolean> {
  if (!isValidUserToolId(id)) return false;
  return withLock(LOCK_KEY, async () => {
    const data = await readUserToolsFile(file);
    const before = data.tools.length;
    data.tools = data.tools.filter((t) => t.id !== id);
    if (data.tools.length === before) return false;
    await writeUserToolsFile(data, file);
    return true;
  });
}

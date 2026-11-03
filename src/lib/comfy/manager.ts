import type { Workflow } from "@/types";

import { env } from "@/lib/env";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import {
  matchBlockedPackId,
  partitionBlockedPackIds,
  type BlockMatch,
} from "@/lib/comfy/nodeBlocklist";

export interface MissingNodePackCandidate {
  id: string;
  label: string;
  source: "cnr" | "git" | "unknown";
}

export interface MissingWorkflowNodeReport {
  nodeType: string;
  candidates: MissingNodePackCandidate[];
}

export interface WorkflowRuntimeCompatibility {
  checked: boolean;
  comfyBaseUrl: string;
  managerAvailable: boolean;
  runtimeNodeTypes: number;
  missingNodeTypes: string[];
  missingNodes: MissingWorkflowNodeReport[];
  unambiguousInstallPackIds: string[];
  ambiguousNodeTypes: string[];
  unresolvedNodeTypes: string[];
  error?: string;
}

type CustomNodeMappingValue = [
  string[] | Record<string, string>,
  Record<string, unknown>?,
];
type CustomNodeMappings = Record<string, CustomNodeMappingValue>;

export function getComfyBaseUrl(): string {
  return env.COMFY_HTTP_URL.replace(/\/$/, "");
}

export function getWorkflowNodeTypes(workflow: Workflow): string[] {
  return [...new Set(Object.values(workflow).map((node) => node.class_type))]
    .filter(Boolean)
    .sort();
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await comfyFetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} failed: ${response.status}`);
  return (await response.json()) as T;
}

// Browse: node packs + models catalog (for the Manager tab)

export interface ManagerNodePack {
  id: string;
  title: string;
  author: string;
  description: string;
  reference: string;
  repository: string;
  installType: string;
  state: "not-installed" | "enabled" | "disabled" | "import-failed" | string;
  stars: number;
  lastUpdate: number | string;
  version: string;
  /** true if flagged by the supply-chain blocklist — install is refused */
  blocked: boolean;
  blockRules?: string[];
}

export interface ManagerModel {
  name: string;
  base: string;
  type: string;
  description: string;
  reference: string;
  filename: string;
  savePath: string;
  url: string;
  size: string;
  installed: boolean;
}

interface RawNodePack {
  author?: string;
  description?: string;
  files?: string[];
  install_type?: string;
  reference?: string;
  repository?: string;
  title?: string;
  id?: string;
  state?: string;
  stars?: number;
  last_update?: number | string;
  version?: string;
}

export async function fetchManagerNodePacks(
  comfyBaseUrl = getComfyBaseUrl(),
  mode: "cache" | "local" | "remote" = "cache",
): Promise<ManagerNodePack[]> {
  const data = await fetchJson<{ node_packs?: Record<string, RawNodePack> }>(
    `${comfyBaseUrl}/customnode/getlist?mode=${mode}`,
  );
  const packs = data.node_packs ?? {};
  return Object.entries(packs).map(([id, p]) => {
    const reference =
      p.reference || p.repository || (p.files && p.files[0]) || id;
    const match = matchBlockedPackId(reference) ?? matchBlockedPackId(id);
    return {
      id: p.id || id,
      title: p.title || id,
      author: p.author || "",
      description: p.description || "",
      reference,
      repository: p.repository || reference,
      installType: p.install_type || "git-clone",
      state: p.state || "not-installed",
      stars: typeof p.stars === "number" ? p.stars : -1,
      lastUpdate: p.last_update ?? -1,
      version: p.version || "",
      blocked: Boolean(match),
      blockRules: match?.rules,
    };
  });
}

interface RawModel {
  name?: string;
  base?: string;
  type?: string;
  description?: string;
  reference?: string;
  filename?: string;
  save_path?: string;
  url?: string;
  size?: string;
  installed?: string | boolean;
}

export async function fetchManagerModels(
  comfyBaseUrl = getComfyBaseUrl(),
  mode: "cache" | "local" | "remote" = "cache",
): Promise<ManagerModel[]> {
  const data = await fetchJson<{ models?: RawModel[] }>(
    `${comfyBaseUrl}/externalmodel/getlist?mode=${mode}`,
  );
  const models = data.models ?? [];
  return models.map((m) => ({
    name: m.name || m.filename || "",
    base: m.base || "",
    type: m.type || "",
    description: m.description || "",
    reference: m.reference || "",
    filename: m.filename || "",
    savePath: m.save_path || "",
    url: m.url || "",
    size: m.size || "",
    installed:
      m.installed === true || m.installed === "True" || m.installed === "true",
  }));
}

export async function fetchRuntimeNodeTypes(
  comfyBaseUrl = getComfyBaseUrl(),
): Promise<Set<string>> {
  const objectInfo = await fetchJson<Record<string, unknown>>(
    `${comfyBaseUrl}/object_info`,
  );
  return new Set(Object.keys(objectInfo));
}

export async function fetchCustomNodeMappings(
  comfyBaseUrl = getComfyBaseUrl(),
  mode: "cache" | "local" | "remote" = "cache",
): Promise<CustomNodeMappings> {
  return fetchJson<CustomNodeMappings>(
    `${comfyBaseUrl}/customnode/getmappings?mode=${mode}`,
  );
}

/**
 * Per-request memoized runtime lookups: checking N workflows costs one
 * /object_info and at most one getmappings call instead of N of each.
 */
export interface RuntimeLookups {
  comfyBaseUrl: string;
  nodeTypes: () => Promise<Set<string>>;
  mappings: () => Promise<CustomNodeMappings>;
}

export function createRuntimeLookups(
  comfyBaseUrl = getComfyBaseUrl(),
): RuntimeLookups {
  let nodeTypes: Promise<Set<string>> | undefined;
  let mappings: Promise<CustomNodeMappings> | undefined;
  return {
    comfyBaseUrl,
    nodeTypes: () => (nodeTypes ??= fetchRuntimeNodeTypes(comfyBaseUrl)),
    mappings: () => (mappings ??= fetchCustomNodeMappings(comfyBaseUrl)),
  };
}

/** Result for a workflow that could not be checked at all. */
export function uncheckedRuntime(
  comfyBaseUrl: string,
  error: string,
): WorkflowRuntimeCompatibility {
  return {
    checked: false,
    comfyBaseUrl,
    managerAvailable: false,
    runtimeNodeTypes: 0,
    missingNodeTypes: [],
    missingNodes: [],
    unambiguousInstallPackIds: [],
    ambiguousNodeTypes: [],
    unresolvedNodeTypes: [],
    error,
  };
}

function mappingNodeTypes(value: CustomNodeMappingValue): string[] {
  const rawNodes = value?.[0];
  if (Array.isArray(rawNodes))
    return rawNodes.filter((item) => typeof item === "string");
  if (rawNodes && typeof rawNodes === "object") return Object.values(rawNodes);
  return [];
}

function candidateSource(id: string): MissingNodePackCandidate["source"] {
  if (id.startsWith("http://") || id.startsWith("https://")) return "git";
  if (/^[a-z0-9][a-z0-9_.-]*$/i.test(id)) return "cnr";
  return "unknown";
}

function candidateLabel(
  id: string,
  metadata?: Record<string, unknown>,
): string {
  const title = metadata?.title;
  if (typeof title === "string" && title.trim()) return title.trim();
  if (id.startsWith("https://github.com/"))
    return id.replace("https://github.com/", "");
  if (id.startsWith("http://github.com/"))
    return id.replace("http://github.com/", "");
  return id;
}

export function resolveMissingNodePacks(
  missingNodeTypes: string[],
  mappings: CustomNodeMappings,
): MissingWorkflowNodeReport[] {
  return missingNodeTypes.map((nodeType) => {
    const candidates = Object.entries(mappings)
      .filter(([, value]) => mappingNodeTypes(value).includes(nodeType))
      .map(([id, value]) => ({
        id,
        label: candidateLabel(id, value[1]),
        source: candidateSource(id),
      }))
      .sort((a, b) => {
        const sourceRank = { cnr: 0, git: 1, unknown: 2 } as const;
        return (
          sourceRank[a.source] - sourceRank[b.source] ||
          a.label.localeCompare(b.label)
        );
      });
    return { nodeType, candidates };
  });
}

export function summarizeInstallCandidates(
  reports: MissingWorkflowNodeReport[],
) {
  const unambiguous = reports
    .filter((report) => report.candidates.length === 1)
    .map((report) => report.candidates[0].id);
  const ambiguousNodeTypes = reports
    .filter((report) => report.candidates.length > 1)
    .map((report) => report.nodeType);
  const unresolvedNodeTypes = reports
    .filter((report) => report.candidates.length === 0)
    .map((report) => report.nodeType);
  return {
    unambiguousInstallPackIds: [...new Set(unambiguous)].sort(),
    ambiguousNodeTypes,
    unresolvedNodeTypes,
  };
}

export async function classifyWorkflowRuntimeCompatibility(
  workflow: Workflow,
  options?: {
    comfyBaseUrl?: string;
    runtimeNodeTypes?: Set<string>;
    mappings?: CustomNodeMappings;
    /** Shared memoized lookups (see createRuntimeLookups) */
    lookups?: RuntimeLookups;
  },
): Promise<WorkflowRuntimeCompatibility> {
  const comfyBaseUrl =
    options?.comfyBaseUrl ?? options?.lookups?.comfyBaseUrl ?? getComfyBaseUrl();
  try {
    const runtimeNodeTypes =
      options?.runtimeNodeTypes ??
      (options?.lookups
        ? await options.lookups.nodeTypes()
        : await fetchRuntimeNodeTypes(comfyBaseUrl));
    const nodeTypes = getWorkflowNodeTypes(workflow);
    const missingNodeTypes = nodeTypes.filter(
      (nodeType) => !runtimeNodeTypes.has(nodeType),
    );

    let managerAvailable = false;
    let missingNodes: MissingWorkflowNodeReport[] = missingNodeTypes.map(
      (nodeType) => ({
        nodeType,
        candidates: [],
      }),
    );

    if (missingNodeTypes.length > 0) {
      try {
        const mappings =
          options?.mappings ??
          (options?.lookups
            ? await options.lookups.mappings()
            : await fetchCustomNodeMappings(comfyBaseUrl));
        missingNodes = resolveMissingNodePacks(missingNodeTypes, mappings);
        managerAvailable = true;
      } catch {
        managerAvailable = false;
      }
    } else {
      managerAvailable = true;
    }

    const candidateSummary = summarizeInstallCandidates(missingNodes);
    return {
      checked: true,
      comfyBaseUrl,
      managerAvailable,
      runtimeNodeTypes: runtimeNodeTypes.size,
      missingNodeTypes,
      missingNodes,
      ...candidateSummary,
    };
  } catch (error) {
    return {
      checked: false,
      comfyBaseUrl,
      managerAvailable: false,
      runtimeNodeTypes: 0,
      missingNodeTypes: [],
      missingNodes: [],
      unambiguousInstallPackIds: [],
      ambiguousNodeTypes: [],
      unresolvedNodeTypes: [],
      error:
        error instanceof Error
          ? error.message
          : "Failed to inspect ComfyUI runtime",
    };
  }
}

export async function queueComfyManagerInstall(
  packIds: string[],
  options?: { comfyBaseUrl?: string; clientId?: string },
) {
  const comfyBaseUrl = options?.comfyBaseUrl ?? getComfyBaseUrl();
  const clientId = options?.clientId ?? "adrift-workflow-page";
  const queued: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  // SECURITY: refuse any pack flagged by the supply-chain sweep BEFORE it ever
  // reaches ComfyUI-Manager. This is the single install choke point — both the
  // workflow missing-node path and the Manager tab funnel through here.
  const uniqueIds = [...new Set(packIds)].filter(Boolean);
  const { allowed, blocked } = partitionBlockedPackIds(uniqueIds);
  for (const b of blocked) {
    failed.push({
      id: b.packId,
      error: `Blocked: "${b.slug}" is on the supply-chain blocklist (${b.rules.join(", ") || "flagged"}). A human must clear it after re-auditing.`,
    });
  }

  for (const id of allowed) {
    const uiId = `adrift-install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body = {
      ui_id: uiId,
      client_id: clientId,
      kind: "install",
      params: {
        id,
        version: "unknown",
        selected_version: "latest",
        mode: "cache",
        channel: "default",
        skip_post_install: false,
      },
    };
    try {
      const response = await comfyFetch("/manager/queue/install", {
        baseUrl: comfyBaseUrl,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        failed.push({ id, error: text || `HTTP ${response.status}` });
      } else {
        queued.push(id);
      }
    } catch (error) {
      failed.push({
        id,
        error: error instanceof Error ? error.message : "Request failed",
      });
    }
  }

  if (queued.length > 0) {
    // New Manager queue model: install only enqueues; start executes.
    // 200 = started, 201 = worker already running; both fine.
    try {
      await comfyFetch("/manager/queue/start", {
        baseUrl: comfyBaseUrl,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } catch {
      // queue kick failure is non-fatal; Manager UI can start it manually
    }
  }

  return { queued, failed, blocked, comfyBaseUrl };
}

export type { BlockMatch };

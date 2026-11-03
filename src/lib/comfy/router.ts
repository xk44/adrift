/**
 * Per-job machine routing across the configured ComfyUI backends
 * (backends.ts lists them; routingSettings.ts holds the preferences).
 *
 * Modes, per submission:
 *  - pinned: the job's tool key (tool id / action / pack) is pinned to an
 *    enabled machine -> that machine only, no failover ("always run X on Y").
 *  - auto (Settings toggle): the role candidates (backends.ts
 *    routeCandidates) are filtered by capability against the actual graph -
 *    every class_type in that machine's /object_info, every model file in its
 *    loader lists (after the optional-node bypass and precision-sibling
 *    fallback queuePrompt would apply), device class (fp8 diffusion weights
 *    cannot load on Apple MPS) and a memory ceiling - then the reachable ones
 *    are ranked by priority - (running + pending). Ties keep list order.
 *  - legacy (auto off, no pin): the caller's backend, exactly as before.
 *
 * Failover: a submission that provably never reached ComfyUI (connection
 * refused / unknown host / input staging failed; ComfyAPIError
 * extra.notSent) moves to the next ranked machine. Anything that may have
 * been accepted (timeout, reset after connecting, HTTP rejection) is thrown,
 * never resubmitted.
 *
 * Uploads / outputs: queuePrompt already tags outputs with the target's
 * marker subfolder and stages annotated input refs onto the target, keyed by
 * the base URL actually used, so a failover re-stages onto the new machine.
 *
 * Server-side only.
 */
import type { ComfyQueueResult, JobBackend, Workflow } from "@/types";
import {
  backendIdForUrl,
  defaultBackendUrl,
  fetchQueueCounts,
  findBackend,
  hasMultipleBackends,
  listBackends,
  routeCandidates,
  type BackendInstance,
  type QueueCounts,
  type RouteInput,
} from "@/lib/comfy/backends";
import { readRuntimeSettings } from "@/lib/runtimeSettings";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import { validatePrompt, comboOptions } from "@/lib/comfy/validatePrompt";
import { swapModelVariants } from "@/lib/comfy/modelVariants";
import { bypassMissingOptionalNodes } from "@/lib/comfy/optionalNodes";
import {
  estimatePackMemoryGb,
  parseSystemStats,
  type MemorySnapshot,
} from "@/lib/comfy/memory";
import {
  ComfyAPIError,
  queuePrompt,
  type QueuePromptOptions,
} from "@/lib/comfy/http";
import type { ComfyRoutingSetting } from "@/lib/comfy/routingSettings";

const trimSlash = (u: string) => u.replace(/\/+$/, "");

export interface RouteRequest extends RouteInput {
  /** Tool id (Tools hub); checked first for a pin. */
  tool?: string;
}

export interface InstanceHealth {
  reachable: boolean;
  queue: QueueCounts | null;
  device: MemorySnapshot | null;
  checkedAt: number;
}

export interface CapabilityReport {
  ok: boolean;
  missingNodes: string[];
  missingModels: string[];
  deviceIssues: string[];
  /** Soft penalty (memory tighter than the pack estimate). */
  penalty: number;
}

export interface RankedInstance {
  instance: BackendInstance;
  health: InstanceHealth;
  capability: CapabilityReport | null;
  priority: number;
  load: number;
  score: number;
  /** Why it was left out; undefined = eligible. */
  excluded?: string;
}

export interface RouteTarget {
  instance: BackendInstance;
  /** Base URL to submit to (the warm H3 process stands in for main). */
  url: string;
}

export interface RoutePlan {
  mode: "single" | "legacy" | "pinned" | "auto";
  targets: RouteTarget[];
  considered: RankedInstance[];
  notes: string[];
}

export interface RouterDeps {
  objectInfo(
    url: string,
    fresh: boolean,
  ): Promise<Record<string, unknown> | null>;
  health(url: string): Promise<InstanceHealth>;
  queue: typeof queuePrompt;
  now(): number;
  log(msg: string): void;
}

// Settings

export function readRouting(): ComfyRoutingSetting {
  try {
    return readRuntimeSettings().comfyRouting ?? {};
  } catch {
    return {};
  }
}

export function autoRouteEnabled(): boolean {
  return readRouting().auto === true;
}

function packFromPath(workflowPath: string | undefined): string | undefined {
  return workflowPath
    ?.replace(/\\/g, "/")
    .match(/(?:^|\/)packs\/([^/]+)\//)?.[1];
}

/** Pin lookup keys, most specific first. */
export function pinKeys(route: RouteRequest): string[] {
  const keys = [
    route.tool,
    route.action,
    packFromPath(route.workflowPath),
    route.packId,
  ].filter((k): k is string => typeof k === "string" && k !== "");
  return [...new Set(keys.map((k) => k.toLowerCase()))];
}

/** The enabled machine this job is pinned to, if any. */
export function resolvePin(
  route: RouteRequest,
  routing: ComfyRoutingSetting,
  backends: BackendInstance[],
): { instance?: BackendInstance; key?: string; stale?: string } {
  const pins = routing.pins ?? {};
  for (const key of pinKeys(route)) {
    const target = pins[key];
    if (!target) continue;
    const hit = backends.find((b) => b.settingsId === target && b.enabled);
    if (hit) return { instance: hit, key };
    return { key, stale: target };
  }
  return {};
}

// Capability

const LOADER_FILE_INPUTS = new Set([
  "unet_name",
  "ckpt_name",
  "model_name",
  "model_path",
]);
const FP8_RE = /fp8|float8|e4m3|e5m2/i;

/** Diffusion weights in the graph that are fp8 (text encoders excluded). */
export function fp8DiffusionWeights(workflow: Workflow): string[] {
  const out: string[] = [];
  for (const node of Object.values(workflow)) {
    const inputs = node?.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;
    for (const [k, v] of Object.entries(inputs)) {
      if (typeof v !== "string" || /\.gguf$/i.test(v)) continue;
      if (LOADER_FILE_INPUTS.has(k) && FP8_RE.test(v)) out.push(v);
    }
    const dtype = inputs.weight_dtype;
    if (
      typeof dtype === "string" &&
      FP8_RE.test(dtype) &&
      node?.class_type === "UNETLoader"
    )
      out.push(`${String(inputs.unet_name ?? "unet")} (${dtype})`);
  }
  return [...new Set(out)];
}

/**
 * Can this machine run `workflow`? Pure: object_info + device snapshot.
 * Graph errors that are the same everywhere (bad links, missing inputs)
 * are not capability problems and are left to validation at submit.
 */
export function checkCapability(
  workflow: Workflow,
  info: Record<string, unknown>,
  device: MemorySnapshot | null,
  opts: { memoryGb?: number } = {},
): CapabilityReport {
  const mps = device?.deviceType === "mps";
  const base = bypassMissingOptionalNodes(workflow, info).prompt;
  const graph = swapModelVariants(base, info, { noFp8: mps }).prompt;
  // MPS: files that exist only as fp8 siblings are a device problem, not a
  // missing download.
  const fp8Only = new Map<string, string>();
  if (mps)
    for (const sw of swapModelVariants(base, info).swaps)
      if (FP8_RE.test(sw.to)) fp8Only.set(`${sw.nodeId}.${sw.input}`, sw.to);
  const missingNodes = new Set<string>();
  const missingModels = new Set<string>();
  const fp8 = new Set<string>(mps ? fp8DiffusionWeights(graph) : []);
  for (const p of validatePrompt(graph, info)) {
    if (p.kind === "unknown_class_type") {
      missingNodes.add(p.classType ?? p.nodeTitle);
    } else if (p.kind === "invalid_combo_value" && p.input) {
      const sibling = fp8Only.get(`${p.nodeId}.${p.input}`);
      if (sibling) {
        fp8.add(sibling);
        continue;
      }
      const v = (graph[p.nodeId]?.inputs as Record<string, unknown> | undefined)?.[p.input];
      missingModels.add(typeof v === "string" ? v : `${p.nodeTitle}.${p.input}`);
    }
  }
  const deviceIssues: string[] = [];
  if (fp8.size > 0)
    deviceIssues.push(`fp8 weights cannot load on Apple MPS (${[...fp8].join(", ")})`);
  let penalty = 0;
  if (opts.memoryGb && device && device.capacityGb > 0) {
    // Discrete GPUs offload to system RAM (slow but runs); unified cannot.
    const ceiling = device.unified
      ? device.capacityGb
      : device.capacityGb + device.ramTotalGb;
    if (opts.memoryGb > ceiling) {
      deviceIssues.push(
        `needs ~${opts.memoryGb} GB, machine has ~${Math.round(ceiling)} GB`,
      );
    } else if (opts.memoryGb > device.capacityGb) {
      penalty = 2;
    }
  }
  return {
    ok:
      missingNodes.size === 0 &&
      missingModels.size === 0 &&
      deviceIssues.length === 0,
    missingNodes: [...missingNodes],
    missingModels: [...missingModels],
    deviceIssues,
    penalty,
  };
}

export function describeCapability(r: CapabilityReport): string {
  const parts: string[] = [];
  if (r.missingNodes.length)
    parts.push(`missing nodes: ${r.missingNodes.slice(0, 4).join(", ")}`);
  if (r.missingModels.length)
    parts.push(`missing files: ${r.missingModels.slice(0, 4).join(", ")}`);
  parts.push(...r.deviceIssues);
  return parts.join("; ");
}

// Caches (per base URL)

const INFO_TTL_MS = 5 * 60_000;
const INFO_FRESH_MIN_MS = 30_000;
const HEALTH_TTL_MS = 4000;
const infoCache = new Map<
  string,
  { at: number; data: Record<string, unknown> }
>();
const healthCache = new Map<string, InstanceHealth>();
const deviceCache = new Map<string, MemorySnapshot>();

async function defaultObjectInfo(
  url: string,
  fresh: boolean,
): Promise<Record<string, unknown> | null> {
  const hit = infoCache.get(url);
  if (!fresh && hit && Date.now() - hit.at < INFO_TTL_MS) return hit.data;
  if (fresh && hit && Date.now() - hit.at < INFO_FRESH_MIN_MS) return hit.data;
  const data = await getObjectInfoCached(url, { fresh: true });
  if (data) infoCache.set(url, { at: Date.now(), data });
  return data ?? hit?.data ?? null;
}

async function defaultHealth(url: string): Promise<InstanceHealth> {
  const hit = healthCache.get(url);
  if (hit && Date.now() - hit.checkedAt < HEALTH_TTL_MS) return hit;
  let device: MemorySnapshot | null = deviceCache.get(url) ?? null;
  let reachable = false;
  try {
    const res = await comfyFetch("/system_stats", {
      baseUrl: url,
      signal: AbortSignal.timeout(1500),
    });
    reachable = res.ok;
    if (res.ok) {
      const parsed = parseSystemStats(await res.json());
      if (parsed) {
        device = parsed;
        deviceCache.set(url, parsed);
      }
    }
  } catch {
    reachable = false;
  }
  const queue = reachable ? await fetchQueueCounts(url, 1500) : null;
  const out = { reachable, queue, device, checkedAt: Date.now() };
  healthCache.set(url, out);
  return out;
}

const defaultDeps: RouterDeps = {
  objectInfo: defaultObjectInfo,
  health: defaultHealth,
  queue: queuePrompt,
  now: () => Date.now(),
  log: (msg) => console.info(`[router] ${msg}`),
};

/** Forget cached object_info / health (one machine by base URL, or all). */
export function clearRouterCaches(url?: string): void {
  if (url) {
    const u = trimSlash(url);
    infoCache.delete(u);
    healthCache.delete(u);
    deviceCache.delete(u);
    return;
  }
  infoCache.clear();
  healthCache.clear();
  deviceCache.clear();
}

export function objectInfoCachedAt(url: string): number | null {
  return infoCache.get(trimSlash(url))?.at ?? null;
}

// Planning

function priorityOf(b: BackendInstance, routing: ComfyRoutingSetting): number {
  return routing.priorities?.[b.settingsId] ?? 0;
}

/**
 * Rank machines for a graph: capable + reachable first by score
 * (priority - load - memory penalty), ties in list order; excluded ones
 * carry the reason.
 */
export async function rankInstances(
  workflow: Workflow,
  candidates: BackendInstance[],
  routing: ComfyRoutingSetting,
  opts: { memoryGb?: number; deps?: Partial<RouterDeps> } = {},
): Promise<RankedInstance[]> {
  const deps = { ...defaultDeps, ...opts.deps };
  const rows = await Promise.all(
    candidates.map(async (instance): Promise<RankedInstance> => {
      const health = await deps.health(instance.url);
      const priority = priorityOf(instance, routing);
      const load = health.queue
        ? health.queue.running + health.queue.pending
        : 0;
      const row: RankedInstance = {
        instance,
        health,
        capability: null,
        priority,
        load,
        score: priority - load,
      };
      if (!health.reachable) return { ...row, excluded: "offline" };
      let info = await deps.objectInfo(instance.url, false);
      if (!info) return row; // can't check: let validation at submit decide
      let cap = checkCapability(workflow, info, health.device, opts);
      if (!cap.ok && !cap.deviceIssues.length) {
        // A model/node installed since the cached snapshot must not be missed.
        const fresh = await deps.objectInfo(instance.url, true);
        if (fresh && fresh !== info) {
          info = fresh;
          cap = checkCapability(workflow, info, health.device, opts);
        }
      }
      row.capability = cap;
      row.score -= cap.penalty;
      return cap.ok ? row : { ...row, excluded: describeCapability(cap) };
    }),
  );
  const index = new Map(candidates.map((c, i) => [c.id, i]));
  return rows.sort((a, b) => {
    if (!!a.excluded !== !!b.excluded) return a.excluded ? 1 : -1;
    if (a.score !== b.score) return b.score - a.score;
    return index.get(a.instance.id)! - index.get(b.instance.id)!;
  });
}

function targetFor(
  instance: BackendInstance,
  preferredUrl: string | undefined,
): RouteTarget {
  // backendForPack may hand main's H3 jobs to the same-machine warm process;
  // keep that when main is the pick.
  if (
    instance.primary &&
    preferredUrl &&
    trimSlash(preferredUrl) !== instance.url &&
    backendIdForUrl(preferredUrl) === instance.id &&
    !listBackends().some((b) => b.url === trimSlash(preferredUrl))
  )
    return { instance, url: trimSlash(preferredUrl) };
  return { instance, url: instance.url };
}

function legacyTarget(preferredUrl: string | undefined): RouteTarget {
  const url = trimSlash(preferredUrl ?? defaultBackendUrl());
  const instance = findBackend(backendIdForUrl(url)) ?? listBackends()[0];
  return { instance, url };
}

/** Where (in order) a job should be submitted. */
export async function planRoute(
  workflow: Workflow,
  route: RouteRequest,
  preferredUrl?: string,
  deps: Partial<RouterDeps> = {},
): Promise<RoutePlan> {
  const backends = listBackends();
  if (backends.length < 2)
    return {
      mode: "single",
      targets: [legacyTarget(preferredUrl)],
      considered: [],
      notes: [],
    };
  const routing = readRouting();
  const notes: string[] = [];
  const pin = resolvePin(route, routing, backends);
  if (pin.instance)
    return {
      mode: "pinned",
      targets: [targetFor(pin.instance, preferredUrl)],
      considered: [],
      notes,
    };
  if (pin.stale)
    notes.push(
      `Pinned machine "${pin.stale}" for ${pin.key} is missing or disabled; routing normally.`,
    );
  if (routing.auto !== true)
    return {
      mode: "legacy",
      targets: [legacyTarget(preferredUrl)],
      considered: [],
      notes,
    };

  const memoryGb = route.packId
    ? estimatePackMemoryGb(route.packId)
    : undefined;
  const ranked = await rankInstances(
    workflow,
    routeCandidates(route),
    routing,
    {
      memoryGb,
      deps,
    },
  );
  const eligible = ranked.filter((r) => !r.excluded);
  if (eligible.length === 0) {
    const why = ranked
      .map((r) => `${r.instance.name}: ${r.excluded}`)
      .join("; ");
    notes.push(`No machine passed the capability check (${why}).`);
    return {
      mode: "auto",
      targets: [legacyTarget(preferredUrl)],
      considered: ranked,
      notes,
    };
  }
  return {
    mode: "auto",
    targets: eligible.map((r) => targetFor(r.instance, preferredUrl)),
    considered: ranked,
    notes,
  };
}

// Submission

export function isNotSentError(error: unknown): boolean {
  return error instanceof ComfyAPIError && error.extra?.notSent === true;
}

export type RoutedQueueResult = ComfyQueueResult & {
  backend?: JobBackend;
  route?: { mode: RoutePlan["mode"]; failedOver: string[] };
};

/**
 * queuePrompt with per-job routing + failover (see the file header). The
 * result carries the machine that accepted the prompt (multi-host only).
 */
export async function queuePromptRouted(
  workflow: Workflow,
  clientId: string,
  preferredUrl: string | undefined,
  route: RouteRequest,
  opts: QueuePromptOptions = {},
  deps: Partial<RouterDeps> = {},
): Promise<RoutedQueueResult> {
  const d = { ...defaultDeps, ...deps };
  const plan = await planRoute(workflow, route, preferredUrl, deps);
  for (const n of plan.notes) d.log(n);
  const failedOver: string[] = [];
  for (let i = 0; i < plan.targets.length; i++) {
    const t = plan.targets[i];
    try {
      const graph = JSON.parse(JSON.stringify(workflow)) as Workflow;
      // single / legacy: exactly the caller's URL (undefined = main), as before.
      const submitUrl =
        plan.mode === "single" || plan.mode === "legacy" ? preferredUrl : t.url;
      const result = await d.queue(graph, clientId, submitUrl, opts);
      if (plan.mode === "single") return result;
      // Count it against the cached queue so a batch spreads across machines.
      const h = healthCache.get(t.instance.url);
      if (h?.queue) h.queue = { ...h.queue, pending: h.queue.pending + 1 };
      const warnings = [...(result.warnings ?? [])];
      if (failedOver.length > 0)
        warnings.push(
          `${failedOver.join(", ")} offline; ran on ${t.instance.name}.`,
        );
      return {
        ...result,
        ...(warnings.length ? { warnings } : {}),
        backend: { id: t.instance.id, name: t.instance.name },
        route: { mode: plan.mode, failedOver },
      };
    } catch (error) {
      if (i < plan.targets.length - 1 && isNotSentError(error)) {
        d.log(
          `${t.instance.name} (${t.url}) did not take the job (${
            error instanceof Error ? error.message : String(error)
          }); trying ${plan.targets[i + 1].instance.name}`,
        );
        failedOver.push(t.instance.name);
        healthCache.delete(t.url);
        continue;
      }
      throw error;
    }
  }
  // Unreachable: targets is never empty.
  throw new ComfyAPIError("No ComfyUI machine available", 503);
}

/**
 * Run params after acceptance: `comfy_backend` (the client polls history for
 * non-main machines) follows the machine that actually took the job.
 */
export function applyJobBackend<P extends Record<string, unknown>>(
  params: P,
  backend: JobBackend | undefined,
): P {
  if (!backend) return params;
  const { comfy_backend: _prev, ...rest } = params as Record<string, unknown>;
  void _prev;
  return (backend.id === "default" ? rest : { ...rest, comfy_backend: backend.id }) as P;
}

/** JobBackend for a base URL (multi-host only), for routes that queue directly. */
export function jobBackendForUrl(
  url: string | undefined,
): JobBackend | undefined {
  if (!hasMultipleBackends()) return undefined;
  const b = findBackend(backendIdForUrl(url));
  return b ? { id: b.id, name: b.name } : undefined;
}

// Status (settings UI)

export interface RoutingInstanceStatus {
  id: string;
  name: string;
  enabled: boolean;
  online: boolean;
  queue: QueueCounts | null;
  device: {
    type: string;
    name?: string;
    memoryGb: number;
    unified: boolean;
  } | null;
  nodes: number | null;
  models: number | null;
  infoAt: number | null;
  priority: number;
}

/** Distinct model-file options across loader-style inputs. */
export function countModelFiles(info: Record<string, unknown>): number {
  const files = new Set<string>();
  for (const node of Object.values(info)) {
    const req = (node as { input?: { required?: Record<string, unknown> } })
      ?.input?.required;
    if (!req) continue;
    for (const [name, spec] of Object.entries(req)) {
      if (!/_name$|^model$|_path$/.test(name) || !Array.isArray(spec)) continue;
      for (const o of comboOptions(spec) ?? [])
        if (
          typeof o === "string" &&
          /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx)$/i.test(o)
        )
          files.add(o);
    }
  }
  return files.size;
}

export async function routingStatus(
  opts: { refresh?: boolean; deps?: Partial<RouterDeps> } = {},
): Promise<RoutingInstanceStatus[]> {
  const deps = { ...defaultDeps, ...opts.deps };
  const routing = readRouting();
  if (opts.refresh) clearRouterCaches();
  return Promise.all(
    listBackends().map(async (b) => {
      const health = await deps.health(b.url);
      const info = health.reachable
        ? await deps.objectInfo(b.url, !!opts.refresh)
        : null;
      return {
        id: b.settingsId,
        name: b.name,
        enabled: b.enabled,
        online: health.reachable,
        queue: health.queue,
        device: health.device
          ? {
              type: health.device.deviceType,
              name: health.device.deviceName,
              memoryGb: Math.round(health.device.capacityGb),
              unified: health.device.unified,
            }
          : null,
        nodes: info ? Object.keys(info).length : null,
        models: info ? countModelFiles(info) : null,
        infoAt: objectInfoCachedAt(b.url),
        priority: priorityOf(b, routing),
      };
    }),
  );
}

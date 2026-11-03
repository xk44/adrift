/**
 * Multi-host ComfyUI routing over N backends ("instances"):
 *  - "default": the main connection (COMFY_HTTP_URL / the saved wizard
 *    connection, plus the optional same-machine H3 warm process);
 *  - "video": the env-configured second host (COMFY_VIDEO_HTTP_URL), e.g.
 *    image tools on one machine and H3 video actions on a CUDA box;
 *  - any extra machines saved in Settings (runtime_settings.json
 *    `comfyInstances`), each with a role: all / image / video.
 *
 * Routing: video actions/packs (the table below) go to enabled role-"video"
 * instances (else role-"all"); everything else to role "image"/"all". Several
 * candidates -> the least busy by /queue (unreachable skipped, ties -> list
 * order); one candidate -> no probe at all.
 *
 * One backend configured = single-host behaviour, unchanged: every helper
 * here returns the default backend / no-ops.
 *
 * The machines share no filesystem, so:
 *  - Outputs: jobs sent to a non-main backend get every `filename_prefix`
 *    prefixed with its marker subfolder (env video: COMFY_VIDEO_OUTPUT_SUBFOLDER,
 *    default "adrift-video"; saved machines: "adrift-<id>"), so their /view
 *    refs carry the marker and /api/comfy/image can route the fetch to the
 *    right host without a lookup table. The main backend stays unprefixed.
 *  - Inputs: annotated refs ("sub/name.png [input|output|temp]") that live on
 *    the other host are copied over (GET /view there → POST /upload/image on
 *    the target) and rewritten before queueing.
 *
 * Cross-host GPU mutex (env COMFY_EXCLUSIVE_BACKENDS, else the saved
 * setting, else on only when an env video backend is configured): every
 * enabled host sits on one breaker, so before queueing to one host every
 * other host's /queue must be empty (main + warm count as one group). Submissions are
 * serialised in-process; the wait polls /queue until idle or times out.
 *
 * Server-side only.
 */
import type { Workflow } from "@/types";
import { env } from "@/lib/env";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import { uploadMimeType } from "@/lib/comfy/uploadName";
import {
  readRuntimeSettings,
  type ComfyInstanceRole,
} from "@/lib/runtimeSettings";

/** "default" (main), "video" (env second host) or a saved instance id. */
export type BackendId = string;
export const DEFAULT_BACKEND: BackendId = "default";

const trimSlash = (u: string) => u.replace(/\/+$/, "");

function envFlag(value: string | undefined): boolean | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) return undefined;
  if (["1", "true", "on", "yes"].includes(v)) return true;
  if (["0", "false", "off", "no"].includes(v)) return false;
  return undefined;
}

function envList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Second ComfyUI base URL (no trailing slash), or undefined = single host. */
export function videoBackendUrl(): string | undefined {
  const raw = process.env.COMFY_VIDEO_HTTP_URL?.trim();
  return raw ? trimSlash(raw) : undefined;
}

export function hasVideoBackend(): boolean {
  return videoBackendUrl() !== undefined;
}

export function defaultBackendUrl(): string {
  // `?? ""`: partial env mocks in tests; the real env always has a default.
  return trimSlash(env.COMFY_HTTP_URL ?? "");
}

/** The same-machine H3 warm process (shares the default host's GPU + disk). */
function warmBackendUrl(): string {
  return trimSlash(
    process.env.CJ_H3_WARM_URL?.trim() || "http://127.0.0.1:8189",
  );
}

// Instances

export interface BackendInstance {
  /** Routing id: "default", "video" or a saved instance id. */
  id: BackendId;
  /** Id in settings/API ("main" for the default backend). */
  settingsId: string;
  name: string;
  url: string;
  role: ComfyInstanceRole;
  enabled: boolean;
  primary: boolean;
  /** Output/input marker subfolder; undefined for the main backend. */
  marker?: string;
  /** Where it is configured. */
  source: "env" | "saved" | "default";
}

/** Marker subfolder of a saved instance. */
export function instanceMarker(id: string): string {
  return `adrift-${id}`;
}

/**
 * Every configured backend: main first, then the env video host, then the
 * saved machines (list order). Disabled ones are listed (their files stay
 * viewable) but never routed to. Duplicate URLs keep the first entry.
 */
export function listBackends(): BackendInstance[] {
  const settings = readRuntimeSettings();
  const mainUrl = defaultBackendUrl();
  const out: BackendInstance[] = [
    {
      id: DEFAULT_BACKEND,
      settingsId: "main",
      name: settings.comfyMain?.name || "Main",
      url: mainUrl,
      role: settings.comfyMain?.role ?? "all",
      enabled: true,
      primary: true,
      source: process.env.COMFY_HTTP_URL?.trim()
        ? "env"
        : settings.comfy
          ? "saved"
          : "default",
    },
  ];
  const seen = new Set([mainUrl]);
  const video = videoBackendUrl();
  if (video && !seen.has(video)) {
    seen.add(video);
    out.push({
      id: "video",
      settingsId: "video",
      name: "Video (env)",
      url: video,
      role: "video",
      enabled: true,
      primary: false,
      marker: videoSubfolderMarker(),
      source: "env",
    });
  }
  for (const inst of settings.comfyInstances ?? []) {
    const url = trimSlash(inst.httpUrl);
    if (seen.has(url) || out.some((b) => b.id === inst.id)) continue;
    seen.add(url);
    out.push({
      id: inst.id,
      settingsId: inst.id,
      name: inst.name,
      url,
      role: inst.role,
      enabled: inst.enabled,
      primary: false,
      marker: instanceMarker(inst.id),
      source: "saved",
    });
  }
  return out;
}

export function enabledBackends(): BackendInstance[] {
  return listBackends().filter((b) => b.enabled);
}

/** More than one backend configured (any multi-host bookkeeping needed). */
export function hasMultipleBackends(): boolean {
  return listBackends().length > 1;
}

export function findBackend(id: BackendId): BackendInstance | undefined {
  return listBackends().find((b) => b.id === id);
}

export function backendUrl(id: BackendId): string {
  return findBackend(id)?.url ?? defaultBackendUrl();
}

/** Which backend a base URL belongs to (warm counts as default). */
export function backendIdForUrl(url: string | undefined): BackendId {
  if (!url) return DEFAULT_BACKEND;
  const clean = trimSlash(url);
  const hit = listBackends().find((b) => b.url === clean);
  return hit?.id ?? DEFAULT_BACKEND;
}

/** Output/input subfolder marker for files that live on the video backend. */
export function videoSubfolderMarker(): string {
  const raw = process.env.COMFY_VIDEO_OUTPUT_SUBFOLDER?.trim();
  const clean = raw?.replace(/^\/+|\/+$/g, "");
  return clean && !clean.includes("..") ? clean : "adrift-video";
}

/** Backend holding a /view file, from its subfolder's first segment. */
export function backendForSubfolder(subfolder: string | undefined): BackendId {
  if (!subfolder) return DEFAULT_BACKEND;
  const backends = listBackends();
  if (backends.length < 2) return DEFAULT_BACKEND;
  const first = subfolder.replace(/\\/g, "/").split("/")[0];
  const hit = backends.find((b) => b.marker && b.marker === first);
  return hit?.id ?? DEFAULT_BACKEND;
}

export function backendUrlForSubfolder(subfolder: string | undefined): string {
  return backendUrl(backendForSubfolder(subfolder));
}

// Routing table

/** Actions that run on the video backend when one is configured. */
export const DEFAULT_VIDEO_ACTIONS = [
  "transition",
  "character_swap",
  "face_swap",
  "orbit_360",
  "camera_move",
] as const;

/** Packs whose graphs (imagine t2v/i2v/r2v ...) run on the video backend. */
export const DEFAULT_VIDEO_PACKS = [
  "minimax",
  "ltx25",
  // Open-weight contest tools: big Wan/SeedVR2/Qwen/TRELLIS/audio graphs.
  "wan22",
  "wan-animate",
  "seedvr2",
  "flashvsr",
  "interp",
  "qwen-edit-2509",
  "trellis2",
  "triposplat",
  "sam3d-body",
  "audio",
  "qwen-layered",
  // cj_image_tools nodes (vectorize, SAM3 breakdown).
  "image-tools",
  // NVIDIA RTX Video Super Resolution (needs an RTX GPU).
  "rtx",
  // Remove video background's named-subject engine (MatAnyone2, NC weights).
  "matanyone",
] as const;

/** COMFY_VIDEO_ACTIONS overrides the action list (comma separated, "" = none). */
export function videoActions(): Set<string> {
  return new Set(
    envList(process.env.COMFY_VIDEO_ACTIONS) ?? [...DEFAULT_VIDEO_ACTIONS],
  );
}

/** COMFY_VIDEO_PACKS overrides the pack list (comma separated, "" = none). */
export function videoPacks(): Set<string> {
  return new Set(
    envList(process.env.COMFY_VIDEO_PACKS) ?? [...DEFAULT_VIDEO_PACKS],
  );
}

export interface RouteInput {
  action?: string;
  packId?: string;
  /** Resolved workflow path; "packs/<id>/..." counts as that pack. */
  workflowPath?: string;
}

function packFromPath(workflowPath: string | undefined): string | undefined {
  const m = workflowPath?.replace(/\\/g, "/").match(/(?:^|\/)packs\/([^/]+)\//);
  return m?.[1];
}

/**
 * Is this a "video" job (the routing table)? An explicit action entry wins;
 * otherwise the pack (from the workflow path, else `packId`).
 */
export function isVideoJob(input: RouteInput): boolean {
  if (input.action && videoActions().has(input.action)) return true;
  // An action that resolves to a default-backend graph stays put even when
  // the client passes a video pack id (e.g. bg_remove with pack_id minimax).
  const pathPack = packFromPath(input.workflowPath);
  const pack = pathPack ?? input.packId;
  return !!pack && videoPacks().has(pack);
}

/**
 * Backends that may run a job, in tie-break order. Video jobs: enabled
 * role-"video" backends, else role "all". Everything else: role "image" or
 * "all". Nothing qualifies -> the main backend.
 */
export function routeCandidates(input: RouteInput): BackendInstance[] {
  const backends = listBackends();
  if (backends.length < 2) return [backends[0]];
  const enabled = backends.filter((b) => b.enabled);
  let picks: BackendInstance[];
  if (isVideoJob(input)) {
    picks = enabled.filter((b) => b.role === "video");
    if (picks.length === 0) picks = enabled.filter((b) => b.role === "all");
  } else {
    picks = enabled.filter((b) => b.role === "image" || b.role === "all");
  }
  return picks.length > 0 ? picks : [backends[0]];
}

/**
 * Backend for a job, synchronously: the first candidate (no load probe).
 * Used for model/node checks; submissions use pickBackend. Always "default"
 * with a single backend.
 */
export function routeBackend(input: RouteInput): BackendId {
  return routeCandidates(input)[0].id;
}

/** Base URL of the first candidate, or undefined when that is the main backend. */
export function routeBackendUrl(input: RouteInput): string | undefined {
  const b = routeCandidates(input)[0];
  return b.primary ? undefined : b.url;
}

export function packRoutesToVideo(packId: string | undefined): boolean {
  return !!packId && !routeCandidates({ packId })[0].primary;
}

/**
 * Where video-only helpers (smart-track, video master formats) run: the
 * first enabled role-"video" backend, else the main one.
 */
export function preferredVideoBackendUrl(): string | undefined {
  const b = listBackends().find((x) => x.enabled && x.role === "video");
  return b && !b.primary ? b.url : undefined;
}

export interface PickDeps {
  fetchQueue(baseUrl: string): Promise<QueueCounts | null>;
}

/**
 * Backend to submit a job to. One candidate: it, without any probe. Several:
 * the least busy by /queue (running + pending); unreachable ones are skipped,
 * ties keep list order; all unreachable -> the first candidate.
 */
export async function pickBackend(
  input: RouteInput,
  deps: Partial<PickDeps> = {},
): Promise<BackendInstance> {
  const candidates = routeCandidates(input);
  if (candidates.length === 1) return candidates[0];
  const fetchQueue = deps.fetchQueue ?? ((u: string) => fetchQueueCounts(u, 1500));
  const counts = await Promise.all(candidates.map((c) => fetchQueue(c.url)));
  let best: BackendInstance | undefined;
  let bestLoad = Infinity;
  candidates.forEach((c, i) => {
    const q = counts[i];
    if (!q) return;
    const load = q.running + q.pending;
    if (load < bestLoad) {
      best = c;
      bestLoad = load;
    }
  });
  return best ?? candidates[0];
}

// Output tagging

/**
 * Prefix every string `filename_prefix` with the video marker subfolder (in
 * place). Idempotent. Returns the number of nodes changed.
 */
export function tagOutputsForVideoBackend(workflow: Workflow): number {
  return tagOutputsWithMarker(workflow, videoSubfolderMarker());
}

/**
 * Prefix every `filename_prefix` with the marker of backend `id` (in place);
 * no-op for the main backend. Returns the number of nodes changed.
 */
export function tagOutputsForBackend(workflow: Workflow, id: BackendId): number {
  const marker = findBackend(id)?.marker;
  return marker ? tagOutputsWithMarker(workflow, marker) : 0;
}

function tagOutputsWithMarker(workflow: Workflow, marker: string): number {
  let n = 0;
  for (const node of Object.values(workflow)) {
    const inputs = node?.inputs as Record<string, unknown> | undefined;
    const prefix = inputs?.filename_prefix;
    if (typeof prefix !== "string") continue;
    const clean = prefix.replace(/^\/+/, "");
    if (clean === marker || clean.startsWith(`${marker}/`)) continue;
    inputs!.filename_prefix = `${marker}/${clean || "ComfyUI"}`;
    n++;
  }
  return n;
}

// Prompt → backend memory (history/cancel lookups)

const PROMPT_BACKENDS_MAX = 2000;
const promptBackends = new Map<string, string>();

export function rememberPromptBackend(promptId: string, baseUrl: string): void {
  if (!promptId) return;
  promptBackends.delete(promptId);
  promptBackends.set(promptId, trimSlash(baseUrl));
  while (promptBackends.size > PROMPT_BACKENDS_MAX) {
    const oldest = promptBackends.keys().next().value;
    if (oldest === undefined) break;
    promptBackends.delete(oldest);
  }
}

export function knownPromptBackend(promptId: string): string | undefined {
  return promptBackends.get(promptId);
}

/**
 * Every base URL that may hold a prompt: remembered first, then default,
 * warm, then the other backends in list order (disabled ones too: a prompt
 * queued before it was disabled still lives there).
 */
export function candidateBackendUrls(promptId?: string): string[] {
  const urls = [
    promptId ? knownPromptBackend(promptId) : undefined,
    defaultBackendUrl(),
    warmBackendUrl(),
    ...otherBackendUrls(),
  ].filter((u): u is string => !!u);
  return [...new Set(urls)];
}

/** Base URLs of every non-main backend, in list order. */
export function otherBackendUrls(): string[] {
  return listBackends()
    .filter((b) => !b.primary)
    .map((b) => b.url);
}

// Input staging

const REF_RE = /^(.+?) \[(input|output|temp)\]$/;

export interface ParsedRef {
  subfolder: string;
  filename: string;
  type: "input" | "output" | "temp";
}

/** "sub/dir/name.png [output]" → parts; null for plain names / non-refs. */
export function parseAnnotatedRef(value: string): ParsedRef | null {
  const m = value.trim().match(REF_RE);
  if (!m) return null;
  const rel = m[1].replace(/\\/g, "/");
  if (rel.split("/").some((s) => s === ".." || s === "")) return null;
  const slash = rel.lastIndexOf("/");
  return {
    subfolder: slash >= 0 ? rel.slice(0, slash) : "",
    filename: slash >= 0 ? rel.slice(slash + 1) : rel,
    type: m[2] as ParsedRef["type"],
  };
}

export interface StagingDeps {
  /** Download a /view file from `baseUrl`. */
  download(baseUrl: string, ref: ParsedRef): Promise<Uint8Array>;
  /** Upload to `baseUrl`'s input dir; returns the annotated ref there. */
  upload(
    baseUrl: string,
    data: Uint8Array,
    filename: string,
    subfolder: string,
  ): Promise<string>;
}

async function defaultDownload(baseUrl: string, ref: ParsedRef) {
  const params = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder,
    type: ref.type,
  });
  const res = await comfyFetch(`/view?${params}`, {
    baseUrl,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(
      `Staging: GET /view ${ref.subfolder}/${ref.filename} failed (${res.status})`,
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function defaultUpload(
  baseUrl: string,
  data: Uint8Array,
  filename: string,
  subfolder: string,
): Promise<string> {
  const form = new FormData();
  form.append(
    "image",
    new Blob([data as BlobPart], { type: uploadMimeType(filename) }),
    filename,
  );
  form.append("overwrite", "true");
  form.append("type", "input");
  form.append("subfolder", subfolder);
  const res = await comfyFetch("/upload/image", {
    baseUrl,
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok)
    throw new Error(`Staging: POST /upload/image failed (${res.status})`);
  const body = (await res.json()) as { name?: string; subfolder?: string };
  const sub = body.subfolder ?? subfolder;
  return `${sub ? `${sub}/` : ""}${body.name ?? filename} [input]`;
}

/** Input subfolder staged files land in on `target`. */
export function stagingSubfolder(target: BackendId): string {
  const marker = findBackend(target)?.marker;
  return marker ? `${marker}/xfer` : "adrift-xfer";
}

/** Collision-safe flat name: "<type>__<sub>__<name>". */
export function stagedFilename(ref: ParsedRef): string {
  const parts = [
    ref.type,
    ...ref.subfolder.split("/").filter(Boolean),
    ref.filename,
  ];
  return parts.join("__").replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Copy every annotated ref the target host does not have (it lives on the
 * other backend) and rewrite the node inputs in place. Returns the number of
 * refs rewritten. No-op with a single backend.
 */
export async function stageInputsForBackend(
  workflow: Workflow,
  target: BackendId,
  deps: StagingDeps = { download: defaultDownload, upload: defaultUpload },
): Promise<number> {
  if (!hasMultipleBackends()) return 0;
  const done = new Map<string, string>();
  let n = 0;
  for (const node of Object.values(workflow)) {
    const inputs = node?.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;
    for (const [key, value] of Object.entries(inputs)) {
      if (typeof value !== "string") continue;
      const ref = parseAnnotatedRef(value);
      if (!ref) continue;
      const source = backendForSubfolder(ref.subfolder);
      if (source === target) continue;
      let staged = done.get(value);
      if (!staged) {
        const data = await deps.download(backendUrl(source), ref);
        staged = await deps.upload(
          backendUrl(target),
          data,
          stagedFilename(ref),
          stagingSubfolder(target),
        );
        done.set(value, staged);
      }
      inputs[key] = staged;
      n++;
    }
  }
  return n;
}

// Cross-host GPU mutex

/**
 * Cross-host mutex on? Needs two or more enabled backends. Env
 * COMFY_EXCLUSIVE_BACKENDS wins, then the saved setting, then the implicit
 * default: on when an env video backend is configured.
 */
export function exclusiveBackendsEnabled(): boolean {
  if (enabledBackends().length < 2) return false;
  return (
    envFlag(process.env.COMFY_EXCLUSIVE_BACKENDS) ??
    readRuntimeSettings().comfyExclusive ??
    hasVideoBackend()
  );
}

/** Where the exclusive setting comes from (for the settings UI). */
export function exclusiveBackendsSource(): "env" | "saved" | "default" {
  if (envFlag(process.env.COMFY_EXCLUSIVE_BACKENDS) !== undefined) return "env";
  return readRuntimeSettings().comfyExclusive !== undefined ? "saved" : "default";
}

function envInt(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Base URLs on the OTHER side of the breaker from `targetUrl`: every other
 * enabled backend (main + warm count as one group).
 */
export function otherGroupUrls(targetUrl: string): string[] {
  const enabled = enabledBackends();
  if (enabled.length < 2) return [];
  const target = backendIdForUrl(targetUrl);
  const urls: string[] = [];
  for (const b of enabled) {
    if (b.id === target) continue;
    urls.push(b.url);
    if (b.primary) urls.push(warmBackendUrl());
  }
  return [...new Set(urls)];
}

export interface QueueCounts {
  running: number;
  pending: number;
}

/** GET /queue counts; null when the backend is unreachable. */
export async function fetchQueueCounts(
  baseUrl: string,
  timeoutMs = 3000,
): Promise<QueueCounts | null> {
  try {
    const res = await comfyFetch("/queue", {
      baseUrl,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      queue_running?: unknown[];
      queue_pending?: unknown[];
    };
    return {
      running: data.queue_running?.length ?? 0,
      pending: data.queue_pending?.length ?? 0,
    };
  } catch {
    return null;
  }
}

export class BackendBusyError extends Error {
  readonly status = 503;
  constructor(
    message: string,
    readonly busy: string[],
  ) {
    super(message);
    this.name = "BackendBusyError";
  }
}

export interface GateDeps {
  fetchQueue(baseUrl: string): Promise<QueueCounts | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log?(msg: string): void;
}

export interface GateOptions {
  enabled?: boolean;
  others?: string[];
  timeoutMs?: number;
  pollMs?: number;
  deps?: Partial<GateDeps>;
}

const defaultGateDeps: GateDeps = {
  fetchQueue: fetchQueueCounts,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  log: (msg) => console.info(`[backends] ${msg}`),
};

/**
 * Wait until every `others` backend reports an empty queue (running +
 * pending). An unreachable backend counts as idle (it cannot be drawing
 * power through ComfyUI). Throws BackendBusyError on timeout.
 */
export async function waitForOthersIdle(
  others: string[],
  opts: { timeoutMs: number; pollMs: number; deps: GateDeps },
): Promise<void> {
  const { deps } = opts;
  const start = deps.now();
  let logged = false;
  for (;;) {
    const counts = await Promise.all(others.map((u) => deps.fetchQueue(u)));
    const busy = others.filter((_, i) => {
      const c = counts[i];
      return c !== null && c.running + c.pending > 0;
    });
    if (busy.length === 0) return;
    if (deps.now() - start >= opts.timeoutMs) {
      throw new BackendBusyError(
        `GPU mutex: other ComfyUI backend still busy after ${Math.round(
          opts.timeoutMs / 1000,
        )}s (${busy.join(", ")}). Try again when it finishes.`,
        busy,
      );
    }
    if (!logged) {
      deps.log?.(`waiting for ${busy.join(", ")} to drain before queueing`);
      logged = true;
    }
    await deps.sleep(opts.pollMs);
  }
}

let gateChain: Promise<unknown> = Promise.resolve();

/**
 * Run `submit` (the POST /prompt) under the cross-host mutex for `targetUrl`:
 * submissions are serialised, and each waits until the other group's queue
 * is empty. Pass-through when the mutex is off.
 */
export async function withExclusiveBackend<T>(
  targetUrl: string,
  submit: () => Promise<T>,
  opts: GateOptions = {},
): Promise<T> {
  const enabled = opts.enabled ?? exclusiveBackendsEnabled();
  if (!enabled) return submit();
  const others = opts.others ?? otherGroupUrls(targetUrl);
  if (others.length === 0) return submit();
  const deps: GateDeps = { ...defaultGateDeps, ...opts.deps };
  const timeoutMs =
    opts.timeoutMs ?? envInt("COMFY_EXCLUSIVE_WAIT_MS", 10 * 60_000);
  const pollMs = opts.pollMs ?? envInt("COMFY_EXCLUSIVE_POLL_MS", 3000);

  const run = gateChain.then(async () => {
    await waitForOthersIdle(others, { timeoutMs, pollMs, deps });
    return submit();
  });
  // The next submission waits for this one whether it succeeds or fails.
  gateChain = run.catch(() => undefined);
  return run;
}

/** Test hook: drop any pending chain state. */
export function _resetBackendStateForTests(): void {
  gateChain = Promise.resolve();
  promptBackends.clear();
}

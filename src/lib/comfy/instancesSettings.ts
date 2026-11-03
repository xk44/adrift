/**
 * Settings-side view of the ComfyUI machines (/api/settings/comfy-instances):
 * the client-safe listing (tokens masked to booleans), PUT validation and the
 * live status probe.
 *
 * The main connection itself (URL / mode / token) stays managed by
 * /api/settings/comfy-connection and the setup wizard; here it only gets a
 * name and a role. The env video host (COMFY_VIDEO_HTTP_URL) is listed
 * read-only. Saved extra machines live in runtime_settings.json
 * `comfyInstances`.
 *
 * Server-side only (reads tokens).
 */
import { randomBytes } from "node:crypto";
import {
  MAX_COMFY_INSTANCES,
  isInstanceRole,
  isValidInstanceId,
  readRuntimeSettings,
  runtimeComfyToken,
  type ComfyInstanceRole,
  type ComfyInstanceSetting,
  type ComfyMainSetting,
} from "@/lib/runtimeSettings";
import {
  normalizeComfyUrl,
  validateToken,
  type ConnectionMode,
} from "@/lib/onboarding/comfyUrl";
import { probeComfy } from "@/lib/onboarding/comfyProbe";
import {
  exclusiveBackendsEnabled,
  exclusiveBackendsSource,
  listBackends,
  type BackendInstance,
} from "@/lib/comfy/backends";

export interface InstanceView {
  /** Settings id: "main", "video" (env) or the saved id. */
  id: string;
  name: string;
  url: string;
  role: ComfyInstanceRole;
  enabled: boolean;
  primary: boolean;
  source: "env" | "saved" | "default";
  /** Saved extra machine: URL/token/enabled editable, removable. */
  editable: boolean;
  hasToken: boolean;
  /** Output marker subfolder (null for the main machine). */
  marker: string | null;
}

export interface InstancesView {
  max: number;
  instances: InstanceView[];
  exclusive: {
    /** Effective (false whenever fewer than two machines are enabled). */
    enabled: boolean;
    source: "env" | "saved" | "default";
    /** The saved value; null = default. */
    saved: boolean | null;
  };
}

function mainToken(): string | undefined {
  return process.env.COMFY_BEARER?.trim() || runtimeComfyToken() || undefined;
}

/** Server-side token for a listed backend (never send to a client). */
export function tokenForBackend(b: BackendInstance): string | undefined {
  if (b.source !== "saved" || b.primary) return mainToken();
  return readRuntimeSettings().comfyInstances?.find((i) => i.id === b.id)
    ?.authToken;
}

export function instancesView(): InstancesView {
  const settings = readRuntimeSettings();
  return {
    max: MAX_COMFY_INSTANCES,
    instances: listBackends().map((b) => ({
      id: b.settingsId,
      name: b.name,
      url: b.url,
      role: b.role,
      enabled: b.enabled,
      primary: b.primary,
      source: b.source,
      editable: !b.primary && b.source === "saved",
      hasToken: !!tokenForBackend(b),
      marker: b.marker ?? null,
    })),
    exclusive: {
      enabled: exclusiveBackendsEnabled(),
      source: exclusiveBackendsSource(),
      saved: settings.comfyExclusive ?? null,
    },
  };
}

// PUT validation

export interface InstancesUpdate {
  instances?: ComfyInstanceSetting[];
  main?: ComfyMainSetting | null;
  exclusive?: boolean | null;
}

export type ValidateResult =
  | { ok: true; update: InstancesUpdate; warnings: string[] }
  | { ok: false; error: string };

const MODES = new Set(["local", "lan", "wan"]);

function newId(taken: Set<string>): string {
  for (;;) {
    const id = `m-${randomBytes(3).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

function cleanName(v: unknown): string {
  return typeof v === "string"
    ? v
        .replace(/[\x00-\x1f\x7f]/g, "")
        .trim()
        .slice(0, 48)
    : "";
}

/**
 * Validate a PUT body against the current settings. `urlsInUse` are the
 * URLs the saved machines may not reuse (main + env video).
 */
export function validateInstancesPut(
  body: Record<string, unknown>,
  current: ComfyInstanceSetting[],
  urlsInUse: string[],
): ValidateResult {
  const update: InstancesUpdate = {};
  const warnings: string[] = [];

  if (body.main !== undefined) {
    if (!body.main || typeof body.main !== "object" || Array.isArray(body.main))
      return { ok: false, error: "main must be an object" };
    const m = body.main as Record<string, unknown>;
    const main: ComfyMainSetting = {};
    const name = cleanName(m.name);
    if (name) main.name = name;
    if (m.role !== undefined) {
      if (!isInstanceRole(m.role))
        return { ok: false, error: "role must be all, image or video" };
      if (m.role !== "all") main.role = m.role;
    }
    update.main = main.name || main.role ? main : null;
  }

  if (body.exclusive !== undefined) {
    if (body.exclusive !== null && typeof body.exclusive !== "boolean")
      return { ok: false, error: "exclusive must be true, false or null" };
    update.exclusive = body.exclusive as boolean | null;
  }

  if (body.instances !== undefined) {
    if (!Array.isArray(body.instances))
      return { ok: false, error: "instances must be a list" };
    const reserved = urlsInUse.length; // main (+ env video)
    const room = MAX_COMFY_INSTANCES - reserved;
    if (body.instances.length > room)
      return {
        ok: false,
        error: `At most ${MAX_COMFY_INSTANCES} machines in total (${room} more).`,
      };
    const byId = new Map(current.map((i) => [i.id, i]));
    const taken = new Set<string>(current.map((i) => i.id));
    const ids = new Set<string>();
    const urls = new Set(urlsInUse.map((u) => u.replace(/\/+$/, "")));
    const out: ComfyInstanceSetting[] = [];
    for (const [n, raw] of body.instances.entries()) {
      const label = `Machine ${n + 2}`;
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return { ok: false, error: `${label}: invalid entry` };
      const i = raw as Record<string, unknown>;
      let id: string;
      if (i.id === undefined || i.id === null || i.id === "") {
        id = newId(new Set([...taken, ...ids]));
      } else if (isValidInstanceId(i.id)) {
        id = i.id;
      } else {
        return { ok: false, error: `${label}: invalid id` };
      }
      if (ids.has(id)) return { ok: false, error: `${label}: duplicate id` };
      ids.add(id);
      const mode = (
        MODES.has(String(i.mode)) ? i.mode : "lan"
      ) as ConnectionMode;
      const url = normalizeComfyUrl(String(i.url ?? ""), mode);
      if (!url.ok) return { ok: false, error: `${label}: ${url.error}` };
      if (urls.has(url.url))
        return {
          ok: false,
          error: `${label}: ${url.url} is already in the list.`,
        };
      urls.add(url.url);
      if (url.warning) warnings.push(`${label}: ${url.warning}`);
      const role = i.role === undefined ? "all" : i.role;
      if (!isInstanceRole(role))
        return {
          ok: false,
          error: `${label}: role must be all, image or video`,
        };
      if (i.enabled !== undefined && typeof i.enabled !== "boolean")
        return { ok: false, error: `${label}: enabled must be true or false` };
      const token = validateToken(i.token);
      if (token && typeof token === "object")
        return { ok: false, error: `${label}: ${token.error}` };
      const prev = byId.get(id);
      // Keep a saved token only for the same machine at the same address: a
      // token saved for one box must never go to another.
      const authToken =
        (token as string | null) ??
        (i.clearToken === true || prev?.httpUrl !== url.url
          ? undefined
          : prev?.authToken);
      const inst: ComfyInstanceSetting = {
        id,
        name: cleanName(i.name) || label,
        httpUrl: url.url,
        role,
        enabled: i.enabled !== false,
      };
      if (authToken) inst.authToken = authToken;
      out.push(inst);
    }
    update.instances = out;
  }
  return { ok: true, update, warnings };
}

// Live status

export interface InstanceStatus {
  reachable: boolean;
  comfyuiVersion?: string | null;
  gpuName?: string;
  memoryGb?: number;
  unified?: boolean;
  queue?: { running: number; pending: number } | null;
  error?: string;
}

/**
 * GET /system_stats (+ /queue) of one machine: a plain fetch like the
 * wizard's probe (see comfyProbe.ts), no redirects, parsed fields only.
 */
export async function probeInstance(
  url: string,
  token?: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<InstanceStatus> {
  const probe = await probeComfy(url, token, fetchImpl, { nodes: false });
  if (!probe.ok) return { reachable: false, error: probe.error };
  let queue: InstanceStatus["queue"] = null;
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchImpl(`${url.replace(/\/+$/, "")}/queue`, {
      headers,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const q = (await res.json()) as {
        queue_running?: unknown[];
        queue_pending?: unknown[];
      };
      queue = {
        running: Array.isArray(q.queue_running) ? q.queue_running.length : 0,
        pending: Array.isArray(q.queue_pending) ? q.queue_pending.length : 0,
      };
    }
  } catch {
    queue = null;
  }
  return {
    reachable: true,
    comfyuiVersion: probe.comfyuiVersion,
    gpuName: probe.gpuName,
    memoryGb: probe.memoryGb,
    unified: probe.unified,
    queue,
  };
}

/** Live status of every listed machine, keyed by settings id. */
export async function probeAllInstances(
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, InstanceStatus>> {
  const backends = listBackends();
  const results = await Promise.all(
    backends.map((b) => probeInstance(b.url, tokenForBackend(b), fetchImpl)),
  );
  return Object.fromEntries(backends.map((b, i) => [b.settingsId, results[i]]));
}

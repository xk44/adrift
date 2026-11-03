/**
 * Client calls + response shapes for the setup wizard. Read-only except
 * saveConnection / forgetConnection (data/runtime_settings.json).
 */
import type { ProbeResult } from "@/lib/onboarding/comfyProbe";
import type { ConnectionMode } from "@/lib/onboarding/comfyUrl";
import type { BackendProfile } from "@/lib/models/compat";
import type {
  ResolvedFile,
  ResolvedPack,
  Tier,
} from "@/lib/onboarding/starterPacks";

import type { ToolRow } from "@/lib/onboarding/toolPicker";

export type { ProbeResult, ConnectionMode };

export interface ConnectionStatus {
  ok: boolean;
  error?: string;
  source: "env" | "saved" | "default";
  envLocked: boolean;
  httpUrl: string;
  mode: ConnectionMode | null;
  savedUrl: string | null;
  hasToken: boolean;
  tokenFromEnv: boolean;
  wsBase: string | null;
  updatedAt: string | null;
  configured: boolean;
  reachable: boolean;
  probe: ProbeResult;
  /** The setup wizard was finished or skipped on some device. */
  onboarded?: boolean;
}

export interface TestResponse {
  ok: boolean;
  error?: string;
  result?: ProbeResult;
  normalizedUrl?: string;
  warning?: string | null;
  envLocked?: boolean;
}

export type PackView = Omit<ResolvedPack, "files"> & {
  command: string | null;
  files: (ResolvedFile & { hfCommand: string | null })[];
};

export interface PacksResponse {
  ok: boolean;
  error?: string;
  connected: boolean;
  profile: BackendProfile | null;
  tier: Tier | null;
  tierLabel: string | null;
  installedKnown: boolean;
  comfyDir: string;
  comfyDirKnown: boolean;
  preselected: string[];
  packs: PackView[];
}

export interface ToolRowsResponse {
  ok: boolean;
  error?: string;
  tools: ToolRow[];
}

async function json<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    return { ok: false, error: `Server answered HTTP ${res.status}` } as T;
  }
}

const WRITE_HEADERS = {
  "Content-Type": "application/json",
  "X-Requested-With": "XMLHttpRequest",
};

export async function getConnection(
  quick = false,
): Promise<ConnectionStatus | null> {
  try {
    const q = quick ? "?quick=1" : "";
    const res = await fetch(`/api/settings/comfy-connection${q}`, {
      cache: "no-store",
    });
    const body = await json<ConnectionStatus>(res);
    return body.ok ? body : null;
  } catch {
    return null;
  }
}

export async function testConnection(body: {
  probeLocal?: boolean;
  url?: string;
  mode?: ConnectionMode;
  token?: string;
  useSavedToken?: boolean;
}): Promise<TestResponse> {
  try {
    const res = await fetch("/api/settings/comfy-connection/test", {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify(body),
    });
    return await json<TestResponse>(res);
  } catch {
    return { ok: false, error: "Couldn't reach Adrift's server." };
  }
}

export async function saveConnection(body: {
  url: string;
  mode: ConnectionMode;
  token?: string;
  keepToken?: boolean;
}): Promise<{ ok: boolean; error?: string; warning?: string | null }> {
  try {
    const res = await fetch("/api/settings/comfy-connection", {
      method: "PUT",
      headers: WRITE_HEADERS,
      body: JSON.stringify(body),
    });
    return await json(res);
  } catch {
    return { ok: false, error: "Couldn't reach Adrift's server." };
  }
}

export async function forgetConnection(): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    const res = await fetch("/api/settings/comfy-connection", {
      method: "DELETE",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    return await json(res);
  } catch {
    return { ok: false, error: "Couldn't reach Adrift's server." };
  }
}

export async function getPacks(): Promise<PacksResponse | null> {
  try {
    const res = await fetch("/api/onboarding/packs", { cache: "no-store" });
    const body = await json<PacksResponse>(res);
    return body.ok ? body : null;
  } catch {
    return null;
  }
}

export async function getToolRows(): Promise<ToolRowsResponse | null> {
  try {
    const res = await fetch("/api/onboarding/tools", { cache: "no-store" });
    const body = await json<ToolRowsResponse>(res);
    return body.ok ? body : null;
  } catch {
    return null;
  }
}

// Folders (GET/PUT /api/settings/dirs, POST /api/settings/dirs/check)

export type DirKey = "comfyRoot" | "models" | "input" | "output" | "data";
export type DirCheckStatus = "ok" | "warn" | "error" | "remote";

export interface DirCheckView {
  key: DirKey;
  status: DirCheckStatus;
  display: string;
  exists: boolean;
  reason: string;
  notes: string[];
  canCreate: boolean;
  created?: boolean;
}

export interface DirRowView {
  key: DirKey;
  display: string;
  source: "env" | "saved" | "default";
  envVar: string;
  envLocked: boolean;
  defaultDisplay: string;
  side: "comfy" | "adrift";
  check: DirCheckView;
}

export interface DirsResponse {
  ok: boolean;
  error?: string;
  key?: DirKey;
  comfyLocal: boolean;
  dirs: DirRowView[];
}

export async function getDirs(): Promise<DirsResponse | null> {
  try {
    const res = await fetch("/api/settings/dirs", { cache: "no-store" });
    const body = await json<DirsResponse>(res);
    return body.ok ? body : null;
  } catch {
    return null;
  }
}

export async function checkDir(body: {
  key: DirKey;
  path: string;
  create?: boolean;
}): Promise<{ ok: boolean; error?: string; check?: DirCheckView }> {
  try {
    const res = await fetch("/api/settings/dirs/check", {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify(body),
    });
    return await json(res);
  } catch {
    return { ok: false, error: "Couldn't reach Adrift's server." };
  }
}

export async function saveDirs(
  dirs: Partial<Record<DirKey, string | null>>,
): Promise<DirsResponse | { ok: false; error: string; key?: DirKey }> {
  try {
    const res = await fetch("/api/settings/dirs", {
      method: "PUT",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ dirs }),
    });
    return await json(res);
  } catch {
    return { ok: false, error: "Couldn't reach Adrift's server." };
  }
}

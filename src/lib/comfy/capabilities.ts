/**
 * Server-version capability gating. Combines ComfyUI's GET /features (server
 * feature flags) and /system_stats comfyui_version into a small, cached
 * capability set so callers fall back to old behaviour on older servers.
 *
 * Server-only fetch (GETs). Never throws: unreachable → all-false caps.
 */

import { env } from "@/lib/env";

export interface ComfyCapabilities {
  /** True when /system_stats answered. */
  reachable: boolean;
  comfyuiVersion: string | null;
  /** Raw /features payload ({} on servers without the endpoint). */
  features: Record<string, unknown>;
  /** POST /interrupt honours {prompt_id} (ComfyUI >= 0.3.57, PR #9607);
   *  older servers ignore the body and interrupt whatever is running. */
  interruptPromptId: boolean;
  /** Server sends PREVIEW_IMAGE_WITH_METADATA frames to clients that opt in
   *  (features.supports_preview_metadata). */
  previewMetadata: boolean;
  /** A /system_stats device is Apple MPS: fp8 weights cannot load there
   *  (model-variant fallback skips fp8 siblings). False when unknown. */
  noFp8: boolean;
}

/** Version that added targeted interrupt (Comfy-Org/ComfyUI 464ba1d, #9607). */
export const INTERRUPT_PROMPT_ID_MIN_VERSION = "0.3.57";

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; data: ComfyCapabilities }>();

export function clearComfyCapabilitiesCache(): void {
  cache.clear();
}

/** Parse "0.42.0" / "v0.3.57-rc1" → [0,42,0]; null when unparseable. */
export function parseVersion(v: unknown): number[] | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

/** a >= b; false when either side is unparseable. */
export function versionAtLeast(a: unknown, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return true;
}

function devicesOf(systemStats: unknown): string[] {
  const devs =
    systemStats && typeof systemStats === "object"
      ? (systemStats as { devices?: unknown }).devices
      : undefined;
  if (!Array.isArray(devs)) return [];
  return devs
    .map((d) =>
      d && typeof d === "object"
        ? `${(d as { type?: unknown }).type ?? ""} ${(d as { name?: unknown }).name ?? ""}`
        : "",
    )
    .filter(Boolean);
}

export function deriveCapabilities(
  systemStats: unknown,
  features: unknown,
): ComfyCapabilities {
  const sys =
    systemStats && typeof systemStats === "object"
      ? (systemStats as { system?: { comfyui_version?: unknown } }).system
      : undefined;
  const version =
    typeof sys?.comfyui_version === "string" ? sys.comfyui_version : null;
  const feats =
    features && typeof features === "object" && !Array.isArray(features)
      ? (features as Record<string, unknown>)
      : {};
  return {
    reachable: systemStats != null,
    comfyuiVersion: version,
    features: feats,
    interruptPromptId: versionAtLeast(version, INTERRUPT_PROMPT_ID_MIN_VERSION),
    previewMetadata: feats.supports_preview_metadata === true,
    noFp8: devicesOf(systemStats).some((d) => /mps/i.test(d)),
  };
}

async function getJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function getComfyCapabilities(
  baseUrl: string = env.COMFY_HTTP_URL,
  opts: { fresh?: boolean } = {},
): Promise<ComfyCapabilities> {
  const hit = cache.get(baseUrl);
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const [stats, features] = await Promise.all([
    getJson(`${baseUrl}/system_stats`),
    getJson(`${baseUrl}/features`),
  ]);
  const data = deriveCapabilities(stats, features);
  // Don't pin an outage for the whole TTL.
  if (data.reachable) cache.set(baseUrl, { at: Date.now(), data });
  return data;
}

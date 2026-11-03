/**
 * Shared, short-lived cache of ComfyUI's full /object_info (~2.5MB) for
 * server-side pre-submit validation. Short TTL so newly installed models or
 * custom nodes are picked up quickly. Read-only GET; never throws.
 */

import { env } from "@/lib/env";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import {
  comboOptions,
  validatePrompt,
  PromptValidationError,
} from "@/lib/comfy/validatePrompt";
import {
  bypassMissingOptionalNodes,
  type BypassedNode,
} from "@/lib/comfy/optionalNodes";

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; data: Record<string, unknown> }>();

export function clearObjectInfoCache(): void {
  cache.clear();
}

/** Returns object_info, or null when ComfyUI is unreachable (fail open). */
export async function getObjectInfoCached(
  baseUrl: string = env.COMFY_HTTP_URL,
  opts: { fresh?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  const hit = cache.get(baseUrl);
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.data;
  try {
    const res = await comfyFetch("/object_info", {
      baseUrl,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return hit?.data ?? null;
    const data = (await res.json()) as Record<string, unknown>;
    cache.set(baseUrl, { at: Date.now(), data });
    return data;
  } catch {
    return hit?.data ?? null;
  }
}

function loaderChoices(
  info: Record<string, unknown>,
  classType: string,
  input: string,
): unknown[] {
  const node = info[classType] as
    | { input?: { required?: Record<string, unknown> } }
    | undefined;
  const spec = node?.input?.required?.[input];
  return (Array.isArray(spec) && comboOptions(spec)) || [];
}

/**
 * Which loader folder ComfyUI lists a model file under: "checkpoint"
 * (CheckpointLoaderSimple ckpt_name — an all-in-one SD-style file), "unet"
 * (UNETLoader unet_name only — a bare diffusion model), or null when unknown
 * or ComfyUI is unreachable. Read-only, cached, never throws.
 */
export async function modelLoaderKind(
  name: string,
  baseUrl?: string,
): Promise<"checkpoint" | "unet" | null> {
  const info = await getObjectInfoCached(baseUrl);
  if (!info) return null;
  if (loaderChoices(info, "CheckpointLoaderSimple", "ckpt_name").includes(name))
    return "checkpoint";
  if (loaderChoices(info, "UNETLoader", "unet_name").includes(name))
    return "unet";
  return null;
}

/**
 * Rewire around optional nodes (`_meta.optional`) whose class_type the
 * connected ComfyUI lacks (see optionalNodes.ts). Unreachable ComfyUI: the
 * prompt is returned as-is. A missing node only counts once a fresh
 * object_info confirms it, so a node installed seconds ago is still used.
 */
export async function applyOptionalNodeBypass<T extends object>(
  prompt: T,
  baseUrl?: string,
): Promise<{ prompt: T; bypassed: BypassedNode[] }> {
  const info = await getObjectInfoCached(baseUrl);
  if (!info) return { prompt, bypassed: [] };
  const first = bypassMissingOptionalNodes(prompt, info);
  if (first.bypassed.length === 0) return first;
  const fresh = await getObjectInfoCached(baseUrl, { fresh: true });
  if (!fresh || fresh === info) return first;
  return bypassMissingOptionalNodes(prompt, fresh);
}

/** Throws PromptValidationError (422) when the prompt has problems. */
export async function assertPromptValid(
  prompt: unknown,
  baseUrl?: string,
): Promise<void> {
  const info = await getObjectInfoCached(baseUrl);
  if (!info) return; // can't validate; let ComfyUI decide
  let problems = validatePrompt(prompt, info);
  if (problems.length > 0) {
    // The cached snapshot may predate a model/node installed seconds ago:
    // never reject on a stale list — re-check against a fresh fetch first.
    const fresh = await getObjectInfoCached(baseUrl, { fresh: true });
    if (!fresh || fresh === info) return; // couldn't refresh: let ComfyUI decide
    problems = validatePrompt(prompt, fresh);
  }
  if (problems.length > 0) throw new PromptValidationError(problems);
}

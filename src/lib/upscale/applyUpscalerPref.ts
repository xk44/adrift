/**
 * Server-side pre-submit step (see queuePrompt): resolveGraphUpscalers with
 * the saved preference and the target server's live upscaler list. Any
 * failure (ComfyUI unreachable, unreadable settings) returns the prompt
 * unchanged so a run is never broken by it.
 */
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import { comboOptions } from "@/lib/comfy/validatePrompt";
import { readUpscalerPref } from "@/lib/runtimeSettings";
import {
  hasUpscaleLoader,
  resolveGraphUpscalers,
  type ResolveUpscalersResult,
} from "./resolveUpscalers";

/** Every UpscaleModelLoader.model_name option (unfiltered), or null. */
export function liveUpscalerFiles(
  info: Record<string, unknown> | null | undefined,
): string[] | null {
  const node = info?.UpscaleModelLoader as
    { input?: { required?: Record<string, unknown> } } | undefined;
  const spec = node?.input?.required?.model_name;
  if (!Array.isArray(spec)) return null;
  const opts = comboOptions(spec);
  return Array.isArray(opts)
    ? opts.filter((o): o is string => typeof o === "string")
    : null;
}

export async function applyUpscalerPreference<T extends object>(
  prompt: T,
  baseUrl?: string,
): Promise<ResolveUpscalersResult<T>> {
  if (!hasUpscaleLoader(prompt)) return { prompt, swaps: [], warnings: [] };
  try {
    const info = await getObjectInfoCached(baseUrl);
    return resolveGraphUpscalers(prompt, {
      pref: readUpscalerPref(),
      live: liveUpscalerFiles(info),
    });
  } catch {
    return { prompt, swaps: [], warnings: [] };
  }
}

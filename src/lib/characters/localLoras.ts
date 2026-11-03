/**
 * Where this ComfyUI keeps its LoRAs on disk, when Adrift can see them.
 * Only for a ComfyUI on this machine: a remote backend's COMFY_ROOT is not
 * ours to read. Server-side only.
 */

import fs from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";
import { comfyBaseUrl } from "@/lib/comfy/comfyFetch";
import { isLoopbackHost } from "@/lib/onboarding/comfyUrl";
import { comfyModelsPath } from "@/lib/paths/resolveDirs";

export function localLorasDir(
  baseUrl: string = comfyBaseUrl(),
  comfyRoot: string = env.COMFY_ROOT,
): string | null {
  try {
    if (!isLoopbackHost(new URL(baseUrl).hostname)) return null;
  } catch {
    return null;
  }
  const dir = path.resolve(comfyModelsPath(comfyRoot, "loras"));
  return fs.existsSync(dir) ? dir : null;
}

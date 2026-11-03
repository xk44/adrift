/**
 * Server side: the connected ComfyUI's BackendProfile, read from
 * GET /system_stats (read-only, short timeout). Null when unreachable.
 */
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import { profileFromSystemStats, type BackendProfile } from "./compat";

export async function fetchBackendProfileServer(
  timeoutMs = 3000,
): Promise<BackendProfile | null> {
  try {
    const res = await comfyFetch("/system_stats", {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return profileFromSystemStats(await res.json());
  } catch {
    return null;
  }
}

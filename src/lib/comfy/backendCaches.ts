/**
 * One call that forgets everything the server cached about the connected
 * ComfyUI (object_info, capabilities, checkpoint list, node-pack mappings).
 * Called when the saved ComfyUI connection changes, so the new backend's
 * nodes and models show on the very next request. The caches are also keyed
 * by base URL, so this mainly covers switching back to an earlier address
 * within a TTL. Server-side only.
 */
import { clearObjectInfoCache } from "@/lib/comfy/objectInfoCache";
import { clearComfyCapabilitiesCache } from "@/lib/comfy/capabilities";
import { clearPackNodeAvailabilityCache } from "@/lib/comfy/packNodeAvailability";
import { clearCheckpointsCache } from "@/lib/comfy/http";
import { clearRouterCaches } from "@/lib/comfy/router";

export function invalidateComfyBackendCaches(): void {
  clearObjectInfoCache();
  clearComfyCapabilitiesCache();
  clearPackNodeAvailabilityCache();
  clearCheckpointsCache();
  clearRouterCaches();
}

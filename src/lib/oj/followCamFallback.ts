/**
 * Follow subject needs the CJFollowCam* nodes (comfy_nodes/cj_h3_tools).
 * The tool picker defaults to "auto", so a backend without them must not
 * fail every character swap: "auto" runs full-frame and says so in
 * `warnings.nodes` (same channel as the SA3 Quality fallback); an explicit
 * "on" is refused with the install hint instead of silently ignored.
 *
 * Unknown listing (backend unreachable) → keep what was asked; queue-time
 * validation reports a real missing node.
 */
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";

export const FOLLOW_CAM_CLASSES = [
  "CJFollowCamTrack",
  "CJFollowCamPlate",
  "CJFollowCamCrop",
  "CJFollowCamCropMask",
  "CJFollowCamPaste",
] as const;

export const FOLLOW_CAM_FALLBACK_NOTE =
  "Follow subject needs Adrift's cj_h3_tools nodes (CJFollowCam*), which this ComfyUI doesn't have. Ran on the whole frame instead.";

export type FollowCamFallback =
  | { kind: "ok" }
  | { kind: "off"; note: string }
  | { kind: "refuse"; error: string };

/** Pure: what to do with params.followSubject given the backend's classes. */
export function followCamFallback(
  params: Record<string, unknown>,
  info: Record<string, unknown> | null,
): FollowCamFallback {
  const mode = params.followSubject;
  if ((mode !== "auto" && mode !== "on") || !info) return { kind: "ok" };
  const missing = FOLLOW_CAM_CLASSES.filter((c) => !(c in info));
  if (!missing.length) return { kind: "ok" };
  if (mode === "auto") return { kind: "off", note: FOLLOW_CAM_FALLBACK_NOTE };
  return {
    kind: "refuse",
    error: `Follow subject "On" needs ComfyUI custom nodes that are not installed: ${missing.join(", ")} (copy comfy_nodes/cj_h3_tools into ComfyUI/custom_nodes and restart ComfyUI), or set Follow subject to Auto/Off.`,
  };
}

/** Route step: drops "auto" to "off" in place; returns the note or error. */
export async function applyFollowCamFallback(
  params: Record<string, unknown>,
  baseUrl?: string,
): Promise<FollowCamFallback> {
  const mode = params.followSubject;
  if (mode !== "auto" && mode !== "on") return { kind: "ok" };
  const info = (await getObjectInfoCached(baseUrl).catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const res = followCamFallback(params, info);
  if (res.kind === "off") params.followSubject = "off";
  return res;
}

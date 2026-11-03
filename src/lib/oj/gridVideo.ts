/**
 * grid_video (packs/utility/grid_video.json): beat-synced grid music video
 * from one source clip (or still) + a music track. No models: the plan
 * (src/lib/tools/gridVideo.ts planGridVideo, run here on the server from the
 * action params) goes to a single CJGridVideo node
 * (comfy_nodes/cj_h3_tools/cj_grid_video.py) that decodes the source with
 * ffmpeg, renders every frame with numpy and muxes the music.
 *
 *   params.source       ComfyUI ref of the clip / image ("x.mp4 [input]")
 *   params.sourceKind   "video" | "image"; params.sourceSeconds clip length
 *   params.audio        music ref; params.audioSeconds its length (output
 *                       length, capped at 90 s)
 *   params.beats        beat times in seconds (browser beat detection)
 *   params.bpm          fallback tempo when beats are missing
 *   params.style        "poster" | "infection" | "mosaic"
 *   params.aspect       "1:1" | "9:16" | "16:9"; params.resolution 720 | 1080
 *   params.gridMax      2..6; params.intensity "low" | "medium" | "high"
 *   params.seed         layout / offsets seed
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import { cloneWorkflow } from "./engine";
import {
  GRID_VIDEO_ACTION,
  normalizeGridParams,
  planGridVideo,
  type GridPlan,
} from "@/lib/tools/gridVideo";

export { GRID_VIDEO_ACTION };
export const GRID_VIDEO_NODE = "CJGridVideo";
export const GRID_VIDEO_PREFIX = "video/adrift_grid";

/** Validate params and build the render plan (throws on bad input). */
export function gridVideoPlan(params: Record<string, unknown>): GridPlan {
  return planGridVideo(normalizeGridParams(params));
}

export function buildGridVideoWorkflow(
  baseWorkflow: Workflow,
  _sourceRun: ImagineRun,
  _sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const A = GRID_VIDEO_ACTION;
  const spec = normalizeGridParams(params);
  const plan = planGridVideo(spec);
  const workflow = cloneWorkflow(baseWorkflow);
  const nodeId = Object.keys(workflow).find(
    (k) => workflow[k]?.class_type === GRID_VIDEO_NODE,
  );
  if (!nodeId) throw new Error(`${A}: workflow needs ${GRID_VIDEO_NODE}`);
  workflow[nodeId] = {
    ...workflow[nodeId],
    inputs: {
      ...workflow[nodeId].inputs,
      source: spec.source,
      audio: spec.audio,
      plan: JSON.stringify(plan),
      filename_prefix: GRID_VIDEO_PREFIX,
    },
  };
  return {
    workflow,
    slots: {
      ksamplerId: nodeId,
      posTextId: nodeId,
      posTextInputName: "filename_prefix",
      negTextId: "",
      latentDimsId: "",
    },
    seed: 0,
  };
}

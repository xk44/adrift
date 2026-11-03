/**
 * video_palette (packs/utility/video_palette.json): regrade the source clip to
 * a palette or a reference still. No models: one CJVideoPalette node
 * (comfy_nodes/cj_h3_tools/cj_video_palette.py) fits a single colour
 * transform for the whole clip, bakes it into a LUT (.cube written next to
 * the MP4) and applies it per frame with the source audio kept.
 *
 *   params.source            "preset" | "hex" | "reference"
 *   params.palette           hex list "#rrggbb[:w], ..." (preset / hex)
 *   params.secondRefImage    uploaded still ("name.png [input]") (reference)
 *   params.strength          0..1 (default 0.8)
 *   params.preserveLuminance keep the source's OKLab lightness
 *   params.skinProtect       0..1 fade on skin tones (0 = off)
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import { parseInputRef } from "@/lib/seedRun";
import {
  VIDEO_PALETTE_ACTION,
  formatHexPalette,
  parseHexPalette,
} from "@/lib/tools/videoPalette";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";

export { VIDEO_PALETTE_ACTION };
export const VIDEO_PALETTE_NODE = "CJVideoPalette";
export const VIDEO_PALETTE_PREFIX = "video/adrift_palette";

/** Fixed node id in packs/utility/video_palette.json. */
export const VP_NODES = { grade: "1" } as const;

function unit(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    !Number.isFinite(n)
  )
    return fallback;
  return Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
}

export function buildVideoPaletteWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const action = VIDEO_PALETTE_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const node = workflow[VP_NODES.grade];
  if (node?.class_type !== VIDEO_PALETTE_NODE)
    throw new Error(`${action}: workflow is missing node ${VP_NODES.grade}`);
  const job = sourceRun.jobs[sourceJobIndex];
  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!videoRef) throw new Error(`${action}: source run has no video`);

  const source = params.source === "reference" ? "reference" : "palette";
  let palette = "";
  let reference = "";
  if (source === "reference") {
    const raw =
      typeof params.secondRefImage === "string"
        ? params.secondRefImage.trim()
        : "";
    if (!raw || !parseInputRef(raw))
      throw new Error(
        `${action}: secondRefImage must be an uploaded image ref ("name.png [input]")`,
      );
    reference = raw;
  } else {
    const raw = typeof params.palette === "string" ? params.palette : "";
    try {
      palette = formatHexPalette(parseHexPalette(raw));
    } catch (e) {
      throw new Error(`${action}: palette: ${(e as Error).message}`);
    }
  }

  setNodeInput(workflow, VP_NODES.grade, "video", videoRef);
  setNodeInput(workflow, VP_NODES.grade, "reference", reference);
  setNodeInput(workflow, VP_NODES.grade, "palette", palette);
  setNodeInput(
    workflow,
    VP_NODES.grade,
    "strength",
    unit(params.strength, 0.8),
  );
  setNodeInput(
    workflow,
    VP_NODES.grade,
    "preserve_luminance",
    params.preserveLuminance === true,
  );
  setNodeInput(
    workflow,
    VP_NODES.grade,
    "skin_protect",
    unit(params.skinProtect, 0),
  );
  setNodeInput(
    workflow,
    VP_NODES.grade,
    "filename_prefix",
    VIDEO_PALETTE_PREFIX,
  );

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: "",
      posTextInputName: "",
      negTextId: "",
      latentDimsId: "",
      imageInputId: VP_NODES.grade,
    },
    seed: typeof job?.seed === "number" ? job.seed : 0,
  };
}

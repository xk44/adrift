/**
 * "Change video background" (packs/utility/video_bg_change.json): pure
 * compositing, no diffusion. BiRefNet mattes every frame, CJMatteGate keeps
 * only the SAM 3.1-tracked subject (params.subject, default "person"; solid
 * core, BiRefNet's soft edge in a band around it), CJMaskTemporal (stable)
 * steadies the matte without ghosting fast movers, CJVideoBgComposite puts the subject over the
 * new background (scaled to cover the frame) with a 1 px choke, feather, light
 * wrap and a clip-wide colour match, and CreateVideo keeps the source fps and
 * audio. The fps is the client's probe of the file (params.sourceFps) when
 * known, else GetVideoComponents' average rate (which reads 1 fps for clips
 * whose stream has no average rate). Background sources (the builder keeps exactly one):
 *   - an uploaded image (params.secondRefImage, LoadImage),
 *   - an uploaded clip (params.backgroundVideo, LoadVideo, cycled if short),
 *   - none / background "blur": the original background, blurred.
 * The first VIDEO_BG_CHANGE_MAX_SECONDS of the source are used (all frames
 * are held in memory at source resolution).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import { parseInputRef } from "@/lib/seedRun";
import { normalizeFps } from "@/lib/videoFps";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";

export const VIDEO_BG_CHANGE_ACTION = "video_bg_change";
export const VIDEO_BG_CHANGE_MAX_SECONDS = 10;

/** Fixed node ids in packs/utility/video_bg_change.json. */
export const VBC_NODES = {
  load: "1",
  slice: "2",
  composite: "7",
  bgImage: "8",
  bgVideo: "11",
  bgFrames: "12",
  subjectText: "21",
  create: "9",
} as const;

export const VIDEO_BG_DEFAULT_SUBJECT = "person";

/** Tracker text: trimmed, one line, capped; empty -> "person". */
export function videoBgSubject(value: unknown): string {
  const s = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return s.slice(0, 120) || VIDEO_BG_DEFAULT_SUBJECT;
}

export type VideoBgMode = "image" | "video" | "blur";

/** Edge treatment presets (light wrap, colour match). */
export const VIDEO_BG_BLEND: Record<
  string,
  { lightWrap: number; colorMatch: number }
> = {
  natural: { lightWrap: 0.25, colorMatch: 0.3 },
  none: { lightWrap: 0, colorMatch: 0 },
  strong: { lightWrap: 0.45, colorMatch: 0.6 },
};

function ref(value: unknown, allowVideo = false): string {
  const s = typeof value === "string" ? value.trim() : "";
  return s && parseInputRef(s, { allowVideo }) ? s : "";
}

export function buildVideoBgChangeWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const action = VIDEO_BG_CHANGE_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!videoRef) throw new Error(`${action}: source run has no video`);
  for (const id of Object.values(VBC_NODES)) {
    if (!workflow[id])
      throw new Error(`${action}: workflow is missing node ${id}`);
  }
  setNodeInput(workflow, VBC_NODES.load, "file", videoRef);
  setNodeInput(
    workflow,
    VBC_NODES.slice,
    "duration",
    VIDEO_BG_CHANGE_MAX_SECONDS,
  );

  const rawImage = params.secondRefImage;
  const image = ref(rawImage);
  if (typeof rawImage === "string" && rawImage.trim() && !image)
    throw new Error(
      `${action}: secondRefImage must be an uploaded image ref ("name.png [input]")`,
    );
  const rawVideo = params.backgroundVideo;
  const bgVideo = ref(rawVideo, true);
  if (typeof rawVideo === "string" && rawVideo.trim() && !bgVideo)
    throw new Error(
      `${action}: backgroundVideo must be an uploaded video ref ("name.mp4 [input]")`,
    );

  const wantBlur = params.background === "blur";
  const mode: VideoBgMode = wantBlur
    ? "blur"
    : bgVideo
      ? "video"
      : image
        ? "image"
        : "blur";

  if (mode === "image") {
    setNodeInput(workflow, VBC_NODES.bgImage, "image", image);
    setNodeInput(workflow, VBC_NODES.composite, "background", [
      VBC_NODES.bgImage,
      0,
    ]);
  } else if (mode === "video") {
    setNodeInput(workflow, VBC_NODES.bgVideo, "file", bgVideo);
    setNodeInput(workflow, VBC_NODES.composite, "background", [
      VBC_NODES.bgFrames,
      0,
    ]);
  } else {
    delete workflow[VBC_NODES.composite].inputs.background;
  }
  if (mode !== "image") delete workflow[VBC_NODES.bgImage];
  if (mode !== "video") {
    delete workflow[VBC_NODES.bgVideo];
    delete workflow[VBC_NODES.bgFrames];
  }

  // Output fps = source fps: the probed value when the client sent one.
  const sourceFps = normalizeFps(params.sourceFps);
  if (sourceFps !== null)
    setNodeInput(workflow, VBC_NODES.create, "fps", sourceFps);

  setNodeInput(
    workflow,
    VBC_NODES.subjectText,
    "text",
    videoBgSubject(params.subject),
  );

  const blendKey = typeof params.blend === "string" ? params.blend : "";
  const blend = VIDEO_BG_BLEND[blendKey] ?? VIDEO_BG_BLEND.natural;
  setNodeInput(workflow, VBC_NODES.composite, "light_wrap", blend.lightWrap);
  setNodeInput(
    workflow,
    VBC_NODES.composite,
    "color_match",
    mode === "blur" ? 0 : blend.colorMatch,
  );

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: "",
      posTextInputName: "",
      negTextId: "",
      latentDimsId: "",
      imageInputId: VBC_NODES.load,
    },
    seed: typeof job?.seed === "number" ? job.seed : 0,
  };
}

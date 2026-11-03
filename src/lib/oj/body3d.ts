/**
 * "Body 3D" (packs/sam3d-body/body_3d.json): a photo or a clip → fitted 3D
 * human body (Meta SAM 3D Body, core ComfyUI nodes only). RT-DETR v4 finds
 * the people, SAM3DBody_Predict fits an MHR body + hands per person,
 * SAM3DBody_FaceExpression adds the face, SAM3DBody_Smooth steadies the
 * motion (clips only) and SAM3DBody_Render draws the body over the source.
 * BuildPoseFile → SaveGLB writes the body file: an animated .glb mesh or a
 * .bvh skeleton.
 *
 * Source: the job's clip (first BODY_3D_MAX_SECONDS, render saved as mp4),
 * or its image when there is no clip or params.media === "image" (render
 * saved as png). Knobs (params): view mesh | solo | skeleton, file glb | bvh,
 * face on | off, smooth on | off (clips only).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";

export const BODY_3D_ACTION = "body_3d";

/** Clip length the graph keeps (Video Slice duration). */
export const BODY_3D_MAX_SECONDS = 10;

/** BuildPoseFile fps for a single photo (no source rate to copy). */
const PHOTO_FPS = 24;

export type Body3dView = "mesh" | "solo" | "skeleton";
export type Body3dFile = "glb" | "bvh";

/** Node ids in body_3d.json. */
export const BODY_ID = {
  loadVideo: "1",
  slice: "2",
  components: "3",
  loadImage: "4",
  detect: "6",
  predict: "8",
  face: "9",
  smooth: "10",
  render: "11",
  createVideo: "12",
  saveVideo: "13",
  poseFile: "14",
  saveFile: "15",
  saveImage: "16",
} as const;

const VIDEO_ONLY = [
  BODY_ID.loadVideo,
  BODY_ID.slice,
  BODY_ID.components,
  BODY_ID.createVideo,
  BODY_ID.saveVideo,
];
const PHOTO_ONLY = [BODY_ID.loadImage, BODY_ID.saveImage];

function str(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isOff(value: unknown): boolean {
  if (value === false) return true;
  return ["off", "false", "none", "0", "no"].includes(str(value));
}

export function body3dView(value: unknown): Body3dView {
  const v = str(value);
  return v === "solo" || v === "skeleton" ? v : "mesh";
}

export function body3dFile(value: unknown): Body3dFile {
  return str(value) === "bvh" ? "bvh" : "glb";
}

/** Point every link that reads `from` at `to` (same output slot). */
function relink(workflow: Workflow, from: string, to: string, slot?: number): void {
  for (const node of Object.values(workflow)) {
    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      if (
        Array.isArray(value) &&
        value[0] === from &&
        (slot === undefined || value[1] === slot)
      ) {
        node.inputs[key] = [to, slot === undefined ? value[1] : 0];
      }
    }
  }
}

/** Replace every dotted sub-input of a dynamic combo (`key.*`). */
function setDynamicCombo(
  workflow: Workflow,
  id: string,
  key: string,
  value: string,
  sub: Record<string, unknown>,
): void {
  const inputs = workflow[id].inputs;
  for (const k of Object.keys(inputs)) {
    if (k.startsWith(`${key}.`)) delete inputs[k];
  }
  inputs[key] = value;
  for (const [k, v] of Object.entries(sub)) inputs[`${key}.${k}`] = v;
}

export function buildBody3dWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  const imageRef = comfyImageRefFromViewUrl(job?.images?.[0]);
  const isVideo = Boolean(videoRef) && params.media !== "image";
  if (!isVideo && !imageRef) {
    throw new Error(`${BODY_3D_ACTION}: source run has no image or video`);
  }
  for (const id of Object.values(BODY_ID)) {
    if (!workflow[id]) {
      throw new Error(`${BODY_3D_ACTION}: workflow is missing node ${id}`);
    }
  }

  if (isVideo) {
    setNodeInput(workflow, BODY_ID.loadVideo, "file", videoRef);
    setNodeInput(workflow, BODY_ID.slice, "duration", BODY_3D_MAX_SECONDS);
    for (const id of PHOTO_ONLY) delete workflow[id];
    if (isOff(params.smooth)) {
      relink(workflow, BODY_ID.smooth, BODY_ID.face);
      delete workflow[BODY_ID.smooth];
    }
  } else {
    setNodeInput(workflow, BODY_ID.loadImage, "image", imageRef);
    // Frames come from the photo; the clip-only nodes go.
    relink(workflow, BODY_ID.components, BODY_ID.loadImage, 0);
    relink(workflow, BODY_ID.smooth, BODY_ID.face);
    delete workflow[BODY_ID.smooth];
    for (const id of VIDEO_ONLY) delete workflow[id];
    setNodeInput(workflow, BODY_ID.poseFile, "fps", PHOTO_FPS);
  }

  if (isOff(params.face)) {
    relink(workflow, BODY_ID.face, BODY_ID.predict);
    delete workflow[BODY_ID.face];
  }

  const view = body3dView(params.view);
  if (view === "solo") {
    // Body on a plain background: no source frames behind it.
    delete workflow[BODY_ID.render].inputs.background;
  } else if (view === "skeleton") {
    setDynamicCombo(workflow, BODY_ID.render, "render_style", "openpose_2d", {
      marker_radius_px: 4,
      stick_width_px: 4,
      limb_alpha: 0.6,
      face_style: "disabled",
      hand_style: "dwpose",
      person_palette_falloff: 0.6,
    });
  }

  if (body3dFile(params.file) === "bvh") {
    setDynamicCombo(workflow, BODY_ID.poseFile, "format", "bvh", { units: "cm" });
  }

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: "",
      posTextInputName: "",
      negTextId: "",
      latentDimsId: "",
      imageInputId: isVideo ? BODY_ID.loadVideo : BODY_ID.loadImage,
    },
    seed: typeof job?.seed === "number" ? job.seed : 0,
  };
}

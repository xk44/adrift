/**
 * Image-in Wan video builders for pack "wan22" (presets in ./wanMotionPresets).
 *
 * wan_motion (packs/wan22/wan_motion.json) carries two model branches that
 * share the text encoder, VAE, source image, prompts, WanImageToVideo and
 * the decode/save tail:
 *   - Wan2.1 I2V 480p + lightx2v distill + one motion LoRA, CLIP-vision
 *     conditioned, single KSampler (nodes 10-24);
 *   - Wan2.2 I2V high/low + wan_speed lightx2v 1022 pair + a hi/lo motion
 *     LoRA pair, two KSamplerAdvanced split 2/4 (nodes 30-53).
 * The builder keeps the preset's branch and deletes the other.
 *
 * wan_camera (packs/wan22/wan_camera.json): Wan2.2 Fun Camera hi/lo with the
 * same wan_speed pair; WanCameraEmbedding drives the pose and feeds its
 * width/height/length into WanCameraImageToVideo.
 *
 * "quality" mode drops the distill/speed LoRAs and samples 20 steps
 * (Wan2.1: cfg 5, shift 3; Wan2.2: cfg 3.5, shift 8, split 10/20). Fast
 * wan_camera keeps the speed LoRAs but samples 8 steps (split 4/8).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import {
  WAN_CAMERA_ACTION,
  WAN_MOTION_ACTION,
  getWanCameraPose,
  getWanMotionPreset,
  isQualityMode,
  wanCameraPrompt,
  wanCameraSpeed,
  wanDims,
  wanLength,
  wanMotionLength,
  wanMotionPrompt,
} from "./wanMotionPresets";

export { WAN_CAMERA_ACTION, WAN_MOTION_ACTION } from "./wanMotionPresets";

/** Node ids in packs/wan22/wan_motion.json and wan_camera.json. */
export const WAN_NODES = {
  clip: "1",
  vae: "2",
  image: "3",
  pos: "4",
  neg: "5",
  i2v: "6",
  // Wan2.1 branch
  unet21: "10",
  distill21: "11",
  lora21: "12",
  shift21: "20",
  clipVision: "21",
  clipVisionEncode: "22",
  sampler21: "24",
  // Wan2.2 branch (also Fun Camera)
  unetHi: "30",
  unetLo: "31",
  speedHi: "32",
  speedLo: "33",
  loraHi: "34",
  loraLo: "35",
  cameraEmbed: "40",
  shiftHi: "50",
  shiftLo: "51",
  samplerHi: "52",
  samplerLo: "53",
  decode: "60",
  save: "62",
} as const;

const N = WAN_NODES;
const WAN21_NODES = [
  N.unet21,
  N.distill21,
  N.lora21,
  N.shift21,
  N.clipVision,
  N.clipVisionEncode,
  N.sampler21,
];
const WAN22_NODES = [
  N.unetHi,
  N.unetLo,
  N.speedHi,
  N.speedLo,
  N.loraHi,
  N.loraLo,
  N.shiftHi,
  N.shiftLo,
  N.samplerHi,
  N.samplerLo,
];

type BuildResult = { workflow: Workflow; slots: WorkflowSlots; seed: number };

function requireNodes(workflow: Workflow, action: string, ids: string[]): void {
  const missing = ids.filter((id) => !workflow[id]);
  if (missing.length) {
    throw new Error(
      `${action}: workflow is missing node(s) ${missing.join(", ")}`,
    );
  }
}

/** Remove a pass-through model node, pointing its consumers at its input. */
function bypassModelNode(workflow: Workflow, id: string): void {
  const node = workflow[id];
  if (!node) return;
  const upstream = node.inputs.model;
  delete workflow[id];
  for (const other of Object.values(workflow)) {
    for (const [key, value] of Object.entries(other.inputs)) {
      if (Array.isArray(value) && value[0] === id) other.inputs[key] = upstream;
    }
  }
}

function seedOf(params: Record<string, unknown>): number {
  return typeof params.seed === "number" && Number.isFinite(params.seed)
    ? params.seed
    : Math.floor(Math.random() * 2 ** 32);
}

function sourceImageRef(
  action: string,
  sourceRun: ImagineRun,
  index: number,
): string {
  const ref = comfyImageRefFromViewUrl(sourceRun.jobs[index]?.images?.[0]);
  if (!ref) throw new Error(`${action}: source run has no image`);
  return ref;
}

/**
 * wan_camera fast mode: Fun Camera + the 4-step lightx2v pair sampled at 8
 * steps. At 4 steps the camera clips grow a cross-hatch mesh by the last
 * frames (Zoom In on a night market, frame 80); 6 and 8 steps were both
 * clean on GPU, 8 keeps a margin for ~15 s more per clip.
 */
export const WAN_CAMERA_FAST_STEPS = 8;

/** Shared high/low KSamplerAdvanced setup (Wan2.2 + Fun Camera). */
function setDualSampler(
  workflow: Workflow,
  seed: number,
  quality: boolean,
  shift: number,
  fastSteps = 4,
): void {
  const steps = quality ? 20 : fastSteps;
  const split = steps / 2;
  const cfg = quality ? 3.5 : 1;
  setNodeInput(workflow, N.shiftHi, "shift", shift);
  setNodeInput(workflow, N.shiftLo, "shift", shift);
  for (const id of [N.samplerHi, N.samplerLo]) {
    setNodeInput(workflow, id, "steps", steps);
    setNodeInput(workflow, id, "cfg", cfg);
  }
  setNodeInput(workflow, N.samplerHi, "noise_seed", seed);
  setNodeInput(workflow, N.samplerHi, "end_at_step", split);
  setNodeInput(workflow, N.samplerLo, "start_at_step", split);
  if (quality) {
    bypassModelNode(workflow, N.speedHi);
    bypassModelNode(workflow, N.speedLo);
  }
}

function slotsFor(
  posId: string,
  latentId: string,
  imageId: string,
): WorkflowSlots {
  return {
    ksamplerId: "",
    posTextId: posId,
    posTextInputName: "text",
    negTextId: "",
    latentDimsId: latentId,
    imageInputId: imageId,
  };
}

/**
 * params: preset (WAN_MOTION_PRESETS id), prompt (subject; whole prompt for
 * "none"), mode ("fast" | "quality"), resolution ("480p" | "720p"),
 * duration ("auto" | "5s" | "3s"; auto = preset's recommended length), seed.
 */
export function buildWanMotionWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): BuildResult {
  const workflow = cloneWorkflow(baseWorkflow);
  const imageRef = sourceImageRef(WAN_MOTION_ACTION, sourceRun, sourceJobIndex);
  const preset = getWanMotionPreset(params.preset);
  const quality = isQualityMode(params.mode);
  const seed = seedOf(params);
  requireNodes(workflow, WAN_MOTION_ACTION, [N.image, N.pos, N.i2v, N.decode]);

  if (preset.base === "wan21") {
    requireNodes(workflow, WAN_MOTION_ACTION, WAN21_NODES);
    for (const id of WAN22_NODES) delete workflow[id];
    if (preset.loras[0]) {
      setNodeInput(workflow, N.lora21, "lora_name", preset.loras[0]);
      setNodeInput(workflow, N.lora21, "strength_model", preset.strength);
    } else {
      bypassModelNode(workflow, N.lora21);
    }
    setNodeInput(workflow, N.sampler21, "seed", seed);
    if (quality) {
      bypassModelNode(workflow, N.distill21);
      setNodeInput(workflow, N.sampler21, "steps", 20);
      setNodeInput(workflow, N.sampler21, "cfg", 5);
      setNodeInput(workflow, N.shift21, "shift", 3);
    } else {
      setNodeInput(workflow, N.sampler21, "steps", 4);
      setNodeInput(workflow, N.sampler21, "cfg", 1);
      setNodeInput(workflow, N.shift21, "shift", 5);
    }
    setNodeInput(workflow, N.decode, "samples", [N.sampler21, 0]);
  } else {
    requireNodes(workflow, WAN_MOTION_ACTION, WAN22_NODES);
    for (const id of WAN21_NODES) delete workflow[id];
    delete workflow[N.i2v].inputs.clip_vision_output;
    const [hi, lo] = preset.loras;
    if (hi && lo) {
      setNodeInput(workflow, N.loraHi, "lora_name", hi);
      setNodeInput(workflow, N.loraLo, "lora_name", lo);
      setNodeInput(workflow, N.loraHi, "strength_model", preset.strength);
      setNodeInput(workflow, N.loraLo, "strength_model", preset.strength);
    } else {
      bypassModelNode(workflow, N.loraHi);
      bypassModelNode(workflow, N.loraLo);
    }
    setDualSampler(workflow, seed, quality, quality ? 8 : 5);
    setNodeInput(workflow, N.decode, "samples", [N.samplerLo, 0]);
  }

  const dims = wanDims(params.resolution, sourceRun.width, sourceRun.height);
  setNodeInput(workflow, N.image, "image", imageRef);
  setNodeInput(workflow, N.pos, "text", wanMotionPrompt(preset, params.prompt));
  setNodeInput(workflow, N.i2v, "width", dims.width);
  setNodeInput(workflow, N.i2v, "height", dims.height);
  setNodeInput(
    workflow,
    N.i2v,
    "length",
    wanMotionLength(preset, params.duration),
  );

  return { workflow, slots: slotsFor(N.pos, N.i2v, N.image), seed };
}

/**
 * params: camera (WAN_CAMERA_POSES id or pose name), cameraSpeed
 * ("normal" | "slow" | "fast" or a number), prompt (optional scene),
 * mode, resolution, duration, seed.
 */
export function buildWanCameraWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): BuildResult {
  const workflow = cloneWorkflow(baseWorkflow);
  const imageRef = sourceImageRef(WAN_CAMERA_ACTION, sourceRun, sourceJobIndex);
  requireNodes(workflow, WAN_CAMERA_ACTION, [
    N.image,
    N.pos,
    N.i2v,
    N.cameraEmbed,
    N.speedHi,
    N.speedLo,
    N.shiftHi,
    N.shiftLo,
    N.samplerHi,
    N.samplerLo,
  ]);
  const pose = getWanCameraPose(params.camera);
  const seed = seedOf(params);
  const dims = wanDims(params.resolution, sourceRun.width, sourceRun.height);

  setNodeInput(workflow, N.image, "image", imageRef);
  setNodeInput(workflow, N.pos, "text", wanCameraPrompt(pose, params.prompt));
  setNodeInput(workflow, N.cameraEmbed, "camera_pose", pose.pose);
  setNodeInput(
    workflow,
    N.cameraEmbed,
    "speed",
    wanCameraSpeed(params.cameraSpeed),
  );
  setNodeInput(workflow, N.cameraEmbed, "width", dims.width);
  setNodeInput(workflow, N.cameraEmbed, "height", dims.height);
  setNodeInput(workflow, N.cameraEmbed, "length", wanLength(params.duration));
  setDualSampler(
    workflow,
    seed,
    isQualityMode(params.mode),
    8,
    WAN_CAMERA_FAST_STEPS,
  );

  return { workflow, slots: slotsFor(N.pos, N.cameraEmbed, N.image), seed };
}

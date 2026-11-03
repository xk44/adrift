/**
 * LTX VFX tools (packs/ltx25/vfx_*.json): LTX-2.5 LoRAs from Lightricks
 * on the distilled LTX-2.5 22B model, core ComfyUI nodes only.
 *
 * Video in (IC-LoRA, the source clip is the in-context reference):
 *   ltx_alpha_matte   Alpha-Gen 0.9        clip -> grayscale alpha matte
 *   ltx_clean_plate   Clean-Plate 1.0      clip -> same shot with no people
 *   ltx_day_to_night  Day-To-Night 0.9     clip -> relit as night
 *   ltx_add_water     Water-Simulation 0.9 clip -> clip with water added
 *   ltx_ripple        LTX Ripple v1.1      clip + edited first frame -> edit
 *                                          carried through the clip
 *   ltx_edge_control  Union Control (2.3)  clip -> canny edges -> new look
 *   ltx_blockout_render Union Control (2.3) grey 3D blockout clip -> Depth
 *                                          Anything 3 depth -> rendered shot
 *   ltx_sdr_to_hdr    SDR-To-HDR 1.0       SDR clip -> HLG video + ACEScg EXR
 *                                          sequence (model space ACEScct)
 *   ltx_layout_render Layout-To-Render 1.0 layout / greybox clip (+ optional
 *                                          look frame) -> rendered shot,
 *                                          two-stage up to 1920x1088
 * Image in (LoRA on image-to-video):
 *   ltx_cinemagraph   Cinemagraph 0.9      photo -> looping cinemagraph
 *   ltx_slow_motion   Slow-Motion-Control  photo -> slow-motion clip
 *   ltx_exploded_view XPLDV v5             product photo -> exploded view
 * Painted keyframes in (IC-LoRA, control video built in-graph):
 *   ltx_paint_fluid   ainvfx-fluid         painted first (+ last) frame ->
 *                                          smoke / steam / fire
 *
 * The packs carry each model card's defaults; this builder patches the
 * source media, sizes (source orientation, card training sizes, /32), frame
 * count (8n+1 from the source length), prompts (card templates around the
 * user's words), LoRA strength, seed and, for slow motion, the conditioning
 * frame rate: Slow-Motion-Control reads speed as motion_fps = 24 / speed
 * while playback stays 24 fps.
 * License: LTX-2 / LTX-2.x Community License (all LoRAs and the base model;
 * Ripple, XPLDV and ainvfx-fluid are community LoRAs under the same terms).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { applyLtxExtraLora } from "./ltxCommunityLoras";
import { sdrToHdrExrDepth } from "./sdrToHdr";

export const LTX_ALPHA_MATTE_ACTION = "ltx_alpha_matte";
export const LTX_CLEAN_PLATE_ACTION = "ltx_clean_plate";
export const LTX_DAY_TO_NIGHT_ACTION = "ltx_day_to_night";
export const LTX_ADD_WATER_ACTION = "ltx_add_water";
export const LTX_CINEMAGRAPH_ACTION = "ltx_cinemagraph";
export const LTX_SLOW_MOTION_ACTION = "ltx_slow_motion";
export const LTX_RIPPLE_ACTION = "ltx_ripple";
export const LTX_EDGE_CONTROL_ACTION = "ltx_edge_control";
export const LTX_BLOCKOUT_RENDER_ACTION = "ltx_blockout_render";
export const LTX_EXPLODED_VIEW_ACTION = "ltx_exploded_view";
export const LTX_PAINT_FLUID_ACTION = "ltx_paint_fluid";
export const LTX_SDR_TO_HDR_ACTION = "ltx_sdr_to_hdr";
export const LTX_LAYOUT_RENDER_ACTION = "ltx_layout_render";

/** Playback frame rate of every LTX VFX output. */
export const LTX_VFX_FPS = 24;

interface VfxSpec {
  source: "video" | "image";
  /** Source sampling rate (video tools). */
  fps: number;
  /** Frame cap (8n+1). */
  maxFrames: number;
  /** Landscape size; portrait sources swap it. */
  width: number;
  height: number;
  /** Prompt text is required. */
  promptRequired: boolean;
  /** Default LoRA strength. */
  strength: number;
  /**
   * Second image (params.secondRefImage, "name.png [input]") into the pack's
   * other LoadImage: required (Ripple's edited first frame) or optional
   * (Paint Fluid's last frame; defaults to the first) or a look frame
   * (Layout to Render): its LTXVImgToVideoInplace chain is dropped when absent.
   */
  second?: "required" | "optional" | "look";
}

export const LTX_VFX_SPECS: Record<string, VfxSpec> = {
  [LTX_ALPHA_MATTE_ACTION]: {
    source: "video",
    fps: 24,
    maxFrames: 97,
    width: 960,
    height: 544,
    promptRequired: false,
    strength: 1.0,
  },
  [LTX_CLEAN_PLATE_ACTION]: {
    source: "video",
    fps: 25,
    maxFrames: 97,
    width: 1024,
    height: 576,
    promptRequired: false,
    strength: 1.0,
  },
  [LTX_DAY_TO_NIGHT_ACTION]: {
    source: "video",
    fps: 24,
    maxFrames: 97,
    width: 768,
    height: 448,
    promptRequired: false,
    strength: 1.0,
  },
  [LTX_ADD_WATER_ACTION]: {
    source: "video",
    fps: 24,
    maxFrames: 121,
    width: 960,
    height: 544,
    promptRequired: true,
    strength: 1.0,
  },
  [LTX_CINEMAGRAPH_ACTION]: {
    source: "image",
    fps: 24,
    maxFrames: 97,
    width: 704,
    height: 512,
    promptRequired: true,
    strength: 1.1,
  },
  [LTX_SLOW_MOTION_ACTION]: {
    source: "image",
    fps: 24,
    maxFrames: 121,
    width: 1280,
    height: 704,
    promptRequired: true,
    strength: 1.0,
  },
  [LTX_RIPPLE_ACTION]: {
    source: "video",
    fps: 24,
    maxFrames: 121,
    width: 960,
    height: 544,
    promptRequired: false,
    strength: 1.35,
    second: "required",
  },
  [LTX_EDGE_CONTROL_ACTION]: {
    source: "video",
    fps: 24,
    maxFrames: 97,
    width: 960,
    height: 512,
    promptRequired: true,
    strength: 1.0,
  },
  [LTX_BLOCKOUT_RENDER_ACTION]: {
    source: "video",
    fps: 24,
    maxFrames: 97,
    width: 960,
    height: 512,
    promptRequired: true,
    strength: 1.0,
  },
  [LTX_SDR_TO_HDR_ACTION]: {
    source: "video",
    fps: 24,
    maxFrames: 121,
    width: 960,
    height: 544,
    promptRequired: false,
    strength: 1.0,
  },
  [LTX_EXPLODED_VIEW_ACTION]: {
    source: "image",
    fps: 24,
    maxFrames: 121,
    width: 960,
    height: 544,
    promptRequired: false,
    strength: 0.5,
  },
  [LTX_PAINT_FLUID_ACTION]: {
    source: "image",
    fps: 24,
    maxFrames: 121,
    width: 960,
    height: 512,
    promptRequired: false,
    strength: 1.0,
    second: "optional",
  },
  // Card: stage 1 960x544, stage 2 1920x1088 (/64), example length 81.
  [LTX_LAYOUT_RENDER_ACTION]: {
    source: "video",
    fps: 24,
    maxFrames: 81,
    width: 1920,
    height: 1088,
    promptRequired: true,
    strength: 1.0,
    second: "look",
  },
};

/** Image-in tools that take the Extra LTX LoRA (not the painted IC tool). */
export const LTX_VFX_IC_IMAGE_ACTIONS: ReadonlySet<string> = new Set([
  LTX_PAINT_FLUID_ACTION,
]);

export const LTX_VFX_ACTIONS = Object.keys(LTX_VFX_SPECS);
export const LTX_VFX_VIDEO_ACTIONS = LTX_VFX_ACTIONS.filter(
  (a) => LTX_VFX_SPECS[a].source === "video",
);

/** Slow-Motion-Control speeds (card): playback speed vs real time. */
export const LTX_SLOWMO_SPEEDS = [0.5, 0.2, 0.1, 0.05, 0.025] as const;
export const LTX_SLOWMO_DEFAULT_SPEED = 0.2;

export function ltxSlowmoSpeed(value: unknown): number {
  const v = typeof value === "string" ? Number(value) : value;
  return typeof v === "number" &&
    (LTX_SLOWMO_SPEEDS as readonly number[]).includes(v)
    ? v
    : LTX_SLOWMO_DEFAULT_SPEED;
}

/** Conditioning frame rate the LoRA reads: 24 / speed. */
export function ltxSlowmoMotionFps(speed: number): number {
  return Math.round((LTX_VFX_FPS / speed) * 100) / 100;
}

/** Water-Simulation strength: 1.0-1.05 subtle, up to 1.45 for drama. */
export const LTX_WATER_STRENGTHS = [1.0, 1.25, 1.45] as const;

/** Cinemagraph loop lengths (frames, 8n+1); 25 is the card's best. */
export const LTX_CINEMAGRAPH_FRAMES = [25, 49, 97] as const;

function positive(...values: unknown[]): number | undefined {
  for (const v of values) {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/** LoRA strength from a picker value, clamped to 0.5..2 (else the default). */
export function ltxVfxStrength(action: string, value: unknown): number {
  const v = positive(value);
  const def = LTX_VFX_SPECS[action]?.strength ?? 1;
  return v === undefined ? def : Math.min(2, Math.max(0.5, v));
}

/**
 * 8n+1 frames covering `seconds` at `fps`, between 17 and `max`. Unknown
 * length: `max`.
 */
export function ltxVfxFrames(
  seconds: number | undefined,
  fps: number,
  max: number,
): number {
  if (!seconds) return max;
  const n = Math.floor(seconds * fps);
  const f = Math.floor((n - 1) / 8) * 8 + 1;
  return Math.min(max, Math.max(17, f));
}

/** Card size in the source orientation (square counts as landscape). */
export function ltxVfxDims(
  action: string,
  width?: number,
  height?: number,
): { width: number; height: number } {
  const spec = LTX_VFX_SPECS[action];
  const portrait = !!width && !!height && height > width;
  return portrait
    ? { width: spec.height, height: spec.width }
    : { width: spec.width, height: spec.height };
}

/** Collapse whitespace, cap length. */
function clean(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, 1500)
    : "";
}

/** Strip a trailing period so the text slots into a template sentence. */
const clause = (s: string) => s.replace(/[.\s]+$/, "");

/** The card says: no "slow motion" wording, the LoRA reads the frame rate. */
export function stripSlowMotionWords(text: string): string {
  return text
    .replace(
      /\b(?:in\s+)?(?:super\s+|ultra\s+|extreme\s+)?slow[\s-]*mo(?:tion)?\b,?/gi,
      "",
    )
    .replace(/\s+([,.])/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/^[,\s]+/, "")
    .trim();
}

/** Ripple card default prompt (works with no description of the edit). */
export const LTX_RIPPLE_PROMPT =
  "Use the reference video for motion, timing, camera movement, composition, and unchanged scene content, while consistently propagating the visual edit established in the first frame throughout the video.";

/** ainvfx-fluid trigger, first in the prompt. */
export const LTX_FLUID_TRIGGER = "ainvfxfluid";

/**
 * SDR-To-HDR caption. The card's pipeline conditions on a precomputed scene
 * embedding of one fixed caption (sdr-to-hdr-scene-emb.safetensors), which
 * core ComfyUI cannot load; this neutral caption stands in for it.
 */
export const LTX_SDR_TO_HDR_PROMPT =
  "The same shot graded for high dynamic range: identical content, composition, framing, camera movement and motion; natural colour, highlight and shadow detail preserved.";

export const LTX_CLEAN_PLATE_NEGATIVE =
  "person, people, human, figure, limb, arm, hand, leg, body part, backpack, shadow of a person, leftover people, leftover figures, ghosting, semi-transparent remnants, blurry, soft, distorted, inconsistent motion, jitter, worst quality, cartoon, video game, ugly";

/** Positive prompt per tool: the model card's template around the user's words. */
export function ltxVfxPrompt(action: string, text: string): string {
  const t = clause(text);
  switch (action) {
    case LTX_ALPHA_MATTE_ACTION:
      return ""; // card: always an empty prompt
    case LTX_CLEAN_PLATE_ACTION:
      return `An empty clean plate of the exact same location${t ? ` (${t})` : ""}: identical background, environment, structures and lighting as the source video, with no people, no humans, no figures, and no body parts such as arms, hands or legs anywhere in the frame. Static photorealistic footage, natural light, high detail.`;
    case LTX_DAY_TO_NIGHT_ACTION:
      return `A realistic nighttime scene${t ? `: ${t}` : ""}. Only the lighting changes from day to night; identical composition, framing, camera movement and motion.`;
    case LTX_ADD_WATER_ACTION:
      return `Reference shows the original dry scene. Edited shows the same scene with water added. ADD WATER ${t}. Subject identity, clothing, framing, and background geometry are identical to the reference; only water-related elements differ between reference and edited.`;
    case LTX_CINEMAGRAPH_ACTION:
      if (/^CINEMAGRAPH_MOTION\b/.test(t)) return t;
      return `CINEMAGRAPH_MOTION, tripod locked-off static camera, zero camera movement, only the ${t.replace(/^(?:the|a|an)\s+/i, "")} moves, everything else stays perfectly still, seamless natural loop`;
    case LTX_SLOW_MOTION_ACTION:
      return stripSlowMotionWords(text);
    case LTX_RIPPLE_ACTION:
      // Card: optionally describe the changed first frame after the default.
      return t ? `${LTX_RIPPLE_PROMPT} ${t}.` : LTX_RIPPLE_PROMPT;
    case LTX_SDR_TO_HDR_ACTION:
      return LTX_SDR_TO_HDR_PROMPT; // no user text: the LoRA is not prompted
    case LTX_EDGE_CONTROL_ACTION:
      return t ? `${t}.` : "";
    case LTX_BLOCKOUT_RENDER_ACTION:
      return t
        ? `${t}. A fully rendered, finished shot with real materials, textures and lighting; layout, scale and camera motion follow the blockout.`
        : "";
    case LTX_LAYOUT_RENDER_ACTION:
      // Card: 1-2 sentences of the finished shot, matching the first frame.
      return t ? `${t}.` : "";
    case LTX_EXPLODED_VIEW_ACTION: {
      if (/exploded view/i.test(t)) return `${t}.`;
      const subject = t ? t.replace(/^(?:the|a|an)\s+/i, "") : "object";
      return `The ${subject} separates into an ordered exploded view. Its outer parts move outward along controlled paths, revealing the internal components underneath. The parts settle into an organized layered arrangement around the exposed core while retaining their original shapes. The camera holds steady. The lighting from the image remains consistent throughout the continuous shot.`;
    }
    case LTX_PAINT_FLUID_ACTION: {
      const body = t.replace(
        new RegExp(`^${LTX_FLUID_TRIGGER}[,\\s]*`, "i"),
        "",
      );
      return `${LTX_FLUID_TRIGGER}, ${body || "smoke plume"}`;
    }
    default:
      return text;
  }
}

function nodeIdOf(workflow: Workflow, classType: string): string | undefined {
  return Object.keys(workflow).find(
    (id) => workflow[id]?.class_type === classType,
  );
}

function nodeIdsOf(workflow: Workflow, classType: string): string[] {
  return Object.keys(workflow).filter(
    (id) => workflow[id]?.class_type === classType,
  );
}

/**
 * Remove an optional still (LoadImage -> ImageScale -> LTXVPreprocess) and
 * every LTXVImgToVideoInplace it feeds; their consumers take the latent the
 * inplace node received.
 */
function dropImageGuide(workflow: Workflow, loadId: string): void {
  const chain = new Set([loadId]);
  const refsChain = (id: string) =>
    Object.values(workflow[id].inputs).some(
      (v) => Array.isArray(v) && chain.has(String(v[0])),
    );
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of Object.keys(workflow)) {
      const cls = workflow[id].class_type;
      if (
        !chain.has(id) &&
        (cls === "ImageScale" || cls === "LTXVPreprocess") &&
        refsChain(id)
      ) {
        chain.add(id);
        grew = true;
      }
    }
  }
  for (const id of nodeIdsOf(workflow, "LTXVImgToVideoInplace")) {
    if (!refsChain(id)) continue;
    const latent = workflow[id].inputs.latent;
    for (const node of Object.values(workflow)) {
      for (const [key, v] of Object.entries(node.inputs)) {
        if (Array.isArray(v) && String(v[0]) === id) node.inputs[key] = latent;
      }
    }
    delete workflow[id];
  }
  for (const id of chain) delete workflow[id];
}

export function buildLtxVfxWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
  actionOverride?: string,
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const action =
    actionOverride ?? (typeof params.action === "string" ? params.action : "");
  const spec = LTX_VFX_SPECS[action];
  if (!spec) throw new Error(`ltx_vfx: unknown action "${action}"`);

  const text = clean(params.prompt ?? params.text);
  if (spec.promptRequired && !text) {
    throw new Error(`${action}: a prompt is required`);
  }
  const prompt = ltxVfxPrompt(action, text);
  if (spec.promptRequired && !prompt) {
    throw new Error(`${action}: a prompt is required`);
  }

  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const media = spec.source === "video" ? job?.videos?.[0] : job?.images?.[0];
  const ref = comfyImageRefFromViewUrl(media);
  if (!ref) throw new Error(`${action}: source run has no ${spec.source}`);

  const loadClass = spec.source === "video" ? "LoadVideo" : "LoadImage";
  const load = nodeIdOf(workflow, loadClass);
  const scale = nodeIdOf(workflow, "ImageScale");
  const latent = nodeIdOf(workflow, "EmptyLTXVLatentVideo");
  const audio = nodeIdOf(workflow, "LTXVEmptyLatentAudio");
  const cond = nodeIdOf(workflow, "LTXVConditioning");
  const lora = nodeIdOf(workflow, "LoraLoaderModelOnly");
  const pos = cond ? workflow[cond].inputs.positive : undefined;
  const neg = cond ? workflow[cond].inputs.negative : undefined;
  if (
    !load ||
    !scale ||
    !latent ||
    !audio ||
    !cond ||
    !lora ||
    !Array.isArray(pos) ||
    !Array.isArray(neg)
  ) {
    throw new Error(
      `${action}: workflow needs ${loadClass}, ImageScale, EmptyLTXVLatentVideo, LTXVEmptyLatentAudio, LTXVConditioning (wired prompts) and LoraLoaderModelOnly`,
    );
  }
  const posId = String(pos[0]);
  const negId = String(neg[0]);

  setNodeInput(workflow, load, spec.source === "video" ? "file" : "image", ref);

  if (spec.second) {
    const raw = params.secondRefImage ?? params.second_image;
    const secondRef =
      typeof raw === "string" && / \[input\]$/.test(raw.trim())
        ? raw.trim()
        : undefined;
    const secondLoad = nodeIdsOf(workflow, "LoadImage").find(
      (id) => id !== load,
    );
    if (!secondLoad) {
      throw new Error(`${action}: workflow needs a second LoadImage`);
    }
    if (!secondRef && spec.second === "required") {
      throw new Error(
        `${action}: secondRefImage must be an uploaded image ref ("name.png [input]")`,
      );
    }
    if (!secondRef && spec.second === "look") {
      dropImageGuide(workflow, secondLoad);
    } else {
      // Optional second frame (Paint Fluid's last frame): the first again.
      setNodeInput(workflow, secondLoad, "image", secondRef ?? ref);
    }
  }

  // Frames: video tools follow the source length; image tools pick a length.
  let frames: number;
  if (spec.source === "video") {
    const seconds = positive(
      params.video_seconds,
      sourceRun.params?.video_seconds,
    );
    frames = ltxVfxFrames(seconds, spec.fps, spec.maxFrames);
    const slice = nodeIdOf(workflow, "Video Slice");
    const sample = nodeIdOf(workflow, "VideoFrameSample");
    if (!slice || !sample) {
      throw new Error(
        `${action}: workflow needs Video Slice and VideoFrameSample`,
      );
    }
    setNodeInput(workflow, slice, "start_time", 0);
    setNodeInput(
      workflow,
      slice,
      "duration",
      Math.round((frames / spec.fps) * 10000) / 10000,
    );
    setNodeInput(workflow, sample, "num_frames", frames);
  } else if (action === LTX_CINEMAGRAPH_ACTION) {
    const f = positive(params.frames);
    frames = (LTX_CINEMAGRAPH_FRAMES as readonly number[]).includes(f ?? 0)
      ? f!
      : LTX_CINEMAGRAPH_FRAMES[0];
  } else {
    frames = spec.maxFrames;
  }

  const dims = ltxVfxDims(action, sourceRun.width, sourceRun.height);
  // Every ImageScale fits to the output size (source, edited / last frame).
  for (const id of nodeIdsOf(workflow, "ImageScale")) {
    setNodeInput(workflow, id, "width", dims.width);
    setNodeInput(workflow, id, "height", dims.height);
  }
  // Ripple: edited frame + source frames, cut back to the clip length.
  for (const id of nodeIdsOf(workflow, "ImageFromBatch")) {
    setNodeInput(workflow, id, "length", frames);
  }
  // Paint Fluid: black frames between the painted first and last frame.
  for (const id of nodeIdsOf(workflow, "EmptyImage")) {
    setNodeInput(workflow, id, "width", dims.width);
    setNodeInput(workflow, id, "height", dims.height);
    setNodeInput(workflow, id, "batch_size", frames - 2);
  }
  // Two-stage graphs sample stage 1 at half size, then upscale the latent x2.
  const half = !!nodeIdOf(workflow, "LTXVLatentUpsampler");
  setNodeInput(workflow, latent, "width", half ? dims.width / 2 : dims.width);
  setNodeInput(
    workflow,
    latent,
    "height",
    half ? dims.height / 2 : dims.height,
  );
  setNodeInput(workflow, latent, "length", frames);
  setNodeInput(workflow, audio, "frames_number", frames);

  // Conditioning frame rate: the clip's rate, or 24 / speed for slow motion
  // (audio latent follows so both streams span the same real time).
  let frameRate = spec.fps;
  if (action === LTX_SLOW_MOTION_ACTION) {
    frameRate = ltxSlowmoMotionFps(ltxSlowmoSpeed(params.speed));
  }
  setNodeInput(workflow, cond, "frame_rate", frameRate);
  setNodeInput(workflow, audio, "frame_rate", frameRate);
  // Playback: the clip's sampling rate (source audio stays in sync), else 24.
  const create = nodeIdOf(workflow, "CreateVideo");
  if (create) {
    setNodeInput(
      workflow,
      create,
      "fps",
      spec.source === "video" ? spec.fps : LTX_VFX_FPS,
    );
  }

  // SDR-To-HDR: the card fixes strength 1; params.exr picks the EXR depth.
  const fixedStrength = action === LTX_SDR_TO_HDR_ACTION;
  setNodeInput(
    workflow,
    lora,
    "strength_model",
    fixedStrength ? spec.strength : ltxVfxStrength(action, params.strength),
  );
  if (action === LTX_SDR_TO_HDR_ACTION) {
    for (const id of nodeIdsOf(workflow, "SaveImageAdvanced")) {
      if (workflow[id].inputs.format === "exr") {
        setNodeInput(
          workflow,
          id,
          "format.bit_depth",
          sdrToHdrExrDepth(params.exr),
        );
      }
    }
  }
  setNodeInput(workflow, posId, "text", prompt);
  // Image-in tools take an optional community LoRA after their own.
  if (spec.source === "image" && !LTX_VFX_IC_IMAGE_ACTIONS.has(action)) {
    applyLtxExtraLora(workflow, params, posId);
  }

  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? Math.floor(Math.abs(params.seed))
      : Math.floor(Math.random() * 2 ** 32);
  for (const id of nodeIdsOf(workflow, "RandomNoise")) {
    setNodeInput(workflow, id, "noise_seed", seed);
  }

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: posId,
      posTextInputName: "text",
      negTextId: negId,
      latentDimsId: "",
      imageInputId: load,
    },
    seed,
  };
}

/** One ActionBuilder per LTX VFX action (the action is fixed per entry). */
export const LTX_VFX_BUILDERS: Record<
  string,
  (
    baseWorkflow: Workflow,
    sourceRun: ImagineRun,
    sourceJobIndex: number,
    params: Record<string, unknown>,
  ) => { workflow: Workflow; slots: WorkflowSlots; seed: number }
> = Object.fromEntries(
  LTX_VFX_ACTIONS.map((action) => [
    action,
    (
      baseWorkflow: Workflow,
      sourceRun: ImagineRun,
      sourceJobIndex: number,
      params: Record<string, unknown>,
    ) =>
      buildLtxVfxWorkflow(
        baseWorkflow,
        sourceRun,
        sourceJobIndex,
        params,
        action,
      ),
  ]),
);

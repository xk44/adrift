/**
 * "Shots" and "Zooms" (packs/qwen-edit-2509/multi_shot.json): one image in,
 * nine re-framed views out, in ONE ComfyUI prompt. Qwen-Image-Edit-2509 +
 * Lightning 4-step + the Multiple-Angles LoRA (fal, trained on 2511; same
 * architecture, loads and steers 2509). Each of the graph's nine branches is
 * a TextEncodeQwenImageEditPlus -> ReferenceLatent -> KSampler -> VAEDecode
 * sharing the source latent; the graph saves the nine views as one batch
 * plus a 3x3 contact sheet (saved first, so it is the job's first image).
 *
 * Prompts use the LoRA's camera vocabulary ("<sks> <azimuth> <elevation>
 * <distance>") followed by a plain framing sentence; the sentence is what
 * separates e.g. medium from wide on a full-body source (the LoRA alone
 * renders "medium shot" as full length).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";

export const SHOTS_ACTION = "shots";
export const ZOOMS_ACTION = "zooms";

export interface MultiShotView {
  id: string;
  label: string;
  prompt: string;
}

const T = "<sks>";

/** Coverage set: nine distinct camera setups of the same moment. */
export const SHOT_VIEWS: MultiShotView[] = [
  {
    id: "establishing",
    label: "Establishing",
    prompt: `${T} front view elevated shot wide shot. Pull the camera far back for an establishing shot: the subject is small in the frame and the whole surrounding location is visible.`,
  },
  {
    id: "wide",
    label: "Wide",
    prompt: `${T} front view eye-level shot wide shot. Wide shot: zoom out, the subject is seen full length and small in the center of the frame, surrounded by the scene.`,
  },
  {
    id: "medium",
    label: "Medium",
    prompt: `${T} front-right quarter view eye-level shot close-up. Medium shot: step back from the close-up so the subject is seen from the top of the head down to the waist.`,
  },
  {
    id: "close_up",
    label: "Close-up",
    prompt: `${T} front view eye-level shot close-up. Close-up of the face and shoulders.`,
  },
  {
    id: "over_shoulder",
    label: "Over the shoulder",
    prompt: `${T} back-right quarter view eye-level shot close-up. Over-the-shoulder shot: the camera is just behind the subject's right shoulder, the back of the head and shoulder are large and out of focus in the foreground, looking past them at the scene ahead.`,
  },
  {
    id: "low_angle",
    label: "Low angle",
    prompt: `${T} front view low-angle shot medium shot. Worm's-eye view: the camera is near the ground looking up at the subject, with the sky behind.`,
  },
  {
    id: "high_angle",
    label: "High angle",
    prompt: `${T} front view high-angle shot medium shot. Bird's-eye view: the camera is high above looking down at the subject.`,
  },
  {
    id: "profile",
    label: "Profile",
    prompt: `${T} left side view eye-level shot close-up. Side profile: step back from the close-up so the subject is seen in profile from the top of the head down to the waist.`,
  },
  {
    id: "detail",
    label: "Detail",
    prompt: `${T} front view eye-level shot close-up. Extreme close-up macro detail shot of one small detail of the main subject, such as the hands, fabric texture or an accessory.`,
  },
];

const ZOOM_TIGHT_DEFAULT = [
  "Close-up: the face fills most of the frame, centered.",
  "Extreme close-up: zoom in until only the eyes and nose fill the frame.",
  "Macro shot: zoom all the way in on a single eye, filling the whole frame with fine detail.",
];

function zoomTight(target: string): string[] {
  return [
    `Close-up: ${target} fills most of the frame, centered.`,
    `Extreme close-up: zoom in further on ${target} until it fills the frame edge to edge.`,
    `Macro shot: zoom all the way in on the finest detail of ${target}, filling the whole frame with texture.`,
  ];
}

/** Zoom ladder, extreme wide -> macro, same front eye-level axis. */
export function zoomViews(target?: string): MultiShotView[] {
  const tight = target ? zoomTight(target) : ZOOM_TIGHT_DEFAULT;
  return [
    {
      id: "extreme_wide",
      label: "Extreme wide",
      prompt: `${T} front view eye-level shot wide shot. Extreme wide shot: zoom far out, the subject is a tiny figure in the center of a vast view of the whole location.`,
    },
    {
      id: "very_wide",
      label: "Very wide",
      prompt: `${T} front view eye-level shot wide shot. Very wide shot: zoom out, the subject is small in the center of the frame with lots of the surrounding location visible.`,
    },
    {
      id: "wide",
      label: "Wide",
      prompt: `${T} front view eye-level shot wide shot. Wide shot: the subject is seen full length in the center of the frame with the surrounding scene around them.`,
    },
    {
      id: "medium_wide",
      label: "Medium wide",
      prompt: `${T} front view eye-level shot medium shot. Medium wide shot: move the camera closer; the whole head and upper body are visible, the frame cuts off at the knees, the feet are not visible.`,
    },
    {
      id: "medium",
      label: "Medium",
      prompt: `${T} front view eye-level shot close-up. Medium shot: step back from the close-up so the subject is seen from the top of the head down to the waist; the top of the head is near the top edge.`,
    },
    {
      id: "medium_close",
      label: "Medium close-up",
      prompt: `${T} front view eye-level shot close-up. Medium close-up: the head, shoulders and chest of the subject fill the frame, centered.`,
    },
    {
      id: "close_up",
      label: "Close-up",
      prompt: `${T} front view eye-level shot close-up. ${tight[0]}`,
    },
    {
      id: "extreme_close",
      label: "Extreme close-up",
      prompt: `${T} front view eye-level shot close-up. ${tight[1]}`,
    },
    {
      id: "macro",
      label: "Macro",
      prompt: `${T} front view eye-level shot close-up. ${tight[2]}`,
    },
  ];
}

const MAX_TEXT = 300;

function cleanText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT)
    : "";
}

/** The nine prompts an action queues (exported for tests / UI captions). */
export function multiShotPrompts(
  action: string,
  params: Record<string, unknown> = {},
): MultiShotView[] {
  if (action === ZOOMS_ACTION) {
    const target = cleanText(params.target ?? params.text ?? params.prompt);
    return zoomViews(target || undefined);
  }
  if (action !== SHOTS_ACTION) {
    throw new Error(`multi-shot: unknown action ${action}`);
  }
  const extra = cleanText(params.text ?? params.prompt);
  return SHOT_VIEWS.map((v) => ({
    ...v,
    prompt: extra
      ? `${v.prompt} ${/[.!?]$/.test(extra) ? extra : `${extra}.`}`
      : v.prompt,
  }));
}

/** Branch k's sampler: KSamplers in node-id order (100, 110, ... 180). */
function branchSamplers(workflow: Workflow): string[] {
  return Object.keys(workflow)
    .filter((id) => workflow[id].class_type === "KSampler")
    .sort((a, b) => Number(a) - Number(b));
}

/** Walk a sampler's positive through ReferenceLatent to the text encoder. */
function positiveEncoder(
  workflow: Workflow,
  samplerId: string,
): string | undefined {
  let id = (
    workflow[samplerId].inputs.positive as [string, number] | undefined
  )?.[0];
  for (let hop = 0; id && hop < 4; hop++) {
    if (workflow[id]?.class_type !== "ReferenceLatent") break;
    id = (
      workflow[id].inputs.conditioning as [string, number] | undefined
    )?.[0];
  }
  return id && workflow[id]?.class_type === "TextEncodeQwenImageEditPlus"
    ? id
    : undefined;
}

function buildMultiShot(
  action: string,
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown>,
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const imageRef = comfyImageRefFromViewUrl(job?.images?.[0]);
  if (!imageRef) throw new Error(`${action}: source run has no image`);

  const loadId = Object.keys(workflow).find(
    (id) => workflow[id].class_type === "LoadImage",
  );
  const samplers = branchSamplers(workflow);
  const views = multiShotPrompts(action, params);
  const encoders = samplers.map((s) => positiveEncoder(workflow, s));
  if (!loadId || samplers.length !== views.length || encoders.some((e) => !e)) {
    throw new Error(
      `${action}: workflow needs LoadImage and ${views.length} KSampler branches with a TextEncodeQwenImageEditPlus positive`,
    );
  }
  setNodeInput(workflow, loadId, "image", imageRef);

  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? Math.floor(params.seed)
      : Math.floor(Math.random() * 2 ** 32);
  samplers.forEach((samplerId, k) => {
    setNodeInput(workflow, encoders[k]!, "prompt", views[k].prompt);
    setNodeInput(workflow, samplerId, "seed", (seed + k) % 2 ** 32);
    workflow[encoders[k]!]._meta = { title: views[k].label };
  });

  const folder = action === ZOOMS_ACTION ? "CJ_Zooms" : "CJ_Shots";
  for (const node of Object.values(workflow)) {
    if (node.class_type !== "SaveImage") continue;
    const prefix = String(node.inputs.filename_prefix ?? "");
    const leaf = prefix.split("/").pop() || "view";
    node.inputs.filename_prefix = `${folder}/${leaf}`;
  }

  return {
    workflow,
    slots: {
      ksamplerId: samplers[0],
      posTextId: encoders[0]!,
      posTextInputName: "prompt",
      negTextId: "",
      latentDimsId: "",
      imageInputId: loadId,
    },
    seed,
  };
}

export function buildShotsWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
) {
  return buildMultiShot(
    SHOTS_ACTION,
    baseWorkflow,
    sourceRun,
    sourceJobIndex,
    params,
  );
}

export function buildZoomsWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
) {
  return buildMultiShot(
    ZOOMS_ACTION,
    baseWorkflow,
    sourceRun,
    sourceJobIndex,
    params,
  );
}

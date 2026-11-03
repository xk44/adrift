/**
 * "Relight" (packs/qwen-edit-2509/relight.json): Qwen-Image-Edit-2509 +
 * dx8152 Relight LoRA + Lightning 4-step LoRA (Comfy-Org template). The
 * positive prompt is the LoRA trigger "重新照明," followed by the template's
 * phrasing "relight the image using <light>". A preset supplies the light;
 * optional free text is appended (or replaces it with preset "custom").
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";

export const RELIGHT_ACTION = "relight";
export const RELIGHT_TRIGGER = "重新照明,";

export const RELIGHT_PRESETS: Record<string, string> = {
  golden_hour:
    "warm golden hour sunlight from a low angle (with a warm color temperature, long soft shadows and a gentle glow)",
  neon_night:
    "neon night lighting (with magenta and cyan neon glow, colored reflections and deep dark shadows)",
  studio_softbox:
    "studio softbox lighting (with a large soft key light from the front left, even fill and clean soft shadows)",
  rim_light:
    "strong rim light from behind (with a bright edge outlining the subject against a darker background)",
  overcast:
    "overcast daylight (with a cool neutral color temperature, diffuse light and very soft shadows)",
  candlelight:
    "warm candlelight (with flickering orange light from below, low ambient light and deep shadows)",
  sunset_backlight:
    "sunset backlight (with the low orange sun behind the subject, glowing rim and lens flare)",
  moonlight:
    "cold moonlight (with a blue color temperature, low light and soft dark shadows)",
};
export const DEFAULT_RELIGHT_PRESET = "golden_hour";

/** Full positive prompt for a preset + optional free text. */
export function relightPrompt(preset: unknown, text: unknown): string {
  const key = typeof preset === "string" ? preset.trim().toLowerCase() : "";
  const extra = typeof text === "string" ? text.trim() : "";
  if (key === "custom") {
    if (!extra)
      throw new Error(`${RELIGHT_ACTION}: custom lighting needs a description`);
    return `${RELIGHT_TRIGGER} relight the image using ${extra}`;
  }
  const light = RELIGHT_PRESETS[key] ?? RELIGHT_PRESETS[DEFAULT_RELIGHT_PRESET];
  return `${RELIGHT_TRIGGER} relight the image using ${light}${extra ? `, ${extra}` : ""}`;
}

function nodeIdOf(workflow: Workflow, classType: string): string | undefined {
  return Object.keys(workflow).find(
    (id) => workflow[id].class_type === classType,
  );
}

export function buildRelightWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const imageRef = comfyImageRefFromViewUrl(job?.images?.[0]);
  if (!imageRef) throw new Error(`${RELIGHT_ACTION}: source run has no image`);

  const loadId = nodeIdOf(workflow, "LoadImage");
  const ksamplerId = nodeIdOf(workflow, "KSampler");
  const encoders = Object.keys(workflow).filter(
    (id) => workflow[id].class_type === "TextEncodeQwenImageEditPlus",
  );
  // positive may pass through ReferenceLatent (exact-size reference latent);
  // walk its conditioning input back to the text encoder.
  let posId = ksamplerId
    ? (
        workflow[ksamplerId].inputs.positive as [string, number] | undefined
      )?.[0]
    : undefined;
  for (let hop = 0; posId && hop < 4; hop++) {
    if (workflow[posId]?.class_type !== "ReferenceLatent") break;
    posId = (
      workflow[posId].inputs.conditioning as [string, number] | undefined
    )?.[0];
  }
  if (!loadId || !ksamplerId || !posId || !encoders.includes(posId)) {
    throw new Error(
      `${RELIGHT_ACTION}: workflow needs LoadImage, KSampler and a TextEncodeQwenImageEditPlus positive`,
    );
  }
  setNodeInput(workflow, loadId, "image", imageRef);
  setNodeInput(
    workflow,
    posId,
    "prompt",
    relightPrompt(params.preset, params.text),
  );

  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? Math.floor(params.seed)
      : Math.floor(Math.random() * 2 ** 32);
  setNodeInput(workflow, ksamplerId, "seed", seed);

  return {
    workflow,
    slots: {
      ksamplerId,
      posTextId: posId,
      posTextInputName: "prompt",
      negTextId: "",
      latentDimsId: "",
      imageInputId: loadId,
    },
    seed,
  };
}

/**
 * Re-shoot from a new angle (packs/ltx25/vfx_reshoot.json): a clip's first
 * frame is re-rendered from a picked camera position by Qwen-Image 2.1 edit
 * + the qma camera-angles LoRA (the qwen21-camera tool's recipe and option
 * list), then LTX-2.5 two-stage image-to-video animates that frame for the
 * source clip's length, with generated sound.
 *
 * Motion is re-generated from the prompt, not copied frame for frame: no
 * camera re-projection model (CrossView-Warp, ReCamMaster) is installed.
 *
 * Client-safe: no Node imports.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import editToolRegistry from "@/lib/tools/editToolRegistry.json";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import {
  LTX25_FPS,
  ltx25LengthForSeconds,
  ltx25SourceDims,
  setLtx25Length,
  setLtx25Size,
} from "./ltx25";

export const LTX_RESHOOT_ACTION = "ltx_reshoot";
/** Longest re-shoot: 5 s at 24 fps (+1), the LTX-2.5 i2v default. */
export const LTX_RESHOOT_MAX_FRAMES = 121;
export const LTX_RESHOOT_FPS = LTX25_FPS;
/** qwen21-camera recipe (editToolRegistry.json defaults). */
export const LTX_RESHOOT_QWEN = { steps: 30, cfg: 3 } as const;

export interface ReshootChoice {
  id: string;
  label: string;
  text: string;
}

type CameraOption = {
  id: string;
  default?: string;
  values?: ReshootChoice[];
};

function cameraOptions(): Record<string, CameraOption> {
  const tools = (editToolRegistry as { tools?: unknown }).tools;
  const list = Array.isArray(tools) ? tools : [];
  const cam = list.find(
    (t): t is { options: CameraOption[] } =>
      !!t && (t as { id?: string }).id === "qwen21-camera",
  );
  return Object.fromEntries((cam?.options ?? []).map((o) => [o.id, o]));
}

const OPTIONS = cameraOptions();

function choices(key: string): ReshootChoice[] {
  return (OPTIONS[key]?.values ?? []).map(({ id, label, text }) => ({
    id,
    label,
    text,
  }));
}

/** Orbit / height / distance choices (same as the Camera angle image tool). */
export const LTX_RESHOOT_ORBITS = choices("azimuth");
export const LTX_RESHOOT_HEIGHTS = choices("elevation");
export const LTX_RESHOOT_DISTANCES = choices("distance");

/** Defaults: the image tool's, so a re-shoot and a still agree. */
export const LTX_RESHOOT_DEFAULTS = {
  orbit: OPTIONS.azimuth?.default ?? "front-right",
  height: OPTIONS.elevation?.default ?? "eye-level",
  distance: OPTIONS.distance?.default ?? "medium",
} as const;

function choice(
  list: ReshootChoice[],
  value: unknown,
  fallback: string,
): ReshootChoice {
  return (
    list.find((c) => c.id === value) ??
    list.find((c) => c.id === fallback) ??
    list[0]
  );
}

export interface ReshootAngle {
  orbit: ReshootChoice;
  height: ReshootChoice;
  distance: ReshootChoice;
}

/** Picked camera position; unknown ids fall back to the defaults. */
export function reshootAngle(params: Record<string, unknown>): ReshootAngle {
  return {
    orbit: choice(LTX_RESHOOT_ORBITS, params.orbit, LTX_RESHOOT_DEFAULTS.orbit),
    height: choice(
      LTX_RESHOOT_HEIGHTS,
      params.height,
      LTX_RESHOOT_DEFAULTS.height,
    ),
    distance: choice(
      LTX_RESHOOT_DISTANCES,
      params.distance,
      LTX_RESHOOT_DEFAULTS.distance,
    ),
  };
}

/** Qwen camera-angles prompt ("<qma> {orbit} {height} {distance}"). */
export function reshootQwenPrompt(angle: ReshootAngle): string {
  return `<qma> ${angle.orbit.text} ${angle.height.text} ${angle.distance.text}`;
}

function clean(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, 1500)
    : "";
}

/** LTX prompt: the new framing, then what happens in the shot. */
export function reshootVideoPrompt(angle: ReshootAngle, text: string): string {
  const t = clean(text).replace(/[.\s]+$/, "");
  return `The same scene filmed again from a new camera position: ${angle.orbit.text}, ${angle.height.text}, ${angle.distance.text}. ${t}.`;
}

function idsOf(workflow: Workflow, classType: string): string[] {
  return Object.keys(workflow).filter(
    (id) => workflow[id]?.class_type === classType,
  );
}

function positive(...values: unknown[]): number | undefined {
  for (const v of values) {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

export function buildLtxReshootWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const text = clean(params.prompt ?? params.text);
  if (!text) {
    throw new Error(
      `${LTX_RESHOOT_ACTION}: a prompt is required (what happens in the shot)`,
    );
  }
  const ref = comfyImageRefFromViewUrl(
    sourceRun.jobs[sourceJobIndex]?.videos?.[0],
  );
  if (!ref) throw new Error(`${LTX_RESHOOT_ACTION}: source run has no video`);

  const workflow = cloneWorkflow(baseWorkflow);
  const load = idsOf(workflow, "LoadVideo")[0];
  const qwenText = idsOf(workflow, "TextEncodeQwenImage21")[0];
  const qwenSampler = idsOf(workflow, "KSampler")[0];
  const cond = idsOf(workflow, "LTXVConditioning")[0];
  const pos = cond ? workflow[cond].inputs.positive : undefined;
  const neg = cond ? workflow[cond].inputs.negative : undefined;
  if (
    !load ||
    !qwenText ||
    !qwenSampler ||
    !Array.isArray(pos) ||
    !Array.isArray(neg) ||
    idsOf(workflow, "EmptyLTXVLatentVideo").length === 0
  ) {
    throw new Error(
      `${LTX_RESHOOT_ACTION}: workflow needs LoadVideo, TextEncodeQwenImage21, KSampler, LTXVConditioning (wired prompts) and EmptyLTXVLatentVideo`,
    );
  }
  const posId = String(pos[0]);
  const negId = String(neg[0]);

  setNodeInput(workflow, load, "file", ref);

  const angle = reshootAngle(params);
  setNodeInput(workflow, qwenText, "prompt", reshootQwenPrompt(angle));
  setNodeInput(workflow, qwenSampler, "steps", LTX_RESHOOT_QWEN.steps);
  setNodeInput(workflow, qwenSampler, "cfg", LTX_RESHOOT_QWEN.cfg);

  // Clip size from the source orientation; length follows the source clip.
  setLtx25Size(
    workflow,
    ltx25SourceDims(sourceRun.width ?? 0, sourceRun.height ?? 0, true),
  );
  const seconds = positive(
    params.video_seconds,
    sourceRun.params?.video_seconds,
  );
  const frames = Math.min(
    LTX_RESHOOT_MAX_FRAMES,
    seconds
      ? ltx25LengthForSeconds(seconds, LTX_RESHOOT_FPS)
      : LTX_RESHOOT_MAX_FRAMES,
  );
  setLtx25Length(workflow, frames);

  setNodeInput(workflow, posId, "text", reshootVideoPrompt(angle, text));

  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? Math.floor(Math.abs(params.seed))
      : Math.floor(Math.random() * 2 ** 32);
  setNodeInput(workflow, qwenSampler, "seed", seed);
  for (const id of idsOf(workflow, "RandomNoise")) {
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

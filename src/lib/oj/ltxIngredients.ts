/**
 * Ingredients (packs/ltx25/vfx_ingredients.json): LTX-2.5 IC-LoRA
 * Ingredients 0.9 on the distilled LTX-2.5 22B model, core ComfyUI nodes.
 *
 * The LoRA reads one reference sheet (a clean panel per character, prop and
 * location on black, no text) held as a static clip, and composes a new shot
 * from it. Up to four ingredient images (the source image, then
 * params.secondRefImage and params.extraRefImages) are stitched on black in
 * the graph: 1 as is, 2 side by side, 3 in a row, 4 as a 2x2 grid. A single
 * image can be a ready-made sheet. The sheet is letterboxed on black to the
 * card size (768x448, portrait 448x768 for a portrait first image) and
 * repeated for the 121-frame clip.
 * Prompt (card): "Reference sheet: <panels>\n\nGenerated video: <action>".
 * License: LTX-2.x Community License.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";

export const LTX_INGREDIENTS_ACTION = "ltx_ingredients";

export const LTX_INGREDIENTS_MAX_IMAGES = 4;
/** Card: trained at 768x448, 121 frames, 24 fps. */
export const LTX_INGREDIENTS_WIDTH = 768;
export const LTX_INGREDIENTS_HEIGHT = 448;
export const LTX_INGREDIENTS_FRAMES = 121;
export const LTX_INGREDIENTS_FPS = 24;
export const LTX_INGREDIENTS_STRENGTH = 1.4;

const DEFAULT_SHEET =
  "the characters, objects and location shown in the panels on the black background";

function clean(value: unknown, max = 1500): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

const clause = (s: string) => s.replace(/[.\s]+$/, "");

/** Card prompt: the sheet's panels, then the shot. */
export function ltxIngredientsPrompt(action: string, sheet = ""): string {
  const raw = typeof action === "string" ? action.trim() : "";
  if (/^reference sheet\s*:/i.test(raw) && /generated video\s*:/i.test(raw)) {
    return raw.slice(0, 3000);
  }
  const shot = clause(clean(action));
  const panels = clause(clean(sheet)) || DEFAULT_SHEET;
  return `Reference sheet: ${panels}.\n\nGenerated video: ${shot}.`;
}

/** LoRA strength from a picker value, clamped to 0.5..2 (card default 1.4). */
export function ltxIngredientsStrength(value: unknown): number {
  const v = typeof value === "string" ? Number(value) : value;
  return typeof v === "number" && Number.isFinite(v) && v > 0
    ? Math.min(2, Math.max(0.5, v))
    : LTX_INGREDIENTS_STRENGTH;
}

const isInputRef = (v: unknown): v is string =>
  typeof v === "string" && / \[input\]$/.test(v.trim());

/** Uploaded ingredient refs after the source image, in order, max 3. */
export function ltxIngredientRefs(params: Record<string, unknown>): string[] {
  const extras = Array.isArray(params.extraRefImages)
    ? params.extraRefImages
    : [];
  return [params.secondRefImage, ...extras]
    .filter(isInputRef)
    .map((v) => v.trim())
    .slice(0, LTX_INGREDIENTS_MAX_IMAGES - 1);
}

function byTitle(workflow: Workflow, cls: string, title: string): string {
  const id = Object.keys(workflow).find(
    (k) =>
      workflow[k]?.class_type === cls && workflow[k]._meta?.title === title,
  );
  if (!id) throw new Error(`ltx_ingredients: workflow needs ${cls} "${title}"`);
  return id;
}

function only(workflow: Workflow, cls: string): string {
  const ids = Object.keys(workflow).filter(
    (k) => workflow[k]?.class_type === cls,
  );
  if (ids.length !== 1) {
    throw new Error(`ltx_ingredients: workflow needs one ${cls}`);
  }
  return ids[0];
}

export function buildLtxIngredientsWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const text =
    typeof (params.prompt ?? params.text) === "string"
      ? String(params.prompt ?? params.text)
      : "";
  if (!clean(text)) {
    throw new Error(
      "ltx_ingredients: describe the shot (a prompt is required)",
    );
  }
  const prompt = ltxIngredientsPrompt(text, clean(params.sheet));

  const workflow = cloneWorkflow(baseWorkflow);
  const first = comfyImageRefFromViewUrl(
    sourceRun.jobs[sourceJobIndex]?.images?.[0],
  );
  if (!first) throw new Error("ltx_ingredients: source run has no image");
  const refs = [first, ...ltxIngredientRefs(params)];

  const loads = [1, 2, 3, 4].map((i) =>
    byTitle(workflow, "LoadImage", `Ingredient ${i}`),
  );
  const stitch12 = byTitle(workflow, "ImageStitch", "Sheet: 1 + 2");
  const stitch123 = byTitle(workflow, "ImageStitch", "Sheet: 1 + 2 + 3");
  const stitch34 = byTitle(workflow, "ImageStitch", "Sheet row: 3 + 4");
  const stitch2x2 = byTitle(workflow, "ImageStitch", "Sheet: 2x2");
  const pad = only(workflow, "ResizeAndPadImage");
  const repeat = only(workflow, "RepeatImageBatch");
  const latent = only(workflow, "EmptyLTXVLatentVideo");
  const audio = only(workflow, "LTXVEmptyLatentAudio");
  const cond = only(workflow, "LTXVConditioning");
  const lora = only(workflow, "LoraLoaderModelOnly");
  const pos = workflow[cond].inputs.positive;
  const neg = workflow[cond].inputs.negative;
  if (!Array.isArray(pos) || !Array.isArray(neg)) {
    throw new Error("ltx_ingredients: LTXVConditioning needs wired prompts");
  }
  const posId = String(pos[0]);
  const negId = String(neg[0]);

  refs.forEach((ref, i) => setNodeInput(workflow, loads[i], "image", ref));
  const n = refs.length;
  const sheet =
    n === 1 ? loads[0] : n === 2 ? stitch12 : n === 3 ? stitch123 : stitch2x2;
  setNodeInput(workflow, pad, "image", [sheet, 0]);
  const used = new Set(
    n === 1
      ? [loads[0]]
      : n === 2
        ? [...loads.slice(0, 2), stitch12]
        : n === 3
          ? [...loads.slice(0, 3), stitch12, stitch123]
          : [...loads, stitch12, stitch34, stitch2x2],
  );
  for (const id of [...loads, stitch12, stitch123, stitch34, stitch2x2]) {
    if (!used.has(id)) delete workflow[id];
  }

  const portrait =
    !!sourceRun.width &&
    !!sourceRun.height &&
    sourceRun.height > sourceRun.width;
  const width = portrait ? LTX_INGREDIENTS_HEIGHT : LTX_INGREDIENTS_WIDTH;
  const height = portrait ? LTX_INGREDIENTS_WIDTH : LTX_INGREDIENTS_HEIGHT;
  // A 2-3 panel strip stacks vertically in a portrait frame so the panels
  // stay large; the 2x2 grid keeps its rows.
  if (portrait && (n === 2 || n === 3)) {
    for (const id of n === 2 ? [stitch12] : [stitch12, stitch123]) {
      setNodeInput(workflow, id, "direction", "down");
    }
  }
  setNodeInput(workflow, pad, "target_width", width);
  setNodeInput(workflow, pad, "target_height", height);
  setNodeInput(workflow, repeat, "amount", LTX_INGREDIENTS_FRAMES);
  setNodeInput(workflow, latent, "width", width);
  setNodeInput(workflow, latent, "height", height);
  setNodeInput(workflow, latent, "length", LTX_INGREDIENTS_FRAMES);
  setNodeInput(workflow, audio, "frames_number", LTX_INGREDIENTS_FRAMES);
  setNodeInput(workflow, audio, "frame_rate", LTX_INGREDIENTS_FPS);
  setNodeInput(workflow, cond, "frame_rate", LTX_INGREDIENTS_FPS);

  setNodeInput(
    workflow,
    lora,
    "strength_model",
    ltxIngredientsStrength(params.strength),
  );
  setNodeInput(workflow, posId, "text", prompt);

  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? Math.floor(Math.abs(params.seed))
      : Math.floor(Math.random() * 2 ** 32);
  for (const id of Object.keys(workflow)) {
    if (workflow[id].class_type === "RandomNoise") {
      setNodeInput(workflow, id, "noise_seed", seed);
    }
  }

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: posId,
      posTextInputName: "text",
      negTextId: negId,
      latentDimsId: "",
      imageInputId: loads[0],
    },
    seed,
  };
}

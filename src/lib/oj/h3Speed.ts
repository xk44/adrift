/**
 * MiniMax H3 speed option (`h3Speed`): lightx2v's MiniMax-H3 Turbo
 * step-distilled LoRAs, inserted at runtime into any H3 video graph.
 *
 *   off     pack recipe unchanged (default)
 *   turbo8  8-step Turbo LoRA @1, 8 steps
 *   turbo4  4-step Turbo LoRA @1, 4 steps
 *   fast8   FastVideo FastH3 distilled DiT (UNET swap, no LoRA), 8 steps —
 *           see the FastH3 section below
 *
 * Model chain (lightx2v's own graphs):
 *   UNET -> [graph LoRAs] -> [extra LoRAs] -> Turbo LoRA -> MiniMaxH3SigmaShift
 *   {shift_video 6, shift_audio 3} -> guider / scheduler.
 * Sampler: BasicScheduler simple / N steps, KSamplerSelect euler, CFG 1 on a
 * CFGGuider (BasicGuider has no CFG). An explicit numeric `steps` param wins
 * over the preset's step count (mossSpeed precedent).
 *
 * The shifts are lightx2v's training shifts for their 768p LoRAs (the node's
 * own default is 12 / 3).
 *
 * Family: a MiniMaxH3ReferenceToVideo graph takes the ref2v LoRAs, anything
 * else the fl2v ones. ref2v 8-step uses v1.0 on purpose (users report v1.1 is
 * worse); the v1.1 constant is kept for a later A/B.
 *
 * No-op when the graph already loads a speed LoRA (character_swap / face_swap
 * pin the fl2v Turbo 8-step v1.1 LoRA) or is not an H3 graph.
 */
import type { Workflow } from "@/types";
import { insertModelLoras, nextNodeId } from "./loraInsert";
import {
  h3Family,
  isH3Graph,
  samplerModelSource,
  type H3Family,
} from "./h3Video";

export { h3Family, type H3Family };
export type H3Speed = "off" | "turbo8" | "turbo4" | "fast8";
export type H3TurboSpeed = "turbo8" | "turbo4";

export const H3_TURBO_FL2V_8 =
  "minimax_h3_fl2v_turbo_8step_v1.1_768p_comfyui_bf16.safetensors";
export const H3_TURBO_FL2V_4 =
  "minimax_h3_fl2v_turbo_4step_v1.3_768p_comfyui_bf16.safetensors";
/** Used for ref2v turbo8: v1.1 is reported worse than v1.0. */
export const H3_TURBO_REF2V_8 =
  "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors";
/** Not used yet; kept for an A/B against v1.0. */
export const H3_TURBO_REF2V_8_V11 =
  "minimax_h3_ref2v_turbo_8step_v1.1_768p_comfyui_bf16.safetensors";
export const H3_TURBO_REF2V_4 =
  "minimax_h3_ref2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors";

export const H3_TURBO_LORAS: Record<H3TurboSpeed, Record<H3Family, string>> = {
  turbo8: { fl2v: H3_TURBO_FL2V_8, ref2v: H3_TURBO_REF2V_8 },
  turbo4: { fl2v: H3_TURBO_FL2V_4, ref2v: H3_TURBO_REF2V_4 },
};

export const H3_TURBO_STEPS: Record<H3TurboSpeed, number> = {
  turbo8: 8,
  turbo4: 4,
};

export const H3_SIGMA_SHIFT_NODE = "MiniMaxH3SigmaShift";
/** lightx2v's training shifts for the 768p Turbo LoRAs. */
export const H3_TURBO_SHIFT = { shift_video: 6, shift_audio: 3 } as const;
export const H3_TURBO_RECIPE = {
  sampler_name: "euler",
  scheduler: "simple",
  cfg: 1,
} as const;

/**
 * A graph LoRA that already distills steps (Turbo, Acc-8Step, DMD-style).
 * Acc-8Step stays matched so user graphs that load it are left alone.
 */
export const H3_SPEED_LORA_RE = /turbo|Acc-8Step|flashgen|pdmd|hyperflow/i;

/** Normalise a param value; undefined if unset / unknown. */
export function parseH3Speed(value: unknown): H3Speed | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const s = String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (["off", "none", "false", "0", "base"].includes(s)) return "off";
  if (["turbo8", "turbo-8", "8", "8-step", "8step", "turbo"].includes(s))
    return "turbo8";
  if (["turbo4", "turbo-4", "4", "4-step", "4step"].includes(s))
    return "turbo4";
  // No bare "fast": `--speed fast` is a MOSS preset and also reaches here.
  if (["fast8", "fast-8", "fasth3", "fast-h3"].includes(s)) return "fast8";
  return undefined;
}

/**
 * The requested speed: `h3Speed`, else a `--speed` value (parsed as
 * `mossSpeed`) that reads as an H3 speed ("8" / "4" / "turbo8" ...).
 */
export function requestedH3Speed(params: Record<string, unknown>): H3Speed {
  return (
    parseH3Speed(params.h3Speed) ?? parseH3Speed(params.mossSpeed) ?? "off"
  );
}

/** True when some LoRA loader in the graph already loads a speed LoRA. */
export function hasH3SpeedLora(workflow: Workflow): boolean {
  return Object.values(workflow).some(
    (n) =>
      (n.class_type === "LoraLoaderModelOnly" ||
        n.class_type === "LoraLoader") &&
      H3_SPEED_LORA_RE.test(String(n.inputs?.lora_name ?? "")),
  );
}

/** Turbo LoRA file `params` would add to `workflow` (null = no-op). */
export function h3SpeedLoraFor(
  workflow: Workflow,
  params: Record<string, unknown>,
): string | null {
  const speed = requestedH3Speed(params);
  if (speed === "off" || speed === "fast8" || !isH3Graph(workflow)) return null;
  if (hasH3SpeedLora(workflow)) return null;
  return H3_TURBO_LORAS[speed][h3Family(workflow)];
}

const isModelLink = (v: unknown, id: string) =>
  Array.isArray(v) &&
  v.length === 2 &&
  String(v[0]) === id &&
  Number(v[1]) === 0;

/**
 * Apply `h3Speed` to an H3 graph in place. Returns the added node ids
 * (Turbo LoRA, then SigmaShift when new); empty when it is a no-op.
 */
export function applyH3Speed(
  workflow: Workflow,
  params: Record<string, unknown>,
): string[] {
  const speed = requestedH3Speed(params);
  if (speed === "off") return [];
  if (speed === "fast8") return applyFastH3(workflow, params);
  const lora = h3SpeedLoraFor(workflow, params);
  if (!lora) return [];
  const source = samplerModelSource(workflow);
  if (!source) return [];

  // An existing SigmaShift tail: the LoRA goes in front of it.
  const existingShift =
    workflow[source]?.class_type === H3_SIGMA_SHIFT_NODE ? source : null;
  let loraAfter = source;
  if (existingShift) {
    const m = workflow[existingShift].inputs.model;
    if (!Array.isArray(m)) return [];
    loraAfter = String(m[0]);
  }
  const ids = insertModelLoras(workflow, loraAfter, [
    {
      file: lora,
      strength: 1,
      title: `MiniMax H3 Turbo ${H3_TURBO_STEPS[speed]}-step (lightx2v)`,
    },
  ]);
  if (!ids.length) return [];
  const loraId = ids[0];

  let shiftId = existingShift ?? findClass(workflow, H3_SIGMA_SHIFT_NODE);
  if (shiftId) {
    Object.assign(workflow[shiftId].inputs, H3_TURBO_SHIFT);
  } else {
    shiftId = nextNodeId(workflow);
    for (const node of Object.values(workflow))
      for (const [k, v] of Object.entries(node.inputs ?? {}))
        if (isModelLink(v, loraId)) node.inputs[k] = [shiftId, 0];
    workflow[shiftId] = {
      class_type: H3_SIGMA_SHIFT_NODE,
      inputs: { model: [loraId, 0], ...H3_TURBO_SHIFT },
      _meta: { title: "MiniMax H3 Sigma Shift (Turbo)" },
    } as Workflow[string];
    ids.push(shiftId);
  }
  // Schedulers must read the shifted model too (some graphs, e.g. a
  // TimestepCache variant, feed the scheduler from a different node).
  for (const node of Object.values(workflow))
    if (node.class_type === "BasicScheduler") node.inputs.model = [shiftId, 0];

  const steps =
    typeof params.steps === "number" ? undefined : H3_TURBO_STEPS[speed];
  for (const node of Object.values(workflow)) {
    const inputs = node.inputs as Record<string, unknown>;
    if (node.class_type === "BasicScheduler") {
      if (steps !== undefined) inputs.steps = steps;
      inputs.scheduler = H3_TURBO_RECIPE.scheduler;
    } else if (node.class_type === "KSamplerSelect") {
      inputs.sampler_name = H3_TURBO_RECIPE.sampler_name;
    } else if (node.class_type === "CFGGuider") {
      inputs.cfg = H3_TURBO_RECIPE.cfg;
    }
  }
  return ids;
}

function findClass(workflow: Workflow, cls: string): string | null {
  return (
    Object.keys(workflow).find((id) => workflow[id].class_type === cls) ?? null
  );
}

// FastH3 (`h3Speed: "fast8"`): FastVideo's distilled H3 checkpoints
// Recipes copied from the ComfyUI core templates (comfyui_workflow_templates
// on the CUDA host): video_fastvideo_fasth3_t2v / _i2v (fl2v family) and
// video_fasth3_ominiref_r2v (ref2v family). Model chain in both:
//   UNET -> MiniMaxH3SigmaShift -> ModelAttentionBackend (comfy kitchen
//   attention) -> BlockSparseAttention (vsa, keep 10%) -> guider / scheduler
// BasicGuider (no CFG), BasicScheduler simple / 8 steps / denoise 1.
//
// The templates also load the int8 video VAE and the nvfp4 Qwen3-VL encoder;
// those are quantizations of the same weights, so the pack's own encoder /
// VAE stay. Both DiTs are int8_convrot: CUDA-only (torch._int_mm), so fast8
// runs on the CUDA video host, not MPS.
//
// ref2v file: FastVideo's official OmniRef build (the template's file, with
// FastVideo's validation receipts), not the community "v2b25-49x050" hybrid
// (OmniRef x FastH3-V2 merge on blocks 25-49; its own header marks inference
// parity "not-validated").

export interface FastH3Recipe {
  unet: string;
  shift_video: number;
  shift_audio: number;
  sampler_name: string;
  /** BlockSparseAttention start_percent (the only VSA field that differs). */
  vsa_start_percent: number;
  /** Core template the numbers are copied from. */
  template: string;
}

export const FASTH3_FL2V_UNET =
  "fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors";
export const FASTH3_REF2V_UNET =
  "fasth3_omniref_8step_pruned_int8_convrot.safetensors";
export const FASTH3_STEPS = 8;

export const FASTH3_RECIPES: Record<H3Family, FastH3Recipe> = {
  fl2v: {
    unet: FASTH3_FL2V_UNET,
    shift_video: 10,
    shift_audio: 3,
    sampler_name: "res_multistep",
    vsa_start_percent: 0.2,
    template: "video_fastvideo_fasth3_t2v / video_fastvideo_fasth3_i2v",
  },
  ref2v: {
    unet: FASTH3_REF2V_UNET,
    shift_video: 12,
    shift_audio: 3,
    sampler_name: "euler",
    vsa_start_percent: 0,
    template: "video_fasth3_ominiref_r2v",
  },
};

export const FASTH3_ATTENTION_BACKEND = "comfy kitchen attention";
/** BlockSparseAttention inputs shared by both templates (API format). */
export const FASTH3_VSA = {
  selection: "vsa",
  "selection.keep_percent": 10,
  end_percent: 1,
  dense_blocks: "",
  min_tokens: 12288,
  extra_tokens: 256,
  sink_conditioning: "exact_kv_and_rows",
  verbose: false,
} as const;

/** The UNETLoader at the root of the sampler's MODEL chain (null if none). */
export function h3UnetLoaderId(workflow: Workflow): string | null {
  let cur = samplerModelSource(workflow);
  const seen = new Set<string>();
  while (cur && !seen.has(cur) && workflow[cur]) {
    seen.add(cur);
    if (workflow[cur].class_type === "UNETLoader") return cur;
    const m = workflow[cur].inputs?.model;
    cur = Array.isArray(m) ? String(m[0]) : null;
  }
  return null;
}

/**
 * FastH3 DiT `params` would swap into `workflow` (null = no-op): H3 graphs
 * fed by a UNETLoader, minus graphs that already pin a speed LoRA
 * (character / face swap stay on their Turbo-LoRA recipe).
 */
export function h3FastUnetFor(
  workflow: Workflow,
  params: Record<string, unknown>,
): string | null {
  if (requestedH3Speed(params) !== "fast8" || !isH3Graph(workflow)) return null;
  if (hasH3SpeedLora(workflow) || !h3UnetLoaderId(workflow)) return null;
  return FASTH3_RECIPES[h3Family(workflow)].unet;
}

/**
 * Apply the FastH3 recipe in place: swap the DiT, append SigmaShift ->
 * attention backend -> VSA after the model chain, set the 8-step sampler.
 * Returns the added node ids; empty when it is a no-op.
 */
export function applyFastH3(
  workflow: Workflow,
  params: Record<string, unknown>,
): string[] {
  const unet = h3FastUnetFor(workflow, params);
  const unetId = h3UnetLoaderId(workflow);
  const source = samplerModelSource(workflow);
  if (!unet || !unetId || !source) return [];
  // Already sparse (applied before, or a FastH3 graph): leave it alone.
  if (workflow[source].class_type === "BlockSparseAttention") return [];
  const recipe = FASTH3_RECIPES[h3Family(workflow)];
  workflow[unetId].inputs.unet_name = unet;
  workflow[unetId].inputs.weight_dtype = "default";

  const ids: string[] = [];
  const add = (node: Workflow[string]) => {
    const id = nextNodeId(workflow);
    workflow[id] = node;
    ids.push(id);
    return id;
  };

  // Consumers of the chain tail, collected before the new nodes exist.
  const consumers: Array<[string, string]> = [];
  for (const [id, node] of Object.entries(workflow))
    for (const [k, v] of Object.entries(node.inputs ?? {}))
      if (isModelLink(v, source)) consumers.push([id, k]);

  let shiftId: string;
  if (workflow[source].class_type === H3_SIGMA_SHIFT_NODE) {
    shiftId = source;
    Object.assign(workflow[shiftId].inputs, {
      shift_video: recipe.shift_video,
      shift_audio: recipe.shift_audio,
    });
  } else {
    shiftId = add({
      class_type: H3_SIGMA_SHIFT_NODE,
      inputs: {
        model: [source, 0],
        shift_video: recipe.shift_video,
        shift_audio: recipe.shift_audio,
      },
      _meta: { title: "MiniMax H3 Sigma Shift (FastH3)" },
    } as Workflow[string]);
  }
  const backendId = add({
    class_type: "ModelAttentionBackend",
    inputs: { model: [shiftId, 0], attention: FASTH3_ATTENTION_BACKEND },
    _meta: { title: "Attention Backend (FastH3)" },
  } as Workflow[string]);
  const vsaId = add({
    class_type: "BlockSparseAttention",
    inputs: {
      model: [backendId, 0],
      ...FASTH3_VSA,
      start_percent: recipe.vsa_start_percent,
    },
    _meta: { title: "Video Sparse Attention (FastH3)" },
  } as Workflow[string]);

  for (const [id, k] of consumers)
    if (id !== shiftId) workflow[id].inputs[k] = [vsaId, 0];
  for (const node of Object.values(workflow))
    if (node.class_type === "BasicScheduler") node.inputs.model = [vsaId, 0];

  const steps = typeof params.steps === "number" ? undefined : FASTH3_STEPS;
  for (const node of Object.values(workflow)) {
    const inputs = node.inputs as Record<string, unknown>;
    if (node.class_type === "BasicScheduler") {
      if (steps !== undefined) inputs.steps = steps;
      inputs.scheduler = "simple";
      inputs.denoise = 1;
    } else if (node.class_type === "KSamplerSelect") {
      inputs.sampler_name = recipe.sampler_name;
    } else if (node.class_type === "CFGGuider") {
      inputs.cfg = 1;
    }
  }
  return ids;
}

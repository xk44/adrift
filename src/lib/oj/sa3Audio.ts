/**
 * Stable Audio 3 Medium tools (pack "audio"): core ComfyUI nodes plus the
 * cj_sa3_audio custom node pack (comfy_nodes/cj_sa3_audio) for inpaint and
 * continuation.
 *
 *   sa3_t2a      packs/audio/sa3_t2a.json      text → music / sound
 *   sa3_a2a      packs/audio/sa3_a2a.json      LoadAudio → VAEEncodeAudio →
 *                                              KSampler (denoise = strength)
 *   sa3_inpaint  packs/audio/sa3_inpaint.json  CJSA3InpaintConditioning
 *                                              (regions) → KSampler →
 *                                              CJAudioPasteback (crossfade)
 *   sa3_extend   packs/audio/sa3_extend.json   same nodes, regions "" and
 *                                              total_seconds > source length
 *
 * Every tool takes an optional audio LoRA (models/loras/audio/<name>, see
 * the d-audiotrain converter): a LoraLoaderModelOnly goes between the
 * checkpoint and the KSampler. "Quality" swaps the distilled checkpoint
 * (8 steps, cfg 1) for the base one (50 steps, cfg 7, the official template).
 *
 * The text tools seed an empty text run like music / sfx; the audio-in tools
 * upload the source to ComfyUI input and pass it as params.audioRef.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import { parseInputRef } from "@/lib/seedRun";
import { cloneWorkflow, setNodeInput } from "./engine";
import { SA3_DURATION } from "./audioDuration";

export * from "./sa3Params";
export { injectAudioDuration } from "./audioDuration";
import {
  AUDIO_LORA_PREFIX,
  SA3_A2A_ACTION,
  SA3_CROSSFADE_MS,
  SA3_EXTEND_ACTION,
  SA3_EXTEND_TOTAL,
  SA3_INPAINT_ACTION,
  SA3_LORA_STRENGTH,
  SA3_SPEEDS,
  SA3_STRENGTH,
  SA3_T2A_ACTION,
  formatAudioRegions,
  isAudioLora,
  parseAudioRegions,
  type AudioRegion,
  type Sa3Speed,
} from "./sa3Params";

type Built = { workflow: Workflow; slots: WorkflowSlots; seed: number };
type Range = { min: number; max: number; default: number };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function clamp(value: unknown, range: Range): number {
  const n = num(value);
  if (n === undefined) return range.default;
  return Math.min(range.max, Math.max(range.min, n));
}

function seedFrom(params: Record<string, unknown>): number {
  const n = num(params.seed);
  return n !== undefined && n >= 0
    ? Math.floor(n)
    : Math.floor(Math.random() * 2147483647);
}

function nodeOf(workflow: Workflow, classType: string): string | undefined {
  return Object.keys(workflow).find(
    (id) => workflow[id].class_type === classType,
  );
}

function need(workflow: Workflow, classType: string, action: string): string {
  const id = nodeOf(workflow, classType);
  if (!id) throw new Error(`${action}: workflow needs ${classType}`);
  return id;
}

function linkId(value: unknown): string {
  return Array.isArray(value) ? String(value[0]) : "";
}

function fmtSeconds(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** Speed preset: checkpoint, steps, cfg (sampler stays lcm / simple). */
export function applySa3Speed(
  workflow: Workflow,
  speed: unknown,
  action: string,
): Sa3Speed {
  const key: Sa3Speed = speed === "quality" ? "quality" : "fast";
  const preset = SA3_SPEEDS[key];
  const ckptId = need(workflow, "CheckpointLoaderSimple", action);
  const samplerId = need(workflow, "KSampler", action);
  setNodeInput(workflow, ckptId, "ckpt_name", preset.ckpt);
  setNodeInput(workflow, samplerId, "steps", preset.steps);
  setNodeInput(workflow, samplerId, "cfg", preset.cfg);
  return key;
}

/**
 * Optional audio LoRA: CheckpointLoaderSimple.MODEL → LoraLoaderModelOnly →
 * KSampler.model. Only names under models/loras/audio/ are accepted (image
 * LoRAs would load but wreck the audio model). Returns the new node id.
 */
export function insertAudioLora(
  workflow: Workflow,
  lora: unknown,
  strength: unknown,
  action: string,
): string | undefined {
  const name = text(lora);
  if (!name) return undefined;
  if (!isAudioLora(name))
    throw new Error(
      `${action}: LoRA must be an audio LoRA under models/loras/audio/ (got "${name}")`,
    );
  const ckptId = need(workflow, "CheckpointLoaderSimple", action);
  const samplerId = need(workflow, "KSampler", action);
  const ids = Object.keys(workflow).map(Number).filter(Number.isFinite);
  const id = String(Math.max(0, ...ids) + 1);
  workflow[id] = {
    class_type: "LoraLoaderModelOnly",
    inputs: {
      model: [ckptId, 0],
      lora_name: name.replace(/\\/g, "/"),
      strength_model: clamp(strength, SA3_LORA_STRENGTH),
    },
  };
  setNodeInput(workflow, samplerId, "model", [id, 0]);
  return id;
}

/** Prompt, negative, seed, speed, LoRA: shared by all four tools. */
function wireCommon(
  workflow: Workflow,
  action: string,
  params: Record<string, unknown>,
  promptRequired: boolean,
): { samplerId: string; posId: string; seed: number } {
  const prompt = text(params.prompt);
  if (promptRequired && !prompt)
    throw new Error(`${action}: describe the sound (prompt)`);
  const samplerId = need(workflow, "KSampler", action);
  // Inpaint / extend route conditioning through CJSA3InpaintConditioning.
  const condId = nodeOf(workflow, "CJSA3InpaintConditioning");
  const from = condId ? workflow[condId].inputs : workflow[samplerId].inputs;
  const posId = linkId(from.positive);
  const negId = linkId(from.negative);
  for (const id of [posId, negId]) {
    if (workflow[id]?.class_type !== "CLIPTextEncode")
      throw new Error(`${action}: prompts must be CLIPTextEncode nodes`);
  }
  setNodeInput(workflow, posId, "text", prompt);
  setNodeInput(workflow, negId, "text", text(params.negative));
  const seed = seedFrom(params);
  setNodeInput(workflow, samplerId, "seed", seed);
  applySa3Speed(workflow, params.speed, action);
  insertAudioLora(workflow, params.lora, params.loraStrength, action);
  return { samplerId, posId, seed };
}

function sourceRef(params: Record<string, unknown>, action: string): string {
  const ref = text(params.audioRef);
  if (!ref || !parseInputRef(ref, { allowAudio: true }))
    throw new Error(
      `${action}: audioRef must be the uploaded audio ("name.mp3 [input]")`,
    );
  return ref;
}

function slotsFor(samplerId: string, posId: string): WorkflowSlots {
  return {
    ksamplerId: samplerId,
    posTextId: posId,
    posTextInputName: "text",
    negTextId: "",
    latentDimsId: "",
  };
}

// Builders (ACTION_BUILDERS signature)

export function buildSa3TextToAudio(
  baseWorkflow: Workflow,
  _sourceRun: ImagineRun,
  _sourceJobIndex: number,
  params: Record<string, unknown> = {},
): Built {
  const A = SA3_T2A_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const { samplerId, posId, seed } = wireCommon(workflow, A, params, true);
  const latentId = need(workflow, "EmptyLatentAudio", A);
  setNodeInput(
    workflow,
    latentId,
    "seconds",
    clamp(params.duration, SA3_DURATION),
  );
  return { workflow, slots: slotsFor(samplerId, posId), seed };
}

export function buildSa3AudioToAudio(
  baseWorkflow: Workflow,
  _sourceRun: ImagineRun,
  _sourceJobIndex: number,
  params: Record<string, unknown> = {},
): Built {
  const A = SA3_A2A_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const ref = sourceRef(params, A);
  const { samplerId, posId, seed } = wireCommon(workflow, A, params, true);
  setNodeInput(workflow, need(workflow, "LoadAudio", A), "audio", ref);
  setNodeInput(
    workflow,
    samplerId,
    "denoise",
    clamp(params.strength, SA3_STRENGTH),
  );
  return { workflow, slots: slotsFor(samplerId, posId), seed };
}

function sourceSeconds(params: Record<string, unknown>): number | undefined {
  const n = num(params.seconds);
  return n !== undefined && n > 0 ? n : undefined;
}

export function buildSa3Inpaint(
  baseWorkflow: Workflow,
  _sourceRun: ImagineRun,
  _sourceJobIndex: number,
  params: Record<string, unknown> = {},
): Built {
  const A = SA3_INPAINT_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const ref = sourceRef(params, A);
  let regions: AudioRegion[];
  try {
    regions = parseAudioRegions(text(params.regions));
  } catch (e) {
    throw new Error(`${A}: ${(e as Error).message}`);
  }
  if (!regions.length)
    throw new Error(`${A}: pick at least one section to fix (e.g. 4-8)`);
  const src = sourceSeconds(params);
  if (src !== undefined && regions.some((r) => r.start >= src))
    throw new Error(
      `${A}: a section starts after the end of the audio (${fmtSeconds(src)} s)`,
    );
  const { samplerId, posId, seed } = wireCommon(workflow, A, params, false);
  const regionText = formatAudioRegions(regions);
  setNodeInput(workflow, need(workflow, "LoadAudio", A), "audio", ref);
  const condId = need(workflow, "CJSA3InpaintConditioning", A);
  setNodeInput(workflow, condId, "regions", regionText);
  setNodeInput(workflow, condId, "total_seconds", 0);
  const pasteId = need(workflow, "CJAudioPasteback", A);
  setNodeInput(workflow, pasteId, "regions", regionText);
  setNodeInput(workflow, pasteId, "crossfade_ms", SA3_CROSSFADE_MS);
  setNodeInput(workflow, samplerId, "denoise", 1);
  return { workflow, slots: slotsFor(samplerId, posId), seed };
}

export function buildSa3Extend(
  baseWorkflow: Workflow,
  _sourceRun: ImagineRun,
  _sourceJobIndex: number,
  params: Record<string, unknown> = {},
): Built {
  const A = SA3_EXTEND_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const ref = sourceRef(params, A);
  const total = clamp(params.total, SA3_EXTEND_TOTAL);
  const src = sourceSeconds(params);
  if (src !== undefined && total <= src)
    throw new Error(
      `${A}: the new length (${fmtSeconds(total)} s) must be longer than the audio (${fmtSeconds(src)} s)`,
    );
  const { samplerId, posId, seed } = wireCommon(workflow, A, params, false);
  setNodeInput(workflow, need(workflow, "LoadAudio", A), "audio", ref);
  const condId = need(workflow, "CJSA3InpaintConditioning", A);
  setNodeInput(workflow, condId, "regions", "");
  setNodeInput(workflow, condId, "total_seconds", total);
  const pasteId = need(workflow, "CJAudioPasteback", A);
  setNodeInput(workflow, pasteId, "regions", "");
  setNodeInput(workflow, pasteId, "crossfade_ms", SA3_CROSSFADE_MS);
  setNodeInput(workflow, samplerId, "denoise", 1);
  return { workflow, slots: slotsFor(samplerId, posId), seed };
}

export const SA3_BUILDERS = {
  [SA3_T2A_ACTION]: buildSa3TextToAudio,
  [SA3_A2A_ACTION]: buildSa3AudioToAudio,
  [SA3_INPAINT_ACTION]: buildSa3Inpaint,
  [SA3_EXTEND_ACTION]: buildSa3Extend,
} as const;

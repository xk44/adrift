/**
 * Voice changer graph builders (plan: src/lib/tools/voiceChanger.ts).
 *
 *   voice_change        packs/audio/voice_change.json  text-seeded:
 *                       params.sourceAudioRef (uploaded speech) is converted.
 *   voice_change_video  packs/audio/voice_change_video.json  clip-sourced
 *                       (job.videos[0]): the clip's audio track is converted
 *                       and remuxed over its frames at 25 fps.
 *
 * Both take an optional params.audioRef (uploaded target voice sample). With
 * none, the target loader + trim are dropped and ChatterboxVC uses the voice
 * built into the model pack.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { parseInputRef } from "@/lib/seedRun";
import { videoLipsyncSourceCap } from "./videoLipsync";
import {
  VOICE_CHANGE_FPS,
  VOICE_CHANGE_MODEL_PACK,
  VOICE_CHANGE_TARGET_REF_SECONDS,
  voiceChangeCfg,
  voiceChangeSpan,
  voiceChangeSteps,
} from "@/lib/tools/voiceChanger";

export const VOICE_CHANGE_ACTION = "voice_change";
export const VOICE_CHANGE_VIDEO_ACTION = "voice_change_video";

type Built = { workflow: Workflow; slots: WorkflowSlots; seed: number };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function seedFrom(raw: unknown): number {
  const n = num(raw);
  return n !== undefined && n >= 0
    ? Math.floor(n)
    : Math.floor(Math.random() * 2147483647);
}

function requireNode(workflow: Workflow, classType: string, action: string) {
  const id = Object.keys(workflow).find(
    (k) => workflow[k]?.class_type === classType,
  );
  if (!id) throw new Error(`${action}: workflow needs ${classType}`);
  return id;
}

function linkSource(value: unknown): string | undefined {
  return Array.isArray(value) && typeof value[0] === "string"
    ? value[0]
    : undefined;
}

/** LoadAudio feeding `input` of the VC node, through an optional trim. */
function loaderFor(
  workflow: Workflow,
  vcId: string,
  input: string,
  action: string,
): { loadId: string; trimId?: string } {
  const first = linkSource(workflow[vcId]?.inputs?.[input]);
  const node = first ? workflow[first] : undefined;
  if (first && node?.class_type === "LoadAudio") return { loadId: first };
  if (first && node?.class_type === "TrimAudioDuration") {
    const loadId = linkSource(node.inputs?.audio);
    if (loadId && workflow[loadId]?.class_type === "LoadAudio")
      return { loadId, trimId: first };
  }
  throw new Error(`${action}: ChatterboxVC ${input} must come from LoadAudio`);
}

function optionalRef(params: Record<string, unknown>, action: string) {
  const ref = text(params.audioRef);
  if (!ref) return undefined;
  if (!parseInputRef(ref, { allowAudio: true }))
    throw new Error(
      `${action}: audioRef must be the uploaded voice sample ("name.mp3 [input]")`,
    );
  return ref;
}

/** Shared ChatterboxVC wiring: source span, target sample (or none), knobs. */
function wireVoiceChange(
  workflow: Workflow,
  action: string,
  sourceRef: string,
  seconds: number,
  params: Record<string, unknown>,
): string {
  const vcId = requireNode(workflow, "ChatterboxVC", action);
  requireNode(workflow, "SaveAudioMP3", action);
  const src = loaderFor(workflow, vcId, "source_audio", action);
  setNodeInput(workflow, src.loadId, "audio", sourceRef);
  if (src.trimId) {
    setNodeInput(workflow, src.trimId, "start_index", 0);
    setNodeInput(workflow, src.trimId, "duration", seconds);
  }

  const targetRef = optionalRef(params, action);
  if (workflow[vcId].inputs.target_voice_audio !== undefined) {
    const tgt = loaderFor(workflow, vcId, "target_voice_audio", action);
    if (targetRef) {
      setNodeInput(workflow, tgt.loadId, "audio", targetRef);
      if (tgt.trimId) {
        setNodeInput(workflow, tgt.trimId, "start_index", 0);
        setNodeInput(
          workflow,
          tgt.trimId,
          "duration",
          VOICE_CHANGE_TARGET_REF_SECONDS,
        );
      }
    } else {
      delete workflow[vcId].inputs.target_voice_audio;
      delete workflow[tgt.loadId];
      if (tgt.trimId) delete workflow[tgt.trimId];
    }
  } else if (targetRef) {
    throw new Error(`${action}: workflow has no target_voice_audio input`);
  }

  setNodeInput(workflow, vcId, "model_pack_name", VOICE_CHANGE_MODEL_PACK);
  setNodeInput(workflow, vcId, "n_timesteps", voiceChangeSteps(params.quality));
  setNodeInput(workflow, vcId, "flow_cfg_scale", voiceChangeCfg(params.match));
  setNodeInput(workflow, vcId, "use_watermark", false);
  return vcId;
}

function slots(id: string, imageInputId?: string): WorkflowSlots {
  return {
    ksamplerId: id,
    posTextId: id,
    posTextInputName: "n_timesteps",
    negTextId: "",
    latentDimsId: "",
    ...(imageInputId ? { imageInputId } : {}),
  };
}

export function buildVoiceChangeWorkflow(
  baseWorkflow: Workflow,
  _sourceRun: ImagineRun,
  _sourceJobIndex: number,
  params: Record<string, unknown> = {},
): Built {
  const A = VOICE_CHANGE_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const sourceRef = text(params.sourceAudioRef);
  if (!sourceRef || !parseInputRef(sourceRef, { allowAudio: true }))
    throw new Error(
      `${A}: sourceAudioRef must be the uploaded speech ("name.mp3 [input]")`,
    );
  const seconds = voiceChangeSpan("audio", num(params.seconds));
  const vcId = wireVoiceChange(workflow, A, sourceRef, seconds, params);
  // ChatterboxVC is deterministic given its inputs; the seed is bookkeeping.
  return { workflow, slots: slots(vcId), seed: seedFrom(params.seed) };
}

export function buildVoiceChangeVideoWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): Built {
  const A = VOICE_CHANGE_VIDEO_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const ref = comfyImageRefFromViewUrl(
    sourceRun.jobs[sourceJobIndex]?.videos?.[0],
  );
  if (!ref) throw new Error(`${A}: source run has no video`);
  const seconds = voiceChangeSpan(
    "video",
    num(params.seconds) ?? num(sourceRun.params?.video_seconds),
  );
  const vcId = wireVoiceChange(workflow, A, ref, seconds, params);

  const vhsId = requireNode(workflow, "VHS_LoadVideo", A);
  const createId = requireNode(workflow, "CreateVideo", A);
  requireNode(workflow, "SaveVideo", A);
  const cap = videoLipsyncSourceCap(sourceRun.width, sourceRun.height);
  setNodeInput(workflow, vhsId, "video", ref);
  setNodeInput(workflow, vhsId, "force_rate", VOICE_CHANGE_FPS);
  setNodeInput(workflow, vhsId, "custom_width", cap.custom_width);
  setNodeInput(workflow, vhsId, "custom_height", cap.custom_height);
  setNodeInput(
    workflow,
    vhsId,
    "frame_load_cap",
    Math.ceil(seconds * VOICE_CHANGE_FPS),
  );
  setNodeInput(workflow, createId, "fps", VOICE_CHANGE_FPS);
  setNodeInput(workflow, createId, "audio", [vcId, 0]);
  const loadId = loaderFor(workflow, vcId, "source_audio", A).loadId;
  return {
    workflow,
    slots: slots(vcId, loadId),
    seed: seedFrom(params.seed),
  };
}

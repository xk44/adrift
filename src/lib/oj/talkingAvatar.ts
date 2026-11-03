/**
 * "Talking avatar" (packs/wan-animate/talking_avatar.json): Wan2.2-S2V 14B on
 * core ComfyUI nodes, wired from the official video_wan2_2_14B_s2v template.
 * The photo (job.images[0]) is the S2V ref_image; the audio (params.audioRef,
 * else job.audios[0] from seed-run) is wav2vec2-encoded and drives the
 * mouth, head and body, so speech talks and music sings.
 *
 * One WanSoundImageToVideo chunk = 77 frames, i.e. 20 latents = 80 audio
 * frames = 5 s @ 16 fps. Longer audio chains WanSoundImageToVideoExtend
 * chunks (each continues from the latent so far and reads the next 80-frame
 * audio window) up to TALK_MAX_CHUNKS; longer audio is cut. The first latent
 * is doubled before decode and 3 frames dropped after (the template's
 * first-frame fix), then frames are trimmed to the audio length and the audio
 * trimmed to the frames and muxed into the mp4.
 *
 * "fast" (default) = Wan2.2 Lightning 4-step LoRA, CFG 1; "quality" drops the
 * LoRA and samples 20 steps at CFG 6 (template's two variants).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { parseInputRef } from "@/lib/seedRun";

export const TALKING_AVATAR_ACTION = "talking_avatar";
export const TALK_FPS = 16;
/** WanSoundImageToVideo length per chunk (template default). */
export const TALK_CHUNK_LENGTH = 77;
/** Audio frames consumed per chunk (latent_t * 4). */
export const TALK_CHUNK_FRAMES = 80;
export const TALK_MAX_CHUNKS = 3;
/** Frames lost to the doubled-first-latent fix. */
const DROP_FRAMES = 3;
export const TALK_MAX_FRAMES =
  TALK_MAX_CHUNKS * TALK_CHUNK_FRAMES - DROP_FRAMES;
export const TALK_MAX_SECONDS = TALK_MAX_FRAMES / TALK_FPS;
const MIN_FRAMES = 16;
const AREA = 640 * 640;

export const TALK_PROMPT =
  "The person talks to the camera with natural head movement and facial expressions, lips moving in sync with the audio.";

const N = {
  photo: "1",
  audio: "2",
  trim: "3",
  encode: "5",
  lora: "7",
  shift: "8",
  pos: "10",
  neg: "11",
  vae: "12",
  s2v: "14",
  sampler: "15",
  cut: "20",
  concat: "21",
  decode: "22",
  frames: "23",
  mux: "24",
} as const;

export const TALK_NODES = N;

const EXPECT: Record<string, string> = {
  [N.photo]: "LoadImage",
  [N.audio]: "LoadAudio",
  [N.trim]: "TrimAudioDuration",
  [N.encode]: "AudioEncoderEncode",
  [N.lora]: "LoraLoaderModelOnly",
  [N.shift]: "ModelSamplingSD3",
  [N.pos]: "CLIPTextEncode",
  [N.neg]: "CLIPTextEncode",
  [N.s2v]: "WanSoundImageToVideo",
  [N.sampler]: "KSampler",
  [N.cut]: "LatentCut",
  [N.concat]: "LatentConcat",
  [N.decode]: "VAEDecode",
  [N.frames]: "ImageFromBatch",
  [N.mux]: "CreateVideo",
};

/** Plan for `seconds` of audio: output frames and S2V chunks. */
export function talkingAvatarPlan(seconds?: number | null): {
  frames: number;
  chunks: number;
  truncated: boolean;
} {
  const valid =
    typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0;
  const want = valid
    ? Math.ceil(seconds * TALK_FPS)
    : TALK_CHUNK_FRAMES - DROP_FRAMES;
  const frames = Math.min(TALK_MAX_FRAMES, Math.max(MIN_FRAMES, want));
  const chunks = Math.min(
    TALK_MAX_CHUNKS,
    Math.max(1, Math.ceil((frames + DROP_FRAMES) / TALK_CHUNK_FRAMES)),
  );
  return { frames, chunks, truncated: want > TALK_MAX_FRAMES };
}

const snap16 = (v: number) => Math.max(16, Math.round(v / 16) * 16);

/** Photo aspect (clamped 9:16..16:9) at ~640x640 pixels, /16 grid. */
export function talkingAvatarDims(
  width?: number,
  height?: number,
): { width: number; height: number } {
  const w = typeof width === "number" && width > 0 ? width : 1;
  const h = typeof height === "number" && height > 0 ? height : 1;
  const aspect = Math.min(16 / 9, Math.max(9 / 16, w / h));
  return {
    width: snap16(Math.sqrt(AREA * aspect)),
    height: snap16(Math.sqrt(AREA / aspect)),
  };
}

function numberOr(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

/**
 * params: audioRef ("name.wav [input]"), audio_seconds, prompt, mode
 * ("fast" | "quality"), seed.
 */
export function buildTalkingAvatarWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const A = TALKING_AVATAR_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];

  const photoRef = comfyImageRefFromViewUrl(job?.images?.[0]);
  if (!photoRef) throw new Error(`${A}: source run has no image`);
  const explicitAudio =
    typeof params.audioRef === "string" ? params.audioRef.trim() : "";
  let audioRef: string | null = null;
  if (explicitAudio) {
    if (!parseInputRef(explicitAudio, { allowAudio: true })) {
      throw new Error(
        `${A}: audioRef must be an uploaded audio ref ("name.wav [input]")`,
      );
    }
    audioRef = explicitAudio;
  } else {
    audioRef = comfyImageRefFromViewUrl(job?.audios?.[0]);
  }
  if (!audioRef) throw new Error(`${A}: attach an audio file`);
  for (const [id, cls] of Object.entries(EXPECT)) {
    if (workflow[id]?.class_type !== cls) {
      throw new Error(
        `${A}: workflow node ${id} should be ${cls} (graph out of sync)`,
      );
    }
  }

  setNodeInput(workflow, N.photo, "image", photoRef);
  setNodeInput(workflow, N.audio, "audio", audioRef);
  const prompt =
    typeof params.prompt === "string" && params.prompt.trim()
      ? params.prompt.trim().slice(0, 1000)
      : TALK_PROMPT;
  setNodeInput(workflow, N.pos, "text", prompt);

  const dims = talkingAvatarDims(sourceRun.width, sourceRun.height);
  setNodeInput(workflow, N.s2v, "width", dims.width);
  setNodeInput(workflow, N.s2v, "height", dims.height);
  setNodeInput(workflow, N.s2v, "length", TALK_CHUNK_LENGTH);

  const quality =
    typeof params.mode === "string" &&
    params.mode.trim().toLowerCase() === "quality";
  const steps = quality ? 20 : 4;
  const cfg = quality ? 6 : 1;
  if (quality) {
    // Drop the Lightning LoRA: shift reads the UNet directly.
    setNodeInput(workflow, N.shift, "model", workflow[N.lora].inputs.model);
    delete workflow[N.lora];
  }
  const seed = numberOr(params.seed) ?? Math.floor(Math.random() * 2 ** 32);
  setNodeInput(workflow, N.sampler, "seed", seed);
  setNodeInput(workflow, N.sampler, "steps", steps);
  setNodeInput(workflow, N.sampler, "cfg", cfg);

  const seconds = numberOr(
    params.audio_seconds,
    params.audio_duration,
    sourceRun.params?.audio_seconds,
  );
  const plan = talkingAvatarPlan(seconds);
  setNodeInput(
    workflow,
    N.trim,
    "duration",
    Math.round((plan.frames / TALK_FPS) * 100) / 100,
  );

  // Chain extend chunks; `acc` is the running latent.
  let next = Math.max(
    ...Object.keys(workflow).map(Number).filter(Number.isFinite),
  );
  const newId = () => String(++next);
  let acc: [string, number] = [N.sampler, 0];
  for (let k = 2; k <= plan.chunks; k++) {
    const ext = newId();
    const ks = newId();
    const cat = newId();
    const meta = (title: string) => ({ title: `${title} (chunk ${k})` });
    workflow[ext] = {
      class_type: "WanSoundImageToVideoExtend",
      inputs: {
        positive: [N.pos, 0],
        negative: [N.neg, 0],
        vae: [N.vae, 0],
        length: TALK_CHUNK_LENGTH,
        video_latent: acc,
        audio_encoder_output: [N.encode, 0],
        ref_image: [N.photo, 0],
      },
      _meta: meta("S2V Extend"),
    } as Workflow[string];
    workflow[ks] = {
      class_type: "KSampler",
      inputs: {
        ...structuredClone(workflow[N.sampler].inputs),
        positive: [ext, 0],
        negative: [ext, 1],
        latent_image: [ext, 2],
        seed: seed + k - 1,
      },
      _meta: meta("KSampler"),
    } as Workflow[string];
    workflow[cat] = {
      class_type: "LatentConcat",
      inputs: { samples1: acc, samples2: [ks, 0], dim: "t" },
      _meta: meta("Append"),
    } as Workflow[string];
    acc = [cat, 0];
  }
  setNodeInput(workflow, N.cut, "samples", acc);
  setNodeInput(workflow, N.concat, "samples2", acc);
  setNodeInput(workflow, N.frames, "batch_index", DROP_FRAMES);
  setNodeInput(workflow, N.frames, "length", plan.frames);
  setNodeInput(workflow, N.mux, "fps", TALK_FPS);

  return {
    workflow,
    slots: {
      ksamplerId: N.sampler,
      posTextId: N.pos,
      posTextInputName: "text",
      negTextId: N.neg,
      latentDimsId: N.s2v,
      imageInputId: N.photo,
    },
    seed,
  };
}

/**
 * pipeline_assemble (packs/pipeline/assemble.json): joins the pipeline's
 * scene clips into one vertical short with burned-in captions, the scenes'
 * narration and an optional music bed. Core ComfyUI + VideoHelperSuite
 * nodes only (no models), graph generated per scene from params:
 *
 *   params.scenes[i] = { video, audio?, caption?, clipSeconds, seconds }
 *     video/audio  ComfyUI file refs ("video/x_00001_.mp4 [output]")
 *     clipSeconds  the clip's length (browser metadata); frames past
 *                  floor(clipSeconds * fps) - 1 are never read
 *     startSeconds optional offset into the clip (ClipCut re-uses one
 *                  look's clip for several beat cuts, each further in)
 *     seconds      the scene's length on the timeline; when longer than the
 *                  clip the last frame is held (narration runs long)
 *     clipAudioDb  optional: mix the clip's own sound (LTX-2.5 audio) under
 *                  the narration at this level (-40..0 dB); absent = muted
 *   params.music    music bed ref (optional), params.musicDb (-40..0)
 *   params.size     "720x1280" | "1080x1920"; params.fps 12..30
 *   params.captions burn scene captions (default true)
 *
 * Each scene's audio is padded with silence and cut to exactly
 * frames / fps, so the chained soundtrack stays in sync with the video
 * however long each narration is.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import { cloneWorkflow } from "./engine";
import {
  ASSEMBLE_FPS,
  ASSEMBLE_MAX_SCENES,
  ASSEMBLE_MAX_SECONDS,
  ASSEMBLE_SIZES,
  AUDIO_EXT,
  SCENE_MAX_SECONDS,
  VIDEO_EXT,
  isSafeFileRef,
  wrapCaption,
  type AssembleSize,
} from "@/lib/tools/pipelines";

export const PIPELINE_ASSEMBLE_ACTION = "pipeline_assemble";
export const ASSEMBLE_MUSIC_DB_DEFAULT = -16;
/** Caption height as % of the frame (TextOverlay font_size). */
export const ASSEMBLE_CAPTION_SIZE = 3.6;
const SAMPLE_RATE = 44100;

export interface AssemblePlanScene {
  video: string;
  audio: string | null;
  caption: string;
  /** Frames skipped at the start of the clip (startSeconds). */
  skipFrames: number;
  /** Frames read from the clip. */
  clipFrames: number;
  /** Frames of the last clip frame repeated after it. */
  holdFrames: number;
  /** Exact scene length (clipFrames + holdFrames) / fps. */
  seconds: number;
  /** Clip's own audio level in dB, null = not mixed. */
  clipAudioDb: number | null;
}

export interface AssemblePlan {
  width: number;
  height: number;
  fps: number;
  captions: boolean;
  music: string | null;
  musicDb: number;
  prefix: string;
  scenes: AssemblePlanScene[];
  totalSeconds: number;
}

function num(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Validate params and compute frame counts (pure; throws on bad input). */
export function planAssembly(params: Record<string, unknown>): AssemblePlan {
  const A = PIPELINE_ASSEMBLE_ACTION;
  const raw = params.scenes;
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Error(`${A}: no scenes to assemble`);
  if (raw.length > ASSEMBLE_MAX_SCENES) {
    throw new Error(`${A}: at most ${ASSEMBLE_MAX_SCENES} scenes`);
  }
  const sizeKey = (
    typeof params.size === "string" ? params.size : "720x1280"
  ) as AssembleSize;
  const size = ASSEMBLE_SIZES[sizeKey];
  if (!size) throw new Error(`${A}: unknown size "${String(params.size)}"`);
  const fps = Math.round(
    Math.min(30, Math.max(12, num(params.fps) ?? ASSEMBLE_FPS)),
  );
  const captions = params.captions !== false;

  const scenes = raw.map((s, i): AssemblePlanScene => {
    const scene = (s && typeof s === "object" ? s : {}) as Record<
      string,
      unknown
    >;
    const n = i + 1;
    if (!isSafeFileRef(scene.video, VIDEO_EXT)) {
      throw new Error(
        `${A}: scene ${n} needs a clip ref ("name.mp4 [output]")`,
      );
    }
    const audio =
      scene.audio === undefined || scene.audio === null || scene.audio === ""
        ? null
        : scene.audio;
    if (audio !== null && !isSafeFileRef(audio, AUDIO_EXT)) {
      throw new Error(`${A}: scene ${n} audio must be an audio file ref`);
    }
    const clipSeconds = num(scene.clipSeconds);
    if (!clipSeconds || clipSeconds <= 0 || clipSeconds > 60) {
      throw new Error(`${A}: scene ${n} needs clipSeconds (0-60)`);
    }
    const target = Math.min(
      SCENE_MAX_SECONDS,
      Math.max(num(scene.seconds) ?? clipSeconds, 0.5),
    );
    const start = num(scene.startSeconds) ?? 0;
    const skipFrames =
      start > 0 ? Math.max(0, Math.round(Math.min(start, clipSeconds) * fps)) : 0;
    // Undershoot the clip by a frame: a capped read must never come up short.
    const available = Math.floor(clipSeconds * fps) - 1 - skipFrames;
    if (skipFrames > 0 && available < 1) {
      throw new Error(`${A}: scene ${n} startSeconds is past the clip end`);
    }
    const clipFrames = Math.max(
      1,
      Math.min(available, Math.round(target * fps)),
    );
    const total = Math.max(clipFrames, Math.round(target * fps));
    const clipDb = num(scene.clipAudioDb);
    const caption =
      typeof scene.caption === "string"
        ? scene.caption.replace(/\s+/g, " ").trim()
        : "";
    return {
      video: scene.video,
      audio: audio as string | null,
      caption: caption.slice(0, 240),
      skipFrames,
      clipFrames,
      holdFrames: total - clipFrames,
      seconds: round3(total / fps),
      clipAudioDb:
        clipDb === undefined
          ? null
          : Math.round(Math.min(0, Math.max(-40, clipDb))),
    };
  });
  const totalSeconds = round3(scenes.reduce((a, s) => a + s.seconds, 0));
  if (totalSeconds > ASSEMBLE_MAX_SECONDS) {
    throw new Error(
      `${A}: ${totalSeconds}s is longer than ${ASSEMBLE_MAX_SECONDS}s`,
    );
  }
  const music =
    params.music === undefined || params.music === null || params.music === ""
      ? null
      : params.music;
  if (music !== null && !isSafeFileRef(music, AUDIO_EXT)) {
    throw new Error(`${A}: music must be an audio file ref`);
  }
  const musicDb = Math.round(
    Math.min(
      0,
      Math.max(-40, num(params.musicDb) ?? ASSEMBLE_MUSIC_DB_DEFAULT),
    ),
  );
  const prefix =
    typeof params.prefix === "string" &&
    /^video\/[A-Za-z0-9_-]{1,40}$/.test(params.prefix)
      ? params.prefix
      : "video/adrift_short";
  return {
    width: size.width,
    height: size.height,
    fps,
    captions,
    music: music as string | null,
    musicDb,
    prefix,
    scenes,
    totalSeconds,
  };
}

export function buildPipelineAssembleWorkflow(
  baseWorkflow: Workflow,
  _sourceRun: ImagineRun,
  _sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const A = PIPELINE_ASSEMBLE_ACTION;
  const plan = planAssembly(params);
  const base = cloneWorkflow(baseWorkflow);
  const saveId = Object.keys(base).find(
    (k) => base[k]?.class_type === "SaveVideo",
  );
  if (!saveId) throw new Error(`${A}: workflow needs SaveVideo`);

  // Keep annotations + SaveVideo; everything else is regenerated.
  const workflow: Workflow = {};
  for (const [k, v] of Object.entries(base))
    if (k.startsWith("_")) workflow[k] = v;
  workflow[saveId] = base[saveId];
  let next =
    Math.max(0, ...Object.keys(base).map(Number).filter(Number.isFinite)) + 1;
  const add = (
    class_type: string,
    inputs: Record<string, unknown>,
    title: string,
  ): string => {
    const id = String(next++);
    workflow[id] = { class_type, inputs, _meta: { title } };
    return id;
  };

  const videos: string[] = [];
  let track: string | null = null;
  plan.scenes.forEach((scene, i) => {
    const n = i + 1;
    const load = add(
      "VHS_LoadVideo",
      {
        video: scene.video,
        force_rate: plan.fps,
        custom_width: 0,
        custom_height: 0,
        frame_load_cap: scene.clipFrames,
        skip_first_frames: scene.skipFrames,
        select_every_nth: 1,
        format: "None",
      },
      `Scene ${n} Clip`,
    );
    let frames = add(
      "ImageScale",
      {
        image: [load, 0],
        upscale_method: "lanczos",
        width: plan.width,
        height: plan.height,
        crop: "center",
      },
      `Scene ${n} Fit`,
    );
    if (scene.holdFrames > 0) {
      const last = add(
        "ImageFromBatch",
        { image: [frames, 0], batch_index: -1, length: 1 },
        `Scene ${n} Last Frame`,
      );
      const hold = add(
        "RepeatImageBatch",
        { image: [last, 0], amount: scene.holdFrames },
        `Scene ${n} Hold`,
      );
      frames = add(
        "ImageBatch",
        { image1: [frames, 0], image2: [hold, 0] },
        `Scene ${n} Clip + Hold`,
      );
    }
    if (plan.captions && scene.caption) {
      frames = add(
        "TextOverlay",
        {
          images: [frames, 0],
          text: wrapCaption(scene.caption, plan.width >= 1080 ? 26 : 24),
          font_size: ASSEMBLE_CAPTION_SIZE,
          color: "#ffffff",
          position: "bottom",
          align: "center",
          outline: true,
        },
        `Scene ${n} Caption`,
      );
    }
    videos.push(
      add(
        "CreateVideo",
        { images: [frames, 0], fps: plan.fps },
        `Scene ${n} Video`,
      ),
    );

    const silence = add(
      "EmptyAudio",
      { duration: scene.seconds, sample_rate: SAMPLE_RATE, channels: 2 },
      `Scene ${n} Silence`,
    );
    let sceneAudio = silence;
    if (scene.audio) {
      const voice = add(
        "LoadAudio",
        { audio: scene.audio },
        `Scene ${n} Narration`,
      );
      const padded = add(
        "AudioConcat",
        { audio1: [voice, 0], audio2: [silence, 0], direction: "after" },
        `Scene ${n} Pad`,
      );
      sceneAudio = add(
        "TrimAudioDuration",
        { audio: [padded, 0], start_index: 0, duration: scene.seconds },
        `Scene ${n} Fit Audio`,
      );
    }
    if (scene.clipAudioDb !== null) {
      // VHS_LoadVideo output 2 is the clip audio for exactly the frames
      // read; AudioMerge pads/trims it to the scene's fitted track.
      const clipSound =
        scene.clipAudioDb === 0
          ? load
          : add(
              "AudioAdjustVolume",
              { audio: [load, 2], volume: scene.clipAudioDb },
              `Scene ${n} Clip Sound Level`,
            );
      sceneAudio = add(
        "AudioMerge",
        {
          audio1: [sceneAudio, 0],
          audio2: [clipSound, clipSound === load ? 2 : 0],
          merge_method: "add",
        },
        `Scene ${n} Mix Clip Sound`,
      );
    }
    track =
      track === null
        ? sceneAudio
        : add(
            "AudioConcat",
            { audio1: [track, 0], audio2: [sceneAudio, 0], direction: "after" },
            `Soundtrack + ${n}`,
          );
  });

  if (plan.music && track) {
    const music = add("LoadAudio", { audio: plan.music }, "Music Bed");
    const quiet = add(
      "AudioAdjustVolume",
      { audio: [music, 0], volume: plan.musicDb },
      "Music Level",
    );
    const cut = add(
      "TrimAudioDuration",
      { audio: [quiet, 0], start_index: 0, duration: plan.totalSeconds },
      "Music Length",
    );
    track = add(
      "AudioMerge",
      { audio1: [track, 0], audio2: [cut, 0], merge_method: "add" },
      "Mix Music",
    );
  }

  const concatInputs: Record<string, unknown> = { codec: "auto" };
  videos.forEach((v, i) => {
    concatInputs[`videos.video${i}`] = [v, 0];
  });
  if (track) concatInputs.complete_audio = [track, 0];
  const concat = add("ConcatenateVideo", concatInputs, "Concat Scenes");
  workflow[saveId] = {
    ...workflow[saveId],
    inputs: {
      ...workflow[saveId].inputs,
      video: [concat, 0],
      filename_prefix: plan.prefix,
    },
  };

  return {
    workflow,
    slots: {
      ksamplerId: saveId,
      posTextId: saveId,
      posTextInputName: "filename_prefix",
      negTextId: "",
      latentDimsId: "",
    },
    seed: 0,
  };
}

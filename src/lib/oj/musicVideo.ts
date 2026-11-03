/**
 * Music video builders (packs/minimax/music_video*.json); planning and
 * params live in src/lib/tools/musicVideo.ts.
 *
 * music_video (one segment, MiniMax H3 Ref2VA + ref2v Turbo 4-step):
 *   params.song        song ref ("x.mp3 [input]")
 *   params.songStart   window start in the song (s)
 *   params.index       segment index; params.startFrame / params.frames its
 *                      first kept frame / kept frames on the 24 fps timeline
 *   params.refs        1-3 reference image refs (<Picture 1..3>)
 *   params.prompt      the full segment prompt
 *   params.aspect      "16:9" | "9:16" | "1:1"
 *   params.token       run token (sidecar folder of the last frames)
 *   params.prevFrame   segment index-1's last-frame sidecar (index > 0)
 *   params.vocals      optional vocal stem ref (window-relative): frozen
 *                      as the audio guide instead of the mix (lip-sync)
 *   params.seed
 *
 * Segment i > 0 renders h3Frames(frames + 1) frames: frame 0 is anchored to
 * the previous segment's last frame and dropped, so the kept frames start
 * exactly at startFrame. The guide audio covers the rendered span
 * (from startFrame - 1); the saved clip carries the song slice of its kept
 * frames.
 *
 * music_video_assemble: params.clips (segment refs), params.frames (kept
 * frames each), params.song, params.songStart.
 * music_video_stems: params.song, params.songStart, params.seconds.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import { cloneWorkflow } from "./engine";
import {
  MUSIC_VIDEO_ACTION,
  MUSIC_VIDEO_ASSEMBLE_ACTION,
  MUSIC_VIDEO_STEMS_ACTION,
  MUSIC_VIDEO_STEMS_NODE,
  MV_FPS,
  MV_SIZES,
  h3Frames,
  lastFramePrefix,
  normalizeAssembleParams,
  normalizeSegmentParams,
  normalizeStemsParams,
} from "@/lib/tools/musicVideo";

export {
  MUSIC_VIDEO_ACTION,
  MUSIC_VIDEO_ASSEMBLE_ACTION,
  MUSIC_VIDEO_STEMS_ACTION,
};

export const MV_PREFIX = "video/adrift_mtv";
export const MV_STEMS_PREFIX = "audio/adrift_mtv";

/** Fixed node ids in packs/minimax/music_video.json. */
export const MV_NODES = {
  unet: "1",
  lora: "20",
  shift: "21",
  attention: "22",
  ref0: "15",
  r2v: "5",
  song: "30",
  guideSlice: "31",
  guideEncode: "32",
  freezeMask: "33",
  concat: "35",
  prevImage: "40",
  addGuide: "41",
  noise: "8",
  guider: "9",
  sampler: "10",
  kept: "12",
  songSlice: "36",
  save: "14",
  lastFrame: "42",
  lastSave: "43",
} as const;

type Built = { workflow: Workflow; slots: WorkflowSlots; seed: number };

const r3 = (n: number) => Math.round(n * 1000) / 1000;

function need(workflow: Workflow, id: string, cls: string, action: string) {
  if (workflow[id]?.class_type !== cls)
    throw new Error(`${action}: workflow node ${id} must be ${cls}`);
}

function setInputs(
  workflow: Workflow,
  id: string,
  inputs: Record<string, unknown>,
) {
  workflow[id] = {
    ...workflow[id],
    inputs: { ...workflow[id].inputs, ...inputs },
  };
}

function slotsFor(
  id: string,
  posTextId = id,
  posTextInputName = "filename_prefix",
): WorkflowSlots {
  return {
    ksamplerId: id,
    posTextId,
    posTextInputName,
    negTextId: "",
    latentDimsId: "",
  };
}

export function buildMusicVideoWorkflow(
  baseWorkflow: Workflow,
  _sourceRun: ImagineRun,
  _sourceJobIndex: number,
  params: Record<string, unknown> = {},
): Built {
  const A = MUSIC_VIDEO_ACTION;
  const p = normalizeSegmentParams(params);
  const workflow = cloneWorkflow(baseWorkflow);
  const N = MV_NODES;
  for (const [id, cls] of [
    [N.r2v, "MiniMaxH3ReferenceToVideo"],
    [N.ref0, "LoadImage"],
    [N.song, "LoadAudio"],
    [N.guideSlice, "TrimAudioDuration"],
    [N.freezeMask, "SolidMask"],
    [N.concat, "LTXVConcatAVLatent"],
    [N.prevImage, "LoadImage"],
    [N.addGuide, "MiniMaxH3AddGuide"],
    [N.noise, "RandomNoise"],
    [N.guider, "BasicGuider"],
    [N.kept, "ImageFromBatch"],
    [N.songSlice, "TrimAudioDuration"],
    [N.save, "SaveVideo"],
    [N.lastFrame, "ImageFromBatch"],
    [N.lastSave, "SaveImage"],
  ] as const)
    need(workflow, id, cls, A);

  const { width, height } = MV_SIZES[p.aspect];
  const skip = p.index > 0 ? 1 : 0;
  const length = h3Frames(p.frames + skip);
  const renderStart = (p.startFrame - skip) / MV_FPS;
  const tag = String(p.index + 1).padStart(2, "0");

  // References: node 15 is ref 0; extra refs get their own LoadImage.
  setInputs(workflow, N.ref0, { image: p.refs[0] });
  const refInputs: Record<string, unknown> = {
    "ref_images.ref_image_0": [N.ref0, 0],
  };
  p.refs.slice(1).forEach((ref, i) => {
    const id = `${16 + i}`;
    workflow[id] = {
      class_type: "LoadImage",
      inputs: { image: ref },
      _meta: { title: `Reference ${i + 2}` },
    };
    refInputs[`ref_images.ref_image_${i + 1}`] = [id, 0];
  });
  setInputs(workflow, N.r2v, {
    prompt: p.prompt,
    width,
    height,
    length,
    ...refInputs,
  });

  // Frozen audio guide over the rendered span (vocal stem for lip-sync:
  // the stem is the window only, so its clock starts at songStart).
  setInputs(workflow, N.song, { audio: p.song });
  if (p.vocals) {
    workflow["37"] = {
      class_type: "LoadAudio",
      inputs: { audio: p.vocals },
      _meta: { title: "Vocal Stem" },
    };
    setInputs(workflow, N.guideSlice, {
      audio: ["37", 0],
      start_index: r3(renderStart),
      duration: r3(length / MV_FPS),
    });
  } else {
    setInputs(workflow, N.guideSlice, {
      audio: [N.song, 0],
      start_index: r3(p.songStart + renderStart),
      duration: r3(length / MV_FPS),
    });
  }
  setInputs(workflow, N.freezeMask, { width, height });

  // Continuity: anchor the previous last frame at frame 0 (or drop it).
  if (p.prevFrame) {
    setInputs(workflow, N.prevImage, { image: p.prevFrame });
  } else {
    delete workflow[N.prevImage];
    delete workflow[N.addGuide];
    setInputs(workflow, N.guider, { conditioning: [N.r2v, 0] });
  }

  setInputs(workflow, N.noise, { noise_seed: p.seed });
  setInputs(workflow, N.kept, { batch_index: skip, length: p.frames });
  setInputs(workflow, N.songSlice, {
    start_index: r3(p.songStart + p.startFrame / MV_FPS),
    duration: r3(p.frames / MV_FPS),
  });
  setInputs(workflow, N.save, {
    filename_prefix: `${MV_PREFIX}/CJ_MTV_${p.token}_seg${tag}`,
  });
  setInputs(workflow, N.lastFrame, { batch_index: p.frames - 1, length: 1 });
  setInputs(workflow, N.lastSave, {
    filename_prefix: lastFramePrefix(p.token, p.index),
  });
  return {
    workflow,
    slots: slotsFor(N.sampler, N.r2v, "prompt"),
    seed: p.seed,
  };
}

export function buildMusicVideoAssembleWorkflow(
  baseWorkflow: Workflow,
  _sourceRun: ImagineRun,
  _sourceJobIndex: number,
  params: Record<string, unknown> = {},
): Built {
  const A = MUSIC_VIDEO_ASSEMBLE_ACTION;
  const p = normalizeAssembleParams(params);
  const workflow = cloneWorkflow(baseWorkflow);
  need(workflow, "1", "VHS_LoadVideo", A);
  need(workflow, "2", "LoadAudio", A);
  need(workflow, "3", "TrimAudioDuration", A);
  need(workflow, "4", "CreateVideo", A);
  need(workflow, "5", "SaveVideo", A);
  const load = (id: string, clip: string, frames: number, i: number) => {
    workflow[id] = {
      class_type: "VHS_LoadVideo",
      inputs: {
        ...workflow["1"].inputs,
        video: clip,
        force_rate: MV_FPS,
        frame_load_cap: frames,
      },
      _meta: { title: `Segment ${i + 1}` },
    };
  };
  load("1", p.clips[0], p.frames[0], 0);
  let timeline = "1";
  let next = 10;
  for (let i = 1; i < p.clips.length; i++) {
    const id = String(next++);
    load(id, p.clips[i], p.frames[i], i);
    const join = String(next++);
    workflow[join] = {
      class_type: "ImageBatch",
      inputs: { image1: [timeline, 0], image2: [id, 0] },
      _meta: { title: `Cut to Segment ${i + 1}` },
    };
    timeline = join;
  }
  const total = p.frames.reduce((a, b) => a + b, 0);
  setInputs(workflow, "2", { audio: p.song });
  setInputs(workflow, "3", {
    start_index: r3(p.songStart),
    duration: r3(total / MV_FPS),
  });
  setInputs(workflow, "4", { images: [timeline, 0], fps: MV_FPS });
  const token =
    typeof params.token === "string" && /^[a-z0-9]{6,32}$/.test(params.token)
      ? `_${params.token}`
      : "";
  setInputs(workflow, "5", { filename_prefix: `${MV_PREFIX}/CJ_MTV${token}` });
  return { workflow, slots: slotsFor("5"), seed: 0 };
}

export function buildMusicVideoStemsWorkflow(
  baseWorkflow: Workflow,
  _sourceRun: ImagineRun,
  _sourceJobIndex: number,
  params: Record<string, unknown> = {},
): Built {
  const A = MUSIC_VIDEO_STEMS_ACTION;
  const p = normalizeStemsParams(params);
  const workflow = cloneWorkflow(baseWorkflow);
  need(workflow, "1", "LoadAudio", A);
  need(workflow, "2", "TrimAudioDuration", A);
  need(workflow, "3", MUSIC_VIDEO_STEMS_NODE, A);
  need(workflow, "4", "SaveAudio", A);
  need(workflow, "5", "SaveAudio", A);
  setInputs(workflow, "1", { audio: p.song });
  setInputs(workflow, "2", {
    start_index: r3(p.songStart),
    duration: r3(p.seconds),
  });
  return { workflow, slots: slotsFor("3"), seed: 0 };
}

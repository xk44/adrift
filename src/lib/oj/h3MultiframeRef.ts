/**
 * Multiframe Reference (MiniMax H3 Ref2VA + keyframe guides,
 * packs/minimax/multiframe_ref.json): 2-4 keyframe photos pinned to chosen
 * points of a new shot with sound. Port of the official ComfyUI template
 * "MiniMax H3 Multiframe Reference" (comfy.org/workflows e99bd5fc385c):
 *
 *   keyframe 1   <Picture 1> on MiniMaxH3ReferenceToVideo: identity lock and
 *                the first frame (the template adds no guide at frame 0; the
 *                prompt says the video starts from <Picture 1>)
 *   keyframes 2-4  chained MiniMaxH3AddGuide nodes (positive -> positive),
 *                each anchoring one still at an output frame (24 fps)
 *
 *   params.secondRefImage / params.extraRefImages  keyframes 2..4, in order
 *   params.timing      "even" (default: spread over the clip, the last one on
 *                      the final frame) | "custom" (params.keyPositions)
 *   params.keyPositions  % of the clip per keyframe 2..4 (custom timing)
 *   params.flow        "continuous" (default: one shot moving through the
 *                      keyframes) | "cuts" (each keyframe opens a new shot,
 *                      like the template's prompt)
 *   params.keysAsRefs  also wire keyframes 2..4 as ref_images so the encoder
 *                      sees them as <Picture 2..4> (the template's note; off
 *                      by default, every reference rides every step)
 *   params.prompt      optional "what happens" text
 *   params.aspect / resolution / h3Speed / seed   as Reference to Video
 *   params.duration    seconds ("3" | "5" | "8")
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { applyH3ExtraLoras } from "./h3Video";
import { applyH3Speed } from "./h3Speed";
import { refVideoSize } from "./h3RefVideo";

export const MULTIFRAME_REF_ACTION = "multiframe_ref";
export const MULTIFRAME_MAX_KEYS = 4;
export const MULTIFRAME_FPS = 24;
const GUIDE_CLASS = "MiniMaxH3AddGuide";
const R2V_CLASS = "MiniMaxH3ReferenceToVideo";

/** Seconds -> frames on the H3 17k+5 grid (the template's length formula). */
export const MULTIFRAME_LENGTHS: Record<string, number> = {
  "3": 73,
  "5": 124,
  "8": 192,
};
export const MULTIFRAME_DEFAULT_DURATION = "5";

export function multiframeLength(value: unknown): number {
  const key = String(value ?? "").trim();
  return (
    MULTIFRAME_LENGTHS[key] ?? MULTIFRAME_LENGTHS[MULTIFRAME_DEFAULT_DURATION]
  );
}

/** "00:01.500" (the template prompt's timestamp format). */
export function multiframeTimestamp(frame: number): string {
  const ms = Math.round((frame / MULTIFRAME_FPS) * 1000);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rest = ms % 1000;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(rest).padStart(3, "0")}`;
}

/**
 * Output frame per keyframe 2..n. Even timing spreads them so the last lands
 * on the final frame; custom timing reads `positions` (% of the clip, one per
 * keyframe 2..n), clamped into [1, length - 1] and kept strictly increasing
 * (a still guide is one frame and must fit inside the clip).
 */
export function multiframeFrames(
  keys: number,
  length: number,
  positions?: unknown,
): number[] {
  const n = Math.max(2, Math.min(MULTIFRAME_MAX_KEYS, Math.round(keys)));
  const last = length - 1;
  const pcts = Array.isArray(positions) ? positions : null;
  const frames: number[] = [];
  for (let k = 1; k < n; k++) {
    const raw = pcts ? Number(pcts[k - 1]) : NaN;
    const f = Number.isFinite(raw)
      ? Math.round((Math.min(100, Math.max(0, raw)) / 100) * last)
      : Math.round((k / (n - 1)) * last);
    frames.push(Math.min(last, Math.max(1, f)));
  }
  // Custom picks may collide or go backwards: sort, then nudge forward and
  // back so each keyframe has its own frame.
  frames.sort((a, b) => a - b);
  for (let i = 1; i < frames.length; i++)
    if (frames[i] <= frames[i - 1]) frames[i] = frames[i - 1] + 1;
  for (let i = frames.length - 1; i >= 0; i--) {
    const cap = i === frames.length - 1 ? last : frames[i + 1] - 1;
    if (frames[i] > cap) frames[i] = cap;
  }
  return frames;
}

const clean = (v: unknown, max = 600) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

const sentence = (s: string) => {
  const t = s.charAt(0).toUpperCase() + s.slice(1);
  return t && !/[.!?]$/.test(t) ? `${t}.` : t;
};

/**
 * Structured Ref2VA prompt in the template's layout (subject_definitions /
 * summary / retention_analysis / detailed_description / overall_soundscape).
 * Keyframes 2..n are named <Picture k> only when they are wired as
 * references; otherwise the tag would bind to nothing, so they are
 * "keyframe k" (the guides carry the pixels).
 */
export function multiframePrompt(opts: {
  frames: number[];
  length: number;
  text?: unknown;
  flow?: unknown;
  keysAsRefs?: boolean;
}): string {
  const { frames, length } = opts;
  const cuts = opts.flow === "cuts";
  const asRefs = opts.keysAsRefs === true;
  const n = frames.length + 1;
  const secs = (length / MULTIFRAME_FPS).toFixed(1);
  const key = (k: number) => (asRefs ? `<Picture ${k}>` : `keyframe ${k}`);
  const at = (k: number) => multiframeTimestamp(frames[k - 2]);
  const text = clean(opts.text);
  const action =
    text ||
    (cuts
      ? "Each keyframe opens a new shot of the same story"
      : "The scene moves naturally from one keyframe to the next");

  const lines = [
    "subject_definitions:",
    "<Subject 1> is the main subject in <Picture 1>.",
    `<Picture 1> is the first frame of [Shot 1].`,
  ];
  if (asRefs)
    for (let k = 2; k <= n; k++)
      lines.push(
        cuts
          ? `<Picture ${k}> is the first frame of [Shot ${k}], at ${at(k)}.`
          : `<Picture ${k}> is the keyframe at ${at(k)}.`,
      );
  const keyList = Array.from(
    { length: n - 1 },
    (_, i) => `${key(i + 2)} at ${at(i + 2)}`,
  ).join(", ");
  lines.push(
    "",
    "summary:",
    `[keyframe completion + reference generation] A ${secs}-second video at 24 fps that begins from <Picture 1> and then matches ${keyList}. ${sentence(action)}`,
    "",
    "retention_analysis:",
    `<Subject 1> (all shots): fully_preserved - face or features, hair, body proportions and outfit stay consistent with <Picture 1> unless a keyframe shows them changed.`,
    `<Picture 1> ([Shot 1] first frame): fully_preserved - the video starts exactly from <Picture 1>'s framing, subject state and background.`,
  );
  for (let k = 2; k <= n; k++)
    lines.push(
      `${asRefs ? `<Picture ${k}>` : `Keyframe ${k}`} (${at(k)}): fully_preserved - the frame at ${at(k)} matches ${key(k)}'s composition, subject pose and background.`,
    );
  lines.push("", "detailed_description:");
  if (cuts) {
    lines.push(`[Shot 1] The shot begins from <Picture 1>.`);
    for (let k = 2; k <= n; k++)
      lines.push(
        `[Shot ${k}] At ${at(k)}, the shot cuts to the next scene, whose first frame corresponds to ${key(k)}.`,
      );
  } else {
    lines.push(
      `One continuous shot. It begins from <Picture 1>; ` +
        Array.from(
          { length: n - 1 },
          (_, i) =>
            `at ${at(i + 2)} the motion arrives exactly at ${key(i + 2)}`,
        ).join("; ") +
        ". Camera and subject move smoothly and plausibly between keyframes, with no cuts, fades or morphing artifacts.",
    );
  }
  lines.push(
    `${sentence(action)} Consistent lighting and identity throughout. No text, captions, logos or watermarks.`,
    "",
    "overall_soundscape:",
    "Natural, synchronized sound effects and ambience that follow the action and the camera.",
  );
  return lines.join("\n").slice(0, 4000);
}

const ANNOTATED_REF_RE = /^[^\s].* \[(input|output|temp)\]$/;

function validRef(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const ref = v.trim();
  return ref.length <= 300 &&
    ANNOTATED_REF_RE.test(ref) &&
    !ref.split(" [")[0].split("/").includes("..")
    ? ref
    : null;
}

/** Keyframes 2..4 from params (secondRefImage, then extraRefImages). */
export function multiframeExtraKeys(params: Record<string, unknown>): string[] {
  const raw = [
    params.secondRefImage,
    ...(Array.isArray(params.extraRefImages) ? params.extraRefImages : []),
  ];
  return raw
    .map(validRef)
    .filter((r): r is string => Boolean(r))
    .slice(0, MULTIFRAME_MAX_KEYS - 1);
}

function nodeIdOf(workflow: Workflow, classType: string): string | undefined {
  return Object.keys(workflow).find(
    (id) => workflow[id].class_type === classType,
  );
}

const linkId = (v: unknown): string | undefined =>
  Array.isArray(v) ? String(v[0]) : undefined;

/** The AddGuide chain in order, starting at the one fed by the Ref2VA node. */
function guideChain(workflow: Workflow, r2vId: string): string[] {
  const chain: string[] = [];
  let prev = r2vId;
  for (;;) {
    const next = Object.keys(workflow).find(
      (id) =>
        workflow[id].class_type === GUIDE_CLASS &&
        linkId(workflow[id].inputs.positive) === prev &&
        !chain.includes(id),
    );
    if (!next) return chain;
    chain.push(next);
    prev = next;
  }
}

export function buildMultiframeRefWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const A = MULTIFRAME_REF_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const firstRef = comfyImageRefFromViewUrl(
    sourceRun.jobs[sourceJobIndex]?.images?.[0],
  );
  if (!firstRef) throw new Error(`${A}: source run has no image`);
  const keys = multiframeExtraKeys(params);
  if (!keys.length) throw new Error(`${A}: needs at least 2 keyframes`);

  const r2vId = nodeIdOf(workflow, R2V_CLASS);
  if (!r2vId) throw new Error(`${A}: workflow needs ${R2V_CLASS}`);
  const r2v = workflow[r2vId].inputs as Record<string, unknown>;
  const ref0Id = linkId(r2v["ref_images.ref_image_0"]);
  if (!ref0Id || workflow[ref0Id]?.class_type !== "LoadImage")
    throw new Error(`${A}: ref_image_0 must come from a LoadImage node`);
  const chain = guideChain(workflow, r2vId);
  if (chain.length < MULTIFRAME_MAX_KEYS - 1)
    throw new Error(
      `${A}: workflow needs ${MULTIFRAME_MAX_KEYS - 1} chained ${GUIDE_CLASS} nodes`,
    );
  const guiderId = Object.keys(workflow).find(
    (id) =>
      workflow[id].class_type === "BasicGuider" &&
      linkId(workflow[id].inputs.conditioning) === chain[chain.length - 1],
  );
  if (!guiderId)
    throw new Error(`${A}: the last guide must feed the BasicGuider`);

  const length = multiframeLength(params.duration);
  const frames = multiframeFrames(
    1 + keys.length,
    length,
    params.timing === "custom" ? params.keyPositions : undefined,
  );
  const keysAsRefs = params.keysAsRefs === true;

  setNodeInput(workflow, ref0Id, "image", firstRef);
  chain.forEach((guideId, i) => {
    const imageId = linkId(workflow[guideId].inputs.image);
    if (i < keys.length) {
      if (!imageId || workflow[imageId]?.class_type !== "LoadImage")
        throw new Error(`${A}: guide ${i + 2} needs a LoadImage image`);
      setNodeInput(workflow, imageId, "image", keys[i]);
      setNodeInput(workflow, guideId, "frame_idx", frames[i]);
      if (keysAsRefs) r2v[`ref_images.ref_image_${i + 1}`] = [imageId, 0];
      return;
    }
    // Unused guide: drop it and its image (a guide with no image errors).
    delete workflow[guideId];
    if (imageId && workflow[imageId]?.class_type === "LoadImage")
      delete workflow[imageId];
  });
  workflow[guiderId].inputs.conditioning = [chain[keys.length - 1], 0];

  const { width, height } = refVideoSize(params.aspect, params.resolution);
  setNodeInput(
    workflow,
    r2vId,
    "prompt",
    multiframePrompt({
      frames,
      length,
      text: params.prompt,
      flow: params.flow,
      keysAsRefs,
    }),
  );
  setNodeInput(workflow, r2vId, "width", width);
  setNodeInput(workflow, r2vId, "height", height);
  setNodeInput(workflow, r2vId, "length", length);

  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? params.seed
      : Math.floor(Math.random() * 2 ** 32);
  const noiseId = nodeIdOf(workflow, "RandomNoise");
  if (noiseId) setNodeInput(workflow, noiseId, "noise_seed", seed);

  applyH3ExtraLoras(workflow, params);
  applyH3Speed(workflow, params);

  const saveId = nodeIdOf(workflow, "SaveVideo");
  if (saveId)
    setNodeInput(workflow, saveId, "filename_prefix", "video/CJ_H3_Multiframe");

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: r2vId,
      posTextInputName: "prompt",
      negTextId: "",
      latentDimsId: r2vId,
      imageInputId: ref0Id,
    },
    seed,
  };
}

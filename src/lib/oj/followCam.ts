/**
 * Follow subject (follow-cam) for the H3 masked video edits.
 *
 * A small subject in a wide shot gets few model pixels. These helpers splice
 * the CJFollowCam* nodes (comfy_nodes/cj_h3_tools/cj_followcam.py) into a
 * built graph: the subject's edit mask drives a smoothed, padded window of
 * the model's aspect; the tool runs on that window, cropped from a plate
 * (prepared geometry at source detail) at the model resolution; the result
 * is pasted back into the plate with a feathered subject mask. Tracking
 * (SAM3) and the final CJPasteBackSave keep the full frame.
 *
 * Idea after Body Double (lucataco/open-source-higgsfield, Apache-2.0); no
 * code from it is used.
 */
import type { Workflow } from "@/types";

export type FollowSubject = "auto" | "on" | "off";
type Ref = [string, number];

export const FOLLOW_SUBJECT_DEFAULT: FollowSubject = "auto";
/** Plate long-side cap (RAM: frames x W x H x 12 bytes on the box). */
export const FOLLOW_CAM_PLATE_MAX_SIDE = 1920;
/** Fixed id block (smart-click tracks use 1000-1599, motion lock 1900+). */
export const FOLLOW_CAM_ID_BASE = 1600;

/** Builder default is "off" so API callers without the param are unchanged;
 * the tool picker always sends a value (default auto). */
export function followSubjectOf(
  params: Record<string, unknown>,
): FollowSubject {
  const v = params.followSubject;
  return v === "auto" || v === "on" || v === "off" ? v : "off";
}

const isLink = (v: unknown): v is Ref =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === "string";
const same = (v: unknown, r: Ref) =>
  isLink(v) && v[0] === r[0] && v[1] === r[1];

/** Every node feeding `id` (inclusive). */
function ancestors(workflow: Workflow, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur) || !workflow[cur]) continue;
    seen.add(cur);
    for (const v of Object.values(workflow[cur].inputs))
      if (isLink(v)) stack.push(v[0]);
  }
  return seen;
}

function rewire(workflow: Workflow, from: Ref, to: Ref, ids: Iterable<string>) {
  for (const id of ids) {
    const node = workflow[id];
    if (!node) continue;
    for (const [k, v] of Object.entries(node.inputs))
      if (same(v, from)) node.inputs[k] = to;
  }
}

function place(workflow: Workflow, id: string, node: Workflow[string]) {
  if (workflow[id]) throw new Error(`follow subject: node id ${id} is taken`);
  workflow[id] = node;
}

function trackNode(mask: Ref, mode: FollowSubject, title: string) {
  return {
    class_type: "CJFollowCamTrack",
    inputs: {
      mask,
      width: ["29", 2] as Ref,
      height: ["29", 3] as Ref,
      mode,
      padding: 0.15,
      smooth: 6,
      max_zoom: 4,
      auto_min_zoom: 1.5,
    },
    _meta: { title },
  };
}

function plateNode() {
  return {
    class_type: "CJFollowCamPlate",
    inputs: {
      source: ["7", 0] as Ref,
      frames: ["29", 0] as Ref,
      max_side: FOLLOW_CAM_PLATE_MAX_SIDE,
    },
    _meta: { title: "Follow subject: source plate" },
  };
}

const crop = (images: Ref, fc: Ref, title: string) => ({
  class_type: "CJFollowCamCrop",
  inputs: { images, followcam: fc },
  _meta: { title },
});
const cropMask = (mask: Ref, fc: Ref, title: string) => ({
  class_type: "CJFollowCamCropMask",
  inputs: { mask, followcam: fc },
  _meta: { title },
});
const paste = (base: Ref, crops: Ref, fc: Ref, mask: Ref, title: string) => ({
  class_type: "CJFollowCamPaste",
  inputs: {
    base,
    crops,
    followcam: fc,
    mask,
    grow_px: 4,
    feather_px: 6,
    edge_px: 8,
  },
  _meta: { title },
});

/**
 * character_swap_masked (one subject). Every consumer of the prepared frames
 * and of the shading / edit masks that is not upstream of the track (SAM3,
 * smart clicks) moves to crop space: mannequin composite, VAEEncode, pose /
 * depth guide, ControlNet source. The decoded result (or the 2K finish) is
 * pasted into the plate, which then feeds CJPasteBackSave with its
 * full-frame masks. Call after applyMotionGuide / applyFinish2K.
 */
export function applyFollowCam(
  workflow: Workflow,
  params: Record<string, unknown>,
  ids = { shadeMask: "19", editMask: "20", save: "52" },
) {
  const mode = followSubjectOf(params);
  const save = workflow[ids.save];
  if (mode === "off" || !save || !workflow[ids.editMask]) return;
  const id = (o: number) => String(FOLLOW_CAM_ID_BASE + o);
  const tracking = ancestors(workflow, ids.editMask);
  const consumers = Object.keys(workflow).filter(
    (k) => !tracking.has(k) && k !== ids.save,
  );
  const fc: Ref = [id(1), 0];
  place(workflow, id(0), plateNode());
  place(
    workflow,
    id(1),
    trackNode([ids.editMask, 0], mode, "Follow subject: track"),
  );
  rewire(workflow, ["29", 0], [id(2), 0], consumers);
  rewire(workflow, [ids.shadeMask, 0], [id(3), 0], consumers);
  rewire(workflow, [ids.editMask, 0], [id(4), 0], consumers);
  place(workflow, id(2), crop([id(0), 0], fc, "Follow subject: crop"));
  place(
    workflow,
    id(3),
    cropMask([ids.shadeMask, 0], fc, "Follow subject: crop shading mask"),
  );
  place(
    workflow,
    id(4),
    cropMask([ids.editMask, 0], fc, "Follow subject: crop edit mask"),
  );
  const result = save.inputs.frames;
  if (!isLink(result))
    throw new Error("follow subject: paste-back frames are not linked");
  place(
    workflow,
    id(5),
    paste([id(0), 0], result, fc, [id(4), 0], "Follow subject: paste back"),
  );
  save.inputs.frames = [id(5), 0];
}

/**
 * cast_swap: one crop pass per person, so faces never share a window. Pass k
 * (ids 100k..) tracks its own grown mask (100k+8), crops from the previous
 * pass's paste (pass 1: the plate) and its composite (100k+19) becomes the
 * paste into that same base, so later passes and the final trim stay wired.
 * The edit mask of pass k (108 / 209 / 309) already excludes earlier people.
 */
export function applyFollowCamCast(
  workflow: Workflow,
  params: Record<string, unknown>,
  people: number,
) {
  const mode = followSubjectOf(params);
  if (mode === "off" || people < 1) return;
  const plate = String(FOLLOW_CAM_ID_BASE);
  place(workflow, plate, plateNode());
  for (let k = 1; k <= people; k++) {
    const b = 100 * k;
    const p = (o: number) => String(b + o);
    const f = (o: number) => String(FOLLOW_CAM_ID_BASE + 10 * k + o);
    for (const o of [7, 8, 10, 12, 13, 18, 19])
      if (!workflow[p(o)])
        throw new Error(
          `cast_swap: follow subject pass ${k} node ${p(o)} missing`,
        );
    const frameIn: Ref = k === 1 ? ["29", 0] : [String(b - 100 + 19), 0];
    const base: Ref = k === 1 ? [plate, 0] : frameIn;
    const edit = workflow[p(13)].inputs.mask;
    if (!isLink(edit))
      throw new Error(`cast_swap: follow subject pass ${k} edit mask missing`);
    const fc: Ref = [f(0), 0];
    place(
      workflow,
      f(0),
      trackNode([p(8), 0], mode, `Follow subject ${k}: track`),
    );
    place(workflow, f(1), crop(base, fc, `Follow subject ${k}: crop`));
    place(
      workflow,
      f(2),
      crop(["34", 0], fc, `Follow subject ${k}: crop shading`),
    );
    place(
      workflow,
      f(3),
      cropMask([p(7), 0], fc, `Follow subject ${k}: crop shading mask`),
    );
    place(
      workflow,
      f(4),
      cropMask(edit, fc, `Follow subject ${k}: crop edit mask`),
    );
    const mannequin = workflow[p(10)].inputs;
    if (
      !same(mannequin.destination, frameIn) ||
      !same(mannequin.source, ["34", 0])
    )
      throw new Error(
        `cast_swap: follow subject pass ${k} mannequin wiring changed`,
      );
    mannequin.destination = [f(1), 0];
    mannequin.source = [f(2), 0];
    mannequin.mask = [f(3), 0];
    if (!same(workflow[p(12)].inputs.pixels, frameIn))
      throw new Error(
        `cast_swap: follow subject pass ${k} encode wiring changed`,
      );
    workflow[p(12)].inputs.pixels = [f(1), 0];
    workflow[p(13)].inputs.mask = [f(4), 0];
    workflow[p(19)] = paste(
      base,
      [p(18), 0],
      fc,
      [f(4), 0],
      `Follow subject ${k}: paste back`,
    );
  }
}

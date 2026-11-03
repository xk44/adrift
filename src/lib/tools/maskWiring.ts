/**
 * Which tools take a subject mask, and how a picked mask reaches the server.
 *
 * Image actions (edits that already support full-res paste-back) get the
 * MaskPainter (Brush | Smart click-to-mask). Each painted subject is uploaded
 * on its own and sent as params.pasteBackMasks: the server pastes the edit
 * back once per mask, clamped to that mask (lib/oj/imagePasteBack.ts), so a
 * refine never leaves its mask and two subjects never share a pass.
 *
 * Video actions with a SAM text target take VideoMaskPicker clicks instead
 * (SMART_TRACK_ACTIONS, lib/tools/smartTrack.ts: object remove / remove text /
 * object swap / person remove / lipsync). Catalog tools with needsMask use the
 * union mask (one inpaint region).
 *
 * Tools that name a subject but get NO picker are listed, with the reason, in
 * MASK_PICKER_EXCLUSIONS (a test keeps that list and the two tables disjoint).
 *
 * Pure: no DOM, no fetch. Unit-tested in maskWiring.test.ts.
 */
import { PASTEBACK_MAX_MASKS } from "@/lib/oj/imagePasteBack";
import { SMART_TRACK_ACTIONS } from "./smartTrack";

export interface RegionMaskTool {
  /** Subjects the painter offers (each becomes its own paste-back pass). */
  subjects: 1 | 2;
  /** Hint above the painter. */
  hint: string;
}

/** Image action tools whose edit can be limited to painted / clicked masks. */
export const REGION_MASK_TOOLS: Record<string, RegionMaskTool> = {
  edit_photo: {
    subjects: 2,
    hint: "Optional: click or paint what to change. Each subject is refined on its own; everything outside stays original.",
  },
  edit_qwen21: {
    subjects: 2,
    hint: "Optional: click or paint what to change (instead of naming the area). Each subject is refined on its own.",
  },
  edit_flux3: {
    subjects: 2,
    hint: "Optional: click or paint what to change (instead of naming the area). Each subject is refined on its own.",
  },
  edit_fibo: {
    subjects: 2,
    hint: "Optional: click or paint what to change (instead of naming the area). Each subject is refined on its own.",
  },
  remove_object: {
    subjects: 2,
    hint: "Optional: click or paint what to remove. Nothing outside the mask changes.",
  },
  replace_person: {
    subjects: 1,
    hint: "Optional: click the person to replace (cover the face). Only that person changes.",
  },
};

export function regionMaskTool(
  specId: string | undefined,
): RegionMaskTool | null {
  return specId &&
    Object.prototype.hasOwnProperty.call(REGION_MASK_TOOLS, specId)
    ? REGION_MASK_TOOLS[specId]
    : null;
}

/**
 * Subject-naming tools deliberately left without a mask picker, and why.
 * A picker is only wired where the graph has a mask or SAM branch the clicks
 * can replace; these graphs have none.
 */
export const MASK_PICKER_EXCLUSIONS: Record<string, string> = {
  video_bg_remove:
    "'Who to keep' feeds SAM 3.1 text detection on the first frame of the MatAnyone2 engine; the graph has no click or mask input for a picker.",
  character_swap:
    "MiniMax H3 Ref2VA has no mask input: 'Who to replace' is a phrase substituted into the prompt (characterSwapPrompt), not a SAM target, so there is no mask for clicks to drive.",
  face_swap:
    "MiniMax H3 Ref2VA FaceSwap LoRA: no mask input and no subject text; the LoRA picks the face itself.",
  wan_animate:
    "Wan Animate replace mode mattes the single main performer with BiRefNet (no SAM, no per-person targeting).",
  relight:
    "Relights the whole photo; the text is lighting details, not a subject.",
  video_edit:
    "Instruction video edit re-renders the clip from the instruction; no mask or SAM branch.",
  video_bg_change:
    "Runs at the clip's native fps (no resample node in the pack). The client now sends that fps (sourceFps, read from the MP4/MOV file), so a click time can map to a frame (round(t * sourceFps)), but the pack has no point-seeded SAM branch for clicks to drive: the 'Who to keep' text drives SAM 3.1. Wiring it as a track tool needs that branch added to the pack and a GPU check first.",
};

/** Which mask picker a tool shows. */
export type MaskPickerKind = "region" | "track" | "inpaint" | null;

export function maskPickerKind(opts: {
  specId?: string;
  catalogNeedsMask?: boolean;
}): MaskPickerKind {
  if (opts.catalogNeedsMask) return "inpaint";
  if (!opts.specId) return null;
  if (SMART_TRACK_ACTIONS.has(opts.specId)) return "track";
  if (regionMaskTool(opts.specId)) return "region";
  return null;
}

const MASK_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,/;

/**
 * Masks to send for a region tool: the painted subjects in order, capped at
 * the tool's subject count (and the server max). Empty / non-image entries
 * drop out, so an unpainted Subject 1 with a painted Subject 2 sends one mask.
 */
export function regionMasksToSend(
  specId: string | undefined,
  subjects: readonly (string | null | undefined)[],
): string[] {
  const tool = regionMaskTool(specId);
  if (!tool) return [];
  const cap = Math.min(tool.subjects, PASTEBACK_MAX_MASKS);
  return subjects
    .filter((m): m is string => typeof m === "string" && MASK_DATA_URL.test(m))
    .slice(0, cap);
}

/**
 * Action params with uploaded mask refs: paste-back on, one pass per mask.
 * The text area / pose fields are dropped (the masks replace them); with no
 * refs the params come back unchanged.
 */
export function withRegionMasks(
  params: Record<string, unknown>,
  refs: readonly string[],
): Record<string, unknown> {
  if (refs.length === 0) return params;
  const out: Record<string, unknown> = { ...params };
  delete out.pasteBackArea;
  delete out.pasteBackPose;
  out.pasteBack = true;
  out.pasteBackMasks = refs.slice(0, PASTEBACK_MAX_MASKS);
  return out;
}

/** Edit actions whose graph has its own mask slot (LoadImageMask). */
export const MASK_SLOT_ACTIONS = new Set(["edit_inpaint"]);

/**
 * Body `mask` for /api/jobs/action: the union mask, only for graphs with a
 * mask slot (the route rejects a mask on any other graph).
 */
export function actionBodyMask(
  action: string,
  union: string | null | undefined,
): string | undefined {
  return MASK_SLOT_ACTIONS.has(action) && union && MASK_DATA_URL.test(union)
    ? union
    : undefined;
}

/** Upload filename prefix for subject k's mask. */
export function regionMaskUploadPrefix(index: number): string {
  return `cj_region_mask${index + 1}`;
}

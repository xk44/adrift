/**
 * Krea 2 Edit "skills" (modes) — presets over the comfyui-krea2edit v1.2 nodes.
 *
 * Every mode drives the SAME dual-conditioning engine (Krea2EditModelPatch +
 * Krea2EditGroundedEncode); a mode just picks how many reference images it takes,
 * an instruction template, and the two v1.2 dials:
 *   - grounding_px : identity/likeness vs edit-adherence (trained 384–768)
 *   - ref_boost    : reference fidelity (~4 = strong likeness; >10 breaks removals)
 * Two-input modes follow the training order: reference A = scene (img1), B = subject (img2).
 */

export type EditModeId =
  | "instruct" // generic instruction edit (recolor, replace, restyle) — 1 ref
  | "identity" // re-stage / keep a person's likeness in a new scene — 1 ref
  | "insert" // put a subject (B) into a scene (A) — 2 refs
  | "tryon" // put a garment/outfit (B) onto a person (A) — 2 refs
  | "swap" // head/face/eye/person swap — 2 refs (+ optional region mask)
  | "restyle" // full-image restyle from a style reference — 1 ref
  | "remove"; // remove an object/person — 1 ref, low ref_boost

export interface EditMode {
  id: EditModeId;
  label: string;
  refCount: 1 | 2;
  /** Human hint shown in the UI. */
  hint: string;
  /** `{prompt}` is replaced by the user's instruction (or used verbatim if none). */
  promptTemplate: string;
  groundingPx: number;
  refBoost: number;
  /** Boost for the scene ref (A) in 2-ref modes. */
  refBoostA?: number;
  /** Lock structure to the source (stacks the depth-control LoRA). */
  lockComposition?: boolean;
  /** Second-reference slot label (2-ref modes). */
  refBLabel?: string;
}

export const EDIT_MODES: Record<EditModeId, EditMode> = {
  instruct: {
    id: "instruct",
    label: "Instruction edit",
    refCount: 1,
    hint: "Recolor, replace, or restyle by instruction. e.g. “make the car matte black”.",
    promptTemplate: "{prompt}",
    groundingPx: 768,
    refBoost: 1.0,
  },
  identity: {
    id: "identity",
    label: "Identity / re-stage",
    refCount: 1,
    hint: "Keep this person's likeness in a new pose or scene. e.g. “standing on a beach at sunset”.",
    promptTemplate: "{prompt}",
    groundingPx: 512,
    refBoost: 4.0,
  },
  insert: {
    id: "insert",
    label: "Insert subject into scene",
    refCount: 2,
    hint: "Place the subject (2nd image) into the scene (1st image).",
    promptTemplate:
      "Place the person from image 2 into the scene of image 1. {prompt}",
    groundingPx: 512,
    refBoost: 4.0,
    refBoostA: 1.0,
    refBLabel: "Subject",
  },
  tryon: {
    id: "tryon",
    label: "Virtual try-on",
    refCount: 2,
    hint: "Put the garment/outfit (2nd image) onto the person (1st image).",
    promptTemplate:
      "Dress the person in image 1 in the outfit shown in image 2, preserving their identity. {prompt}",
    groundingPx: 640,
    refBoost: 4.0,
    refBoostA: 4.0,
    refBLabel: "Garment",
  },
  swap: {
    id: "swap",
    label: "Face / person swap",
    refCount: 2,
    hint: "Swap the face/person from the 2nd image onto the 1st. Optional region mask on the target.",
    promptTemplate:
      "Replace the face of the person in image 1 with the person from image 2, matching lighting and pose. {prompt}",
    groundingPx: 512,
    refBoost: 6.0,
    refBoostA: 1.0,
    refBLabel: "New face",
  },
  restyle: {
    id: "restyle",
    label: "Restyle from reference",
    refCount: 1,
    hint: "Reapply the aesthetic of the reference across the whole image.",
    promptTemplate: "Restyle the image: {prompt}",
    groundingPx: 768,
    refBoost: 1.0,
  },
  remove: {
    id: "remove",
    label: "Object Remover",
    refCount: 1,
    hint: "Remove an object or person and fill plausibly. Uses Raw + higher steps for clean removals.",
    promptTemplate: "Remove {prompt} and fill the area naturally.",
    groundingPx: 768,
    refBoost: 1.0, // removals break at high ref_boost
  },
};

export const EDIT_MODE_LIST: EditMode[] = Object.values(EDIT_MODES);

/** Fill an instruction into a mode's template. */
export function renderEditPrompt(mode: EditMode, instruction: string): string {
  const trimmed = instruction.trim();
  if (mode.promptTemplate.includes("{prompt}")) {
    return mode.promptTemplate
      .replace("{prompt}", trimmed)
      .replace(/\s+/g, " ")
      .trim();
  }
  return trimmed || mode.promptTemplate;
}

/**
 * "Swap face in video" — MiniMax H3 Ref2VA + the UntMods FaceSwap_H3_REF2VA
 * LoRA (apache-2.0, strength 1.0), native ComfyUI nodes only
 * (packs/minimax/face_swap.json). The source clip is <Video 1>
 * (LoadVideo → GetVideoComponents → ref_videos.ref_video_0) and the face
 * reference is <Picture 1> (LoadImage → ref_images.ref_image_0).
 *
 * LoRA chain: lightx2v fl2v Turbo 8-step v1.1, then FaceSwap, then
 * MiniMaxH3SigmaShift 12/3 (see characterSwap.ts for why not Acc-8Step).
 * The only trigger prompt is "Faceswap". Clip rules are identical to character swap (24 fps, length
 * n % 17 == 5, 480 short edge), so the helpers are shared.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import { buildH3VideoSwapWorkflow } from "./characterSwap";

export {
  CHARACTER_SWAP_FPS as FACE_SWAP_FPS,
  CHARACTER_SWAP_MAX_LENGTH as FACE_SWAP_MAX_LENGTH,
  characterSwapDims as faceSwapDims,
  characterSwapLength as faceSwapLength,
} from "./characterSwap";

export const FACE_SWAP_ACTION = "face_swap";
export const FACE_SWAP_PACK = "minimax";
export const FACE_SWAP_LORA = "FaceSwap_H3_REF2VA.safetensors";
export const FACE_SWAP_PROMPT = "Faceswap";

/** Point the face-swap graph at the source run's video and the uploaded face. */
export function buildFaceSwapWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  // The LoRA is trained on the bare trigger word; free-form prompts are
  // deliberately ignored.
  return buildH3VideoSwapWorkflow(
    { action: FACE_SWAP_ACTION, promptFor: () => FACE_SWAP_PROMPT },
    baseWorkflow,
    sourceRun,
    sourceJobIndex,
    params,
  );
}

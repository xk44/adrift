/**
 * Imagine --video with attached images: which attachments feed the graph and
 * how they are wired into its LoadImage node(s).
 *
 *   i2v  the starting frame (else the first image prompt) fills the graph's
 *        empty LoadImage.
 *   r2v  (MiniMax H3 Ref2VA) every image prompt is a reference: the first
 *        fills the LoadImage on ref_images.ref_image_0, the next ones get
 *        their own LoadImage on ref_image_1.. (<Picture 1..n> in the prompt).
 */
import type { ImageAttachment, Workflow } from "@/types";
import { nextNodeId } from "./loraInsert";

/** <Picture 1..3>: the cap the music video tool uses too. */
export const H3_MAX_REF_IMAGES = 3;

const R2V_CLASS = "MiniMaxH3ReferenceToVideo";
const REF_INPUT = "ref_images.ref_image_";

/** Attachments the video template consumes, in <Picture n> order. */
export function videoRefAttachments(
  template: string,
  attachments: ImageAttachment[] | undefined,
): ImageAttachment[] {
  const list = (attachments ?? []).filter(
    (a) => typeof a?.url === "string" && a.url.length > 0,
  );
  if (template === "r2v")
    return list
      .filter((a) => a.mode === "image_prompt")
      .slice(0, H3_MAX_REF_IMAGES);
  if (template === "i2v") {
    const frame =
      list.find((a) => a.mode === "starting_frame") ??
      list.find((a) => a.mode === "image_prompt");
    return frame ? [frame] : [];
  }
  return [];
}

function emptyLoadImage(workflow: Workflow): string | undefined {
  return Object.keys(workflow).find((id) => {
    const node = workflow[id];
    if (node?.class_type !== "LoadImage") return false;
    const image = node.inputs?.image;
    return typeof image !== "string" || image.trim() === "";
  });
}

/**
 * Point the graph at uploaded image refs ("name.png" / "sub/name.png").
 * Mutates `workflow`; returns the LoadImage ids it set, in order.
 */
export function wireVideoRefImages(
  workflow: Workflow,
  refs: string[],
): string[] {
  if (refs.length === 0) return [];
  const r2vId = Object.keys(workflow).find(
    (id) => workflow[id]?.class_type === R2V_CLASS,
  );
  if (!r2vId) {
    const id = emptyLoadImage(workflow);
    if (!id) return [];
    workflow[id].inputs.image = refs[0];
    return [id];
  }

  const r2v = workflow[r2vId];
  const first = r2v.inputs[`${REF_INPUT}0`];
  const firstId =
    Array.isArray(first) &&
    workflow[String(first[0])]?.class_type === "LoadImage"
      ? String(first[0])
      : undefined;
  if (!firstId) return [];
  workflow[firstId].inputs.image = refs[0];
  const ids = [firstId];
  refs.slice(1, H3_MAX_REF_IMAGES).forEach((ref, i) => {
    const id = nextNodeId(workflow);
    workflow[id] = {
      class_type: "LoadImage",
      inputs: { image: ref },
      _meta: { title: `Reference ${i + 2}` },
    };
    r2v.inputs[`${REF_INPUT}${i + 1}`] = [id, 0];
    ids.push(id);
  });
  return ids;
}

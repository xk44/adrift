/**
 * MiniMax H3 Text to Image (packs/minimax/t2i.json): the fl2va DiT renders a
 * single frame from an EmptyLatentImage, with the fl2v Turbo 8-step LoRA
 * pinned in the graph (8 steps, res_multistep / simple, BasicGuider so no
 * CFG). The joint AV latent is split with LTXVSeparateAVLatent and only the
 * video half is decoded.
 *
 * The graph has no MiniMaxH3* node, so isH3Graph() is false and the video
 * options (h3Speed, extra LoRAs, frame-length tiers, canvas cap) leave it
 * alone. Selected in Create as the "MiniMax H3 Image" engine.
 */
import type { Workflow } from "@/types";

export const H3_IMAGE_WORKFLOW = "packs/minimax/t2i.json";
export const H3_IMAGE_ENGINE = "h3-image";
export const H3_IMAGE_STEPS = 8;
/** The H3 video VAE downsamples 32x per axis. */
export const H3_IMAGE_GRID = 32;

const H3_UNET_RE = /minimax_h3/i;

/** True for a single-frame H3 graph (H3 UNET + EmptyLatentImage). */
export function isH3ImageGraph(workflow: Workflow): boolean {
  const nodes = Object.values(workflow);
  return (
    nodes.some(
      (n) =>
        n?.class_type === "UNETLoader" &&
        H3_UNET_RE.test(String(n.inputs?.unet_name ?? "")),
    ) && nodes.some((n) => n?.class_type === "EmptyLatentImage")
  );
}

/**
 * Snap EmptyLatentImage dims to the 32-px grid. Aspect presets already sit
 * on it; custom ratios (64-rounded) do too, but --draft scaling rounds to 8.
 */
export function applyH3ImageGrid(workflow: Workflow): void {
  if (!isH3ImageGraph(workflow)) return;
  const snap = (v: unknown) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return v;
    return Math.max(
      H3_IMAGE_GRID,
      Math.round(n / H3_IMAGE_GRID) * H3_IMAGE_GRID,
    );
  };
  for (const node of Object.values(workflow)) {
    if (node?.class_type !== "EmptyLatentImage") continue;
    node.inputs.width = snap(node.inputs.width);
    node.inputs.height = snap(node.inputs.height);
  }
}

/**
 * "Overlay composite" (packs/utility/overlay_composite.json): RGBA stickers,
 * cut-outs (qwen21-remove-bg output) and animated WebM/MOV layers over a
 * clip, with stock nodes only. The template holds the source loader (id 1)
 * and VHS_VideoCombine (id 2); this builder appends one node chain per layer
 * (see the template description) and points the combine at the last one.
 *
 * Geometry (scaled size, visible rect, crop offset, frame windows) comes from
 * src/lib/tools/overlayComposite.ts, so every node input is a fixed integer.
 *
 * Node semantics this relies on (ComfyUI core + VHS):
 *  - LoadImage / VHS_LoadVideoFFmpeg masks are 1 - alpha, which is exactly
 *    what JoinImageWithAlpha expects; SplitImageWithAlpha hands back
 *    1 - alpha again, so InvertMask yields the true alpha.
 *  - ImageCompositeMasked repeats source + mask to the destination batch, so a
 *    still overlay covers every frame and a short animated one loops.
 *  - ImageBlend needs equal batches: the blend branch first pastes the
 *    overlay (no mask) onto the cropped region to get a same-batch copy.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import {
  OVERLAY_COMPOSITE_ACTION,
  overlayFps,
  OVERLAY_MAX_LAYERS,
  overlayFrameCount,
  overlayFrameSize,
  overlayPlacement,
  overlaySeconds,
  overlayWindow,
  parseOverlayLayer,
  type OverlayLayer,
} from "@/lib/tools/overlayComposite";

export { OVERLAY_COMPOSITE_ACTION };

/** Fixed node ids in packs/utility/overlay_composite.json. */
export const OVC_NODES = { load: "1", combine: "2" } as const;

type Link = [string, number];

function num(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** Parse params.overlays; throws with the first problem. */
export function overlayLayersFrom(
  params: Record<string, unknown>,
): OverlayLayer[] {
  const A = OVERLAY_COMPOSITE_ACTION;
  const raw = params.overlays;
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Error(`${A}: add at least one overlay`);
  if (raw.length > OVERLAY_MAX_LAYERS)
    throw new Error(`${A}: at most ${OVERLAY_MAX_LAYERS} overlays`);
  return raw.map((r, i) => {
    const layer = parseOverlayLayer(r, i);
    if (typeof layer === "string") throw new Error(`${A}: ${layer}`);
    return layer;
  });
}

export function buildOverlayCompositeWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const A = OVERLAY_COMPOSITE_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const videoRef = comfyImageRefFromViewUrl(job?.videos?.[0]);
  if (!videoRef) throw new Error(`${A}: source run has no video`);
  for (const id of Object.values(OVC_NODES)) {
    if (!workflow[id]) throw new Error(`${A}: workflow is missing node ${id}`);
  }
  const layers = overlayLayersFrom(params);

  const frame = overlayFrameSize(
    num(params.width) ?? sourceRun.width,
    num(params.height) ?? sourceRun.height,
  );
  // Unknown length: decode up to the cap and ignore time windows (a split
  // past the real frame count would leave an empty batch).
  const known = num(params.seconds) ?? num(sourceRun.params?.video_seconds);
  const seconds = overlaySeconds(known);
  // Source clip's own rate (client-probed sourceFps), not a fixed 24.
  const fps = overlayFps(params.fps ?? params.sourceFps);
  const frames = overlayFrameCount(seconds, fps);

  setNodeInput(workflow, OVC_NODES.load, "video", videoRef);
  setNodeInput(workflow, OVC_NODES.load, "force_rate", fps);
  setNodeInput(workflow, OVC_NODES.load, "custom_width", frame.width);
  setNodeInput(workflow, OVC_NODES.load, "custom_height", frame.height);
  setNodeInput(workflow, OVC_NODES.load, "frame_load_cap", frames);
  setNodeInput(workflow, OVC_NODES.load, "skip_first_frames", 0);
  setNodeInput(workflow, OVC_NODES.load, "select_every_nth", 1);
  setNodeInput(workflow, OVC_NODES.load, "format", "None");
  setNodeInput(workflow, OVC_NODES.combine, "frame_rate", fps);

  let next = 10;
  const add = (
    class_type: string,
    inputs: Record<string, unknown>,
    title: string,
  ): string => {
    const id = String(next++);
    workflow[id] = { class_type, inputs, _meta: { title } } as Workflow[string];
    return id;
  };

  let current: Link = [OVC_NODES.load, 0];
  layers.forEach((layer, i) => {
    const n = i + 1;
    const place = overlayPlacement(layer, frame);
    if (!place) throw new Error(`${A}: overlay ${n} is entirely off the frame`);
    const win =
      known === undefined
        ? { startFrame: 0, endFrame: frames }
        : overlayWindow(layer, frames, fps);
    const active = win.endFrame - win.startFrame;

    const load =
      layer.kind === "video"
        ? add(
            "VHS_LoadVideoFFmpeg",
            {
              video: layer.ref,
              force_rate: fps,
              custom_width: 0,
              custom_height: 0,
              frame_load_cap: active,
              start_time: 0,
              format: "None",
            },
            `Overlay ${n} clip`,
          )
        : add("LoadImage", { image: layer.ref }, `Overlay ${n} image`);
    const rgba = add(
      "JoinImageWithAlpha",
      { image: [load, 0], alpha: [load, 1] },
      `Overlay ${n} RGBA`,
    );
    const shrinking = place.sw < layer.width;
    let img: Link = [
      add(
        "ImageScale",
        {
          image: [rgba, 0],
          upscale_method: shrinking ? "area" : "bilinear",
          width: place.sw,
          height: place.sh,
          crop: "disabled",
        },
        `Overlay ${n} size`,
      ),
      0,
    ];
    if (place.clipped)
      img = [
        add(
          "ImageCrop",
          {
            image: img,
            width: place.vw,
            height: place.vh,
            x: place.cropX,
            y: place.cropY,
          },
          `Overlay ${n} on-frame part`,
        ),
        0,
      ];
    const split = add(
      "SplitImageWithAlpha",
      { image: img },
      `Overlay ${n} split`,
    );
    let alpha: Link = [
      add("InvertMask", { mask: [split, 1] }, `Overlay ${n} alpha`),
      0,
    ];
    if (layer.opacity < 1) {
      const solid = add(
        "SolidMask",
        {
          value: Math.round(layer.opacity * 100) / 100,
          width: place.vw,
          height: place.vh,
        },
        `Overlay ${n} opacity`,
      );
      alpha = [
        add(
          "MaskComposite",
          {
            destination: alpha,
            source: [solid, 0],
            x: 0,
            y: 0,
            operation: "multiply",
          },
          `Overlay ${n} faded alpha`,
        ),
        0,
      ];
    }

    // Time window: [pre | active | post]
    let pre: Link | null = null;
    let post: Link | null = null;
    let target: Link = current;
    if (win.startFrame > 0) {
      const s = add(
        "VHS_SplitImages",
        { images: current, split_index: win.startFrame },
        `Overlay ${n} before start`,
      );
      pre = [s, 0];
      target = [s, 2];
    }
    if (win.endFrame < frames) {
      const s = add(
        "VHS_SplitImages",
        { images: target, split_index: active },
        `Overlay ${n} after end`,
      );
      target = [s, 0];
      post = [s, 2];
    }

    const rgb: Link = [split, 0];
    let source: Link = rgb;
    if (layer.blend !== "normal") {
      const region = add(
        "ImageCrop",
        {
          image: target,
          width: place.vw,
          height: place.vh,
          x: place.vx,
          y: place.vy,
        },
        `Overlay ${n} region`,
      );
      const matched = add(
        "ImageCompositeMasked",
        {
          destination: [region, 0],
          source: rgb,
          x: 0,
          y: 0,
          resize_source: false,
        },
        `Overlay ${n} per-frame copy`,
      );
      source = [
        add(
          "ImageBlend",
          {
            image1: [region, 0],
            image2: [matched, 0],
            blend_factor: 1.0,
            blend_mode: layer.blend,
          },
          `Overlay ${n} ${layer.blend}`,
        ),
        0,
      ];
    }
    let out: Link = [
      add(
        "ImageCompositeMasked",
        {
          destination: target,
          source,
          x: place.vx,
          y: place.vy,
          resize_source: false,
          mask: alpha,
        },
        `Overlay ${n} composite`,
      ),
      0,
    ];
    if (pre)
      out = [
        add(
          "ImageBatch",
          { image1: pre, image2: out },
          `Overlay ${n} rejoin start`,
        ),
        0,
      ];
    if (post)
      out = [
        add(
          "ImageBatch",
          { image1: out, image2: post },
          `Overlay ${n} rejoin end`,
        ),
        0,
      ];
    current = out;
  });

  setNodeInput(workflow, OVC_NODES.combine, "images", current);

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: "",
      posTextInputName: "",
      negTextId: "",
      latentDimsId: "",
      imageInputId: OVC_NODES.load,
    },
    seed: typeof job?.seed === "number" ? job.seed : 0,
  };
}

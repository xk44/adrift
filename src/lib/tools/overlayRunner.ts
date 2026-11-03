/**
 * Overlay Composite executor. Every step is an ordinary Adrift run queued
 * through the job routes and polled from history (same plumbing as the dub
 * and pipeline runners), so the flow runs under vitest with a mock fetch.
 *
 *   upload layer   PNG / WebP still or WebM / MOV clip -> /api/comfy/upload
 *   look layer     /api/jobs/imagine (square sticker on white)
 *                  -> /api/jobs/tool qwen21-remove-bg (RGBA PNG)
 *                  -> output re-uploaded as an input
 *   composite      clip seeded once -> overlay_composite with every layer
 */
import { pickFinalOutput } from "./pickOutput";
import type { ImagineRun } from "@/types";
import {
  ToolApiError,
  seedRun,
  uploadDataUrl,
  uploadName,
  videoUploadName,
  type ToolVideo,
} from "./runTool";
import {
  action,
  measured,
  outputOf,
  promptIdOf,
  waitForOutputs,
  type RunnerDeps,
} from "./pipelineRunner";
import {
  OVERLAY_COMPOSITE_ACTION,
  OVERLAY_MAX_LAYERS,
  overlayLook,
  overlayLookPrompt,
  overlaySeconds,
  type OverlayBlend,
  type OverlayKind,
  type OverlayLayer,
} from "./overlayComposite";
import type { StepOutput } from "./pipelines";

/** Catalog image tool that turns the generated sticker into an RGBA cut-out. */
export const OVERLAY_CUTOUT_TOOL = "qwen21-remove-bg";
/** Size assumed for a generated sticker when it cannot be measured. */
export const OVERLAY_LOOK_FALLBACK_SIZE = 1024;

/** A layer as edited in the runner. */
export interface OverlayInputLayer {
  id: string;
  source: "upload" | "look";
  kind: OverlayKind;
  label: string;
  /** Upload: data: URL of the file. */
  dataUrl?: string;
  /** Look: OVERLAY_LOOKS id. */
  lookId?: string;
  /** Native size (uploads: measured on pick; looks: filled after generation). */
  width: number;
  height: number;
  /** Resolved input ref, cached across runs. */
  ref?: string;
  /** Preview of the overlay asset (look output URL once generated). */
  previewUrl?: string;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  blend: OverlayBlend;
  start: number;
  end: number | null;
}

export interface OverlayInputs {
  video: ToolVideo;
  layers: OverlayInputLayer[];
  /** Extra words appended to every look prompt (palette, theme). */
  lookExtra?: string;
}

export interface OverlayDeps extends RunnerDeps {
  /** Clip seeded once per source clip (reused across re-runs). */
  clip?: { runId: string; jobIndex: number };
  /** Pixel size of an output image, null if unknown. */
  imageSize?: (
    url: string,
  ) => Promise<{ width: number; height: number } | null>;
}

export type OverlayLayerStatus =
  "uploading" | "generating" | "cutting" | "ready" | "error";

export interface OverlayLayerUpdate {
  status: OverlayLayerStatus;
  ref?: string;
  previewUrl?: string;
  width?: number;
  height?: number;
  error?: string;
}

export interface OverlayResult {
  output: StepOutput;
  runId: string;
  layers: OverlayInputLayer[];
}

async function postJson(
  deps: RunnerDeps,
  url: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await deps.fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: Record<string, unknown> = {};
  try {
    data = ((await res.json()) ?? {}) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok || data.ok === false)
    throw new ToolApiError(
      typeof data.error === "string" && data.error
        ? data.error
        : `Request failed (${res.status})`,
      res.status,
    );
  return data;
}

function checkCancelled(deps: RunnerDeps) {
  if (deps.isCancelled?.()) throw new ToolApiError("Stopped");
}

/**
 * Generate one look's sticker and cut it out: text-to-image, then the
 * qwen21-remove-bg image tool, then the RGBA PNG re-uploaded as an input.
 */
export async function generateLookOverlay(
  deps: OverlayDeps,
  lookId: string,
  extra?: string,
  onStatus?: (s: OverlayLayerStatus) => void,
): Promise<{ ref: string; previewUrl: string; width: number; height: number }> {
  const look = overlayLook(lookId);
  if (!look) throw new ToolApiError(`Unknown overlay look "${lookId}"`);
  if (!deps.toDataUrl)
    throw new ToolApiError("Cannot re-upload the cut-out here");

  onStatus?.("generating");
  const gen = await postJson(deps, "/api/jobs/imagine", {
    prompt: overlayLookPrompt(look, extra),
    client_id: deps.clientId,
    batch_size: 1,
  });
  const genRun = (gen.runs as ImagineRun[] | undefined)?.[0];
  if (!genRun) throw new ToolApiError("Server returned no run");
  deps.onRun?.(genRun);
  const genOut = await waitForOutputs(deps, promptIdOf(genRun));
  const genFile = pickFinalOutput(genOut.images);
  if (!genFile)
    throw new ToolApiError(`${look.label}: the sticker came back empty`);
  // Send the sticker's own file ref: /api/jobs/tool resolves
  // { run_id, job_index } only from the in-memory run, whose images an
  // imagine run never has filled in, so that form would 409.
  const sticker = outputOf(genFile, "sticker");
  checkCancelled(deps);

  onStatus?.("cutting");
  const cut = await postJson(deps, "/api/jobs/tool", {
    toolId: OVERLAY_CUTOUT_TOOL,
    images: [sticker.ref],
    options: {},
    client_id: deps.clientId,
  });
  const cutRun = cut.run as ImagineRun | undefined;
  if (!cutRun) throw new ToolApiError("Server returned no run");
  deps.onRun?.(cutRun);
  const cutOut = await waitForOutputs(deps, promptIdOf(cutRun));
  const file = pickFinalOutput(cutOut.images);
  if (!file)
    throw new ToolApiError(`${look.label}: the cut-out came back empty`);
  checkCancelled(deps);

  const ref = await uploadDataUrl(
    deps.fetchImpl,
    await deps.toDataUrl(file.url),
    uploadName("cj_overlay"),
  );
  const size = (await deps.imageSize?.(file.url).catch(() => null)) ?? null;
  return {
    ref,
    previewUrl: file.url,
    width: size?.width || OVERLAY_LOOK_FALLBACK_SIZE,
    height: size?.height || OVERLAY_LOOK_FALLBACK_SIZE,
  };
}

async function clipRun(deps: OverlayDeps, video: ToolVideo) {
  if (deps.clip) return deps.clip;
  const ref = await uploadDataUrl(
    deps.fetchImpl,
    video.dataUrl,
    videoUploadName(video.label),
  );
  deps.clip = await seedRun(
    deps.fetchImpl,
    ref,
    video.width,
    video.height,
    "overlay composite",
    video.duration,
  );
  return deps.clip;
}

/** Params for the overlay_composite action (pure; exported for tests). */
export function overlayParams(
  video: ToolVideo,
  layers: OverlayInputLayer[],
): Record<string, unknown> {
  const overlays: OverlayLayer[] = layers.map((l) => {
    if (!l.ref) throw new ToolApiError(`${l.label} is not ready`);
    return {
      ref: l.ref,
      kind: l.kind,
      width: l.width,
      height: l.height,
      x: l.x,
      y: l.y,
      scale: l.scale,
      opacity: l.opacity,
      blend: l.blend,
      start: l.start,
      end: l.end,
    };
  });
  return {
    overlays,
    width: video.width,
    height: video.height,
    ...(typeof video.duration === "number"
      ? { seconds: overlaySeconds(video.duration) }
      : {}),
    // Composite at the clip's own frame rate when the file reports one.
    ...(typeof video.fps === "number" && video.fps > 0
      ? { sourceFps: video.fps }
      : {}),
  };
}

/**
 * Resolve every layer's asset (upload or generate), then composite them all
 * over the clip in one run. Layers that already carry a ref are reused.
 */
export async function runOverlayComposite(
  inputs: OverlayInputs,
  deps: OverlayDeps,
  onLayer?: (id: string, update: OverlayLayerUpdate) => void,
): Promise<OverlayResult> {
  const { video } = inputs;
  if (!video) throw new ToolApiError("Add a clip first");
  if (inputs.layers.length === 0) throw new ToolApiError("Add an overlay");
  if (inputs.layers.length > OVERLAY_MAX_LAYERS)
    throw new ToolApiError(`Use at most ${OVERLAY_MAX_LAYERS} overlays`);

  const layers: OverlayInputLayer[] = [];
  for (const layer of inputs.layers) {
    checkCancelled(deps);
    if (layer.ref) {
      layers.push(layer);
      continue;
    }
    try {
      let resolved: OverlayInputLayer;
      if (layer.source === "look") {
        const got = await generateLookOverlay(
          deps,
          layer.lookId ?? "",
          inputs.lookExtra,
          (status) => onLayer?.(layer.id, { status }),
        );
        resolved = { ...layer, ...got };
      } else {
        if (!layer.dataUrl) throw new ToolApiError(`${layer.label} is empty`);
        onLayer?.(layer.id, { status: "uploading" });
        const ref = await uploadDataUrl(
          deps.fetchImpl,
          layer.dataUrl,
          layer.kind === "video"
            ? videoUploadName(layer.label)
            : uploadName("cj_overlay"),
        );
        resolved = { ...layer, ref };
      }
      onLayer?.(layer.id, {
        status: "ready",
        ref: resolved.ref,
        previewUrl: resolved.previewUrl,
        width: resolved.width,
        height: resolved.height,
      });
      layers.push(resolved);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onLayer?.(layer.id, { status: "error", error: msg });
      throw e;
    }
  }

  checkCancelled(deps);
  const src = await clipRun(deps, video);
  const run = await action(
    deps,
    src,
    OVERLAY_COMPOSITE_ACTION,
    overlayParams(video, layers),
  );
  const out = await waitForOutputs(deps, promptIdOf(run));
  const output = await measured(
    deps,
    outputOf(pickFinalOutput(out.videos), "composited clip"),
    "video",
  );
  return { output, runId: run.run_id, layers };
}

/** New layer for an illustrated look (asset generated on run). */
export function lookLayer(lookId: string, id: string): OverlayInputLayer {
  const look = overlayLook(lookId);
  if (!look) throw new ToolApiError(`Unknown overlay look "${lookId}"`);
  return {
    id,
    source: "look",
    kind: "image",
    label: look.label,
    lookId,
    width: OVERLAY_LOOK_FALLBACK_SIZE,
    height: OVERLAY_LOOK_FALLBACK_SIZE,
    x: look.x,
    y: look.y,
    scale: look.scale,
    opacity: look.opacity,
    blend: look.blend,
    start: 0,
    end: null,
  };
}

/** New layer for an uploaded still or clip: centred, a third of the width. */
export function uploadLayer(args: {
  id: string;
  kind: OverlayKind;
  label: string;
  dataUrl: string;
  width: number;
  height: number;
}): OverlayInputLayer {
  return {
    ...args,
    source: "upload",
    previewUrl: args.dataUrl,
    x: 0.5,
    y: 0.5,
    scale: 0.33,
    opacity: 1,
    blend: "normal",
    start: 0,
    end: null,
  };
}

/** CSS mix-blend-mode for the in-browser placement preview. */
export const OVERLAY_CSS_BLEND: Record<OverlayBlend, string> = {
  normal: "normal",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  soft_light: "soft-light",
  difference: "difference",
};

/** Preview box in percent of the frame (same maths as the graph). */
export function overlayPreviewBox(
  layer: Pick<OverlayInputLayer, "width" | "height" | "x" | "y" | "scale">,
  frame: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  const fw = frame.width > 0 ? frame.width : 16;
  const fh = frame.height > 0 ? frame.height : 9;
  const w = layer.scale * 100;
  const h =
    ((layer.scale * fw * (layer.height || 1)) / (layer.width || 1) / fh) * 100;
  return {
    left: layer.x * 100 - w / 2,
    top: layer.y * 100 - h / 2,
    width: w,
    height: h,
  };
}

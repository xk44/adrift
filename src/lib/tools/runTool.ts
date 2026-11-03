/**
 * Tools tab submission helpers. Pure async functions over an injectable
 * `fetch` so they can be unit-tested with a mock (no ComfyUI, no GPU).
 *
 * Flow per source image:
 *   gallery image  -> { run_id, job_index } (the run already lives server-side)
 *   uploaded file  -> POST /api/comfy/upload -> annotated ref
 *                     catalog tools take the ref directly;
 *                     action tools first POST /api/jobs/seed-run to wrap it.
 */

import { nodeWarningsOf } from "@/lib/comfy/nodeWarnings";
import { normalizeFps } from "@/lib/videoFps";
import { comfyProxyUrl } from "@/lib/comfy/outputs";
import {
  VACE_EXTEND_ACTION,
  vaceTailRefsFromVideoUrl,
} from "@/lib/oj/vaceVideo";
import type { ImagineRun } from "@/types";
import {
  audioActive,
  buildActionRequest,
  buildCatalogBody,
  type ActionToolSpec,
  type CatalogTool,
  type EditLoraListResponse,
  type ToolImageRef,
  type ToolSettings,
} from "./toolsPage";
import { buildEngineRequest } from "./engineRequest";
import type { EditEngine, EngineContext } from "./templates";
import {
  actionBodyMask,
  regionMaskUploadPrefix,
  regionMasksToSend,
  withRegionMasks,
} from "./maskWiring";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json">>;

/** An image chosen in the runner. Gallery images carry a run; uploads carry a data URL. */
export interface ToolImage {
  id: string;
  source: "gallery" | "upload";
  previewUrl: string;
  label: string;
  width: number;
  height: number;
  runId?: string;
  jobIndex?: number;
  /** data: URL for uploads. */
  dataUrl?: string;
  /**
   * Annotated ComfyUI ref ("sub/name.png [output]") for an image that already
   * lives on the ComfyUI server (overlay: picked from the graph). Used as-is
   * by catalog tools instead of re-uploading the data URL.
   */
  comfyRef?: string;
}

/** A source clip chosen in the runner (video-in tools). Always an upload. */
export interface ToolVideo {
  id: string;
  /** Object/data URL for the preview <video>. */
  previewUrl: string;
  /** data: URL sent to /api/comfy/upload. */
  dataUrl: string;
  label: string;
  /** Seconds (from the file's metadata); null when unknown. */
  duration: number | null;
  width: number;
  height: number;
  /** Frame rate read from the file (MP4 / MOV); null or absent when unknown. */
  fps?: number | null;
  /**
   * Gallery URL the clip was loaded from (lightbox hand-off only; absent for
   * uploads and edited clips). Extend video reads its lossless tail from it.
   */
  sourceUrl?: string;
}

/** Decoded upload cap of POST /api/comfy/upload. */
export const MAX_VIDEO_UPLOAD_BYTES = 32 * 1024 * 1024;

/** A speech/audio file chosen in the runner (audio-in tools). Always an upload. */
export interface ToolAudio {
  id: string;
  /** Object URL for the preview <audio>. */
  previewUrl: string;
  /** data: URL sent to /api/comfy/upload. */
  dataUrl: string;
  label: string;
  /** Seconds (from the file's metadata); null when unknown. */
  duration: number | null;
}

/** Same upload cap as clips (POST /api/comfy/upload). */
export const MAX_AUDIO_UPLOAD_BYTES = MAX_VIDEO_UPLOAD_BYTES;

/** Unique upload name for an audio file; keeps a ComfyUI-loadable extension. */
export function audioUploadName(label: string): string {
  const ext = /\.(wav|mp3|m4a|flac)$/i.exec(label)?.[1]?.toLowerCase() ?? "wav";
  return uploadName("cj_audio").replace(/\.png$/, `.${ext}`);
}

export class ToolApiError extends Error {
  status: number;
  code?: string;
  /** The API envelope's `details` (ComfyUI error body, problems, ...). */
  details?: unknown;
  constructor(message: string, status = 0, code?: string, details?: unknown) {
    super(message);
    this.name = "ToolApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function reportWarnings(
  data: Record<string, unknown>,
  onWarnings: ((warnings: string[]) => void) | undefined,
): void {
  const warnings = nodeWarningsOf(data);
  if (warnings.length > 0) onWarnings?.(warnings);
}

async function readJson(
  res: Pick<Response, "ok" | "status" | "json">,
): Promise<Record<string, unknown>> {
  let data: Record<string, unknown> = {};
  try {
    data = ((await res.json()) ?? {}) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok || data.ok === false) {
    const details = data.details as { code?: string } | undefined;
    const msg =
      typeof data.error === "string" && data.error
        ? data.error
        : `Request failed (${res.status})`;
    throw new ToolApiError(msg, res.status, details?.code, data.details);
  }
  return data;
}

function postJson(fetchImpl: FetchLike, url: string, body: unknown) {
  return fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

let uploadCounter = 0;
/** Unique upload name: a queued run keeps reading its own reference. */
export function uploadName(prefix: string): string {
  uploadCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${uploadCounter}.png`;
}

export async function uploadDataUrl(
  fetchImpl: FetchLike,
  dataUrl: string,
  filename: string,
): Promise<string> {
  const data = await readJson(
    await postJson(fetchImpl, "/api/comfy/upload", {
      image: dataUrl,
      filename,
    }),
  );
  if (typeof data.ref !== "string") throw new ToolApiError("Upload failed");
  return data.ref;
}

export async function seedRun(
  fetchImpl: FetchLike,
  ref: string,
  width: number,
  height: number,
  prompt: string,
  duration?: number | null,
  audio?: { ref: string; seconds?: number | null },
): Promise<{ runId: string; jobIndex: number }> {
  const data = await readJson(
    await postJson(fetchImpl, "/api/jobs/seed-run", {
      ref,
      width,
      height,
      prompt,
      ...(typeof duration === "number" ? { duration } : {}),
      ...(audio ? { audio: audio.ref } : {}),
      ...(audio && typeof audio.seconds === "number"
        ? { audio_duration: audio.seconds }
        : {}),
    }),
  );
  const run = data.run as ImagineRun | undefined;
  if (!run?.run_id) throw new ToolApiError("Could not prepare the image");
  return { runId: run.run_id, jobIndex: run.jobs?.[0]?.index ?? 0 };
}

/** Catalog tools: gallery -> run ref, upload -> annotated ref. */
export async function imageRefFor(
  fetchImpl: FetchLike,
  image: ToolImage,
): Promise<ToolImageRef> {
  if (image.source === "gallery" && image.runId) {
    return { run_id: image.runId, job_index: image.jobIndex ?? 0 };
  }
  if (image.comfyRef) return image.comfyRef;
  if (!image.dataUrl) throw new ToolApiError("Image is not ready");
  return uploadDataUrl(fetchImpl, image.dataUrl, uploadName("cj_tool"));
}

/** Action tools: always a (run, job) pair. */
export async function sourceRunFor(
  fetchImpl: FetchLike,
  image: ToolImage,
  title: string,
  audio?: { ref: string; seconds?: number | null },
): Promise<{ runId: string; jobIndex: number }> {
  if (image.source === "gallery" && image.runId) {
    return { runId: image.runId, jobIndex: image.jobIndex ?? 0 };
  }
  // seed-run only takes input refs: graph images from output/temp upload
  // their pixels instead.
  const ref = await imageRefFor(
    fetchImpl,
    image.comfyRef && !image.comfyRef.endsWith(" [input]")
      ? { ...image, comfyRef: undefined }
      : image,
  );
  if (typeof ref !== "string") throw new ToolApiError("Image is not ready");
  return seedRun(fetchImpl, ref, image.width, image.height, title, null, audio);
}

export async function submitCatalogTool(args: {
  fetchImpl: FetchLike;
  tool: CatalogTool;
  settings: ToolSettings;
  images: (ToolImage | null)[];
  mask: string | null;
  clientId: string;
  /** Optional-node bypass warnings from the job route (toast them). */
  onWarnings?: (warnings: string[]) => void;
}): Promise<ImagineRun> {
  const { fetchImpl, tool, settings, images, mask, clientId } = args;
  // Validate before uploading anything.
  buildCatalogBody(
    tool,
    settings,
    images.map((i) => (i ? "pending" : null)),
    mask,
    clientId,
  );
  const refs: ToolImageRef[] = [];
  for (const img of images.slice(0, tool.refCount)) {
    if (!img) continue;
    refs.push(await imageRefFor(fetchImpl, img));
  }
  const body = buildCatalogBody(tool, settings, refs, mask, clientId);
  const data = await readJson(
    await postJson(fetchImpl, "/api/jobs/tool", body),
  );
  if (!data.run) throw new ToolApiError("Server returned no run");
  reportWarnings(data, args.onWarnings);
  return data.run as ImagineRun;
}

/** API-format workflow (as built by POST /api/jobs/tool with dry_run). */
export type ApiWorkflowJson = Record<
  string,
  {
    class_type: string;
    inputs: Record<string, unknown>;
    _meta?: { title?: string };
  }
>;

/**
 * Build a catalog tool's API workflow without queueing it (dry run), e.g. to
 * insert it into the ComfyUI graph from the overlay. Same validation and
 * image resolution as submitCatalogTool.
 */
export async function exportCatalogToolWorkflow(args: {
  fetchImpl: FetchLike;
  tool: CatalogTool;
  settings: ToolSettings;
  images: (ToolImage | null)[];
  mask: string | null;
  clientId: string;
}): Promise<{ workflow: ApiWorkflowJson; seed?: number }> {
  const { fetchImpl, tool, settings, images, mask, clientId } = args;
  buildCatalogBody(
    tool,
    settings,
    images.map((i) => (i ? "pending" : null)),
    mask,
    clientId,
  );
  const refs: ToolImageRef[] = [];
  for (const img of images.slice(0, tool.refCount)) {
    if (!img) continue;
    refs.push(await imageRefFor(fetchImpl, img));
  }
  const body = buildCatalogBody(tool, settings, refs, mask, clientId);
  const data = await readJson(
    await postJson(fetchImpl, "/api/jobs/tool", { ...body, dry_run: true }),
  );
  const workflow = data.workflow;
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new ToolApiError("Server returned no workflow");
  }
  return {
    workflow: workflow as ApiWorkflowJson,
    seed: typeof data.seed === "number" ? data.seed : undefined,
  };
}

async function postActionTool(args: {
  fetchImpl: FetchLike;
  spec: ActionToolSpec;
  settings: ToolSettings;
  editLoras: EditLoraListResponse | null;
  image: ToolImage | null;
  secondImage: ToolImage | null;
  /** Further optional reference photos (spec.extraImages, e.g. ref_video). */
  extraImages?: (ToolImage | null)[];
  /** Speech for audio-in tools (spec.audioInput, e.g. lipsync). */
  audio?: ToolAudio | null;
  clientId: string;
  /** Optional-node bypass warnings from the job route (toast them). */
  onWarnings?: (warnings: string[]) => void;
  /**
   * MaskPainter per-subject masks (REGION_MASK_TOOLS): each is uploaded and
   * gets its own paste-back pass, clamped to that mask.
   */
  subjectMasks?: (string | null)[];
  /** MaskPainter union mask (graphs with a mask slot, e.g. edit_inpaint). */
  mask?: string | null;
}, dryRun: boolean): Promise<Record<string, unknown>> {
  const { fetchImpl, spec, settings, editLoras, image, secondImage, clientId } =
    args;
  if (!image) throw new ToolApiError("Add an image first.");
  const masks = regionMasksToSend(spec.id, args.subjectMasks ?? []);
  const needsAudio = audioActive(spec, settings);
  const audio = needsAudio ? (args.audio ?? null) : null;
  if (needsAudio && !audio)
    throw new ToolApiError(
      `Add the ${(spec.audioInput ?? "audio").toLowerCase()} first.`,
    );
  const extras = spec.extraImages?.length
    ? (args.extraImages ?? [])
        .slice(0, spec.extraImages.length)
        .filter((x): x is ToolImage => Boolean(x))
    : [];
  // Validate (text, LoRA) before uploading anything.
  buildActionRequest(
    spec,
    settings,
    editLoras,
    spec.secondImage && secondImage ? "pending" : undefined,
    audio ? { ref: "pending" } : undefined,
    extras.map(() => "pending"),
  );
  let audioArg: { ref: string; seconds?: number } | undefined;
  if (audio) {
    const ref = await uploadDataUrl(
      fetchImpl,
      audio.dataUrl,
      audioUploadName(audio.label),
    );
    audioArg = {
      ref,
      ...(typeof audio.duration === "number" ? { seconds: audio.duration } : {}),
    };
  }
  let secondRef: string | undefined;
  if (spec.secondImage && secondImage) {
    // The 2nd reference is always uploaded (the picker loads gallery pixels
    // into a data URL), so it never depends on a server-side run.
    if (!secondImage.dataUrl)
      throw new ToolApiError(`${spec.secondImage} photo is not ready.`);
    secondRef = await uploadDataUrl(
      fetchImpl,
      secondImage.dataUrl,
      uploadName("cj_ref2"),
    );
  }
  const extraRefs: string[] = [];
  for (const [i, img] of extras.entries()) {
    if (!img.dataUrl)
      throw new ToolApiError(`${spec.extraImages?.[i] ?? "Photo"} is not ready.`);
    extraRefs.push(
      await uploadDataUrl(fetchImpl, img.dataUrl, uploadName(`cj_ref${i + 3}`)),
    );
  }
  const req = buildActionRequest(
    spec,
    settings,
    editLoras,
    secondRef,
    audioArg,
    extraRefs,
  );
  const maskRefs: string[] = [];
  for (const [i, m] of masks.entries()) {
    maskRefs.push(
      await uploadDataUrl(fetchImpl, m, uploadName(regionMaskUploadPrefix(i))),
    );
  }
  const bodyMask = actionBodyMask(req.action, args.mask);
  const src = await sourceRunFor(fetchImpl, image, spec.title, audioArg);
  const data = await readJson(
    await postJson(fetchImpl, "/api/jobs/action", {
      run_id: src.runId,
      job_index: src.jobIndex,
      action: req.action,
      client_id: clientId,
      tool_page_id: spec.id,
      params: withRegionMasks(req.params, maskRefs),
      ...(bodyMask ? { mask: bodyMask } : {}),
      ...(Object.keys(req.overrides).length
        ? { workflow_control_overrides: req.overrides }
        : {}),
      ...(dryRun ? { dry_run: true } : {}),
    }),
  );
  return data;
}

export type ActionToolArgs = Parameters<typeof postActionTool>[0];

export async function submitActionTool(
  args: ActionToolArgs,
): Promise<ImagineRun> {
  const data = await postActionTool(args, false);
  if (!data.run) throw new ToolApiError("Server returned no run");
  reportWarnings(data, args.onWarnings);
  return data.run as ImagineRun;
}

/**
 * Build an image action tool's exact API workflow without queueing it
 * (POST /api/jobs/action with dry_run): same validation, uploads and
 * overrides as submitActionTool. For "Show graph".
 */
export async function exportActionToolWorkflow(
  args: ActionToolArgs,
): Promise<{ workflow: ApiWorkflowJson; seed?: number }> {
  const data = await postActionTool(args, true);
  const workflow = data.workflow;
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new ToolApiError("Server returned no workflow");
  }
  return {
    workflow: workflow as ApiWorkflowJson,
    seed: typeof data.seed === "number" ? data.seed : undefined,
  };
}

/**
 * Text-only action tools (music, sfx): seed an empty text run, then queue
 * the action on it. No upload, no source media.
 */
export async function submitTextTool(args: {
  fetchImpl: FetchLike;
  spec: ActionToolSpec;
  settings: ToolSettings;
  clientId: string;
  onWarnings?: (warnings: string[]) => void;
  /**
   * Voice sample for text tools with spec.audioInput (voiceover clone engine);
   * ignored while the spec's audioWhen pick is inactive (stock voice).
   */
  audio?: ToolAudio | null;
}): Promise<ImagineRun> {
  const { fetchImpl, spec, settings, clientId } = args;
  const needsAudio = audioActive(spec, settings);
  const audio = needsAudio ? (args.audio ?? null) : null;
  if (needsAudio && !audio)
    throw new ToolApiError(
      `Add the ${(spec.audioInput ?? "audio").toLowerCase()} first.`,
    );
  // Validate (text) before uploading anything.
  buildActionRequest(
    spec,
    settings,
    null,
    undefined,
    audio ? { ref: "pending" } : undefined,
  );
  let audioArg: { ref: string; seconds?: number } | undefined;
  if (audio) {
    const ref = await uploadDataUrl(
      fetchImpl,
      audio.dataUrl,
      audioUploadName(audio.label),
    );
    audioArg = {
      ref,
      ...(typeof audio.duration === "number" ? { seconds: audio.duration } : {}),
    };
  }
  const req = buildActionRequest(spec, settings, null, undefined, audioArg);
  const prompt =
    typeof req.params.prompt === "string"
      ? req.params.prompt
      : typeof req.params.script === "string"
        ? req.params.script
        : spec.title;
  const seeded = await readJson(
    await postJson(fetchImpl, "/api/jobs/seed-run", {
      text_only: true,
      prompt,
    }),
  );
  const src = seeded.run as ImagineRun | undefined;
  if (!src?.run_id) throw new ToolApiError("Could not start the tool");
  const data = await readJson(
    await postJson(fetchImpl, "/api/jobs/action", {
      run_id: src.run_id,
      job_index: src.jobs?.[0]?.index ?? 0,
      action: req.action,
      client_id: clientId,
      tool_page_id: spec.id,
      params: req.params,
    }),
  );
  if (!data.run) throw new ToolApiError("Server returned no run");
  reportWarnings(data, args.onWarnings);
  return data.run as ImagineRun;
}

/** Unique upload name for a clip; keeps a ComfyUI-loadable extension. */
export function videoUploadName(label: string): string {
  const ext = /\.(mp4|mov|m4v|webm)$/i.exec(label)?.[1]?.toLowerCase() ?? "mp4";
  return uploadName("cj_clip").replace(/\.png$/, `.${ext}`);
}

/**
 * Video-in tools (face swap): upload the face photo + the clip, seed a run
 * from the clip, then queue the action with the face as secondRefImage.
 */
export async function submitVideoTool(args: {
  fetchImpl: FetchLike;
  spec: ActionToolSpec;
  settings: ToolSettings;
  video: ToolVideo | null;
  /** Reference photo; ignored (may be null) when the spec has no secondImage. */
  face: ToolImage | null;
  /** Further optional reference photos (spec.extraImages, e.g. cast_swap). */
  extras?: (ToolImage | null)[];
  /** Driving audio for video + audio tools (spec.audioInput, e.g. video_lipsync). */
  audio?: ToolAudio | null;
  clientId: string;
  /** Optional-node bypass warnings from the job route (toast them). */
  onWarnings?: (warnings: string[]) => void;
}): Promise<ImagineRun> {
  const { fetchImpl, spec, settings, video, face, clientId } = args;
  if (!video) throw new ToolApiError("Add a source video first.");
  const needsAudio = audioActive(spec, settings);
  const audio = needsAudio ? (args.audio ?? null) : null;
  if (needsAudio && !audio)
    throw new ToolApiError(
      `Add the ${(spec.audioInput ?? "audio").toLowerCase()} first.`,
    );
  // Video-only tools (video background removal) take no reference photo.
  const needsRef = Boolean(spec.secondImage);
  if (needsRef && !face && !spec.secondImageOptional)
    throw new ToolApiError(
      `Add the ${(spec.secondImage ?? "face photo").toLowerCase()} first.`,
    );
  // Validate before uploading anything (an optional reference left empty is
  // validated as absent, so modes that need it fail before any upload).
  const extras = spec.extraImages?.length
    ? (args.extras ?? [])
        .slice(0, spec.extraImages.length)
        .filter((x): x is ToolImage => Boolean(x))
    : [];
  buildActionRequest(
    spec,
    settings,
    null,
    needsRef && face ? "pending" : undefined,
    audio ? { ref: "pending" } : undefined,
    extras.map(() => "pending"),
  );
  let faceRef: string | undefined;
  if (needsRef && face) {
    if (!face.dataUrl)
      throw new ToolApiError(`${spec.secondImage ?? "Face"} is not ready.`);
    faceRef = await uploadDataUrl(
      fetchImpl,
      face.dataUrl,
      uploadName("cj_face"),
    );
  }
  const videoRef = await uploadDataUrl(
    fetchImpl,
    video.dataUrl,
    videoUploadName(video.label),
  );
  let audioArg: { ref: string; seconds?: number } | undefined;
  if (audio) {
    const ref = await uploadDataUrl(
      fetchImpl,
      audio.dataUrl,
      audioUploadName(audio.label),
    );
    audioArg = {
      ref,
      ...(typeof audio.duration === "number" ? { seconds: audio.duration } : {}),
    };
  }
  const extraRefs: string[] = [];
  for (const [i, img] of extras.entries()) {
    if (!img.dataUrl)
      throw new ToolApiError(`${spec.extraImages?.[i] ?? "Photo"} is not ready.`);
    extraRefs.push(
      await uploadDataUrl(fetchImpl, img.dataUrl, uploadName(`cj_ref${i + 3}`)),
    );
  }
  const req = buildActionRequest(
    spec,
    settings,
    null,
    faceRef,
    audioArg,
    extraRefs,
  );
  const src = await seedRun(
    fetchImpl,
    videoRef,
    video.width || 1280,
    video.height || 720,
    spec.title,
    video.duration,
    audioArg,
  );
  let params = withSourceFps(req.params, video.fps);
  if (req.action === VACE_EXTEND_ACTION && video.sourceUrl) {
    const contextFrames = await vaceTailContext(fetchImpl, video.sourceUrl);
    if (contextFrames) params = { ...params, contextFrames };
  }
  const data = await readJson(
    await postJson(fetchImpl, "/api/jobs/action", {
      run_id: src.runId,
      job_index: src.jobIndex,
      action: req.action,
      client_id: clientId,
      tool_page_id: spec.id,
      params,
    }),
  );
  if (!data.run) throw new ToolApiError("Server returned no run");
  reportWarnings(data, args.onWarnings);
  return data.run as ImagineRun;
}

/**
 * Extend video of an earlier extend output: the 17 lossless tail PNG refs its
 * run saved (vaceTailRefsFromVideoUrl), when the first and last are served by
 * /api/comfy/image (which routes to the backend holding them). null otherwise
 * (not an extend output, older run, files gone): the graph then slices the
 * context from the MP4 as before.
 */
export async function vaceTailContext(
  fetchImpl: FetchLike,
  videoUrl: string,
): Promise<string[] | null> {
  const refs = vaceTailRefsFromVideoUrl(videoUrl);
  if (!refs) return null;
  for (const ref of [refs[0], refs[refs.length - 1]]) {
    const path = ref.replace(/ \[output\]$/, "");
    const slash = path.lastIndexOf("/");
    const url = comfyProxyUrl({
      filename: path.slice(slash + 1),
      subfolder: slash >= 0 ? path.slice(0, slash) : "",
      type: "output",
    });
    try {
      const res = await fetchImpl(url, { headers: { Range: "bytes=0-0" } });
      if (!res.ok) return null;
    } catch {
      return null;
    }
  }
  return refs;
}

/**
 * Adds the clip's probed fps as `sourceFps` (graphs that rebuild the clip,
 * e.g. video_bg_change, encode at it). Unknown fps: params unchanged.
 */
export function withSourceFps(
  params: Record<string, unknown>,
  fps: number | null | undefined,
): Record<string, unknown> {
  const value = normalizeFps(fps);
  return value === null ? params : { ...params, sourceFps: value };
}

async function postDescribe(
  fetchImpl: FetchLike,
  image: ToolImage,
  loadBlob: (url: string) => Promise<Blob>,
): Promise<Record<string, unknown>> {
  const blob = await loadBlob(image.dataUrl ?? image.previewUrl);
  const form = new FormData();
  form.set("image", blob, "describe.png");
  const res = await fetchImpl("/api/describe", { method: "POST", body: form });
  return readJson(res).catch((e) => {
    throw new ToolApiError(
      e instanceof Error && e.message
        ? e.message
        : "StyleVault must be running for image description.",
    );
  });
}

/** Plain caption of a tool input (local StyleVault Qwen3-VL), shaped to seed a prompt box. */
export async function describeCaption(
  fetchImpl: FetchLike,
  image: ToolImage,
  loadBlob: (url: string) => Promise<Blob>,
): Promise<string> {
  const data = await postDescribe(fetchImpl, image, loadBlob);
  const caption = String(data.caption ?? "")
    .replace(/\s+/g, " ")
    .replace(/^ohwx,\s*/i, "")
    .trim()
    .replace(/[.!?]+$/, "");
  if (!caption) throw new ToolApiError("No description came back.");
  return caption;
}

export async function describeImage(
  fetchImpl: FetchLike,
  image: ToolImage,
  loadBlob: (url: string) => Promise<Blob>,
): Promise<string[]> {
  const data = await postDescribe(fetchImpl, image, loadBlob);
  const list = (data.suggestions as string[] | undefined) ?? [];
  if (!list.length) throw new ToolApiError("No description came back.");
  return list.slice(0, 4);
}

// Hub templates / apps: edit engines with a compiled prompt

/**
 * Per-image upload cache so a batch (one photo → N restyles) uploads and
 * seeds the source only once.
 */
export interface PreparedSource {
  catalogRef?: ToolImageRef;
  run?: { runId: string; jobIndex: number };
}

export async function submitEngineEdit(args: {
  fetchImpl: FetchLike;
  engine: EditEngine;
  prompt: string;
  image: ToolImage | null;
  /** Reference image for two-image engines (always uploaded). */
  secondImage?: ToolImage | null;
  ctx: EngineContext;
  clientId: string;
  title: string;
  /** Edit mode hint for grounded Krea 2 dual edits (insert / tryon / swap). */
  editMode?: string;
  prepared?: PreparedSource;
  onWarnings?: (warnings: string[]) => void;
}): Promise<ImagineRun> {
  const { fetchImpl, engine, image, clientId } = args;
  if (!image) throw new ToolApiError("Add a photo first.");
  const req = buildEngineRequest(engine, args.prompt, args.ctx, {
    secondRef: engine.refs === 2 ? "pending" : undefined,
    editMode: args.editMode,
  });
  const prepared = args.prepared ?? {};

  if (req.kind === "catalog") {
    if (!prepared.catalogRef)
      prepared.catalogRef = await imageRefFor(fetchImpl, image);
    const body = buildCatalogBody(
      req.tool,
      req.settings,
      [prepared.catalogRef],
      null,
      clientId,
    );
    const data = await readJson(
      await postJson(fetchImpl, "/api/jobs/tool", body),
    );
    if (!data.run) throw new ToolApiError("Server returned no run");
    reportWarnings(data, args.onWarnings);
    return data.run as ImagineRun;
  }

  let secondRef: string | undefined;
  if (engine.refs === 2) {
    const ref = args.secondImage;
    if (!ref) throw new ToolApiError("Add the reference image first.");
    if (!ref.dataUrl) throw new ToolApiError("Reference image is not ready.");
    secondRef = await uploadDataUrl(
      fetchImpl,
      ref.dataUrl,
      uploadName("cj_ref2"),
    );
  }
  const final = buildEngineRequest(engine, args.prompt, args.ctx, {
    secondRef,
    editMode: args.editMode,
  });
  if (final.kind !== "action") throw new ToolApiError("Engine mismatch");
  if (!prepared.run)
    prepared.run = await sourceRunFor(fetchImpl, image, args.title);
  const data = await readJson(
    await postJson(fetchImpl, "/api/jobs/action", {
      run_id: prepared.run.runId,
      job_index: prepared.run.jobIndex,
      action: final.action,
      client_id: clientId,
      params: final.params,
      ...(Object.keys(final.overrides).length
        ? { workflow_control_overrides: final.overrides }
        : {}),
    }),
  );
  if (!data.run) throw new ToolApiError("Server returned no run");
  reportWarnings(data, args.onWarnings);
  return data.run as ImagineRun;
}

/** Step 2 of an app: animate a finished image job (LTXV image-to-video). */
export async function submitAnimate(args: {
  fetchImpl: FetchLike;
  runId: string;
  jobIndex: number;
  motion: "animate_low" | "animate_high";
  prompt: string;
  clientId: string;
}): Promise<ImagineRun> {
  const prompt = args.prompt.trim();
  const data = await readJson(
    await postJson(args.fetchImpl, "/api/jobs/action", {
      run_id: args.runId,
      job_index: args.jobIndex,
      action: args.motion,
      client_id: args.clientId,
      params: prompt ? { prompt } : {},
    }),
  );
  if (!data.run) throw new ToolApiError("Server returned no run");
  return data.run as ImagineRun;
}

/** Queue add_sound (MMAudio V2A) on a finished clip run (App step 3). */
export async function submitAddSound(args: {
  fetchImpl: FetchLike;
  runId: string;
  jobIndex: number;
  params: Record<string, unknown>;
  clientId: string;
}): Promise<ImagineRun> {
  const data = await readJson(
    await postJson(args.fetchImpl, "/api/jobs/action", {
      run_id: args.runId,
      job_index: args.jobIndex,
      action: "add_sound",
      client_id: args.clientId,
      params: args.params,
    }),
  );
  if (!data.run) throw new ToolApiError("Server returned no run");
  return data.run as ImagineRun;
}

/**
 * Generic ComfyUI output extraction.
 *
 * A history entry's `outputs` is `{ [nodeId]: { [uiKey]: unknown[] } }`, where
 * the uiKey depends on the node that produced it (see comfy_api/latest/_ui.py):
 *
 *   images            SaveImage / PreviewImage; also SaveVideo / CreateVideo
 *                     (PreviewVideo reports video files under "images" with
 *                     `animated: [true]`) and SaveAnimatedWEBP/PNG
 *   gifs | videos     VideoHelperSuite VHS_VideoCombine (any container, incl. GIF)
 *   audio             SaveAudio / PreviewAudio (SavedAudios)
 *   3d | meshes       SaveGLB / Preview3DAdvanced (Saved3DModels) / legacy savers
 *   result            Preview3D (PreviewUI3D): [model_file, camera_info, bg_image]
 *   text | string     PreviewAny / ShowText-style nodes
 *   latents           SaveLatent (and anything else unknown → kept raw)
 *
 * Metadata keys that ride alongside file lists (`animated`, `camera_info`,
 * `model_3d_info`) are folded into the outputs they describe, never emitted
 * as outputs themselves.
 *
 * Client-safe: no Node imports.
 */

import {
  isMasterNode,
  isMasterSubfolder,
  isSidecarNode,
  isSidecarSubfolder,
} from "@/lib/output/saveNodes";

export type ComfyOutputKind =
  "image" | "animated" | "video" | "audio" | "mesh" | "text" | "unknown";

/** Query params for ComfyUI's GET /view (and Adrift's /api/comfy/image proxy). */
export interface ComfyViewParams {
  filename: string;
  subfolder: string;
  type: string;
}

export interface ExtractedOutput {
  /** Output node id as keyed in history (may be a subgraph path like "12:5"). */
  nodeId: string;
  /** UI node id from history `meta.display_node`, when ComfyUI reports one. */
  displayNodeId?: string;
  /** `_meta.title` from the prompt, else class_type, else "Node <id>". */
  nodeTitle: string;
  classType?: string;
  kind: ComfyOutputKind;
  /** The ui key the payload came from ("images", "gifs", "audio", "text", ...). */
  key: string;
  /** Present for file outputs: pass to /view or comfyProxyUrl(). */
  view?: ComfyViewParams;
  /** File format hint (extension or VHS mime like "video/h264-mp4"). */
  format?: string;
  /** ComfyUI media enrichment (`kind`/`width`/`height`/`duration`/...). */
  metadata?: Record<string, unknown>;
  /** Text payload for kind "text". */
  text?: string;
  /** Original payload for kind "unknown" (latents, custom node data). */
  raw?: unknown;
}

type PromptNode = {
  class_type?: unknown;
  _meta?: { title?: unknown } | null;
};
export type ComfyPromptGraph = Record<string, PromptNode | undefined>;

export interface HistoryEntryLike {
  outputs?: Record<string, unknown> | null;
  prompt?: unknown;
  meta?: Record<string, { display_node?: unknown } | undefined> | null;
}

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv|avi|mpe?g|ts|flv)$/i;
const ANIMATED_EXT = /\.(gif|apng)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|tiff?|avif|heic|gif|apng)$/i;
const AUDIO_EXT = /\.(flac|mp3|wav|ogg|opus|m4a|aac)$/i;
const MESH_EXT = /\.(glb|gltf|obj|fbx|stl|ply|usdz|spz|splat|ksplat|bvh)$/i;

/** Keys that annotate sibling outputs rather than being outputs. */
const ANNOTATION_KEYS = new Set(["animated", "camera_info", "model_3d_info"]);
const TEXT_KEYS = new Set(["text", "string"]);

export function isVideoFilename(filename: string): boolean {
  return VIDEO_EXT.test(filename);
}

export function isAudioFilename(filename: string): boolean {
  return AUDIO_EXT.test(filename);
}

export function isMeshFilename(filename: string): boolean {
  return MESH_EXT.test(filename);
}

/** `filename=…&subfolder=…&type=…` — same encoding as the legacy routes. */
export function comfyViewQuery(view: ComfyViewParams): string {
  return `filename=${encodeURIComponent(view.filename)}&subfolder=${encodeURIComponent(view.subfolder || "")}&type=${encodeURIComponent(view.type || "output")}`;
}

/** Adrift proxy URL for a file output (served by /api/comfy/image). */
export function comfyProxyUrl(view: ComfyViewParams): string {
  return `/api/comfy/image?${comfyViewQuery(view)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asFileEntry(value: unknown): {
  view: ComfyViewParams;
  format?: string;
  metadata?: Record<string, unknown>;
} | null {
  if (!isRecord(value)) return null;
  const { filename, subfolder, type, format, metadata } = value;
  if (typeof filename !== "string" || !filename) return null;
  return {
    view: {
      filename,
      subfolder: typeof subfolder === "string" ? subfolder : "",
      type: typeof type === "string" && type ? type : "output",
    },
    format: typeof format === "string" ? format : undefined,
    metadata: isRecord(metadata) ? metadata : undefined,
  };
}

function extensionOf(filename: string): string | undefined {
  return filename.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
}

function isAnimatedFlag(nodeOutput: Record<string, unknown>): boolean {
  const animated = nodeOutput.animated;
  return Array.isArray(animated) ? animated.some(Boolean) : animated === true;
}

/** Classify a file entry by key, extension, VHS mime format and enrichment. */
function classifyFile(
  key: string,
  filename: string,
  format: string | undefined,
  metadata: Record<string, unknown> | undefined,
  animated: boolean,
): ComfyOutputKind {
  const fmt = (format ?? "").toLowerCase();
  const metaKind = typeof metadata?.kind === "string" ? metadata.kind : "";

  if (key === "audio" || AUDIO_EXT.test(filename) || fmt.startsWith("audio/"))
    return "audio";
  if (key === "3d" || key === "meshes" || MESH_EXT.test(filename))
    return "mesh";
  // GIF/APNG play in <img>, never in <video> — even under VHS's "gifs" key.
  if (ANIMATED_EXT.test(filename) || fmt === "image/gif" || fmt === "gif")
    return "animated";
  if (
    VIDEO_EXT.test(filename) ||
    fmt.startsWith("video/") ||
    metaKind === "video"
  )
    return "video";
  if (key === "gifs" || key === "videos") {
    // VHS image/webp output: animated image, not a video container.
    return /\.webp$/i.test(filename) || fmt === "image/webp"
      ? "animated"
      : "video";
  }
  if (IMAGE_EXT.test(filename) || metaKind === "image" || key === "images") {
    return animated && /\.(webp|png)$/i.test(filename) ? "animated" : "image";
  }
  return "unknown";
}

function stringifyText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Pull the API-format prompt graph out of a history entry (`prompt[2]`). */
export function promptGraphOf(
  entry: HistoryEntryLike | null | undefined,
): ComfyPromptGraph {
  const prompt = entry?.prompt;
  if (Array.isArray(prompt) && isRecord(prompt[2])) {
    return prompt[2] as ComfyPromptGraph;
  }
  if (isRecord(prompt)) return prompt as ComfyPromptGraph;
  return {};
}

function lookupNode(
  graph: ComfyPromptGraph,
  nodeId: string,
  displayNodeId?: string,
): { title: string; classType?: string } {
  const node =
    graph[nodeId] ?? (displayNodeId ? graph[displayNodeId] : undefined);
  const classType =
    typeof node?.class_type === "string" ? node.class_type : undefined;
  const title =
    typeof node?._meta?.title === "string" && node._meta.title.trim()
      ? node._meta.title
      : (classType ?? `Node ${displayNodeId ?? nodeId}`);
  return { title, classType };
}

/**
 * Classify every output node's payload in a history entry (or an `executed`
 * WS message's `output`, wrapped as `{ outputs: { [node]: output } }`).
 *
 * @param prompt API-format prompt graph for node titles; defaults to the
 *               entry's own `prompt[2]`.
 */
export function extractOutputs(
  entry: HistoryEntryLike | null | undefined,
  prompt?: ComfyPromptGraph | null,
): ExtractedOutput[] {
  const outputs = entry?.outputs;
  if (!isRecord(outputs)) return [];
  const graph = prompt ?? promptGraphOf(entry);
  const meta = isRecord(entry?.meta) ? entry!.meta! : {};
  const result: ExtractedOutput[] = [];

  for (const [nodeId, nodeOutput] of Object.entries(outputs)) {
    if (!isRecord(nodeOutput)) continue;
    const displayRaw = meta[nodeId]?.display_node;
    const displayNodeId =
      typeof displayRaw === "string" && displayRaw ? displayRaw : undefined;
    const { title, classType } = lookupNode(graph, nodeId, displayNodeId);
    const base = {
      nodeId,
      ...(displayNodeId && displayNodeId !== nodeId ? { displayNodeId } : {}),
      nodeTitle: title,
      ...(classType ? { classType } : {}),
    };
    const animated = isAnimatedFlag(nodeOutput);
    const graphNode =
      graph[nodeId] ?? (displayNodeId ? graph[displayNodeId] : undefined);
    const masterNode = isMasterNode(graphNode);
    // Internal sidecar files (Extend video's lossless tail PNGs) are inputs
    // for a later run, never results or downloads.
    if (isSidecarNode(graphNode)) continue;

    for (const [key, payload] of Object.entries(nodeOutput)) {
      if (ANNOTATION_KEYS.has(key)) continue;

      if (TEXT_KEYS.has(key)) {
        const items = Array.isArray(payload) ? payload : [payload];
        for (const item of items) {
          if (item === null || item === undefined) continue;
          result.push({
            ...base,
            kind: "text",
            key,
            text: stringifyText(item),
          });
        }
        continue;
      }

      // Preview3D (PreviewUI3D): ["path/model.glb", camera_info, bg_image]
      if (
        key === "result" &&
        Array.isArray(payload) &&
        typeof payload[0] === "string" &&
        MESH_EXT.test(payload[0])
      ) {
        const path = payload[0].replace(/\\/g, "/");
        const slash = path.lastIndexOf("/");
        result.push({
          ...base,
          kind: "mesh",
          key,
          view: {
            filename: path.slice(slash + 1),
            subfolder: slash >= 0 ? path.slice(0, slash) : "",
            type: "output",
          },
          format: extensionOf(path),
        });
        continue;
      }

      const items = Array.isArray(payload) ? payload : [payload];
      const files = items.map(asFileEntry);
      if (items.length > 0 && files.every((f) => f !== null)) {
        files.forEach((file, i) => {
          const { view, format, metadata } = file!;
          // LoadVideo/LoadAudio echo their source back as a type:"input"
          // preview. That's the user's own upload, never a result.
          if (view.type === "input") return;
          if (isSidecarSubfolder(view.subfolder)) return;
          // Opt-in master files (EXR / 16-bit PNG / ProRes) are downloads,
          // never gallery media (lib/output/saveNodes.ts).
          const kind =
            masterNode || isMasterSubfolder(view.subfolder)
              ? "unknown"
              : classifyFile(key, view.filename, format, metadata, animated);
          result.push({
            ...base,
            kind,
            key,
            view,
            format: format ?? extensionOf(view.filename),
            ...(metadata ? { metadata } : {}),
            ...(kind === "unknown" ? { raw: items[i] } : {}),
          });
        });
        continue;
      }

      // Non-file payload (latents without filenames, custom node data, ...).
      if (payload === null || payload === undefined) continue;
      if (Array.isArray(payload) && payload.length === 0) continue;
      result.push({ ...base, kind: "unknown", key, raw: payload });
    }
  }

  return result;
}

/** Group extracted outputs by kind (stable order within each kind). */
export function groupOutputs(
  outputs: ExtractedOutput[],
): Record<ComfyOutputKind, ExtractedOutput[]> {
  const groups: Record<ComfyOutputKind, ExtractedOutput[]> = {
    image: [],
    animated: [],
    video: [],
    audio: [],
    mesh: [],
    text: [],
    unknown: [],
  };
  for (const output of outputs) groups[output.kind].push(output);
  return groups;
}

/** Job media buckets (ImagineJob images/videos/audios/meshes/texts). */
export interface JobMedia {
  images: string[];
  videos: string[];
  audios: string[];
  meshes: string[];
  texts: string[];
}

/**
 * Bucket a history entry's outputs the way ImagineJob stores them.
 * `toUrl` receives the /view query (comfyViewQuery) — e.g. an absolute
 * `${COMFY_HTTP_URL}/view?…` for server-side source fetches, or the
 * /api/comfy/image proxy for the browser. image + animated (gif/apng/webp)
 * go to images; latents/custom payloads ("unknown") are skipped.
 */
export function jobMediaFromHistory(
  entry: HistoryEntryLike | null | undefined,
  toUrl: (viewQuery: string) => string = (q) => `/api/comfy/image?${q}`,
): JobMedia {
  const media: JobMedia = {
    images: [],
    videos: [],
    audios: [],
    meshes: [],
    texts: [],
  };
  for (const out of extractOutputs(entry)) {
    if (out.kind === "text") {
      if (typeof out.text === "string" && out.text) media.texts.push(out.text);
      continue;
    }
    if (!out.view) continue;
    const url = toUrl(comfyViewQuery(out.view));
    if (out.kind === "image" || out.kind === "animated") media.images.push(url);
    else if (out.kind === "video") media.videos.push(url);
    else if (out.kind === "audio") media.audios.push(url);
    else if (out.kind === "mesh") media.meshes.push(url);
  }
  return media;
}

/**
 * Non-empty text outputs (PreviewAny / ShowText) from a /api/comfy/history
 * response, or undefined when there are none.
 */
export function historyTexts(data: {
  texts?: { text?: unknown }[];
}): string[] | undefined {
  const texts = (data?.texts ?? [])
    .map((t) => (typeof t?.text === "string" ? t.text.trim() : ""))
    .filter(Boolean);
  return texts.length > 0 ? texts : undefined;
}

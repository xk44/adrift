/**
 * ComfyUI HTTP Client
 * Handles communication with ComfyUI backend via REST API
 */

import type { ComfyQueueResult, ComfyHistoryEntry, Workflow } from "@/types";
import { env } from "@/lib/env";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import { withPreviewMethod } from "@/lib/comfy/previewMethod";
import { readPreviewMethod } from "@/lib/runtimeSettings";
import { applyUpscalerPreference } from "@/lib/upscale/applyUpscalerPref";
import { uploadMimeType } from "@/lib/comfy/uploadName";
import { contentHashedName } from "@/lib/comfy/contentName";
import {
  applyOptionalNodeBypass,
  assertPromptValid,
  getObjectInfoCached,
} from "@/lib/comfy/objectInfoCache";
import { rememberPromptTitles } from "@/lib/comfy/promptTitles";
import { persistRecipe, stampRecipe } from "@/lib/recipe/stamp";
import { applyModelVariantFallback } from "@/lib/comfy/modelVariants";
import {
  addMasterOutputs,
  detectMasterFormats,
  supportedChoice,
  type MasterChoice,
} from "@/lib/output/saveNodes";
import { extractNodeTitles, formatNodeErrors } from "@/lib/comfy/errorMessages";
import type { ComfyErrorCode } from "@/lib/comfy/runFailure";
import {
  BackendBusyError,
  backendIdForUrl,
  backendUrlForSubfolder,
  hasMultipleBackends,
  rememberPromptBackend,
  stageInputsForBackend,
  tagOutputsForBackend,
  withExclusiveBackend,
} from "@/lib/comfy/backends";

/** Read per call: the URL can change at runtime (first-run wizard). */
const comfyHttpUrl = (): string => env.COMFY_HTTP_URL;

/**
 * Upload an image to ComfyUI's input dir and return the annotated LoadImage ref
 * ("[subfolder/]filename [input]"). Used for dual-reference edit modes' 2nd image.
 * Without an explicit filename the name is content-addressed (never a shared
 * fixed name that concurrent jobs would overwrite).
 */
export async function uploadImageToComfy(
  data: Uint8Array,
  filename?: string,
  subfolder = "",
): Promise<string> {
  filename ??= contentHashedName("cj_ref.png", data);
  const form = new FormData();
  form.append(
    "image",
    new Blob([data as BlobPart], { type: uploadMimeType(filename) }),
    filename,
  );
  form.append("overwrite", "true");
  form.append("type", "input");
  if (subfolder) form.append("subfolder", subfolder);
  const res = await comfyFetch("/upload/image", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`ComfyUI /upload/image failed: ${res.status}`);
  }
  const body = (await res.json()) as { name?: string; subfolder?: string };
  const name = body.name ?? filename;
  const sub = body.subfolder ? `${body.subfolder}/` : "";
  return `${sub}${name} [input]`;
}

type ObjectInfoResponse = Record<
  string,
  {
    input?: {
      required?: Record<string, unknown[]>;
      optional?: Record<string, unknown[]>;
    };
  }
>;

const MODELS_CACHE_MS = 5 * 60 * 1000;
/** Keyed by base URL: switching ComfyUI must not serve the old list. */
let checkpointsCache: {
  at: number;
  url: string;
  checkpoints: string[];
} | null = null;

/** Drop the checkpoint list (the ComfyUI connection changed). */
export function clearCheckpointsCache(): void {
  checkpointsCache = null;
}

function extractList(
  data: ObjectInfoResponse,
  nodeType: string,
  inputName: string,
): string[] {
  const nodeInfo = data[nodeType];
  if (!nodeInfo?.input?.required?.[inputName]) {
    return [];
  }
  const values = nodeInfo.input.required[inputName][0];
  return Array.isArray(values) ? (values as string[]) : [];
}

export async function fetchAvailableCheckpoints(): Promise<string[]> {
  const now = Date.now();
  const url = comfyHttpUrl();
  if (
    checkpointsCache &&
    checkpointsCache.url === url &&
    now - checkpointsCache.at < MODELS_CACHE_MS
  ) {
    return checkpointsCache.checkpoints;
  }

  log("info", `Fetching ComfyUI object_info`);

  const attempts = 3;
  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      const response = await comfyFetch("/object_info", {
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        throw new ComfyAPIError(
          `Failed to fetch ComfyUI object_info: HTTP ${response.status}`,
        );
      }
      const data = (await response.json()) as ObjectInfoResponse;
      const checkpoints = extractList(
        data,
        "CheckpointLoaderSimple",
        "ckpt_name",
      );
      checkpointsCache = { at: now, url, checkpoints };
      return checkpoints;
    } catch (error) {
      lastError = error;
      const delayMs = 500 * Math.pow(2, i);
      log(
        "warn",
        `object_info fetch failed (attempt ${i + 1}/${attempts}), retrying in ${delayMs}ms`,
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new ComfyAPIError("Failed to fetch ComfyUI object_info");
}

export class ComfyAPIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public nodeErrors?: Record<string, unknown>,
    /**
     * Failure class + ComfyUI's parsed /prompt error body (runFailure.ts).
     * notSent: the prompt provably never reached ComfyUI (connection refused /
     * host unknown, or input staging failed), so another machine may take it.
     */
    public extra?: { code?: ComfyErrorCode; body?: unknown; notSent?: boolean },
  ) {
    super(message);
    this.name = "ComfyAPIError";
  }
}

/** API envelope `details` for a ComfyAPIError: the client parses these. */
export function comfyErrorDetails(error: ComfyAPIError): {
  code: ComfyErrorCode;
  comfy?: unknown;
} {
  const code = error.extra?.code ?? "comfy_error";
  return error.extra?.body !== undefined
    ? { code, comfy: error.extra.body }
    : { code };
}

const CONNECT_FAILURE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * fetch() failed while connecting (no request bytes reached the server).
 * A reset / timeout after connecting does not count: ComfyUI may already
 * have queued the prompt.
 */
export function isConnectFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (e: unknown): boolean => {
    if (!e || typeof e !== "object" || seen.has(e)) return false;
    seen.add(e);
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && CONNECT_FAILURE_CODES.has(code)) return true;
    const errors = (e as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0 && errors.every(visit))
      return true;
    return visit((e as { cause?: unknown }).cause);
  };
  return visit(error);
}

function log(
  level: "info" | "warn" | "error",
  message: string,
  data?: unknown,
) {
  const timestamp = new Date().toISOString();
  const prefix = `[ComfyHTTP ${timestamp}]`;

  if (level === "error") {
    console.error(prefix, message, data ?? "");
  } else if (level === "warn") {
    console.warn(prefix, message, data ?? "");
  } else {
    console.log(prefix, message, data ?? "");
  }
}

export interface QueuePromptOptions {
  /** ComfyUI extra_data (e.g. extra_pnginfo) embedded in saved PNGs. */
  extraData?: Record<string, unknown>;
  /** "Run next": queue at the front of the pending queue. */
  front?: boolean;
  /**
   * Opt-in master file (16-bit PNG / EXR / ProRes 4444) saved beside the
   * normal outputs; skipped when the backend lacks the nodes.
   */
  master?: { choice: MasterChoice | null; tool?: string; seed?: number | string | null };
}

/**
 * Queue a prompt (workflow) for execution
 * Returns the prompt_id for tracking via WebSocket
 */
export async function queuePrompt(
  workflow: Workflow,
  clientId: string,
  baseUrl: string = comfyHttpUrl(),
  opts: QueuePromptOptions = {},
): Promise<ComfyQueueResult> {
  const url = `${baseUrl}/prompt`;

  if (opts.master?.choice) {
    const choice = supportedChoice(
      opts.master.choice,
      detectMasterFormats(await getObjectInfoCached(baseUrl)),
    );
    workflow = addMasterOutputs(workflow, choice, opts.master).graph;
  }

  // Multi-host: tag non-main-backend outputs with that backend's marker
  // subfolder and copy inputs that live on another host (no-op on a single
  // host).
  if (hasMultipleBackends()) {
    const target = backendIdForUrl(baseUrl);
    workflow = JSON.parse(JSON.stringify(workflow)) as Workflow;
    tagOutputsForBackend(workflow, target);
    try {
      await stageInputsForBackend(workflow, target);
    } catch (error) {
      throw new ComfyAPIError(
        error instanceof Error ? error.message : "Input staging failed",
        502,
        undefined,
        { notSent: true },
      );
    }
  }

  // Optional custom nodes (`_meta.optional`) the server lacks are bypassed.
  const bypass = await applyOptionalNodeBypass(workflow, baseUrl);
  workflow = bypass.prompt;
  const warnings = bypass.bypassed.map((b) => b.warning);
  for (const b of bypass.bypassed) {
    log(
      "warn",
      `Optional node bypassed: ${b.title} (#${b.nodeId}, ${b.classType})`,
      b.warning,
    );
  }

  // A pack file the server lacks -> its installed precision sibling
  // (krea2_turbo_bf16 -> krea2_turbo_fp8_scaled); see modelVariants.ts.
  const variants = await applyModelVariantFallback(workflow, baseUrl);
  workflow = variants.prompt;
  for (const v of variants.swaps) {
    const msg = `Using ${v.to} (${v.from} is not installed)`;
    warnings.push(msg);
    log("warn", `Model variant fallback: #${v.nodeId} ${v.classType}.${v.input}`, msg);
  }

  // Upscaler of choice (Settings → Upscaler): see lib/upscale/resolveUpscalers.
  const upscalers = await applyUpscalerPreference(workflow, baseUrl);
  workflow = upscalers.prompt;
  warnings.push(...upscalers.warnings);
  for (const u of upscalers.swaps) {
    log("info", `Upscaler: #${u.nodeId} ${u.from} -> ${u.to} (${u.content}, ${u.source}, x${u.rescale})`);
  }

  await assertPromptValid(workflow, baseUrl); // throws PromptValidationError (422)

  const stamped = stampRecipe(opts.extraData, workflow);

  log("info", `Queueing prompt to ${url}`, {
    clientId,
    nodeCount: Object.keys(workflow).length,
  });

  let responded = false;
  try {
    // Cross-host GPU mutex: serialise and wait for the other host to drain.
    const response = await withExclusiveBackend(baseUrl, () =>
      comfyFetch("/prompt", {
        baseUrl,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: workflow,
          client_id: clientId,
          // Live previews: per-prompt preview_method (settings, "auto"
          // default) merged into the caller's extra_data (pnginfo, ...).
          extra_data: withPreviewMethod(stamped.extraData, readPreviewMethod()),
          // ComfyUI server.py: `front: true` negates the queue number.
          ...(opts.front ? { front: true } : {}),
        }),
        signal: AbortSignal.timeout(30000),
      }),
    );
    responded = true;

    if (!response.ok) {
      const errorText = await response.text();
      log("error", `Queue prompt failed: ${response.status}`, errorText);

      // Try to parse error response for structured error details
      let errorJson: Record<string, unknown> | null = null;
      try {
        errorJson = JSON.parse(errorText);
      } catch {
        // Not JSON — fall through to plain-text error
      }

      if (errorJson) {
        const nodeErrorText = formatNodeErrors(
          errorJson.node_errors as Record<string, unknown> | undefined,
          extractNodeTitles(workflow),
        );
        const baseMsg =
          ((errorJson.error as Record<string, unknown>)?.message as string) ??
          `HTTP ${response.status}`;
        throw new ComfyAPIError(
          nodeErrorText ? `${baseMsg}\n${nodeErrorText}` : baseMsg,
          response.status,
          errorJson.node_errors as Record<string, unknown> | undefined,
          { code: "comfy_rejected", body: errorJson },
        );
      }

      throw new ComfyAPIError(
        `ComfyUI returned ${response.status}: ${errorText.slice(0, 200)}`,
        response.status,
      );
    }

    const result = (await response.json()) as ComfyQueueResult;
    rememberPromptTitles(result.prompt_id, workflow);
    rememberPromptBackend(result.prompt_id, baseUrl);
    await persistRecipe(result.prompt_id, stamped.recipe);
    log("info", `Prompt queued successfully`, { prompt_id: result.prompt_id });

    return warnings.length > 0 ? { ...result, warnings } : result;
  } catch (error) {
    if (error instanceof ComfyAPIError) throw error;
    if (error instanceof BackendBusyError) {
      throw new ComfyAPIError(error.message, error.status);
    }

    // Network or connection error
    const message = error instanceof Error ? error.message : "Unknown error";
    if (error instanceof Error && error.name === "TimeoutError") {
      log("error", `ComfyUI /prompt timed out`, { url });
      throw new ComfyAPIError(
        `ComfyUI at ${baseUrl} did not respond within 30 s.`,
        504,
        undefined,
        { code: "comfy_timeout" },
      );
    }
    log("error", `Failed to connect to ComfyUI`, { url, error: message });

    throw new ComfyAPIError(
      `Cannot connect to ComfyUI at ${baseUrl}. Is it running?`,
      undefined,
      undefined,
      {
        code: "comfy_unreachable",
        ...(!responded && isConnectFailure(error) ? { notSent: true } : {}),
      },
    );
  }
}

/**
 * Fetch history for a specific prompt_id
 * Returns outputs including generated image filenames
 */
export async function fetchHistory(
  promptId: string,
  baseUrl: string = comfyHttpUrl(),
): Promise<ComfyHistoryEntry | null> {
  const url = `${baseUrl}/history/${promptId}`;

  log("info", `Fetching history for ${promptId}`);

  try {
    const response = await comfyFetch(url, {
      baseUrl,
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      if (response.status === 404) {
        log("warn", `History not found for ${promptId}`);
        return null;
      }
      throw new ComfyAPIError(
        `Failed to fetch history: HTTP ${response.status}`,
        response.status,
      );
    }

    const data = (await response.json()) as Record<string, ComfyHistoryEntry>;
    const entry = data[promptId];

    if (!entry) {
      log("warn", `No history entry for ${promptId}`);
      return null;
    }

    log("info", `History fetched for ${promptId}`, {
      outputNodes: Object.keys(entry.outputs ?? {}),
    });

    return entry;
  } catch (error) {
    if (error instanceof ComfyAPIError) throw error;

    const message = error instanceof Error ? error.message : "Unknown error";
    log("error", `Failed to fetch history`, { promptId, error: message });
    throw new ComfyAPIError(`Failed to fetch history: ${message}`);
  }
}

export function extractImageUrls(
  entry: ComfyHistoryEntry,
  baseUrl = comfyHttpUrl(),
): string[] {
  const urls: string[] = [];

  for (const [nodeId, output] of Object.entries(entry.outputs ?? {})) {
    if (output.images) {
      for (const img of output.images) {
        const params = new URLSearchParams({
          filename: img.filename,
          subfolder: img.subfolder || "",
          type: img.type || "output",
        });
        urls.push(`${baseUrl}/view?${params}`);
      }
    }
  }

  return urls;
}

function validateComfyViewParam(
  name: string,
  value: string,
  allowSlashes = false,
): void {
  const controlChar = /[\x00-\x1f\x7f]/;
  if (
    !value ||
    value.length > 255 ||
    controlChar.test(value) ||
    value.includes("\\")
  ) {
    throw new ComfyAPIError(`Invalid ${name}`, 400);
  }
  if (!allowSlashes && (value.includes("/") || value.includes(".."))) {
    throw new ComfyAPIError(`Invalid ${name}`, 400);
  }
  if (allowSlashes) {
    const segments = value.split("/");
    if (
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment.includes(".."),
      )
    ) {
      throw new ComfyAPIError(`Invalid ${name}`, 400);
    }
  }
}

export async function fetchImageResponse(
  filename: string,
  subfolder = "",
  type = "output",
  range?: string | null,
): Promise<Response> {
  validateComfyViewParam("filename", filename);
  if (subfolder) validateComfyViewParam("subfolder", subfolder, true);
  if (!["output", "input", "temp"].includes(type)) {
    throw new ComfyAPIError("Invalid type", 400);
  }

  const params = new URLSearchParams({ filename, subfolder, type });
  // Files from the video backend carry its marker subfolder.
  const viewBase = backendUrlForSubfolder(subfolder);
  const url = `${viewBase}/view?${params}`;

  log("info", `Fetching image: ${filename}`);

  // The timeout only guards the initial request: once headers arrive the
  // caller streams the body to the client, and an armed AbortSignal.timeout
  // would destroy large transfers (videos) mid-stream.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const headers: Record<string, string> = {};
    if (range) headers["Range"] = range;
    const response = await comfyFetch(url, {
      baseUrl: viewBase,
      signal: controller.signal,
      headers,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new ComfyAPIError(
        `Failed to fetch image: HTTP ${response.status}`,
        response.status,
      );
    }

    return response;
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof ComfyAPIError) throw error;

    const message = error instanceof Error ? error.message : "Unknown error";
    log("error", `Failed to fetch image`, { filename, error: message });
    throw new ComfyAPIError(`Failed to fetch image: ${message}`);
  }
}

export async function fetchImage(
  filename: string,
  subfolder = "",
  type = "output",
): Promise<Buffer> {
  const response = await fetchImageResponse(filename, subfolder, type);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function fetchImageBase64(
  filename: string,
  subfolder = "",
  type = "output",
): Promise<string> {
  const buffer = await fetchImage(filename, subfolder, type);
  const base64 = buffer.toString("base64");

  const ext = filename.split(".").pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    mp4: "video/mp4",
    webm: "video/webm",
    glb: "model/gltf-binary",
    obj: "text/plain",
    wav: "audio/wav",
    mp3: "audio/mpeg",
    flac: "audio/flac",
    ogg: "audio/ogg",
  };
  const mime = mimeTypes[ext ?? "png"] ?? "image/png";

  return `data:${mime};base64,${base64}`;
}

export async function checkConnection(): Promise<{
  connected: boolean;
  error?: string;
  queueRemaining?: number;
}> {
  try {
    const response = await comfyFetch("/system_stats", {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return {
        connected: false,
        error: `ComfyUI returned HTTP ${response.status}`,
      };
    }

    // Also check queue status — non-critical, default to 0 on failure
    let queueRemaining = 0;
    try {
      const queueResponse = await comfyFetch("/prompt", {
        signal: AbortSignal.timeout(5000),
      });
      if (queueResponse.ok) {
        const queueData = await queueResponse.json();
        queueRemaining = queueData?.exec_info?.queue_remaining ?? 0;
      }
    } catch {
      // Queue check is best-effort
    }

    return {
      connected: true,
      queueRemaining,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      connected: false,
      error: `Cannot connect to ComfyUI: ${message}`,
    };
  }
}

/**
 * Upload an image to ComfyUI for img2img/inpainting
 */
export async function uploadImage(
  imageData: Buffer | Blob,
  filename: string,
  subfolder = "",
  overwrite = true,
): Promise<{ name: string; subfolder: string; type: string }> {
  const url = `${comfyHttpUrl()}/upload/image`;

  log("info", `Uploading image: ${filename}`);

  const formData = new FormData();

  const blob =
    imageData instanceof Blob
      ? imageData
      : new Blob([new Uint8Array(imageData)]);

  formData.append("image", blob, filename);
  if (subfolder) formData.append("subfolder", subfolder);
  formData.append("overwrite", overwrite ? "true" : "false");

  try {
    const response = await comfyFetch(url, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new ComfyAPIError(
        `Failed to upload image: HTTP ${response.status} - ${errorText}`,
        response.status,
      );
    }

    const result = await response.json();
    log("info", `Image uploaded successfully`, result);

    return result;
  } catch (error) {
    if (error instanceof ComfyAPIError) throw error;

    const message = error instanceof Error ? error.message : "Unknown error";
    log("error", `Failed to upload image`, { filename, error: message });
    throw new ComfyAPIError(`Failed to upload image: ${message}`);
  }
}

export async function getCheckpoints(): Promise<string[]> {
  const url = `${comfyHttpUrl()}/object_info/CheckpointLoaderSimple`;

  try {
    const response = await comfyFetch(url, {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return [];

    const data = await response.json();
    return data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
  } catch {
    return [];
  }
}

export async function getSamplers(): Promise<string[]> {
  const url = `${comfyHttpUrl()}/object_info/KSampler`;

  try {
    const response = await comfyFetch(url, {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return [];

    const data = await response.json();
    return data?.KSampler?.input?.required?.sampler_name?.[0] ?? [];
  } catch {
    return [];
  }
}

export async function getSchedulers(): Promise<string[]> {
  const url = `${comfyHttpUrl()}/object_info/KSampler`;

  try {
    const response = await comfyFetch(url, {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return [];

    const data = await response.json();
    return data?.KSampler?.input?.required?.scheduler?.[0] ?? [];
  } catch {
    return [];
  }
}

export async function interruptGeneration(): Promise<void> {
  const url = `${comfyHttpUrl()}/interrupt`;

  log("info", "Interrupting generation");

  try {
    await comfyFetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    log("error", `Failed to interrupt`, { error: message });
    throw new ComfyAPIError(`Failed to interrupt: ${message}`);
  }
}

export async function clearQueue(): Promise<void> {
  const url = `${comfyHttpUrl()}/queue`;

  log("info", "Clearing queue");

  try {
    await comfyFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clear: true }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    log("error", `Failed to clear queue`, { error: message });
    throw new ComfyAPIError(`Failed to clear queue: ${message}`);
  }
}

export async function deleteFromQueue(
  promptIds: string | string[],
  baseUrl: string = comfyHttpUrl(),
): Promise<void> {
  const ids = Array.isArray(promptIds) ? promptIds : [promptIds];

  log("info", `Deleting ${ids.length} prompt(s) from queue`, { ids });

  try {
    await comfyFetch("/queue", {
      baseUrl,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: ids }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    log("error", `Failed to delete from queue`, { ids, error: message });
    throw new ComfyAPIError(`Failed to delete from queue: ${message}`);
  }
}

/**
 * Interrupt one running prompt (ComfyUI >= 0.4x honours prompt_id and skips
 * the interrupt if that prompt is not the one currently running).
 */
export async function interruptPrompt(
  promptId: string,
  baseUrl: string = comfyHttpUrl(),
): Promise<void> {
  const res = await comfyFetch("/interrupt", {
    baseUrl,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt_id: promptId }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new ComfyAPIError(
      `ComfyUI /interrupt returned ${res.status}`,
      res.status,
    );
  }
}

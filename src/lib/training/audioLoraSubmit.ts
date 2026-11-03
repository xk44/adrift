/**
 * Train audio LoRA, browser side: upload clips (with 429 back-off), start
 * the one-node prompt, follow it (SSE steps + status polling), stop it.
 * `fetch`, the data-URL reader and `sleep` are injectable for tests.
 */
import {
  datasetFolder,
  type AudioLoraAdapter,
  type AudioLoraBase,
} from "./audioLora";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

async function readBody(res: Response): Promise<Record<string, unknown>> {
  try {
    return ((await res.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function errorOf(
  body: Record<string, unknown>,
  res: Response,
  fallback: string,
): string {
  return typeof body.error === "string" && body.error
    ? body.error
    : `${fallback} (HTTP ${res.status})`;
}

export interface AudioLoraAvailability {
  available: boolean;
  reason: string | null;
}

export async function getAudioLoraAvailability(
  fetchImpl: FetchLike = fetch,
): Promise<AudioLoraAvailability> {
  try {
    const res = await fetchImpl("/api/tools/audio-lora");
    const body = await readBody(res);
    if (!res.ok)
      return {
        available: false,
        reason: errorOf(body, res, "Trainer check failed"),
      };
    return {
      available: body.available === true,
      reason: typeof body.reason === "string" ? body.reason : null,
    };
  } catch {
    return {
      available: false,
      reason: "Trainer check failed (is Adrift's server running?).",
    };
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Could not read a clip."));
    r.readAsDataURL(blob);
  });
}

export interface ClipToUpload {
  blob: Blob;
  /** clipUploadName() result. */
  uploadName: string;
}

/**
 * Upload every clip into input/sa3_train/<name>/. The upload route allows
 * 30 requests a minute, so a 429 waits for Retry-After and tries again.
 */
export async function uploadAudioLoraClips(
  name: string,
  clips: ClipToUpload[],
  opts: {
    fetchImpl?: FetchLike;
    toDataUrl?: (b: Blob) => Promise<string>;
    sleep?: (ms: number) => Promise<void>;
    onProgress?: (done: number, total: number, waiting: boolean) => void;
    signal?: { aborted: boolean };
    maxRetries?: number;
  } = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const toDataUrl = opts.toDataUrl ?? blobToDataUrl;
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = opts.maxRetries ?? 6;
  const subfolder = datasetFolder(name);
  for (let i = 0; i < clips.length; i++) {
    opts.onProgress?.(i, clips.length, false);
    const image = await toDataUrl(clips[i].blob);
    for (let attempt = 0; ; attempt++) {
      if (opts.signal?.aborted) throw new Error("Upload stopped.");
      const res = await fetchImpl("/api/comfy/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image,
          filename: clips[i].uploadName,
          subfolder,
        }),
      });
      if (res.status === 429 && attempt < maxRetries) {
        const after = Number(res.headers?.get?.("Retry-After") ?? "");
        const waitS =
          Number.isFinite(after) && after > 0 ? Math.min(after, 60) : 10;
        opts.onProgress?.(i, clips.length, true);
        await sleep(waitS * 1000);
        continue;
      }
      const body = await readBody(res);
      if (!res.ok || body.ok === false)
        throw new Error(
          `${clips[i].uploadName}: ${errorOf(body, res, "Upload failed")}`,
        );
      break;
    }
  }
  opts.onProgress?.(clips.length, clips.length, false);
}

export interface AudioLoraStartBody {
  name: string;
  base: AudioLoraBase;
  adapter: AudioLoraAdapter;
  rank: number;
  lr: number;
  steps: number;
  captions: Record<string, string>;
}

export async function startAudioLoraTraining(
  body: AudioLoraStartBody,
  fetchImpl: FetchLike = fetch,
): Promise<{ promptId: string; clientId: string }> {
  const res = await fetchImpl("/api/tools/audio-lora", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await readBody(res);
  if (!res.ok || data.ok === false || typeof data.prompt_id !== "string")
    throw new Error(errorOf(data, res, "Training failed to start"));
  return { promptId: data.prompt_id, clientId: String(data.client_id ?? "") };
}

export interface AudioLoraStatus {
  state: "queued" | "running" | "done" | "error" | "unknown";
  lora?: string;
  summary?: string;
  error?: string;
}

export async function getAudioLoraStatus(
  promptId: string,
  fetchImpl: FetchLike = fetch,
): Promise<AudioLoraStatus> {
  const res = await fetchImpl(
    `/api/tools/audio-lora?prompt_id=${encodeURIComponent(promptId)}`,
  );
  const data = await readBody(res);
  if (!res.ok || data.ok === false)
    throw new Error(errorOf(data, res, "Status check failed"));
  const state = data.state;
  return {
    state:
      state === "queued" ||
      state === "running" ||
      state === "done" ||
      state === "error"
        ? state
        : "unknown",
    lora: typeof data.lora === "string" ? data.lora : undefined,
    summary: typeof data.summary === "string" ? data.summary : undefined,
    error: typeof data.error === "string" ? data.error : undefined,
  };
}

/** Stop a queued or running training prompt (the node kills the trainer). */
export async function cancelAudioLoraTraining(
  promptId: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const res = await fetchImpl("/api/jobs/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt_id: promptId }),
  });
  const data = await readBody(res);
  if (!res.ok) throw new Error(errorOf(data, res, "Could not stop training"));
  // ComfyUI < 0.3.57 has no targeted interrupt. The route only asks when this
  // prompt is the one running, so a global interrupt stops exactly it.
  if (data.action === "confirm-global-interrupt") {
    const again = await fetchImpl("/api/jobs/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt_id: promptId, confirm_global: true }),
    });
    if (!again.ok)
      throw new Error(
        errorOf(await readBody(again), again, "Could not stop training"),
      );
  }
}

export type AudioLoraStreamEvent =
  | { kind: "step"; step: number; max: number }
  | { kind: "executing" }
  | { kind: "end" };

/**
 * Follow the prompt's own client_id stream. Returns a closer. Steps come from
 * the node's ProgressBar; completion is confirmed by status polling.
 */
export function watchAudioLoraProgress(
  clientId: string,
  promptId: string,
  onEvent: (e: AudioLoraStreamEvent) => void,
  makeSource: (url: string) => EventSource = (url) => new EventSource(url),
): () => void {
  if (!clientId || typeof EventSource === "undefined") return () => {};
  const es = makeSource(
    `/api/comfy/progress?client_id=${encodeURIComponent(clientId)}`,
  );
  const parse = (ev: MessageEvent): Record<string, unknown> | null => {
    try {
      const d = JSON.parse(String(ev.data)) as Record<string, unknown>;
      return d && d.prompt_id === promptId ? d : null;
    } catch {
      return null;
    }
  };
  es.addEventListener("progress", (ev) => {
    const d = parse(ev as MessageEvent);
    if (d && typeof d.step === "number" && typeof d.max === "number")
      onEvent({ kind: "step", step: d.step, max: d.max });
  });
  es.addEventListener("executing", (ev) => {
    if (parse(ev as MessageEvent)) onEvent({ kind: "executing" });
  });
  for (const type of ["complete", "error", "cancelled"]) {
    es.addEventListener(type, (ev) => {
      if (parse(ev as MessageEvent)) onEvent({ kind: "end" });
    });
  }
  return () => es.close();
}

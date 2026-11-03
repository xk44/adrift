/**
 * Per-run upscale model override, shared by the Upscale tool, Lightbox,
 * Gallery and Quick edit for this page session only. "" (the default) means
 * "use the Settings → Upscaler choice", which the server applies at submit;
 * a file pins that model for the run. Not persisted: the saved default lives
 * server-side (upscalerDefaultsClient.ts).
 */
import {
  UPSCALE_ACTIONS,
  VIDEO_UPSCALE_ACTION,
  sanitizeUpscaleModel,
  upscaleRequestParams,
} from "./upscaleModels";

/** Old per-browser choice, moved into the server preference once. */
export const UPSCALE_MODEL_PREF_KEY = "adrift.upscale-model";

type Listener = (model: string) => void;
const listeners = new Set<Listener>();
let override = "";

export function readUpscaleModelPref(): string {
  return override;
}

export function writeUpscaleModelPref(model: string): void {
  override = sanitizeUpscaleModel(model) ?? "";
  for (const l of listeners) l(override);
}

/** Notified when any picker on the page changes the override. */
export function subscribeUpscaleModelPref(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Read and remove the legacy localStorage choice ("" when none). */
export function takeLegacyUpscaleModel(): string {
  try {
    if (typeof window === "undefined") return "";
    const v = window.localStorage.getItem(UPSCALE_MODEL_PREF_KEY);
    if (v !== null) window.localStorage.removeItem(UPSCALE_MODEL_PREF_KEY);
    return sanitizeUpscaleModel(v) ?? "";
  } catch {
    return "";
  }
}

/**
 * /api/jobs/action params for a one-click upscale (Lightbox / Gallery):
 * the per-run override if any (else the server default), default
 * creativity. undefined for any other action, so their request bodies are
 * unchanged.
 */
export function upscaleActionParams(
  action: string,
): Record<string, unknown> | undefined {
  if (!UPSCALE_ACTIONS.has(action)) return undefined;
  // The override is picked against image upscalers; clips use the video default.
  return upscaleRequestParams(action, {
    model: action === VIDEO_UPSCALE_ACTION ? undefined : readUpscaleModelPref(),
  });
}

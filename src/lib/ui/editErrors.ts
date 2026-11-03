/**
 * Toast copy for Editor failures. The editor has no error banner (that lives
 * in Create's header), so these are what the user sees.
 */
import { classifyRunError } from "@/lib/comfy/runFailure";

const MAX_DETAIL = 140;

function clip(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > MAX_DETAIL ? `${t.slice(0, MAX_DETAIL - 1)}…` : t;
}

/** "The edit didn't start: …" with the cause in plain words when known. */
export function editFailureMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const failure = classifyRunError({ message: raw });
  switch (failure.kind) {
    case "comfy_unreachable":
      return "The edit didn't start: ComfyUI isn't running. Start it, then try again.";
    case "app_unreachable":
      return "The edit didn't start: Adrift's server isn't answering.";
    case "timeout":
      return "The edit didn't start: ComfyUI took too long to answer. Try again.";
    case "out_of_memory":
      return "The edit ran out of GPU memory. Try a smaller image.";
  }
  return raw
    ? `The edit didn't start: ${clip(raw)}`
    : "The edit didn't start. Try again.";
}

/**
 * Toast copy for a failed Smart Select click. Says what to do next; the
 * Paint brush always works without ComfyUI, so it is the fallback offered.
 */
export function smartSelectFailureMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const failure = classifyRunError({ message: raw });
  switch (failure.kind) {
    case "comfy_unreachable":
      return "Smart Select needs ComfyUI running. Start it, or paint the area with the brush (B).";
    case "app_unreachable":
      return "Smart Select couldn't reach Adrift's server. Try again.";
    case "timeout":
      return "Smart Select took too long (ComfyUI may be busy). Try again in a moment.";
    case "out_of_memory":
      return "Smart Select ran out of GPU memory. Try again when the current job finishes.";
    case "missing_node":
    case "missing_model":
      return `Smart Select isn't set up on this ComfyUI: ${failure.message}`;
  }
  return raw
    ? `Smart Select failed: ${clip(raw).replace(/[.!]+$/, "")}. You can paint the area with the brush (B).`
    : "Smart Select failed. You can paint the area with the brush (B).";
}

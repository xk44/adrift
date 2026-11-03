/**
 * Create (POST /api/jobs/imagine) failures, explained with the same
 * RunFailure model the tools use, plus the next step Create can offer:
 * "Open checklist" (the first-run checklist) or the node manager.
 *
 * The imagine envelope is { ok:false, error, code?, comfy?, problems?,
 * details?: string[] } where details are "Job N: <message>" lines.
 */
import {
  classifyJobError,
  classifyRunError,
  type RunFailure,
} from "@/lib/comfy/runFailure";

/** What Create's notice offers next. */
export type CreateFailureAction = "setup" | "nodes" | null;

export interface CreateFailure extends RunFailure {
  action: CreateFailureAction;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

const JOB_PREFIX_RE = /^Job \d+:\s*/;
const SERVER_PREFIX_RE = /^Server error:\s*/;
/** Raw graph references ("KSampler (#3)", "#12") belong in Details only. */
const NODE_REF_RE = /\(#[^)]*\)|#\d+\b/;

function noModelFailure(detail?: string): RunFailure {
  return {
    kind: "missing_model",
    title: "No model for Create",
    message:
      "Adrift couldn't find a model for Create. Open the first-run checklist to download one, or pick a model in Settings, then try again.",
    detail,
    retryable: true,
    setup: true,
    startComfy: false,
  };
}

/** Reword tool-drawer copy for Create and pick the button to offer. */
export function forCreate(failure: RunFailure): CreateFailure {
  let { message, startComfy } = failure;
  let action: CreateFailureAction = null;
  let detail = failure.detail;

  switch (failure.kind) {
    case "missing_model":
      action = "setup";
      message = message.replace(
        /Open "Set up this tool" for the download link and folder/,
        "Add it to your ComfyUI models folder (the first-run checklist shows what Create needs)",
      );
      break;
    case "missing_node":
      action = "nodes";
      message = message.replace(
        /Open "Set up this tool"( for the node pack)?/,
        "Open the node manager",
      );
      break;
    case "comfy_unreachable":
      action = "setup";
      startComfy = false;
      message =
        "Adrift couldn't connect to ComfyUI. Open the first-run checklist for the command that starts it, then try again.";
      break;
  }

  if (failure.kind === "unknown" && NODE_REF_RE.test(message)) {
    detail = detail ?? message;
    message =
      "ComfyUI couldn't run this prompt. Open Details for what it said, then try again.";
  }

  return {
    ...failure,
    message,
    startComfy,
    detail,
    setup: action === "setup",
    action,
  };
}

/** Classify a failed /api/jobs/imagine response (status 0 = no response). */
export function classifyCreateResponse(
  data: unknown,
  status: number,
): CreateFailure {
  const body = isRecord(data) ? data : {};
  const code = str(body.code);
  const error = str(body.error)?.replace(SERVER_PREFIX_RE, "") ?? "";

  if (code === "no_checkpoint") return forCreate(noModelFailure(error));

  const jobLines = Array.isArray(body.details)
    ? body.details.filter((d): d is string => typeof d === "string")
    : [];
  const firstJob = jobLines[0]?.replace(JOB_PREFIX_RE, "");
  const rawDetail = jobLines.length > 0 ? jobLines.join("\n") : undefined;

  let failure = classifyRunError({
    message: firstJob ?? error,
    status,
    code,
    details: { comfy: body.comfy, problems: body.problems },
  });
  if (failure.kind === "unknown" && firstJob) {
    failure = classifyJobError(firstJob);
  }
  if (!failure.detail && rawDetail) failure = { ...failure, detail: rawDetail };
  return forCreate(failure);
}

/** A thrown fetch/parse error while submitting Create. */
export function classifyCreateException(message: string): CreateFailure {
  return forCreate(classifyRunError({ message, status: 0 }));
}

/**
 * Server side: the envelope fields (code, ComfyUI /prompt body) a ComfyAPIError
 * carries. Duck-typed (no http import) so route tests that stub
 * @/lib/comfy/http keep working; callers check instanceof ComfyAPIError.
 * Mirrors comfyErrorDetails() in lib/comfy/http.
 */
export function comfyFailureFields(
  error: unknown,
): { code: string; comfy?: unknown } | undefined {
  if (!(error instanceof Error)) return undefined;
  const extra = (error as { extra?: { code?: unknown; body?: unknown } }).extra;
  const code = typeof extra?.code === "string" ? extra.code : "comfy_error";
  return extra?.body !== undefined ? { code, comfy: extra.body } : { code };
}

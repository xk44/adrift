/**
 * Turns a failed tool run into one human sentence plus the next step.
 *
 * Inputs it understands:
 * - ComfyUI's POST /prompt 400 body: { error: { type, message, details,
 *   extra_info }, node_errors: { [id]: { class_type, errors: [...] } } }
 *   (execution.py validate_prompt / server.py post_prompt).
 * - Adrift's own pre-submit validation problems (validatePrompt.ts, 422).
 * - The API envelope codes of /api/jobs/tool and /api/jobs/action.
 * - WS execution_error payloads and the job.error strings built from them.
 *
 * Pure; safe for client and server. Never changes what a successful run does.
 */
import type { PromptProblem } from "@/lib/comfy/validatePrompt";

export type RunFailureKind =
  | "comfy_unreachable"
  | "app_unreachable"
  | "missing_node"
  | "missing_model"
  | "missing_input_file"
  | "invalid_workflow"
  | "out_of_memory"
  | "interrupted"
  | "timeout"
  | "unknown";

export interface RunFailure {
  kind: RunFailureKind;
  /** Short headline ("ComfyUI isn't reachable"). */
  title: string;
  /** One or two plain sentences: what happened and what to do. */
  message: string;
  /** Raw technical text for a disclosure (node errors, exception). */
  detail?: string;
  /** Running again is likely to help (possibly after the suggested fix). */
  retryable: boolean;
  /** Point at the "Set up this tool" drawer. */
  setup: boolean;
  /** Show the "how to start ComfyUI" help. */
  startComfy: boolean;
  /** Node class the failure is about, when known. */
  nodeClass?: string;
  /** Model file the failure is about, when known. */
  modelFile?: string;
}

/** Envelope codes Adrift's server attaches to ComfyUI failures. */
export type ComfyErrorCode =
  "comfy_unreachable" | "comfy_timeout" | "comfy_rejected" | "comfy_error";

/** README anchor for "Start ComfyUI with a CORS origin". */
export const START_COMFY_README_ANCHOR = "#2-start-comfyui-with-a-cors-origin";

/** Command shown inline when ComfyUI is unreachable (README quick start). */
export const START_COMFY_COMMAND =
  "python main.py --listen 127.0.0.1 --port 8188 --enable-cors-header http://localhost:3000";

const MODEL_EXT_RE = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx)$/i;
/** Loader inputs that name a model file (ckpt_name, lora_name, unet_name, ...). */
const MODEL_INPUT_RE =
  /^(?:\w+_)?(ckpt|lora|vae|unet|clip|clip_vision|model|control_net|controlnet|style_model|upscale_model|gligen|ipadapter|text_encoder|diffusion_model|checkpoint)(?:_name)?\d*$/i;
const IMAGE_EXT_RE =
  /\.(png|jpe?g|webp|gif|bmp|tiff?|mp4|webm|mov|wav|mp3|flac|m4a)$/i;

const OOM_RE =
  /out of memory|OutOfMemoryError|Allocation on device|MPS backend out of memory|CUBLAS_STATUS_ALLOC_FAILED|not enough memory/i;
const INTERRUPT_RE =
  /InterruptProcessingException|Processing interrupted|\binterrupted\b/i;
const TIMEOUT_RE =
  /TimeoutError|timed out|aborted due to timeout|did not respond within|ETIMEDOUT|UND_ERR_(HEADERS|BODY)_TIMEOUT/i;
const UNREACHABLE_RE =
  /Cannot connect to ComfyUI|fetch failed|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|ComfyUI (is )?(offline|unreachable)|socket hang up/i;
const BROWSER_NET_RE =
  /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/i;
const MISSING_FILE_RE =
  /FileNotFoundError|No such file or directory|Error while deserializing header|could not find (the )?model/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function quote(s: string): string {
  return `"${s}"`;
}

function nodeLabel(
  title: string | undefined,
  classType: string | undefined,
): string {
  if (title && classType && title !== classType)
    return `${title} (${classType})`;
  return title ?? classType ?? "a node";
}

// Constructors

export function unreachableFailure(detail?: string): RunFailure {
  return {
    kind: "comfy_unreachable",
    title: "ComfyUI isn't reachable",
    message:
      "Adrift couldn't connect to ComfyUI. Start ComfyUI with --enable-cors-header (or check COMFY_HTTP_URL in .env.local), then try again.",
    detail,
    retryable: true,
    setup: false,
    startComfy: true,
  };
}

function appUnreachableFailure(detail?: string): RunFailure {
  return {
    kind: "app_unreachable",
    title: "Adrift's server isn't answering",
    message:
      "The browser couldn't reach the Adrift web server. Check that npm run dev (or npm start) is still running, then try again.",
    detail,
    retryable: true,
    setup: false,
    startComfy: false,
  };
}

function timeoutFailure(detail?: string): RunFailure {
  return {
    kind: "timeout",
    title: "ComfyUI timed out",
    message:
      "ComfyUI took too long to answer. It may be busy loading a large model or finishing another job; wait a moment and try again.",
    detail,
    retryable: true,
    setup: false,
    startComfy: false,
  };
}

function oomFailure(where: string | undefined, detail?: string): RunFailure {
  return {
    kind: "out_of_memory",
    title: "Out of GPU memory",
    message: `${where ? `${where} ran` : "ComfyUI ran"} out of memory. Close other GPU apps, try a smaller size or a GGUF/fp8 variant of the model, or start ComfyUI with --lowvram, then try again.`,
    detail,
    retryable: true,
    setup: false,
    startComfy: false,
  };
}

function interruptedFailure(detail?: string): RunFailure {
  return {
    kind: "interrupted",
    title: "Run interrupted",
    message:
      "The run was stopped before it finished (cancelled in ComfyUI, or ComfyUI restarted). Run it again when you're ready.",
    detail,
    retryable: true,
    setup: false,
    startComfy: false,
  };
}

function missingNodeFailure(
  classType: string | undefined,
  detail?: string,
): RunFailure {
  const what = classType
    ? `the ComfyUI node ${quote(classType)}`
    : "a ComfyUI custom node";
  return {
    kind: "missing_node",
    title: "Missing custom node",
    message: `This tool needs ${what}, which isn't installed on this ComfyUI. Open "Set up this tool" for the node pack, install it, restart ComfyUI and run again.`,
    detail,
    retryable: true,
    setup: true,
    startComfy: false,
    nodeClass: classType,
  };
}

function missingModelFailure(
  file: string | undefined,
  where: string | undefined,
  detail?: string,
): RunFailure {
  const what = file ? `the model file ${quote(file)}` : "a model file";
  return {
    kind: "missing_model",
    title: "Missing model file",
    message: `ComfyUI can't find ${what}${where ? ` for ${where}` : ""}. Open "Set up this tool" for the download link and folder, then run again.`,
    detail,
    retryable: true,
    setup: true,
    startComfy: false,
    modelFile: file,
  };
}

function missingInputFailure(
  file: string | undefined,
  detail?: string,
): RunFailure {
  return {
    kind: "missing_input_file",
    title: "Input file not found",
    message: `ComfyUI can't find the input ${file ? quote(file) : "file"}. Add the image again and run.`,
    detail,
    retryable: true,
    setup: false,
    startComfy: false,
  };
}

function invalidFailure(sentence: string, detail?: string): RunFailure {
  return {
    kind: "invalid_workflow",
    title: "ComfyUI rejected the workflow",
    message: sentence,
    detail,
    retryable: false,
    setup: false,
    startComfy: false,
  };
}

function unknownFailure(message: string, detail?: string): RunFailure {
  return {
    kind: "unknown",
    title: "Run failed",
    message: message || "Something went wrong.",
    detail,
    retryable: true,
    setup: false,
    startComfy: false,
  };
}

// ComfyUI POST /prompt error body

interface ComfyReason {
  type?: string;
  message?: string;
  details?: string;
  extra_info?: Record<string, unknown>;
}

/** "ckpt_name: 'x.safetensors' not in [...]" -> "x.safetensors". */
function receivedValue(reason: ComfyReason): string | undefined {
  const fromExtra = reason.extra_info?.received_value;
  if (typeof fromExtra === "string" && fromExtra) return fromExtra;
  const m = /: '([^']*)' not in/.exec(reason.details ?? "");
  return m?.[1] || undefined;
}

function inputName(reason: ComfyReason): string | undefined {
  const fromExtra = str(reason.extra_info?.input_name);
  if (fromExtra) return fromExtra;
  const m = /^([A-Za-z0-9_.]+)[:,\s]/.exec(reason.details ?? "");
  return m?.[1];
}

function looksLikeModelInput(
  input: string | undefined,
  value: string | undefined,
): boolean {
  if (value && IMAGE_EXT_RE.test(value)) return false;
  if (value && MODEL_EXT_RE.test(value)) return true;
  return Boolean(
    input &&
    MODEL_INPUT_RE.test(input) &&
    !/image|video|audio|file/i.test(input),
  );
}

function reasonLine(reason: ComfyReason): string {
  const msg = reason.message ?? reason.type ?? "error";
  return reason.details ? `${msg}: ${reason.details}` : msg;
}

/** One readable line per node error, for the detail disclosure. */
function nodeErrorDetail(nodeErrors: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [id, raw] of Object.entries(nodeErrors)) {
    if (!isRecord(raw)) continue;
    const cls = str(raw.class_type) ?? "node";
    const errs = Array.isArray(raw.errors) ? (raw.errors as ComfyReason[]) : [];
    if (errs.length === 0) lines.push(`${cls} #${id}: invalid`);
    for (const e of errs) lines.push(`${cls} #${id}: ${reasonLine(e)}`);
  }
  return lines.join("\n");
}

/**
 * Parse ComfyUI's /prompt rejection body. `titles` maps node id -> title
 * (extractNodeTitles) so sentences can name the node as the user sees it.
 * Returns null when `body` is not a ComfyUI error body.
 */
export function parseComfyPromptError(
  body: unknown,
  titles?: Record<string, string>,
): RunFailure | null {
  if (!isRecord(body)) return null;
  const error = isRecord(body.error)
    ? (body.error as ComfyReason & Record<string, unknown>)
    : null;
  const nodeErrors = isRecord(body.node_errors) ? body.node_errors : null;
  if (!error && !nodeErrors) return null;

  const type = error?.type;
  const topMsg = str(error?.message) ?? "";
  const topDetail = [topMsg, str(error?.details)].filter(Boolean).join(" ");

  // Unknown class_type: whole prompt rejected before node validation.
  if (type === "missing_node_type") {
    const cls =
      str(error?.extra_info?.class_type) ??
      /Node '([^']+)' not found/.exec(topMsg)?.[1];
    return missingNodeFailure(cls, topDetail);
  }
  if (type === "invalid_prompt") {
    const cls = /node (\S+) does not exist/i.exec(topMsg)?.[1];
    if (cls) return missingNodeFailure(cls, topDetail);
    return invalidFailure(topMsg || "The workflow is malformed.", topDetail);
  }

  if (nodeErrors && Object.keys(nodeErrors).length > 0) {
    const detail = nodeErrorDetail(nodeErrors);
    // Most actionable first: missing model > missing input file > the rest.
    let firstGeneric: string | null = null;
    let missingFile: { value?: string } | null = null;
    for (const [id, raw] of Object.entries(nodeErrors)) {
      if (!isRecord(raw)) continue;
      const cls = str(raw.class_type);
      const where = nodeLabel(titles?.[id], cls);
      const errs = Array.isArray(raw.errors)
        ? (raw.errors as ComfyReason[])
        : [];
      for (const reason of errs) {
        const input = inputName(reason);
        const value = receivedValue(reason);
        if (
          reason.type === "value_not_in_list" &&
          looksLikeModelInput(input, value)
        ) {
          return missingModelFailure(value, where, detail);
        }
        const custom = `${reason.details ?? ""} ${reason.message ?? ""}`;
        if (
          !missingFile &&
          (reason.type === "value_not_in_list" ||
            reason.type === "custom_validation_failed") &&
          (/Invalid (image|video|audio) file/i.test(custom) ||
            (value && IMAGE_EXT_RE.test(value)))
        ) {
          missingFile = {
            value:
              value ??
              /Invalid \w+ file: (.+)$/i
                .exec((reason.details ?? "").trim())?.[1]
                ?.trim(),
          };
          continue;
        }
        if (!firstGeneric) {
          const msg = reason.message ?? reason.type ?? "invalid value";
          const field = input ? ` input ${quote(input)}` : "";
          firstGeneric = `${where}${field}: ${msg}${reason.details && !input ? ` (${reason.details})` : ""}.`;
        }
      }
    }
    if (missingFile) return missingInputFailure(missingFile.value, detail);
    return invalidFailure(
      firstGeneric ?? (topMsg ? `${topMsg}.` : "A node failed validation."),
      detail,
    );
  }

  if (type === "prompt_no_outputs") {
    return invalidFailure(
      "The workflow has no output node (Save Image, Preview, ...), so ComfyUI has nothing to run.",
      topDetail,
    );
  }
  return invalidFailure(
    topMsg ? `${topMsg}.` : "ComfyUI rejected the workflow.",
    topDetail,
  );
}

// Adrift pre-submit validation (422 details.problems)

function isProblem(v: unknown): v is PromptProblem {
  return (
    isRecord(v) && typeof v.kind === "string" && typeof v.message === "string"
  );
}

export function failureFromProblems(problems: unknown): RunFailure | null {
  if (!Array.isArray(problems)) return null;
  const list = problems.filter(isProblem);
  if (list.length === 0) return null;
  const detail = list
    .map(
      (p) =>
        `${p.nodeTitle} (#${p.nodeId})${p.input ? ` / ${p.input}` : ""}: ${p.message}`,
    )
    .join("\n");
  const node = list.find((p) => p.kind === "unknown_class_type");
  if (node) return missingNodeFailure(node.classType ?? undefined, detail);
  for (const p of list) {
    if (p.kind !== "invalid_combo_value") continue;
    // validatePrompt: `Value "x.safetensors" is not an available option ...`
    const value =
      /^Value "([^"]+)"/.exec(p.message)?.[1] ??
      /'([^']+)'/.exec(p.message)?.[1];
    if (looksLikeModelInput(p.input, value)) {
      return missingModelFailure(
        value,
        nodeLabel(p.nodeTitle, p.classType ?? undefined),
        detail,
      );
    }
  }
  const p = list[0];
  return invalidFailure(
    `${nodeLabel(p.nodeTitle, p.classType ?? undefined)}${p.input ? ` input ${quote(p.input)}` : ""}: ${p.message}`,
    detail,
  );
}

// Execution failures (WS execution_error / job.error)

export interface ExecutionErrorLike {
  node_id?: string | number;
  node_type?: string;
  exception_message?: string;
  exception_type?: string;
}

/** WS execution_error payload -> failure. */
export function failureFromExecutionError(
  data: ExecutionErrorLike,
  titles?: Record<string, string>,
): RunFailure {
  const id = data.node_id === undefined ? undefined : String(data.node_id);
  const where = nodeLabel(id ? titles?.[id] : undefined, data.node_type);
  const msg = data.exception_message?.trim() ?? "";
  const type = data.exception_type ?? "";
  const detail = [msg, type && `[${type}]`].filter(Boolean).join(" ");
  const both = `${msg} ${type}`;
  if (OOM_RE.test(both)) return oomFailure(where, detail);
  if (INTERRUPT_RE.test(both)) return interruptedFailure(detail);
  if (MISSING_FILE_RE.test(both)) {
    const file =
      /['"]([^'"]+\.(?:safetensors|sft|ckpt|pt|pth|bin|gguf|onnx))['"]/i.exec(
        msg,
      )?.[1];
    return missingModelFailure(file, where, detail);
  }
  return unknownFailure(
    `${where} failed: ${msg || "unknown error"}.`,
    detail || undefined,
  );
}

/** A finished job's error string (e.g. "Main Sampler (#4) failed: ..."). */
export function classifyJobError(
  message: string | null | undefined,
): RunFailure {
  const text = (message ?? "").trim();
  if (!text) return unknownFailure("The run failed without an error message.");
  if (OOM_RE.test(text)) {
    const where = /^(.+?) \(#[^)]+\) failed:/.exec(text)?.[1];
    return oomFailure(where, text);
  }
  if (INTERRUPT_RE.test(text)) return interruptedFailure(text);
  if (TIMEOUT_RE.test(text)) return timeoutFailure(text);
  if (UNREACHABLE_RE.test(text)) return unreachableFailure(text);
  if (MISSING_FILE_RE.test(text)) {
    const file =
      /['"]([^'"]+\.(?:safetensors|sft|ckpt|pt|pth|bin|gguf|onnx))['"]/i.exec(
        text,
      )?.[1];
    return missingModelFailure(file, undefined, text);
  }
  return unknownFailure(text);
}

// API envelope (what ToolRunner catches)

export interface RunErrorInput {
  message?: string;
  /** HTTP status of the Adrift API response; 0 = no response at all. */
  status?: number;
  /** details.code from the API envelope. */
  code?: string;
  /** details from the API envelope. */
  details?: unknown;
}

/** Classify an error thrown while submitting a run. */
export function classifyRunError(input: RunErrorInput): RunFailure {
  const message = (input.message ?? "").trim();
  const details = isRecord(input.details) ? input.details : null;
  const code = input.code ?? str(details?.code);

  if (details) {
    const fromComfy = parseComfyPromptError(details.comfy);
    if (fromComfy) return fromComfy;
    const fromProblems = failureFromProblems(details.problems);
    if (fromProblems) return fromProblems;
  }

  switch (code) {
    case "comfy_unreachable":
      return unreachableFailure(message);
    case "comfy_timeout":
      return timeoutFailure(message);
    case "nodes_missing": {
      const cls = /not installed: ([^(]+?)(?: \(|$)/
        .exec(message)?.[1]
        ?.split(",")[0]
        ?.trim();
      return {
        ...missingNodeFailure(cls, message),
        message: `${message}. Open "Set up this tool", install it and restart ComfyUI.`,
      };
    }
    case "lora_missing":
    case "pack_unavailable":
      return missingModelFailure(
        /not installed: ([^,]+)/.exec(message)?.[1]?.trim(),
        undefined,
        message,
      );
  }

  if (BROWSER_NET_RE.test(message) && !input.status)
    return appUnreachableFailure(message);
  if (UNREACHABLE_RE.test(message)) return unreachableFailure(message);
  if (input.status === 504 || TIMEOUT_RE.test(message))
    return timeoutFailure(message);
  if (OOM_RE.test(message)) return oomFailure(undefined, message);
  if (INTERRUPT_RE.test(message)) return interruptedFailure(message);
  return unknownFailure(message);
}

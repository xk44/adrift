/**
 * Builds ComfyUI `extra_data` so SaveImage PNGs embed a re-openable
 * "workflow" (UI graph, when we have one) and an Adrift "cj" chunk.
 * ComfyUI writes the API "prompt" chunk itself.
 */

const SECRET_KEY_RE = /(key|token|secret|password|passwd|auth|cookie|bearer)/i;
const MAX_STR = 4000;

export function sanitizeCjParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (SECRET_KEY_RE.test(k) || v === undefined || typeof v === "function") {
      continue;
    }
    if (typeof v === "string") {
      if (v.startsWith("data:") || v.length > MAX_STR) continue;
      out[k] = v;
    } else if (v === null || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (Array.isArray(v)) {
      const items = v.filter(
        (x) =>
          (typeof x === "string" && !x.startsWith("data:") && x.length <= MAX_STR) ||
          typeof x === "number" ||
          typeof x === "boolean",
      );
      out[k] = items;
    } else if (typeof v === "object") {
      out[k] = sanitizeCjParams(v as Record<string, unknown>);
    }
  }
  return out;
}

/** UI-format graphs have a `nodes` array; API graphs are id -> {class_type}. */
export function isUiWorkflow(w: unknown): w is Record<string, unknown> {
  return (
    !!w &&
    typeof w === "object" &&
    Array.isArray((w as { nodes?: unknown }).nodes)
  );
}

export function buildExtraData(opts: {
  params: Record<string, unknown>;
  uiWorkflow?: unknown;
}): { extra_pnginfo: Record<string, unknown> } {
  const extra_pnginfo: Record<string, unknown> = {};
  if (isUiWorkflow(opts.uiWorkflow)) extra_pnginfo.workflow = opts.uiWorkflow;
  extra_pnginfo.cj = { v: 1, params: sanitizeCjParams(opts.params) };
  return { extra_pnginfo };
}

/**
 * Pick the best downloadable graph from a ComfyUI history entry.
 * prompt tuple = [number, prompt_id, apiPrompt, extra_data, outputs].
 */
export function workflowFromHistory(entry: {
  prompt?: unknown;
}): { kind: "ui" | "api"; workflow: unknown } | null {
  const p = entry.prompt;
  if (!Array.isArray(p)) return null;
  const extra = p[3] as { extra_pnginfo?: { workflow?: unknown } } | undefined;
  const ui = extra?.extra_pnginfo?.workflow;
  if (isUiWorkflow(ui)) return { kind: "ui", workflow: ui };
  const api = p[2];
  if (api && typeof api === "object") return { kind: "api", workflow: api };
  return null;
}

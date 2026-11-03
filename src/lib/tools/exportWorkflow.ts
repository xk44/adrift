/**
 * "Send to graph" for any tool: run a tool's normal submit function against
 * a fetch wrapper that turns its job POST (/api/jobs/action or
 * /api/jobs/tool) into a dry run, captures the built API workflow and stops
 * there. Uploads and seed runs (no GPU) pass through untouched; nothing is
 * queued. Any other job endpoint (imagine, inpaint, ...) has no dry run, so
 * it is refused before it is sent.
 *
 *   const { workflow } = await captureToolWorkflow(fetch, (f) =>
 *     submitActionTool({ ...args, fetchImpl: f }),
 *   );
 */

import { ToolApiError, type ApiWorkflowJson, type FetchLike } from "./runTool";

/** Job endpoints that accept `dry_run: true`. */
export const DRY_RUN_JOB_ENDPOINTS: ReadonlySet<string> = new Set([
  "/api/jobs/action",
  "/api/jobs/tool",
]);

/** Job-side endpoints that queue nothing (safe to forward during capture). */
const PASSTHROUGH_JOB_ENDPOINTS: ReadonlySet<string> = new Set([
  "/api/jobs/seed-run",
]);

export interface CapturedToolWorkflow {
  workflow: ApiWorkflowJson;
  /** Endpoint that built it. */
  endpoint: string;
  /** Action id (action route) or tool id (tool route). */
  id?: string;
  seed?: number;
  /** "video" when the action routes to the video host. */
  backend?: string;
  /** The (dry-run) body the tool sent, for debugging / re-run. */
  body: Record<string, unknown>;
}

/** Thrown inside the wrapper to stop the submit function after capture. */
class WorkflowCaptured extends Error {
  constructor(readonly result: CapturedToolWorkflow) {
    super("workflow captured");
    this.name = "WorkflowCaptured";
  }
}

function pathOf(input: string): string {
  const q = input.search(/[?#]/);
  const p = q >= 0 ? input.slice(0, q) : input;
  // Absolute URLs (tests, other origins): keep only the path.
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i.exec(p);
  return m ? (m[1] ?? "/") : p;
}

/** True when `wf` looks like an API-format prompt graph. */
export function isApiWorkflowJson(wf: unknown): wf is ApiWorkflowJson {
  if (!wf || typeof wf !== "object" || Array.isArray(wf)) return false;
  const nodes = Object.values(wf as Record<string, unknown>);
  return (
    nodes.length > 0 &&
    nodes.every(
      (n) =>
        !!n &&
        typeof n === "object" &&
        typeof (n as { class_type?: unknown }).class_type === "string",
    )
  );
}

/**
 * Wrap `fetchImpl` so the first dry-runnable job POST is sent with
 * `dry_run: true` and its workflow captured (the submit call is then
 * aborted). Server errors flow back to the submit function unchanged so
 * its own messages surface.
 */
export function dryRunFetch(fetchImpl: FetchLike): FetchLike {
  return async (input, init) => {
    const path = pathOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "POST" || !path.startsWith("/api/jobs/")) {
      return fetchImpl(input, init);
    }
    if (PASSTHROUGH_JOB_ENDPOINTS.has(path)) return fetchImpl(input, init);
    if (!DRY_RUN_JOB_ENDPOINTS.has(path)) {
      throw new ToolApiError(
        `This tool runs through ${path}, which can't be sent to the graph yet.`,
      );
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    } catch {
      throw new ToolApiError("Tool request body is not JSON.");
    }
    const dryBody = { ...body, dry_run: true };
    const res = await fetchImpl(input, {
      ...init,
      body: JSON.stringify(dryBody),
    });
    if (!res.ok) return res;
    let data: Record<string, unknown> = {};
    try {
      data = ((await res.json()) ?? {}) as Record<string, unknown>;
    } catch {
      /* fall through: no workflow */
    }
    if (data.ok === false) {
      // Hand the error envelope back to the submit function's readJson.
      return { ok: false, status: res.status, json: async () => data };
    }
    if (!isApiWorkflowJson(data.workflow)) {
      throw new ToolApiError(
        data.run
          ? "Server queued the job instead of a dry run (update the server)."
          : "Server returned no workflow.",
      );
    }
    const id =
      typeof data.action === "string"
        ? data.action
        : typeof data.tool_id === "string"
          ? data.tool_id
          : undefined;
    throw new WorkflowCaptured({
      workflow: data.workflow,
      endpoint: path,
      ...(id ? { id } : {}),
      ...(typeof data.seed === "number" ? { seed: data.seed } : {}),
      ...(typeof data.comfy_backend === "string"
        ? { backend: data.comfy_backend }
        : {}),
      body: dryBody,
    });
  };
}

/**
 * Run `submit` (any submit*Tool / submitEngineEdit call) with a dry-run
 * fetch and return the API workflow its job request would have queued.
 * Input validation errors from the submit function propagate as-is.
 */
export async function captureToolWorkflow(
  fetchImpl: FetchLike,
  submit: (fetchImpl: FetchLike) => Promise<unknown>,
): Promise<CapturedToolWorkflow> {
  try {
    await submit(dryRunFetch(fetchImpl));
  } catch (e) {
    if (e instanceof WorkflowCaptured) return e.result;
    throw e;
  }
  throw new ToolApiError("This tool doesn't build a ComfyUI workflow.");
}

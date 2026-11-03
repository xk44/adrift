/**
 * GET /api/jobs/workflow?prompt_id=... | ?run_id=...&job_index=...
 * Returns the finished job's graph as a downloadable JSON file: the UI-format
 * workflow if one was embedded at queue time, else the API prompt from history.
 */
import { NextRequest, NextResponse } from "next/server";
import { apiError, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { validateIdentifier } from "@/lib/validate";
import { fetchHistory } from "@/lib/comfy/http";
import { fetchHistoryAnyBackend } from "@/lib/comfy/warmBackend";
import { workflowFromHistory } from "@/lib/comfy/pnginfo";
import { getDB } from "@/lib/db";

export function OPTIONS() {
  return apiOptions();
}

export async function GET(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;

  const sp = new URL(req.url).searchParams;
  let promptId = sp.get("prompt_id");
  if (!promptId) {
    const runId = sp.get("run_id");
    const idx = Number(sp.get("job_index") ?? "0");
    if (!runId || !Number.isInteger(idx) || idx < 0) {
      return apiError("Missing prompt_id or run_id", { status: 400 });
    }
    try {
      const row = getDB()
        .prepare("SELECT prompt_id_comfy FROM jobs WHERE id = ?")
        .get(`${runId}:${idx}`) as { prompt_id_comfy: string | null } | undefined;
      promptId = row?.prompt_id_comfy ?? null;
    } catch {
      return apiError("Job lookup failed", { status: 500 });
    }
    if (!promptId) return apiError("Job not found", { status: 404 });
  }
  const id = validateIdentifier(promptId, "prompt_id", 200);
  if (!id.ok) return apiError(id.error, { status: 400 });

  try {
    const entry = await fetchHistoryAnyBackend(fetchHistory, id.text);
    const found = entry ? workflowFromHistory(entry) : null;
    if (!found) return apiError("No workflow in history", { status: 404 });
    return new NextResponse(JSON.stringify(found.workflow, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="workflow-${id.text.slice(0, 8)}-${found.kind}.json"`,
      },
    });
  } catch {
    return apiError("ComfyUI unreachable", { status: 503 });
  }
}

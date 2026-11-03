/**
 * POST /api/user-tools/:id/run
 * Body: { values?: { [paramKey]: string|number }, media?: { [paramKey]: ref },
 *         client_id? }
 *   ref = "name.png [input]" (from /api/comfy/upload) | { run_id, job_index }
 * Reply: { run } — same envelope as /api/jobs/tool.
 */
import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  apiCorsHeaders,
  apiErr,
  apiError,
  apiLog,
  apiOk,
  apiOptions,
} from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { addActiveRun, getActiveRun } from "@/lib/comfy/runs";
import {
  ComfyAPIError,
  comfyErrorDetails,
  queuePrompt,
} from "@/lib/comfy/http";
import { comfyImageRefFromViewUrl } from "@/lib/oj/engine";
import { insertJob, insertPrompt, insertRun } from "@/lib/db";
import type { ImagineRun } from "@/types";
import { PromptValidationError } from "@/lib/comfy/validatePrompt";
import { buildExtraData } from "@/lib/comfy/pnginfo";
import { getUserTool } from "@/lib/userTools/store";
import { applyUserToolParams, promptLine } from "@/lib/userTools/build";
import { resolveMedia } from "@/lib/userTools/service";
import { userToolKey } from "@/lib/userTools/types";
import {
  readJsonObject,
  userToolErrorResponse,
} from "@/lib/userTools/http";

const MAX_BYTES = 2 * 1024 * 1024;

type Ctx = { params: Promise<{ id: string }> };

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

function runImageRef(runId: string, jobIndex: number): string | null {
  const job = getActiveRun(runId)?.jobs[jobIndex];
  return comfyImageRefFromViewUrl(job?.images?.[0]);
}

function numberOf(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export async function POST(
  request: NextRequest,
  { params }: Ctx,
): Promise<NextResponse> {
  const requestId = uuidv4();
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(request, { windowMs: 60_000, max: 30 });
  if (!rl.ok) return rl.response;
  const len = parseInt(request.headers.get("content-length") || "0", 10);
  if (len > MAX_BYTES) {
    return apiError("Payload too large", { status: 413, requestId });
  }
  const { id } = await params;
  const body = await readJsonObject(request);
  if (!body) return apiError("Invalid JSON body", { status: 400, requestId });

  try {
    const tool = await getUserTool(id);
    if (!tool) {
      return apiError("That tool was not found", {
        status: 404,
        requestId,
        headers: apiCorsHeaders(),
      });
    }
    const values =
      body.values && typeof body.values === "object" && !Array.isArray(body.values)
        ? (body.values as Record<string, unknown>)
        : {};
    const media = resolveMedia(body.media, runImageRef);
    const { workflow, used } = applyUserToolParams(tool, { values, media });
    const clientId =
      typeof body.client_id === "string" && body.client_id.trim()
        ? body.client_id.trim().slice(0, 200)
        : `user-tool-${requestId}`;

    const key = userToolKey(tool.id);
    const seedParam = tool.params.find((p) => p.kind === "seed");
    const seed = numberOf(seedParam ? used[seedParam.key] : undefined) ?? 0;
    const widthParam = tool.params.find((p) => p.kind === "width");
    const heightParam = tool.params.find((p) => p.kind === "height");
    const width =
      numberOf(widthParam ? used[widthParam.key] : undefined) ??
      numberOf(widthParam?.default) ??
      1024;
    const height =
      numberOf(heightParam ? used[heightParam.key] : undefined) ??
      numberOf(heightParam?.default) ??
      1024;
    const prompt = promptLine(tool, used);
    const action = `tool_${key}`;
    const runParams: ImagineRun["params"] = {
      tool_id: key,
      action_provenance: { kind: "tool", id: key, label: tool.name },
      user_tool_values: used,
      seed,
    };

    const result = await queuePrompt(workflow, clientId, undefined, {
      extraData: buildExtraData({
        params: { ...runParams, action, fullPrompt: prompt },
      }),
    });

    const run: ImagineRun = {
      run_id: uuidv4(),
      prompt,
      parsedPrompt: prompt,
      params: runParams,
      width,
      height,
      action,
      createdAt: new Date().toISOString(),
      status: "queued",
      jobs: [
        {
          seed,
          index: 0,
          status: "queued",
          progress: 0,
          images: [],
          prompt_id: result.prompt_id,
        },
      ],
    };

    try {
      insertPrompt(requestId, run.prompt, JSON.stringify(run.params), key);
      insertRun(run.run_id, requestId, Object.keys(workflow).length, {
        parsedPrompt: run.parsedPrompt,
        params: run.params,
        width: run.width,
        height: run.height,
      });
      insertJob(`${run.run_id}:0`, run.run_id, seed, result.prompt_id);
    } catch (dbErr) {
      console.warn(`[UserTool ${requestId}] DB persistence failed:`, dbErr);
    }

    addActiveRun(run);
    apiLog("UserTools", "Queued user tool", { tool: key, requestId });
    return apiOk(
      { run },
      {
        requestId,
        headers: apiCorsHeaders(),
        warnings: result.warnings?.length
          ? { nodes: result.warnings }
          : undefined,
      },
    );
  } catch (error) {
    if (error instanceof PromptValidationError) {
      return apiError(error.message, {
        status: 422,
        requestId,
        details: { problems: error.problems },
        headers: apiCorsHeaders(),
      });
    }
    if (error instanceof ComfyAPIError) {
      apiErr("UserTools", "Failed user tool job", {
        requestId,
        error: error.message,
      });
      return apiError(error.message, {
        status: 502,
        requestId,
        details: comfyErrorDetails(error),
        headers: apiCorsHeaders(),
      });
    }
    return userToolErrorResponse(error, requestId, "run");
  }
}

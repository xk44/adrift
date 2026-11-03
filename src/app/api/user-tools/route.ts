/**
 * GET  /api/user-tools  -> { tools: UserToolSummary[] }
 * POST /api/user-tools  -> { tool: UserToolSummary }   (save a reviewed import)
 *   Optional body.modelOverrides: [{ nodeId, input, value }] swaps missing
 *   model files for installed ones; each value must be a live object_info
 *   option of that node input.
 *
 * Tools imported from Civitai or a workflow file (data/user_tools.json).
 * Admin-gated like other mutating routes; CSRF is enforced by middleware.
 */
import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { apiCorsHeaders, apiError, apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import {
  createUserTool,
  listUserTools,
  summarizeUserTool,
} from "@/lib/userTools/store";
import {
  readJsonObject,
  userToolErrorResponse,
} from "@/lib/userTools/http";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import {
  applyModelOverrides,
  relabelOverriddenLoraParams,
} from "@/lib/userTools/modelOverrides";

const MAX_BYTES = 8 * 1024 * 1024;

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = uuidv4();
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(request, { windowMs: 60_000, max: 120 });
  if (!rl.ok) return rl.response;
  try {
    const tools = (await listUserTools()).map(summarizeUserTool);
    return apiOk({ tools }, { requestId, headers: apiCorsHeaders() });
  } catch (e) {
    return userToolErrorResponse(e, requestId, "list");
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = uuidv4();
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(request, { windowMs: 60_000, max: 20 });
  if (!rl.ok) return rl.response;
  const len = parseInt(request.headers.get("content-length") || "0", 10);
  if (len > MAX_BYTES) {
    return apiError("That workflow is too large to save", {
      status: 413,
      requestId,
    });
  }
  const body = await readJsonObject(request);
  if (!body) return apiError("Invalid JSON body", { status: 400, requestId });
  try {
    // Model picks from the review screen: checked against the live
    // object_info, then written into the graph (no run-time indirection).
    let workflow = body.workflow;
    let params = body.params;
    const overrides = body.modelOverrides;
    if (overrides !== undefined && overrides !== null) {
      if (Array.isArray(overrides) && overrides.length > 0) {
        const oi = await getObjectInfoCached();
        if (!oi) {
          return apiError(
            "ComfyUI is not reachable, so the model picks can't be checked. Try again, or keep the missing models as they are.",
            { status: 503, requestId, headers: apiCorsHeaders() },
          );
        }
        const rewritten = applyModelOverrides(workflow, overrides, oi);
        params = relabelOverriddenLoraParams(params, workflow, rewritten);
        workflow = rewritten;
      } else if (!Array.isArray(overrides)) {
        return apiError("modelOverrides must be a list", {
          status: 400,
          requestId,
          headers: apiCorsHeaders(),
        });
      }
    }
    const tool = await createUserTool({
      name: body.name,
      icon: body.icon,
      category: body.category,
      description: body.description,
      workflowType: body.workflowType,
      output: body.output,
      workflow,
      params,
      source: body.source,
    });
    return apiOk(
      { tool: summarizeUserTool(tool) },
      { status: 201, requestId, headers: apiCorsHeaders() },
    );
  } catch (e) {
    return userToolErrorResponse(e, requestId, "create");
  }
}

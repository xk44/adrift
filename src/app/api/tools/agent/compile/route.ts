/**
 * POST /api/tools/agent/compile
 * Turns agent inputs for an action tool into the /api/jobs/action fields the
 * Tools page would send (buildActionRequest), so agents never hand-build
 * params. Body: { toolId, text?, second_text?, options?, edit_lora?,
 * edit_family?, second_ref?, extra_refs?, audio_ref?, audio_seconds? }
 *   → { ok, action, params, overrides, tool_page_id, source }
 * Catalog tools need no compile step: POST /api/jobs/tool takes them as-is.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { ToolInputError, type EditLoraListResponse } from "@/lib/tools/toolsPage";
import {
  AgentInputError,
  compileAgentAction,
  resolveAgentToolId,
  type AgentActionInput,
} from "@/lib/mcp/agentTools";
import { GET as getEditLoras } from "../../../krea2-edit-loras/route";

export async function POST(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  let body: (AgentActionInput & { toolId?: unknown }) | null;
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON body", { status: 400, details: { code: "BAD_JSON" } });
  }
  if (!body || typeof body !== "object")
    return apiError("Body must be an object", { status: 400, details: { code: "BAD_JSON" } });
  const resolved = resolveAgentToolId(body.toolId);
  if (!resolved)
    return apiError(`Unknown tool: ${String(body.toolId)}`, { status: 404, details: { code: "UNKNOWN_TOOL" } });
  if (resolved.kind !== "action")
    return apiError("Catalog tools are submitted to /api/jobs/tool directly", { status: 400, details: { code: "NOT_AN_ACTION_TOOL" } });
  let editLoras: EditLoraListResponse | null = null;
  if (resolved.spec.usesEditLora) {
    const res = await getEditLoras(req).catch(() => null);
    editLoras = res?.ok
      ? ((await res.json().catch(() => null)) as EditLoraListResponse | null)
      : null;
  }
  try {
    return NextResponse.json({
      ok: true,
      ...compileAgentAction(resolved.spec, body, editLoras),
    });
  } catch (e) {
    if (e instanceof AgentInputError || e instanceof ToolInputError)
      return apiError(e.message, { status: 400, details: { code: "BAD_INPUT" } });
    throw e;
  }
}

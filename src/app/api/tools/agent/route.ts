/**
 * GET /api/tools/agent
 * Every runnable Tools-page tool for agents (MCP, scripts/adrift-mcp.mjs):
 * id ("action:<id>" | "catalog:<id>"), name, category, inputs, VRAM and
 * commercial-license badges, a JSON Schema for its inputs generated from the
 * registries, and live availability. See docs/MCP.md.
 *   → { ok, tools: AgentTool[] }
 */
import { existsSync, readFileSync } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/auth";
import { apiCorsHeaders } from "@/lib/api";
import { getAllPacks, getPack } from "@/lib/oj/packs";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import {
  computeAvailability,
  getEditTool,
  installedLorasFor,
} from "@/lib/tools/editTools";
import {
  actionAvailability,
  getActionTool,
  type EditLoraListResponse,
  type ModelStatusResponse,
} from "@/lib/tools/toolsPage";
import { buildToolDocRows, type ToolDocRow } from "@/lib/tools/toolsDoc";
import { buildAgentTools, type AgentTool } from "@/lib/mcp/agentTools";
import type { Workflow } from "@/types";
import { GET as getModelStatus } from "../model-status/route";
import { GET as getEditLoras } from "../../krea2-edit-loras/route";

const CORS_HEADERS = apiCorsHeaders(null, "GET, OPTIONS");

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

let docRows: ToolDocRow[] | null = null;

function toolDocRows(): ToolDocRow[] {
  if (docRows) return docRows;
  const dir = path.join(process.cwd(), "public", "workflows");
  try {
    docRows = buildToolDocRows((rel) => {
      const p = path.join(dir, rel);
      if (!p.startsWith(dir + path.sep) || !existsSync(p)) return null;
      return JSON.parse(readFileSync(p, "utf8")) as Workflow;
    }).rows;
  } catch {
    docRows = [];
  }
  return docRows;
}

async function jsonOf<T>(res: Response): Promise<T | null> {
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as T | null;
}

export async function GET(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;

  const tools: AgentTool[] = buildAgentTools(toolDocRows());
  const objectInfo = await getObjectInfoCached().catch(() => null);
  const [installed, modelStatus, editLoras] = await Promise.all([
    installedLorasFor(env.COMFY_ROOT, objectInfo),
    getModelStatus(req)
      .then((r) => jsonOf<ModelStatusResponse>(r))
      .catch(() => null),
    getEditLoras(req)
      .then((r) => jsonOf<EditLoraListResponse>(r))
      .catch(() => null),
  ]);
  const packIds = new Set(getAllPacks().map((p) => p.id));
  const status: ModelStatusResponse =
    modelStatus ?? ({ tools: {}, failed: true } as ModelStatusResponse);

  await Promise.all(
    tools.map(async (t) => {
      const bare = t.id.slice(t.id.indexOf(":") + 1);
      if (t.kind === "action") {
        const spec = getActionTool(bare);
        if (!spec) return;
        const a = actionAvailability(spec, packIds, editLoras, status);
        t.available = a.available;
        t.unavailableReason = a.available ? null : a.reason;
        return;
      }
      const tool = getEditTool(bare);
      if (!tool) return;
      const a = await computeAvailability(
        tool,
        env.COMFY_ROOT,
        installed,
        getPack(tool.pack)?.workflows,
        objectInfo,
      );
      t.available = a.installed && a.packAvailable;
      t.unavailableReason = t.available
        ? null
        : !a.packAvailable
          ? a.missingNodes?.length
            ? `Needs custom nodes: ${a.missingNodes.join(", ")}`
            : a.missingModels?.length
              ? `Model not installed: ${a.missingModels.join(", ")}`
              : "Base workflow or weights not installed."
          : "Tool LoRA not installed.";
    }),
  );
  return NextResponse.json({ ok: true, tools }, { headers: CORS_HEADERS });
}

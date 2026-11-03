/**
 * GET /api/oj/packs
 *   → { packs: PackCardSummary[] }  every registered workflow pack.
 *
 * GET /api/oj/packs?pack=<id>&kind=<kind>
 *   → the analysis the web PackBrowser computes in the browser: workflow
 *     stats, capabilities, defaults, editable controls (with their option
 *     lists already resolved against ComfyUI's live inventory), required
 *     models with availability, and custom-node requirements.
 *
 * Native clients can't run the TypeScript control-schema builder, so this
 * route runs it server-side. Overrides chosen in a client are sent back as
 * `workflow_control_overrides` (`${nodeId}.${inputKey}` → value) on
 * imagine/action requests, exactly like the web panel.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { apiError, apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import type { Workflow } from "@/types";
import { getPack } from "@/lib/oj/packs";
import {
  discoverDynamicControls,
  extractCustomNodeRequirements,
  extractRequirementsFromWorkflow,
  getAllPackCardSummaries,
  getKindLabel,
  validateRequirements,
} from "@/lib/oj/packBrowser";
import {
  deriveControlSubtype,
  enrichEnumOptions,
  filterBySubtypeExtensions,
  getFileOptionsForControl,
  getImageOptionsForControl,
  getModelOptionsForControl,
  type ControlSchema,
  type LocalInventory,
} from "@/lib/oj/workflowControlSchema";
import type { ObjectInfoResponse } from "@/lib/oj/localInventory";
import {
  buildModelInventory,
  type ModelInventoryPayload,
} from "@/lib/comfy/modelInventory";

/** Same set the web panel edits (getEditableControls). */
const EDITABLE_KINDS = new Set([
  "number",
  "seed",
  "string",
  "enum",
  "boolean",
  "model",
  "image",
  "file",
]);

const WORKFLOWS_DIR = path.join(process.cwd(), "public", "workflows");

export function OPTIONS(): NextResponse {
  return apiOptions();
}

async function readPackWorkflow(
  packId: string,
  file: string,
): Promise<Workflow | null> {
  // Same lookup order as PackBrowser: packs/<id>/<file>, then <file>.
  const candidates = [
    path.join(WORKFLOWS_DIR, "packs", packId, file),
    path.join(WORKFLOWS_DIR, file),
  ];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(WORKFLOWS_DIR + path.sep)) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(resolved, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Workflow;
      }
    } catch {
      // try the next location
    }
  }
  return null;
}

async function fetchInventory(): Promise<ModelInventoryPayload | null> {
  try {
    const response = await comfyFetch("/object_info", {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    return buildModelInventory((await response.json()) as ObjectInfoResponse);
  } catch {
    return null;
  }
}

function choicesFor(
  control: ControlSchema,
  inventory: ModelInventoryPayload | null,
): string[] | null {
  const local = (inventory ?? {}) as LocalInventory;
  switch (control.kind) {
    case "enum":
      return enrichEnumOptions(control, local);
    case "model":
      return inventory ? getModelOptionsForControl(control, local) : null;
    case "image":
      return inventory
        ? filterBySubtypeExtensions(
            getImageOptionsForControl(control, local),
            deriveControlSubtype(control),
          )
        : null;
    case "file":
      return inventory
        ? filterBySubtypeExtensions(
            getFileOptionsForControl(control, local),
            deriveControlSubtype(control),
          )
        : null;
    default:
      return null;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;

  const { searchParams } = new URL(request.url);
  const packId = searchParams.get("pack");
  const kind = searchParams.get("kind");

  if (!packId) {
    const packs = getAllPackCardSummaries().map((summary) => ({
      ...summary,
      selectionPrefix: `pack::${summary.id}::`,
    }));
    return apiOk({ packs });
  }

  const pack = getPack(packId);
  if (!pack) return apiError(`Unknown pack: ${packId}`, { status: 404 });
  if (!kind) return apiError("Missing kind", { status: 400 });

  const file = pack.workflows[kind as keyof typeof pack.workflows] as
    string | undefined;
  if (!file) {
    return apiError(`Pack ${packId} has no ${kind} workflow`, { status: 404 });
  }

  const workflow = await readPackWorkflow(packId, file);
  if (!workflow) {
    return apiError(`Workflow file not found: ${file}`, { status: 404 });
  }

  const inventory = await fetchInventory();
  const dynamic = discoverDynamicControls(workflow);
  const controls = dynamic.controlSchema
    .filter((c) => c.visible && EDITABLE_KINDS.has(c.kind))
    .sort((a, b) => a.order - b.order)
    .map((c) => ({
      ...c,
      subtype:
        c.kind === "image" || c.kind === "file"
          ? deriveControlSubtype(c)
          : undefined,
      choices: choicesFor(c, inventory),
    }));

  // Web passes only checkpoints/loras/vaes here (PackBrowser modelFiles).
  // Loaders with an empty filename (generic templates the server backfills
  // with the default checkpoint) are not a real requirement.
  const requirements = validateRequirements(
    extractRequirementsFromWorkflow(workflow).filter((r) => r.name.trim()),
    inventory
      ? {
          checkpoints: inventory.checkpoints,
          loras: inventory.loras,
          vaes: inventory.vaes,
        }
      : null,
  );

  return apiOk({
    pack: pack.id,
    kind,
    kindLabel: getKindLabel(kind),
    file,
    selectionKey: `pack::${pack.id}::${kind}`,
    inventoryAvailable: inventory !== null,
    workflowType: dynamic.workflowType,
    samplerClass: dynamic.samplerClass,
    nodeCount: dynamic.nodeCount,
    nodeTypeCount: dynamic.nodeTypeCount,
    capabilities: dynamic.capabilities,
    defaults: dynamic.defaults,
    controls,
    requirements,
    customNodes: extractCustomNodeRequirements(workflow),
  });
}

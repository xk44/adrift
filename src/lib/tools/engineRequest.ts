/**
 * Pure request builder for hub templates / apps: compiled prompt + edit
 * engine → the catalog body settings or the /api/jobs/action payload.
 * Throws ToolInputError for anything the server would reject.
 */

import {
  GROUNDED_FAMILY,
  ToolInputError,
  defaultSettings,
  editLorasIn,
  type CatalogTool,
  type ToolSettings,
} from "./toolsPage";
import type { EditEngine, EngineContext } from "./templates";

export type EngineRequest =
  | { kind: "catalog"; tool: CatalogTool; settings: ToolSettings }
  | {
      kind: "action";
      action: string;
      params: Record<string, unknown>;
      overrides: Record<string, string | number>;
    };

export function buildEngineRequest(
  engine: EditEngine,
  prompt: string,
  ctx: EngineContext,
  opts: { secondRef?: string; editMode?: string } = {},
): EngineRequest {
  const text = prompt.trim();
  if (engine.promptStyle !== "none" && !text)
    throw new ToolInputError("The prompt is empty.");

  if (engine.run.kind === "catalog") {
    const id = engine.run.toolId;
    const tool = ctx.catalog?.find((t) => t.id === id);
    if (!tool || !tool.available)
      throw new ToolInputError(
        `${engine.model} isn't installed on this server.`,
      );
    const settings = defaultSettings(tool);
    if (tool.promptMode !== "none") settings.text = text;
    return { kind: "catalog", tool, settings };
  }

  const params: Record<string, unknown> = { pack_id: engine.run.pack };
  if (text) params.prompt = text;
  const overrides: Record<string, string | number> = {
    ...(engine.run.overrides ?? {}),
  };

  if (engine.refs === 2) {
    if (!opts.secondRef)
      throw new ToolInputError("Add the reference image first.");
    params.secondRefImage = opts.secondRef;
  }
  if (engine.run.groundedLora) {
    const lora = editLorasIn(ctx.editLoras, GROUNDED_FAMILY)[0];
    if (!lora) throw new ToolInputError("Needs a grounded Krea 2 edit LoRA.");
    if (opts.editMode) params.editMode = opts.editMode;
    if (lora.kvCache) params.editLoraKvCache = true;
    overrides["2.lora_name"] = lora.file;
    overrides["2.strength_model"] = lora.defaultStrength;
  }
  return { kind: "action", action: engine.run.action, params, overrides };
}

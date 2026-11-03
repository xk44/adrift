/**
 * Build a smoke entry's API prompt through the same functions the app's
 * routes call, minus HTTP / DB / uploads:
 *
 *   action  POST /api/jobs/action  (seed-run source like /api/jobs/seed-run,
 *           resolveWorkflow -> loadWorkflowFromSelection -> checkActionMask
 *           -> actionBuilderFor ?? buildActionWorkflow)
 *   tool    POST /api/jobs/tool    (resolveToolOptions -> renderToolPrompt
 *           -> resolveToolLoras -> loadPackWorkflow -> buildToolWorkflow;
 *           only prep paths that need no server-side image surgery)
 *
 * Single-host: the multi-host ".video.json" variant swap is not applied.
 */
import path from "node:path";
import { checkActionMask } from "@/lib/comfy/actionMask";
import { loadWorkflowFromSelection } from "@/lib/comfy/workflows";
import { actionBuilderFor } from "@/lib/oj/actionBuilders";
import { buildActionWorkflow } from "@/lib/oj/engine";
import { getPack, resolveWorkflow } from "@/lib/oj/packs";
import registry from "@/lib/oj/registry.json";
import { textOnlySeedRun } from "@/lib/seedRun";
import {
  buildToolWorkflow,
  cleanToolPrompt,
  fitLatentDims,
  getEditTool,
  loadPackWorkflow,
  renderToolPrompt,
  resolveToolLoras,
  resolveToolOptions,
  toolFixedLatent,
  toolNeedsLatentFit,
  toolWorkflowPath,
} from "@/lib/tools/editTools";
import { normalizeWorkflowActionId } from "@/lib/workflowAssignments";
import type { ImagineRun, Workflow } from "@/types";
import {
  isSmokeAssetId,
  smokeAssetLocation,
  smokeAssetMeta,
  smokeAssetRef,
  type SmokeAsset,
  type SmokeAssetId,
} from "./assets";
import { ASSET_PLACEHOLDER, type SmokeEntry } from "./manifest";

export interface BuiltSmokeGraph {
  workflow: Workflow;
  /** public/workflows-relative graph the prompt was built from. */
  workflowPath: string;
  /** Assets the prompt references (the runner uploads these in --run). */
  assets: SmokeAssetId[];
}

const ACTIONS = registry.actions as Record<
  string,
  { template?: string; requiresImage?: boolean }
>;

/** Replace "@asset:<id>" strings (deep) with the asset's ComfyUI ref. */
export function resolveAssetPlaceholders<T>(
  value: T,
  used: Set<SmokeAssetId> = new Set(),
): T {
  if (typeof value === "string" && value.startsWith(ASSET_PLACEHOLDER)) {
    const id = value.slice(ASSET_PLACEHOLDER.length);
    if (!isSmokeAssetId(id)) throw new Error(`unknown smoke asset "${id}"`);
    used.add(id);
    return smokeAssetRef(id) as T;
  }
  if (Array.isArray(value))
    return value.map((v) => resolveAssetPlaceholders(v, used)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        resolveAssetPlaceholders(v, used),
      ]),
    ) as T;
  }
  return value;
}

function viewUrl(comfyUrl: string, id: SmokeAssetId): string {
  const { subfolder, file } = smokeAssetLocation(id);
  const q = new URLSearchParams({ filename: file, subfolder, type: "input" });
  return `${comfyUrl}/view?${q}`;
}

/** The run /api/jobs/seed-run would register for this source. */
export function smokeSeedRun(
  source: SmokeAssetId | "text",
  comfyUrl: string,
  prompt = "",
): ImagineRun {
  const runId = `gpu-smoke-${source}`;
  if (source === "text")
    return textOnlySeedRun(runId, prompt, "2026-01-01T00:00:00.000Z");
  const a: SmokeAsset = smokeAssetMeta(source);
  if (a.kind === "audio") throw new Error(`seed source ${source} is audio`);
  const url = viewUrl(comfyUrl, source);
  const isVideo = a.kind === "video";
  return {
    run_id: runId,
    prompt,
    parsedPrompt: prompt,
    width: a.width ?? 1024,
    height: a.height ?? 1024,
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "done",
    jobs: [
      {
        seed: 0,
        index: 0,
        status: "done",
        progress: 100,
        images: isVideo ? [] : [url],
        ...(isVideo ? { videos: [url] } : {}),
      },
    ],
    params: {
      seed_upload: true,
      ...(isVideo && a.seconds ? { video_seconds: a.seconds } : {}),
    },
  };
}

function workflowFilePath(selection: string): string {
  if (selection.startsWith("saved:") || path.isAbsolute(selection))
    return selection;
  return path.join(process.cwd(), "public/workflows", selection);
}

async function buildAction(
  entry: Extract<SmokeEntry, { kind: "action" }>,
  comfyUrl: string,
): Promise<BuiltSmokeGraph> {
  const used = new Set<SmokeAssetId>();
  if (entry.source !== "text") used.add(entry.source);
  const params = resolveAssetPlaceholders(entry.params, used);
  const action = normalizeWorkflowActionId(entry.action);
  const meta = ACTIONS[action];
  if (!meta?.template)
    throw new Error(`no registry template for action ${action}`);
  const str = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const resolved = resolveWorkflow({
    templateOrAction: action,
    checkpointName: str(params.model) ?? str(params.checkpoint),
    modelFamily: str(params.modelFamily) ?? str(params.model_family),
    packId: str(params.packId) ?? str(params.pack_id),
  });
  const sourceRun = smokeSeedRun(entry.source, comfyUrl, entry.sourcePrompt);
  const job = sourceRun.jobs[0];
  // Same 409 guards as the route.
  if (meta.requiresImage && !job.images?.length)
    throw new Error(`${action} requires an image source`);
  const workflow = await loadWorkflowFromSelection(
    workflowFilePath(resolved.workflowPath),
  );
  if (checkActionMask(workflow, undefined).length > 0)
    throw new Error(
      `${action} needs a mask (not supported by the smoke runner)`,
    );
  const builder = actionBuilderFor(action);
  const built = builder
    ? builder(workflow, sourceRun, 0, params)
    : buildActionWorkflow(workflow, action, sourceRun, 0, params);
  return {
    workflow: built.workflow,
    workflowPath: resolved.workflowPath,
    assets: [...used],
  };
}

async function buildTool(
  entry: Extract<SmokeEntry, { kind: "tool" }>,
): Promise<BuiltSmokeGraph> {
  const tool = getEditTool(entry.toolId);
  if (!tool) throw new Error(`unknown edit tool ${entry.toolId}`);
  const simplePrep =
    !tool.prep ||
    tool.prep === "none" ||
    toolNeedsLatentFit(tool) ||
    !!tool.fixedLatent;
  if (!simplePrep)
    throw new Error(`${tool.id}: unsupported prep "${tool.prep}"`);
  if (entry.images.length !== tool.refCount)
    throw new Error(`${tool.id} needs ${tool.refCount} image(s)`);
  const options = resolveToolOptions(tool, entry.options ?? {});
  const userPrompt = entry.prompt ? cleanToolPrompt(entry.prompt) : undefined;
  if (tool.promptMode === "required" && !userPrompt)
    throw new Error(`${tool.id} needs a prompt`);
  const prompt = renderToolPrompt(tool, userPrompt, options.choices);
  const loras = resolveToolLoras(tool, options);
  let latent: { width: number; height: number } | undefined;
  if (toolNeedsLatentFit(tool)) {
    const src: SmokeAsset = smokeAssetMeta(entry.images[0]);
    latent = fitLatentDims(src.width ?? 1024, src.height ?? 1024);
  } else if (tool.fixedLatent) {
    toolFixedLatent(tool, options.choices); // route only uses it for canvas size
  }
  const rel = toolWorkflowPath(tool, getPack(tool.pack)?.workflows);
  const base = await loadPackWorkflow(rel);
  const workflow = buildToolWorkflow({
    workflow: base,
    tool,
    prompt,
    loras,
    steps: options.steps,
    cfg: options.cfg,
    seed: options.seed ?? 4242,
    imageRefs: entry.images.map(smokeAssetRef),
    latent,
    choices: options.choices,
  });
  return { workflow, workflowPath: rel, assets: [...new Set(entry.images)] };
}

export async function buildSmokeGraph(
  entry: SmokeEntry,
  opts: { comfyUrl: string },
): Promise<BuiltSmokeGraph> {
  return entry.kind === "action"
    ? buildAction(entry, opts.comfyUrl.replace(/\/+$/, ""))
    : buildTool(entry);
}

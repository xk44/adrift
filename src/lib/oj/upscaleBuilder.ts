/**
 * Builders for the image upscale actions (see lib/upscale/upscaleModels).
 *
 *   upscale_subtle  (Faithful): model upscale only. Graphs without a sampler
 *                   are patched directly (the generic builder needs a
 *                   KSampler); graphs with one fall back to the generic path.
 *                   params.size pins an exact factor (ImageScaleBy) or long
 *                   edge (ImageScaleToMaxDimension) after the model.
 *   upscale_creative (Creative): model upscale → 2x → tiled re-render. The
 *                   generic builder injects prompt/seed, then the creativity
 *                   dial sets denoise and the template's tuned sampler
 *                   settings are restored (a source run's steps/cfg must not
 *                   leak into the tile pass).
 *   upscale_redetail (Re-detail): the current image model's img2img graph
 *                   with its KSampler replaced by UltimateSDUpscale (tiled
 *                   low-denoise re-render at params.size).
 *
 * All honour params.upscale_model on every UpscaleModelLoader; without one
 * the user's default upscaler is applied at submit (Faithful at "model" size
 * also takes the preferred output scale). params.cleanup adds a fixed 1x
 * restoration pass on the source first.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  DEFAULT_MODEL_SCALE,
  UPSCALE_CLEANUP_PARAM,
  UPSCALE_CREATIVITY_PARAM,
  UPSCALE_CREATIVE_ACTION,
  UPSCALE_MODEL_PARAM,
  UPSCALE_REDETAIL_ACTION,
  UPSCALE_REDETAIL_PARAM,
  UPSCALE_SIZE_PARAM,
  UPSCALE_SUBTLE_ACTION,
  cleanupModel,
  creativeRescale,
  creativityDenoise,
  redetailDenoise,
  redetailFactor,
  sanitizeUpscaleModel,
  upscaleSize,
} from "@/lib/upscale/upscaleModels";
import { imageUpscaleContent, knownScale } from "@/lib/upscale/upscalerPref";
import {
  buildActionWorkflow,
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";

type BuildResult = { workflow: Workflow; slots: WorkflowSlots; seed: number };

const SAMPLER_CLASSES = new Set(["KSampler", "KSamplerAdvanced"]);
/** Sampler inputs the creative templates tune for the tile pass. */
const TILE_SAMPLER_KEYS = ["steps", "cfg", "sampler_name", "scheduler"];

/** Node ids, without top-level entries such as a pack graph's `_meta`. */
function nodeIds(workflow: Workflow): string[] {
  return Object.keys(workflow).filter(
    (id) => !id.startsWith("_") && workflow[id]?.inputs,
  );
}

function idsOf(workflow: Workflow, classType: string): string[] {
  return nodeIds(workflow).filter(
    (id) => workflow[id].class_type === classType,
  );
}

function newNodeId(workflow: Workflow, hint: string): string {
  const keys = nodeIds(workflow);
  const nums = keys.map(Number).filter((n) => Number.isInteger(n) && n >= 0);
  if (nums.length && nums.length === keys.length)
    return String(Math.max(...nums) + 1);
  let id = hint;
  for (let i = 2; workflow[id]; i++) id = `${hint}${i}`;
  return id;
}

function consumersOf(workflow: Workflow, id: string, output = 0) {
  const out: { id: string; input: string }[] = [];
  for (const nid of nodeIds(workflow)) {
    for (const [k, v] of Object.entries(workflow[nid].inputs)) {
      if (Array.isArray(v) && String(v[0]) === id && Number(v[1]) === output)
        out.push({ id: nid, input: k });
    }
  }
  return out;
}

/** Insert `classType` on output 0 of `id`, taking over all its consumers. */
function insertAfter(
  workflow: Workflow,
  id: string,
  classType: string,
  inputs: Record<string, unknown>,
  title: string,
): string {
  const users = consumersOf(workflow, id);
  const nid = newNodeId(workflow, `${id}_${classType}`);
  workflow[nid] = {
    class_type: classType,
    inputs: { image: [id, 0], ...inputs },
    _meta: { title },
  };
  for (const u of users) workflow[u.id].inputs[u.input] = [nid, 0];
  return nid;
}

/**
 * params.cleanup: a 1x restoration model (DeJpeg / GainRES) on every
 * LoadImage before anything reads it. The loader is "fixed" so the
 * submit-time resolver never swaps it for a full upscaler.
 */
export function insertCleanupPass(
  workflow: Workflow,
  params: Record<string, unknown>,
): string[] {
  const file = cleanupModel(params[UPSCALE_CLEANUP_PARAM]);
  if (!file) return [];
  const added: string[] = [];
  for (const loadId of idsOf(workflow, "LoadImage")) {
    if (!consumersOf(workflow, loadId).length) continue;
    const loaderId = newNodeId(workflow, `${loadId}_cleanup_model`);
    workflow[loaderId] = {
      class_type: "UpscaleModelLoader",
      inputs: { model_name: file },
      _meta: { title: "Clean-up model", upscaler: "fixed" },
    };
    const upId = insertAfter(
      workflow,
      loadId,
      "ImageUpscaleWithModel",
      { upscale_model: [loaderId, 0] },
      "Clean up first",
    );
    added.push(loaderId, upId);
  }
  return added;
}

/**
 * Point every UpscaleModelLoader at the chosen model and mark it for the
 * submit-time resolver (lib/upscale/resolveUpscalers): a per-run pick is
 * "fixed", otherwise it follows the user's default for the source's content
 * type. Returns the model in use.
 */
export function applyUpscaleModel(
  workflow: Workflow,
  params: Record<string, unknown>,
  opts: { sourceRun?: ImagineRun; prefScale?: boolean } = {},
): string | undefined {
  const chosen = sanitizeUpscaleModel(params[UPSCALE_MODEL_PARAM]);
  const content = opts.sourceRun
    ? imageUpscaleContent(opts.sourceRun)
    : undefined;
  let inUse: string | undefined;
  for (const id of idsOf(workflow, "UpscaleModelLoader")) {
    if (chosen) setNodeInput(workflow, id, "model_name", chosen);
    const node = workflow[id];
    node._meta = {
      ...node._meta,
      upscaler: chosen ? "fixed" : "default",
      ...(content ? { upscaleContent: content } : {}),
      ...(opts.prefScale ? { upscaleScale: "pref" as const } : {}),
    };
    const v = node.inputs.model_name;
    if (!inUse && typeof v === "string") inUse = v;
  }
  return inUse;
}

/** ImageScaleBy nodes fed by a model upscale: retarget them to 2x overall. */
function applyCreativeRescale(workflow: Workflow, model: string | undefined) {
  const factor = creativeRescale(model);
  const upscaleIds = new Set(idsOf(workflow, "ImageUpscaleWithModel"));
  for (const id of idsOf(workflow, "ImageScaleBy")) {
    const src = workflow[id].inputs.image;
    if (Array.isArray(src) && upscaleIds.has(String(src[0]))) {
      setNodeInput(workflow, id, "scale_by", factor);
    }
  }
}

function hasSampler(workflow: Workflow): boolean {
  return Object.values(workflow).some((n) => SAMPLER_CLASSES.has(n.class_type));
}

function sourceImageRef(run: ImagineRun, jobIndex: number): string | null {
  return comfyImageRefFromViewUrl(run.jobs[jobIndex]?.images?.[0]);
}

/** Sampler-less model upscale: LoadImage ← source, model override, no seed. */
function buildModelOnly(
  action: string,
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown>,
): BuildResult {
  const workflow = cloneWorkflow(baseWorkflow);
  const imageInputId = idsOf(workflow, "LoadImage")[0];
  if (!imageInputId)
    throw new Error(`${action}: workflow has no LoadImage node`);
  const ref = sourceImageRef(sourceRun, sourceJobIndex);
  if (!ref) throw new Error(`${action}: source run has no image`);
  setNodeInput(workflow, imageInputId, "image", ref);
  const size =
    action === UPSCALE_SUBTLE_ACTION
      ? upscaleSize(params[UPSCALE_SIZE_PARAM])
      : ({ kind: "model" } as const);
  const model = applyUpscaleModel(workflow, params, {
    sourceRun,
    prefScale: action === UPSCALE_SUBTLE_ACTION && size.kind === "model",
  });
  if (size.kind === "factor") {
    const by = size.factor / (knownScale(model ?? "") ?? DEFAULT_MODEL_SCALE);
    for (const id of idsOf(workflow, "ImageUpscaleWithModel")) {
      insertAfter(
        workflow,
        id,
        "ImageScaleBy",
        {
          upscale_method: "lanczos",
          scale_by: Math.round(by * 10000) / 10000,
        },
        "Exact size",
      );
    }
  } else if (size.kind === "long") {
    for (const id of idsOf(workflow, "ImageUpscaleWithModel")) {
      insertAfter(
        workflow,
        id,
        "ImageScaleToMaxDimension",
        {
          upscale_method: "lanczos",
          largest_size: size.px,
        },
        "Long edge",
      );
    }
  }
  insertCleanupPass(workflow, params);
  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: "",
      negTextId: "",
      latentDimsId: "",
      imageInputId,
    },
    seed: sourceRun.jobs[sourceJobIndex]?.seed ?? 0,
  };
}

export function buildUpscaleSubtleWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): BuildResult {
  if (!hasSampler(baseWorkflow)) {
    return buildModelOnly(
      UPSCALE_SUBTLE_ACTION,
      baseWorkflow,
      sourceRun,
      sourceJobIndex,
      params,
    );
  }
  // A pack that maps Faithful to a refine graph: keep generic behaviour.
  const built = buildActionWorkflow(
    baseWorkflow,
    UPSCALE_SUBTLE_ACTION,
    sourceRun,
    sourceJobIndex,
    params,
  );
  applyUpscaleModel(built.workflow, params, { sourceRun });
  insertCleanupPass(built.workflow, params);
  return built;
}

export function buildUpscaleCreativeWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): BuildResult {
  if (!hasSampler(baseWorkflow)) {
    // Misconfigured pack (no re-render pass): still honour the model choice.
    return buildModelOnly(
      UPSCALE_CREATIVE_ACTION,
      baseWorkflow,
      sourceRun,
      sourceJobIndex,
      params,
    );
  }
  const built = buildActionWorkflow(
    baseWorkflow,
    UPSCALE_CREATIVE_ACTION,
    sourceRun,
    sourceJobIndex,
    params,
  );
  const { workflow, slots } = built;
  const ks = slots.ksamplerId ? workflow[slots.ksamplerId] : undefined;
  const template = slots.ksamplerId
    ? baseWorkflow[slots.ksamplerId]
    : undefined;
  if (ks && template) {
    for (const key of TILE_SAMPLER_KEYS) {
      if (key in template.inputs) {
        setNodeInput(workflow, slots.ksamplerId, key, template.inputs[key]);
      }
    }
    setNodeInput(
      workflow,
      slots.ksamplerId,
      "denoise",
      creativityDenoise(params[UPSCALE_CREATIVITY_PARAM]),
    );
  }
  const model = applyUpscaleModel(workflow, params, { sourceRun });
  applyCreativeRescale(workflow, model);
  insertCleanupPass(workflow, params);
  return built;
}

/**
 * Tile settings shared with packs/krea2/upscale_detail.json. No seam-fix
 * pass: Chess tiles with mask_blur 12 + padding 32 already hide the joins,
 * and the "Half Tile" pass re-sampled strips that left ~30 px blocky patches
 * on fine texture (knit, hair) in the 2026-10-31 GPU sweep.
 */
const REDETAIL_TILE = {
  mode_type: "Chess",
  tile_width: 1024,
  tile_height: 1024,
  mask_blur: 12,
  tile_padding: 32,
  seam_fix_mode: "None",
  seam_fix_width: 64,
  seam_fix_mask_blur: 8,
  seam_fix_padding: 16,
  force_uniform_tiles: true,
  tiled_decode: false,
  batch_size: 1,
};
/** Placeholder the submit-time resolver swaps for the user's upscaler. */
const REDETAIL_PLACEHOLDER_MODEL = "RealESRGAN_x4plus.pth";
const OUTPUT_CLASSES = /^(Save|Preview)/;

function refId(v: unknown): string | null {
  return Array.isArray(v) ? String(v[0]) : null;
}

/** Drop non-output nodes nothing reads any more (repeat until stable). */
function pruneOrphans(workflow: Workflow): void {
  for (;;) {
    const used = new Set<string>();
    for (const id of nodeIds(workflow))
      for (const v of Object.values(workflow[id].inputs)) {
        const r = refId(v);
        if (r) used.add(r);
      }
    const dead = nodeIds(workflow).filter(
      (id) => !used.has(id) && !OUTPUT_CLASSES.test(workflow[id].class_type),
    );
    if (!dead.length) return;
    for (const id of dead) delete workflow[id];
  }
}

/**
 * Re-detail: the pack's img2img graph (prompt, model, LoRAs, VAE as the
 * generic builder set them) with KSampler → UltimateSDUpscale, which upscales
 * the source with the user's upscaler and redraws it in tiles. The template's
 * sampler settings are kept (a source run's 50 steps must not run per tile).
 */
export function buildUpscaleRedetailWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): BuildResult {
  const action = UPSCALE_REDETAIL_ACTION;
  if (!hasSampler(baseWorkflow))
    throw new Error(
      `${action}: the image model's img2img graph has no sampler`,
    );
  const built = buildActionWorkflow(
    baseWorkflow,
    action,
    sourceRun,
    sourceJobIndex,
    params,
  );
  const { workflow, slots } = built;
  const ksId = slots.ksamplerId;
  const ks = ksId ? workflow[ksId] : undefined;
  if (!ks || ks.class_type !== "KSampler")
    throw new Error(`${action}: img2img graph needs a plain KSampler`);
  const encId = refId(ks.inputs.latent_image);
  const enc = encId ? workflow[encId] : undefined;
  if (!enc || enc.class_type !== "VAEEncode")
    throw new Error(`${action}: img2img sampler does not start from VAEEncode`);
  const decodes = consumersOf(workflow, ksId).filter(
    (u) => workflow[u.id].class_type === "VAEDecode",
  );
  if (!decodes.length)
    throw new Error(`${action}: img2img graph has no VAEDecode`);

  const template = baseWorkflow[ksId]?.inputs ?? ks.inputs;
  const denoise = redetailDenoise(params[UPSCALE_REDETAIL_PARAM]);
  const loaderId = newNodeId(workflow, "redetail_model");
  workflow[loaderId] = {
    class_type: "UpscaleModelLoader",
    inputs: { model_name: REDETAIL_PLACEHOLDER_MODEL },
    _meta: { title: "Upscale model" },
  };
  const usduId = newNodeId(workflow, "redetail");
  workflow[usduId] = {
    class_type: "UltimateSDUpscale",
    inputs: {
      image: enc.inputs.pixels,
      model: ks.inputs.model,
      positive: ks.inputs.positive,
      negative: ks.inputs.negative,
      vae: enc.inputs.vae,
      upscale_by: redetailFactor(params[UPSCALE_SIZE_PARAM]),
      seed: ks.inputs.seed,
      steps: template.steps,
      cfg: template.cfg,
      sampler_name: template.sampler_name,
      scheduler: template.scheduler,
      denoise,
      upscale_model: [loaderId, 0],
      ...REDETAIL_TILE,
      seam_fix_denoise: Math.min(denoise, 0.25),
    },
    _meta: { title: "Re-detail (tiled)" },
  };
  for (const d of decodes) {
    for (const u of consumersOf(workflow, d.id))
      workflow[u.id].inputs[u.input] = [usduId, 0];
    delete workflow[d.id];
  }
  delete workflow[ksId];
  pruneOrphans(workflow);

  applyUpscaleModel(workflow, params, { sourceRun });
  insertCleanupPass(workflow, params);
  return {
    ...built,
    workflow,
    slots: { ...slots, ksamplerId: usduId, latentDimsId: "" },
  };
}

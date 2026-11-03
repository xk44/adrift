/**
 * Regional prompting: `--region <area>[::strength] <prompt>` (repeatable).
 *
 *   a quiet harbor at dusk --region left a red lighthouse
 *     --region top-right::1.4 a full moon --region 0.6,0.5,0.4,0.5 a sailboat
 *
 * The base prompt (everything outside --region) still conditions the whole
 * frame. Each region becomes its own encode, bounded to a box with core
 * ComfyUI area conditioning:
 *
 *   base CLIPTextEncode ─────────────────────────────┐
 *   region CLIPTextEncode → ConditioningSetAreaPercentage ─ ConditioningCombine ─ … → sampler positive
 *
 * The combine sits directly after the base encoder, so per-family
 * conditioning post-processing between encoder and sampler (Krea2's
 * ConditioningKrea2Rebalance) applies to every entry alike; that node
 * rescales each cond tensor and copies its extras dict, so the area survives.
 *
 * ComfyUI resolves percentage areas against the latent at sample time
 * (comfy/samplers.py resolve_areas_and_cond_masks_multidim), crops the latent
 * to the box for that cond and feathers the edges, so the rewrite is
 * resolution-independent (--ar / --hd / --draft need no coordination).
 *
 * Gate: image families only, and only graphs whose base encoder feeds the
 * sampler through pass-through nodes. Edit/reference/control graphs are
 * skipped: those patch full-size spatial inputs (reference latents, control
 * hints) that an area crop would misalign. Anything else is a silent no-op,
 * matching graphControls' "stray flag never breaks a prompt" convention.
 */
import type { Workflow, WorkflowSlots } from "@/types";
import { detectWorkflowFamily } from "./graphControls";
import { nextNodeId } from "./loraInsert";

export interface RegionSpec {
  /** Box as fractions of the canvas, origin top-left. */
  x: number;
  y: number;
  w: number;
  h: number;
  prompt: string;
  /** ConditioningSetAreaPercentage strength (0-10, default 1). */
  strength: number;
}

export const REGION_MAX = 8;
const MAX_REGION_PROMPT = 400;
const T = 1 / 3;

/** Named areas: [x, y, w, h] fractions. */
export const REGION_PRESETS: Readonly<
  Record<string, readonly [number, number, number, number]>
> = {
  left: [0, 0, 0.5, 1],
  right: [0.5, 0, 0.5, 1],
  top: [0, 0, 1, 0.5],
  bottom: [0, 0.5, 1, 0.5],
  center: [0.25, 0.25, 0.5, 0.5],
  "top-left": [0, 0, 0.5, 0.5],
  "top-right": [0.5, 0, 0.5, 0.5],
  "bottom-left": [0, 0.5, 0.5, 0.5],
  "bottom-right": [0.5, 0.5, 0.5, 0.5],
  "left-third": [0, 0, T, 1],
  "middle-third": [T, 0, T, 1],
  "right-third": [2 * T, 0, T, 1],
  "top-third": [0, 0, 1, T],
  "bottom-third": [0, 2 * T, 1, T],
};

/**
 * Families where core area conditioning is valid.
 * - sd15/sdxl/pony/illustrious: UNet area composition, the technique ComfyUI's
 *   area-composition examples are built on.
 * - krea2, krea2-raw, flux3, qwen-image-21: DiT image models sampled through
 *   a plain KSampler. The area path in comfy/samplers.py is model-agnostic
 *   (crop latent, process_cond(area=…), feathered blend), but prompt
 *   adherence per box has not been GPU-verified on these yet.
 * Excluded: video families (5-D latents; a 2-D percentage area mis-indexes
 * the time axis), moss_image (native layout boxes: use those), API/remote
 * nodes, edit/inpaint packs.
 */
export const REGION_FAMILIES: ReadonlySet<string> = new Set([
  "sd15",
  "sdxl",
  "pony",
  "illustrious",
  "krea2",
  "krea2-raw",
  "flux3",
  "qwen-image-21",
]);

/**
 * Families whose latent is 5-D (B,C,T,H,W: Krea2 samples through the
 * Qwen-Image/Wan-style VAE). ComfyUI 0.42.0's percentage-area resolver
 * (resolve_areas_and_cond_masks_multidim) indexes a[d + len(a)//2] for every
 * latent dim, so a 2-D percentage box on a 3-dim (T,H,W) latent raises
 * "IndexError: tuple index out of range" in KSampler.
 * The mask path is N-D safe (masks are resized to the last two
 * dims and broadcast over T), so these families get a rect mask per region:
 *   SolidMask(0, canvas) ─┐
 *   SolidMask(1, box) ────┴ MaskComposite(add @x,y) → ConditioningSetMask
 *     → MaskToImage → ImageBlur → ImageToMask (feather)
 *     → ConditioningSetMask → ConditioningSetTimestepRange(0, REGION_T_END)
 * The mask canvas is MASK_CANVAS² regardless of --ar: ComfyUI bilinearly
 * resizes it to the latent's H×W, so box fractions are preserved.
 * A hard mask edge leaves a
 * visible seam slicing objects at the box line; the blur feather (radius 31,
 * sigma 10 on a 256 canvas ≈ 4% of width) removes it. Ending the regions at
 * 60% of the schedule doesn't change composition (it is fixed early) but
 * drops the extra per-region model passes for the last steps: ~25% faster.
 */
export const MASK_REGION_FAMILIES: ReadonlySet<string> = new Set([
  "krea2",
  "krea2-raw",
]);
const MASK_CANVAS = 256;
const MASK_FEATHER_RADIUS = 31;
const MASK_FEATHER_SIGMA = 10;
const REGION_T_END = 0.6;

/** Samplers whose positive input we may re-point (input name per class). */
const SAMPLER_POSITIVE: Readonly<Record<string, string>> = {
  KSampler: "positive",
  KSamplerAdvanced: "positive",
  CFGGuider: "positive",
  BasicGuider: "conditioning",
};

/** CONDITIONING → CONDITIONING nodes that keep per-entry extras (area). */
const PASS_THROUGH: Readonly<Record<string, string>> = {
  ConditioningKrea2Rebalance: "conditioning",
};

/**
 * Consumers of the base encoder that don't take part in the positive path
 * and may stay wired to the bare base (Z-Image style negative = zeroed pos).
 */
const IGNORED_CONSUMERS = new Set(["ConditioningZeroOut"]);

/**
 * Graphs an area crop would misalign: control hints / reference latents /
 * IP-Adapter images are full-frame, inpaint graphs sample a crop (so the
 * fractions would land on the crop, not the image), edit patches carry the
 * source latent spatially.
 */
const SPATIAL_BLOCKERS =
  /Control|Reference|IPAdapter|Inpaint|InstructPixToPix|StyleModelApply|Edit/;

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** Parse the area token: preset name or "x,y,w,h" fractions. */
function parseArea(
  token: string,
): readonly [number, number, number, number] | string {
  const preset = REGION_PRESETS[token.toLowerCase()];
  if (preset) return preset;
  const parts = token.split(",");
  if (parts.length !== 4)
    return `unknown area "${token}" (use ${Object.keys(REGION_PRESETS).join(", ")} or x,y,w,h fractions)`;
  const nums = parts.map((p) => Number(p.trim()));
  if (!nums.every((n) => Number.isFinite(n)))
    return `area "${token}": x,y,w,h must be numbers`;
  const [x, y, w, h] = nums;
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001)
    return `area "${token}": box must lie inside the 0-1 canvas`;
  return [x, y, w, h];
}

/** One `--region` value ("<area>[::strength] <prompt>") → spec or error. */
export function parseRegionSpec(raw: string): RegionSpec | { error: string } {
  const trimmed = raw.trim();
  const sp = trimmed.search(/\s/);
  const head = sp < 0 ? trimmed : trimmed.slice(0, sp);
  const prompt = (sp < 0 ? "" : trimmed.slice(sp + 1))
    .trim()
    .slice(0, MAX_REGION_PROMPT);
  const [areaTok, strengthTok, ...extra] = head.split("::");
  if (extra.length) return { error: `--region "${head}": one :: weight only` };
  const area = parseArea(areaTok);
  if (typeof area === "string") return { error: `--region: ${area}` };
  let strength = 1;
  if (strengthTok !== undefined) {
    strength = Number(strengthTok);
    if (!Number.isFinite(strength) || strength < 0 || strength > 10)
      return { error: `--region "${head}": strength must be 0-10` };
  }
  if (!prompt) return { error: `--region ${areaTok}: needs a prompt` };
  const [x, y, w, h] = area;
  return {
    x: round4(x),
    y: round4(y),
    w: round4(w),
    h: round4(h),
    prompt,
    strength,
  };
}

/** params.region (string | string[]) → specs + errors. */
export function parseRegions(value: unknown): {
  regions: RegionSpec[];
  errors: string[];
} {
  const raws =
    value === undefined || value === null
      ? []
      : Array.isArray(value)
        ? value
        : [value];
  const regions: RegionSpec[] = [];
  const errors: string[] = [];
  for (const raw of raws) {
    const r = parseRegionSpec(String(raw));
    if ("error" in r) errors.push(r.error);
    else regions.push(r);
  }
  if (regions.length > REGION_MAX) {
    errors.push(`--region: at most ${REGION_MAX} regions`);
    regions.length = REGION_MAX;
  }
  return { regions, errors };
}

function isLinkTo(v: unknown, id: string, slot = 0): boolean {
  return (
    Array.isArray(v) && v.length === 2 && String(v[0]) === id && v[1] === slot
  );
}

/** [nodeId, inputName] pairs that read output 0 of `id`. */
function consumersOf(workflow: Workflow, id: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [nid, node] of Object.entries(workflow)) {
    for (const [key, v] of Object.entries(node.inputs ?? {})) {
      if (isLinkTo(v, id)) out.push([nid, key]);
    }
  }
  return out;
}

/**
 * Inputs to re-point from the base encoder to the combined conditioning,
 * or a reason the graph is not eligible. Every positive-path consumer must
 * reach a sampler's positive through PASS_THROUGH nodes only.
 */
function positiveRewireTargets(
  workflow: Workflow,
  baseId: string,
): Array<[string, string]> | string {
  const targets: Array<[string, string]> = [];
  let reachesSampler = false;
  const visit = (id: string, depth: number): string | undefined => {
    if (depth > 8) return "conditioning chain too deep";
    for (const [cid, key] of consumersOf(workflow, id)) {
      const cls = workflow[cid].class_type;
      if (depth === 0 && IGNORED_CONSUMERS.has(cls)) continue;
      if (SAMPLER_POSITIVE[cls] === key) {
        reachesSampler = true;
      } else if (PASS_THROUGH[cls] === key) {
        const err = visit(cid, depth + 1);
        if (err) return err;
      } else {
        return `${cls}.${key} consumes the positive prompt`;
      }
      if (depth === 0) targets.push([cid, key]);
    }
    return undefined;
  };
  const err = visit(baseId, 0);
  if (err) return err;
  if (!reachesSampler) return "positive prompt does not reach a sampler";
  return targets;
}

export interface RegionalResult {
  applied: number;
  family: string;
  /** Why nothing was applied (for logs/tests). */
  skipped?: string;
  errors: string[];
}

/** Whether `workflow` accepts --region, with the reason when it does not. */
export function regionalSupport(
  workflow: Workflow,
  slots: Pick<
    WorkflowSlots,
    "posTextId" | "negTextId" | "negTextInputName" | "apiPromptNodeId"
  >,
):
  { ok: true; family: string } | { ok: false; family: string; reason: string } {
  const { family } = detectWorkflowFamily(workflow);
  const no = (reason: string) => ({ ok: false as const, family, reason });
  if (slots.apiPromptNodeId) return no("API generator node");
  if (!REGION_FAMILIES.has(family)) return no(`family ${family}`);
  const base = workflow[slots.posTextId];
  if (base?.class_type !== "CLIPTextEncode")
    return no(`positive encoder is ${base?.class_type ?? "missing"}`);
  if (slots.negTextInputName || slots.negTextId === slots.posTextId)
    return no("shared positive/negative encoder");
  const blocker = Object.values(workflow).find((n) =>
    SPATIAL_BLOCKERS.test(n.class_type),
  );
  if (blocker) return no(`spatial conditioning node ${blocker.class_type}`);
  const targets = positiveRewireTargets(workflow, slots.posTextId);
  if (typeof targets === "string") return no(targets);
  return { ok: true, family };
}

/**
 * Rewrite the graph for `params.region`. Additive: new nodes get fresh ids,
 * only the base encoder's positive-path consumers are re-pointed.
 * Call after the prompt text is injected; before clip-skip insertion so
 * the region encoders share the base encoder's CLIP source.
 */
export function applyRegionalPrompts(
  workflow: Workflow,
  slots: Pick<
    WorkflowSlots,
    "posTextId" | "negTextId" | "negTextInputName" | "apiPromptNodeId"
  >,
  params: Record<string, unknown>,
): RegionalResult {
  const { regions, errors } = parseRegions(params.region);
  if (!regions.length)
    return { applied: 0, family: "", skipped: "no regions", errors };
  // --controlnet hints are resized to whatever latent a cond samples, so an
  // area-cropped region would get the whole hint squashed into its box.
  if (params.controlnet)
    return { applied: 0, family: "", skipped: "--controlnet active", errors };
  const support = regionalSupport(workflow, slots);
  if (!support.ok)
    return {
      applied: 0,
      family: support.family,
      skipped: support.reason,
      errors,
    };
  const targets = positiveRewireTargets(workflow, slots.posTextId);
  if (typeof targets === "string")
    return { applied: 0, family: support.family, skipped: targets, errors };

  const baseId = slots.posTextId;
  const clip = workflow[baseId].inputs.clip;
  const useMask = MASK_REGION_FAMILIES.has(support.family);
  let canvasId = "";
  if (useMask) {
    canvasId = nextNodeId(workflow);
    workflow[canvasId] = {
      class_type: "SolidMask",
      inputs: { value: 0, width: MASK_CANVAS, height: MASK_CANVAS },
      _meta: { title: "Region mask canvas" },
    };
  }
  const px = (f: number) => Math.round(f * MASK_CANVAS);
  let acc: [string, number] = [baseId, 0];
  regions.forEach((r, i) => {
    const encId = nextNodeId(workflow);
    workflow[encId] = {
      class_type: "CLIPTextEncode",
      inputs: { clip, text: r.prompt },
      _meta: { title: `Region ${i + 1} prompt` },
    };
    const areaId = nextNodeId(workflow);
    if (useMask) {
      const x = Math.min(px(r.x), MASK_CANVAS - 1);
      const y = Math.min(px(r.y), MASK_CANVAS - 1);
      const boxId = areaId;
      workflow[boxId] = {
        class_type: "SolidMask",
        inputs: {
          value: 1,
          width: Math.max(1, Math.min(px(r.w), MASK_CANVAS - x)),
          height: Math.max(1, Math.min(px(r.h), MASK_CANVAS - y)),
        },
        _meta: { title: `Region ${i + 1} box` },
      };
      const compId = nextNodeId(workflow);
      workflow[compId] = {
        class_type: "MaskComposite",
        inputs: {
          destination: [canvasId, 0],
          source: [boxId, 0],
          x,
          y,
          operation: "add",
        },
        _meta: { title: `Region ${i + 1} mask` },
      };
      const toImgId = nextNodeId(workflow);
      workflow[toImgId] = {
        class_type: "MaskToImage",
        inputs: { mask: [compId, 0] },
        _meta: { title: `Region ${i + 1} feather in` },
      };
      const blurId = nextNodeId(workflow);
      workflow[blurId] = {
        class_type: "ImageBlur",
        inputs: {
          image: [toImgId, 0],
          blur_radius: MASK_FEATHER_RADIUS,
          sigma: MASK_FEATHER_SIGMA,
        },
        _meta: { title: `Region ${i + 1} feather` },
      };
      const toMaskId = nextNodeId(workflow);
      workflow[toMaskId] = {
        class_type: "ImageToMask",
        inputs: { image: [blurId, 0], channel: "red" },
        _meta: { title: `Region ${i + 1} feather out` },
      };
      const setId = nextNodeId(workflow);
      workflow[setId] = {
        class_type: "ConditioningSetMask",
        inputs: {
          conditioning: [encId, 0],
          mask: [toMaskId, 0],
          strength: r.strength,
          set_cond_area: "default",
        },
        _meta: { title: `Region ${i + 1} area` },
      };
      const rangeId = nextNodeId(workflow);
      workflow[rangeId] = {
        class_type: "ConditioningSetTimestepRange",
        inputs: { conditioning: [setId, 0], start: 0, end: REGION_T_END },
        _meta: { title: `Region ${i + 1} steps` },
      };
      const combId = nextNodeId(workflow);
      workflow[combId] = {
        class_type: "ConditioningCombine",
        inputs: { conditioning_1: acc, conditioning_2: [rangeId, 0] },
        _meta: { title: `Region ${i + 1} combine` },
      };
      acc = [combId, 0];
      return;
    }
    workflow[areaId] = {
      class_type: "ConditioningSetAreaPercentage",
      inputs: {
        conditioning: [encId, 0],
        width: r.w,
        height: r.h,
        x: r.x,
        y: r.y,
        strength: r.strength,
      },
      _meta: { title: `Region ${i + 1} area` },
    };
    const combId = nextNodeId(workflow);
    workflow[combId] = {
      class_type: "ConditioningCombine",
      inputs: { conditioning_1: acc, conditioning_2: [areaId, 0] },
      _meta: { title: `Region ${i + 1} combine` },
    };
    acc = [combId, 0];
  });
  for (const [nid, key] of targets) {
    workflow[nid].inputs[key] = acc;
  }
  return { applied: regions.length, family: support.family, errors };
}

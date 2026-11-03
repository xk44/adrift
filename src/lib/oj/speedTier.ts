/**
 * Speed tier (Settings > Speed: Draft / Standard / Quality).
 *
 * One resolver maps the tier to a real per-engine change, applied where the
 * workflow is built (engine.ts injectParams, plus the MOSS / H3 option
 * resolution in the imagine / action routes):
 *
 *   engine            Draft                               Quality
 *   checkpoint        steps x0.5 (min 4)                  steps x1.5
 *   ideogram4         steps x0.5 (min 4)                  steps x1.5
 *   anima             steps x0.5 (min 4)                  steps x1.5
 *   krea2-raw         steps x0.5 (min 4)                  steps x1.5
 *   krea2-turbo       steps x0.5 (min 4)                  no effect (distilled)
 *   zimage-turbo      steps x0.5 (min 4)                  no effect (distilled)
 *   qwen-image        Viggle 4-step turbo LoRA, 4 steps,  steps x1.5
 *                     CFG 1 (steps x0.5 when not installed)
 *   qwen-image-turbo  no effect (already 4 steps)          no effect
 *   flux3             Klein step-distilled DiT, 16 steps, no effect (base is
 *                     CFG 1 (steps x0.5 when not installed) already 50 steps)
 *   flux3-distilled   no effect                            no effect
 *   moss-image        mossSpeed fast (10 steps)            mossSpeed off (50)
 *   h3-video          h3Speed turbo8 (when installed),     no effect
 *                     + 22-frame prompt clips (engine.ts)
 *   (H3 Image)        no effect (Turbo 8-step pinned)      no effect
 *
 * Standard never changes anything (current defaults). Anything that pins the
 * step count wins over the tier: an explicit `--steps`, `--draft`, `--turbo`,
 * an explicit MOSS `--speed`, or an explicit `--h3speed`.
 *
 * The stored setting is "Draft" | "Standard" | "Quality"; the prompt bar emits
 * it as `--tier draft|quality` (Standard emits nothing).
 */
import type { Workflow } from "@/types";
import { insertModelLoras } from "./loraInsert";
import { isMossImageWorkflow, type MossSpeed } from "./mossImage";
import { isH3Graph } from "./h3Video";
import type { H3Speed } from "./h3Speed";

export type SpeedTier = "draft" | "standard" | "quality";
export type SpeedSetting = "Draft" | "Standard" | "Quality";

export const SPEED_SETTINGS: readonly SpeedSetting[] = [
  "Draft",
  "Standard",
  "Quality",
];

/** Internal param set by the routes when the Draft variant's files exist. */
export const SPEED_TIER_DISTILLED_PARAM = "_speedTierDistilled";

const LEGACY_SPEED: Record<string, SpeedSetting> = {
  relax: "Quality",
  fast: "Standard",
  turbo: "Draft",
};

/**
 * Stored speed setting -> new tier label. Migrates the old cosmetic values
 * (Relax -> Quality, Fast -> Standard, Turbo -> Draft); anything unknown is
 * Standard.
 */
export function normalizeSpeedSetting(value: unknown): SpeedSetting {
  if (typeof value !== "string") return "Standard";
  const s = value.trim().toLowerCase();
  if (s in LEGACY_SPEED) return LEGACY_SPEED[s];
  if (s === "draft") return "Draft";
  if (s === "quality") return "Quality";
  return "Standard";
}

/**
 * Migrate a saved preset's settings: legacy speed names map to tiers and the
 * reserved `weird` value is dropped (it has no effect yet).
 */
export function migratePresetSettings<T extends Record<string, unknown>>(
  settings: T,
): Omit<T, "weird" | "speed"> & { speed: SpeedSetting } {
  const { weird: _weird, ...rest } = settings;
  void _weird;
  return { ...rest, speed: normalizeSpeedSetting(settings.speed) } as Omit<
    T,
    "weird" | "speed"
  > & { speed: SpeedSetting };
}

/** `--tier` value -> tier; undefined when unset or unknown. */
export function parseSpeedTier(value: unknown): SpeedTier | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim().toLowerCase();
  if (s === "draft" || s === "standard" || s === "quality") return s;
  return undefined;
}

/** Prompt flag for a stored setting ("" for Standard). */
export function speedTierFlag(setting: unknown): string {
  const tier = normalizeSpeedSetting(setting);
  return tier === "Standard" ? "" : `--tier ${tier.toLowerCase()}`;
}

export type SpeedEngine =
  | "checkpoint"
  | "ideogram4"
  | "anima"
  | "krea2-turbo"
  | "krea2-raw"
  | "zimage-turbo"
  | "qwen-image"
  | "qwen-image-turbo"
  | "flux3"
  | "flux3-distilled"
  | "moss-image"
  | "h3-video";

export interface DistilledVariant {
  /** Step-distilled LoRA inserted after the UNET. */
  lora?: { file: string; strength: number };
  /**
   * Swap the UNET file: replace `from` in unet_name with `to`. `file` is the
   * named target; `alt` lists siblings that also satisfy the install check
   * (the submit-time variant fallback points `file` at them).
   */
  unet?: { from: RegExp; to: string; file: string; alt?: string[] };
  steps: number;
  cfg: number;
}

export interface SpeedTierPlan {
  /** Short, user-facing summary. */
  summary: string;
  /** Multiply the graph's step count (fallback when `distilled` is unusable). */
  stepsScale?: number;
  /** Floor for the scaled step count. */
  minSteps?: number;
  /** Faster model variant, used only when its files are installed. */
  distilled?: DistilledVariant;
  /** MOSS-Image preset (resolved in mossImageDefaults). */
  mossSpeed?: MossSpeed;
  /** MiniMax H3 speed (resolved in the routes' install check). */
  h3Speed?: H3Speed;
}

export const QWEN_TURBO_LORA =
  "Qwen-Image-2.1-viggle-turbo-4step-lora-r64.safetensors";
export const FLUX3_KLEIN_UNET = "flux3_image_klein_bf16.safetensors";
/** CUDA default: 5.8 GB int8_convrot; a bf16-only install falls back to the sibling. */
export const FLUX3_KLEIN_DISTILLED_UNET =
  "flux3_image_klein_sd_int8_convrot.safetensors";
export const FLUX3_KLEIN_DISTILLED_UNET_BF16 =
  "flux3_image_klein_sd_bf16.safetensors";

const HALF: SpeedTierPlan = {
  summary: "Half the steps",
  stepsScale: 0.5,
  minSteps: 4,
};
const MORE: SpeedTierPlan = { summary: "1.5x the steps", stepsScale: 1.5 };

export const SPEED_TIER_MAP: Record<
  SpeedEngine,
  Partial<Record<Exclude<SpeedTier, "standard">, SpeedTierPlan>>
> = {
  checkpoint: { draft: HALF, quality: MORE },
  ideogram4: { draft: HALF, quality: MORE },
  anima: { draft: HALF, quality: MORE },
  "krea2-raw": { draft: HALF, quality: MORE },
  // Distilled: more steps don't add quality, fewer steps still draft.
  "krea2-turbo": { draft: HALF },
  "zimage-turbo": { draft: HALF },
  "qwen-image": {
    draft: {
      ...HALF,
      summary: "4-step turbo LoRA",
      distilled: {
        lora: { file: QWEN_TURBO_LORA, strength: 1 },
        steps: 4,
        cfg: 1,
      },
    },
    quality: MORE,
  },
  "qwen-image-turbo": {},
  flux3: {
    draft: {
      ...HALF,
      summary: "Step-distilled Klein, 16 steps",
      distilled: {
        unet: {
          from: /flux3_image_klein_bf16/i,
          to: "flux3_image_klein_sd_int8_convrot",
          file: FLUX3_KLEIN_DISTILLED_UNET,
          alt: [FLUX3_KLEIN_DISTILLED_UNET_BF16],
        },
        steps: 16,
        cfg: 1,
      },
    },
    // Base already runs the official 50 steps; past that is wasted time.
  },
  "flux3-distilled": {},
  "moss-image": {
    draft: { summary: "Fast preset, 10 steps", mossSpeed: "fast" },
    quality: { summary: "Full 50 steps", mossSpeed: "off" },
  },
  "h3-video": {
    draft: {
      summary: "8-step turbo LoRA; prompt clips 22 frames",
      h3Speed: "turbo8",
    },
  },
};

/** The plan for `engine` at `tier`; null = no effect (or Standard). */
export function resolveSpeedTier(
  engine: SpeedEngine | null | undefined,
  tier: SpeedTier | SpeedSetting | undefined,
): SpeedTierPlan | null {
  if (!engine || !tier) return null;
  const t = tier.toLowerCase();
  if (t !== "draft" && t !== "quality") return null;
  return SPEED_TIER_MAP[engine]?.[t] ?? null;
}

// Engine detection

const VIDEO_AUDIO_CKPT_RE =
  /ltx|stable_audio|audio|svd|wan|hunyuan|cogvideo|mochi|triposr/i;
const DISTILL_LORA_RE = /turbo|distill|lightning|\d-?step/i;

function nodes(workflow: Workflow) {
  return Object.values(workflow).filter(
    (n) => n && typeof n === "object" && typeof n.class_type === "string",
  );
}

function unetNames(workflow: Workflow): string[] {
  return nodes(workflow)
    .filter((n) => n.class_type === "UNETLoader")
    .map((n) => String(n.inputs?.unet_name ?? ""));
}

function loraNames(workflow: Workflow): string[] {
  return nodes(workflow)
    .filter(
      (n) =>
        n.class_type === "LoraLoaderModelOnly" || n.class_type === "LoraLoader",
    )
    .map((n) => String(n.inputs?.lora_name ?? ""));
}

const hasSampler = (workflow: Workflow) =>
  nodes(workflow).some((n) =>
    ["KSampler", "KSamplerAdvanced", "SamplerCustomAdvanced"].includes(
      n.class_type,
    ),
  );

/** Which speed mapping a built graph belongs to; null = none. */
export function detectSpeedEngine(workflow: Workflow): SpeedEngine | null {
  if (isH3Graph(workflow)) return "h3-video";
  if (isMossImageWorkflow(workflow)) return "moss-image";
  // Self-contained / remote generator nodes (SeFi, API partners) own their
  // sampling and have no sampler node: no mapping.
  if (!hasSampler(workflow)) return null;
  const unets = unetNames(workflow);
  const loras = loraNames(workflow);
  const distillLora = loras.some((l) => DISTILL_LORA_RE.test(l));

  if (nodes(workflow).some((n) => n.class_type === "Ideogram4Scheduler")) {
    return "ideogram4";
  }
  const krea2 = unets.find((u) => /krea2|krea-2/i.test(u));
  if (krea2) {
    return /turbo/i.test(krea2) || distillLora ? "krea2-turbo" : "krea2-raw";
  }
  if (unets.some((u) => /z[_-]?image.*turbo/i.test(u))) return "zimage-turbo";
  if (unets.some((u) => /qwen[_-]?image/i.test(u))) {
    return distillLora ? "qwen-image-turbo" : "qwen-image";
  }
  const flux3 = unets.find((u) => /flux3/i.test(u));
  if (flux3) {
    return /klein_sd|distill/i.test(flux3) || distillLora
      ? "flux3-distilled"
      : "flux3";
  }
  if (unets.some((u) => /anima/i.test(u))) return "anima";
  if (unets.length > 0) return null; // unknown diffusion model: no guess

  const ckpts = nodes(workflow)
    .filter((n) => n.class_type === "CheckpointLoaderSimple")
    .map((n) => String(n.inputs?.ckpt_name ?? ""));
  if (ckpts.length === 0) return null;
  if (ckpts.some((c) => VIDEO_AUDIO_CKPT_RE.test(c))) return null;
  return "checkpoint";
}

/**
 * Client-side guess from the selected workflow path (no graph loaded).
 * undefined = can't tell (a custom graph); null = known, no mapping.
 */
export function speedEngineForWorkflowPath(
  workflowPath: string | null | undefined,
): SpeedEngine | null | undefined {
  // No workflow selected: the stock checkpoint t2i graph.
  if (!workflowPath) return "checkpoint";
  const p = workflowPath.replace(/\\/g, "/").toLowerCase();
  const file = p.split("/").pop() ?? p;
  if (p.includes("packs/moss-image/")) return "moss-image";
  // H3 Image pins its Turbo 8-step LoRA: no tier mapping.
  if (p.endsWith("packs/minimax/t2i.json")) return null;
  if (p.includes("packs/minimax/")) return "h3-video";
  if (p.includes("packs/sefi/")) return null;
  if (p.includes("packs/krea2-raw/")) return "krea2-turbo"; // distill LoRA
  if (file.startsWith("krea2") || p.includes("packs/krea2")) {
    return "krea2-turbo";
  }
  if (file.startsWith("zimageturbo")) return "zimage-turbo";
  if (file.startsWith("ideogram4")) return "ideogram4";
  if (p.includes("packs/qwen-image-21/")) {
    return file.includes("turbo") ? "qwen-image-turbo" : "qwen-image";
  }
  if (p.includes("packs/flux3/")) {
    return file.includes("fast") ? "flux3-distilled" : "flux3";
  }
  if (p.includes("packs/anima/")) return "anima";
  if (p.includes("packs/sdxl/")) return "checkpoint";
  if (/^(t2i|i2i|remix_\w+|vary_\w+|inpaint|outpaint)\.json$/.test(file)) {
    return "checkpoint";
  }
  return undefined;
}

/**
 * Settings hint for the selected model: the plan summary, "No effect for
 * this model", or null when nothing needs saying (Standard / unknown graph).
 */
export function speedTierHint(
  engine: SpeedEngine | null | undefined,
  setting: unknown,
): string | null {
  const tier = normalizeSpeedSetting(setting);
  if (tier === "Standard" || engine === undefined) return null;
  const plan = resolveSpeedTier(engine, tier);
  return plan ? plan.summary : "No effect for this model";
}

// Server side

/** Explicit params that already pin the sampling speed. */
function pinnedBy(params: Record<string, unknown>): boolean {
  return (
    params.steps !== undefined || Boolean(params.draft) || Boolean(params.turbo)
  );
}

/** The tier a request asks for, ignoring Standard. */
export function requestedSpeedTier(
  params: Record<string, unknown>,
): Exclude<SpeedTier, "standard"> | undefined {
  const tier = parseSpeedTier(params.speedTier);
  return tier === "draft" || tier === "quality" ? tier : undefined;
}

/**
 * Files the Draft distilled variant needs for this graph (for the routes'
 * install check). Empty when the tier or engine has no distilled variant.
 */
export function speedTierDistilledFiles(
  workflow: Workflow,
  params: Record<string, unknown>,
): { loras: string[]; unets: string[]; alts: Record<string, string[]> } {
  const empty = { loras: [], unets: [], alts: {} };
  const tier = requestedSpeedTier(params);
  if (!tier || pinnedBy(params)) return empty;
  const d = resolveSpeedTier(detectSpeedEngine(workflow), tier)?.distilled;
  if (!d) return empty;
  return {
    loras: d.lora ? [d.lora.file] : [],
    unets: d.unet ? [d.unet.file] : [],
    alts: d.unet?.alt ? { [d.unet.file]: d.unet.alt } : {},
  };
}

/** MOSS preset for the requested tier; undefined = keep the default. */
export function mossSpeedForTier(
  params: Record<string, unknown>,
): MossSpeed | undefined {
  const tier = requestedSpeedTier(params);
  if (!tier || params.steps !== undefined) return undefined;
  return resolveSpeedTier("moss-image", tier)?.mossSpeed;
}

/** H3 speed for the requested tier; undefined = keep the pack recipe. */
export function h3SpeedForTier(
  params: Record<string, unknown>,
): H3Speed | undefined {
  const tier = requestedSpeedTier(params);
  if (!tier || params.steps !== undefined) return undefined;
  if (params.h3Speed != null || params.mossSpeed != null) return undefined;
  return resolveSpeedTier("h3-video", tier)?.h3Speed;
}

export interface SpeedTierTargets {
  stepsTargetId: string;
  cfgTargetId: string;
}

/**
 * Apply the step / variant part of the tier to a built graph in place
 * (MOSS and H3 go through their own option resolvers). Returns the plan it
 * applied, or null when it changed nothing.
 */
export function applySpeedTier(
  workflow: Workflow,
  targets: SpeedTierTargets,
  params: Record<string, unknown>,
): SpeedTierPlan | null {
  const tier = requestedSpeedTier(params);
  if (!tier || pinnedBy(params)) return null;
  const engine = detectSpeedEngine(workflow);
  if (engine === "moss-image" || engine === "h3-video") return null;
  const plan = resolveSpeedTier(engine, tier);
  if (!plan) return null;

  const stepsNode = workflow[targets.stepsTargetId];
  if (!stepsNode || typeof stepsNode.inputs?.steps !== "number") return null;

  const d = plan.distilled;
  if (d && params[SPEED_TIER_DISTILLED_PARAM] === true) {
    if (d.lora) {
      const unetId = Object.keys(workflow).find(
        (id) => workflow[id].class_type === "UNETLoader",
      );
      if (unetId) {
        insertModelLoras(workflow, unetId, [
          {
            file: d.lora.file,
            strength: d.lora.strength,
            title: "Draft speed LoRA",
          },
        ]);
      }
    }
    if (d.unet) {
      for (const node of nodes(workflow)) {
        if (node.class_type !== "UNETLoader") continue;
        const name = String(node.inputs.unet_name ?? "");
        if (d.unet.from.test(name)) {
          node.inputs.unet_name = name.replace(d.unet.from, d.unet.to);
        }
      }
    }
    stepsNode.inputs.steps = d.steps;
    const cfgNode = workflow[targets.cfgTargetId];
    if (params.cfg === undefined && cfgNode && "cfg" in cfgNode.inputs) {
      cfgNode.inputs.cfg = d.cfg;
    }
    return plan;
  }

  if (plan.stepsScale) {
    const base = stepsNode.inputs.steps as number;
    stepsNode.inputs.steps = Math.max(
      plan.minSteps ?? 1,
      Math.round(base * plan.stepsScale),
    );
    return plan;
  }
  return null;
}

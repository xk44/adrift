/**
 * MOSS-Image runtime options (applied to packs/moss-image t2i / i2i graphs).
 *
 * Speed presets follow MATLOWAI's TESTED stock-node recipe
 * (MOSS-Image-SFT-DeBand `moss_banding_fix_presets.json`), not "speed LoRA at
 * 1.0 + CFG 1": the distillation adapters' own cards say ComfyUI's stock LoRA
 * merge is inexact at full strength (their time-embedding / step-code parts
 * need the rapid-moss node), and full-strength output comes out soft / purple.
 * Partial strength + CFG 3 + ER-SDE keeps the base model in charge and just
 * shortens the schedule.
 *
 *  - `mossSpeed`:
 *      off      base pack recipe (50 steps, CFG 3, euler / sgm_uniform, SLG 22)
 *      balanced lodestones 8-step DMD LoRA, 14 steps
 *      fast     lodestones 8-step DMD LoRA, 10 steps
 *      fast4    darask0 4-step adapter, 10 steps ("Fast alt")
 *    Those three: banding-fix LoRA @1, CFG 3, er_sde / simple,
 *    TemporalScoreRescaling (k 0.95, sigma 1), SLG single layers "22, 24"
 *    over 0.1-0.7.
 *      turbo    lodestones' OWN recipe for their Base DMD LoRA: swaps the
 *               UNET to MOSS-Image-Base, DMD LoRA @1, 8 steps, CFG 1,
 *               euler / simple (shift 5 is already the pack's). No deband
 *               (that LoRA was trained on SFT) and no TSR. SLG stays in the
 *               graph but is inert at CFG 1 (no negative pass).
 *  - `deband`: MATLOWAI banding-fix LoRA (layers 37-41) @1 straight after the
 *    UNET. Implied by every SFT speed preset (pass `deband: false` to drop
 *    it); on its own it leaves the base sampler recipe alone.
 *  - `mossKrea2`: WAS/Krea2_MOSS_graft_lora r64 (TenStrip's MOSSkr2 graft of
 *    Krea 2 attention/MLP weights, extracted against SFT) @1 after deband.
 *    SFT only: its card says it is untested on Base, so turbo ignores it.
 *    Krea 2 Community License.
 *  - `mossPhotoreal`: Civitai "MOSS Photographic Realism" enhancement LoRA
 *    (r128, model 3021669 / file 3331776) @1 after the Krea 2 graft. The
 *    author's photographic fine-tune as a LoRA on SFT; SFT presets only.
 *
 * Strength note: the presets were tuned on lodestones `lora_latest` (0.28 /
 * 0.35). Our file is the original `lora.safetensors`, which lodestones'
 * card runs at 1.0 where `lora_latest` runs at 0.7, so the preset strengths
 * are scaled by 1/0.7 (0.40 / 0.50). darask0's adapter is the same file the
 * preset used (0.35).
 *
 * Runtime insertion (not *_fast graph copies): speed x deband would otherwise
 * need 8 graph variants per template.
 */
import type { Workflow } from "@/types";
import { insertModelLoras, nextNodeId, type LoraSpec } from "./loraInsert";

export type MossSpeed = "off" | "balanced" | "fast" | "fast4" | "turbo";

export const MOSS_SPEED_8_LORA = "moss_image_sft_8step_dmd.safetensors";
export const MOSS_SPEED_4_LORA = "moss_image_4step_adapter.safetensors";
export const MOSS_DEBAND_LORA =
  "moss_image_sft_banding_fix_L37-41_bf16.safetensors";
/** lodestones/MOSS-Image-Base-8-steps-dmd `lora.safetensors`, renamed. */
export const MOSS_BASE_DMD_LORA = "moss_image_base_8step_dmd.safetensors";
/** Comfy-Org/MOSS-Image `diffusion_models/moss_image_base_bf16.safetensors`. */
export const MOSS_BASE_UNET = "moss_image_base_bf16.safetensors";
/** WAS/Krea2_MOSS_graft_lora `krea2_moss_graft_lora_r64.safetensors`, renamed. */
export const MOSS_KREA2_GRAFT_LORA = "moss_image_sft_krea2_graft_r64.safetensors";
/** Civitai 3021669 "Enhancement LoRA" (file 3331776), its own file name. */
export const MOSS_PHOTOREAL_LORA = "mossPhotographic_sftInt810_3331776.safetensors";
/**
 * Native MOSS (UNETLoader) shift node. MOSS's model_sampling uses
 * multiplier 1.0; ModelSamplingSD3 re-patches it with multiplier 1000, which
 * double-scales the timestep and samples pure noise (ComfyUI #17119).
 * AuraFlow = same flow shift with multiplier 1.0.
 * (The OpenMOSS plugin's MOSSImageLoader is the opposite: multiplier 1000,
 * so colorize.json keeps ModelSamplingSD3.)
 */
export const MOSS_SAMPLING_NODE = "ModelSamplingAuraFlow";

export interface MossSpeedPreset {
  label: string;
  steps: number | null;
  lora: string | null;
  strength: number;
  /** Swap the UNET (diffusion_models file) for this preset. */
  unet?: string;
}

export const MOSS_SPEEDS: Record<MossSpeed, MossSpeedPreset> = {
  off: { label: "Off (50 steps)", steps: null, lora: null, strength: 0 },
  balanced: {
    label: "Balanced (14 steps)",
    steps: 14,
    lora: MOSS_SPEED_8_LORA,
    strength: 0.4,
  },
  fast: {
    label: "Fast (10 steps)",
    steps: 10,
    lora: MOSS_SPEED_8_LORA,
    strength: 0.5,
  },
  fast4: {
    label: "Fast alt (10 steps, 4-step adapter)",
    steps: 10,
    lora: MOSS_SPEED_4_LORA,
    strength: 0.35,
  },
  turbo: {
    label: "Turbo (Base + 8-step DMD, 8 steps, CFG 1)",
    steps: 8,
    lora: MOSS_BASE_DMD_LORA,
    strength: 1,
    unet: MOSS_BASE_UNET,
  },
};

/** lodestones' Base DMD recipe (model card): flow-matching Euler, CFG 1. */
export const MOSS_TURBO_RECIPE = {
  cfg: 1,
  sampler_name: "euler",
  scheduler: "simple",
} as const;

/** Sampler recipe shared by every speed preset (DeBand presets). */
export const MOSS_SPEED_RECIPE = {
  cfg: 3,
  sampler_name: "er_sde",
  scheduler: "simple",
  tsr: { tsr_k: 0.95, tsr_sigma: 1.0 },
  slg: { single_layers: "22, 24", start_percent: 0.1, end_percent: 0.7 },
} as const;

/**
 * Normalise a user/param value; undefined if unset/unknown. Legacy "8" /
 * "8-step" map to balanced and "4" / "4-step" to fast4.
 */
export function parseMossSpeed(value: unknown): MossSpeed | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const s = String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (["off", "none", "false", "0", "50", "base"].includes(s)) return "off";
  if (["balanced", "14", "8", "8-step", "8step"].includes(s)) return "balanced";
  if (["fast", "10"].includes(s)) return "fast";
  if (
    ["fast4", "fast-4", "fast-alt", "fastalt", "4", "4-step", "4step"].includes(
      s,
    )
  )
    return "fast4";
  if (["turbo", "dmd", "base-dmd", "basedmd", "base8"].includes(s))
    return "turbo";
  return undefined;
}

function flag(value: unknown): boolean | undefined {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value !== "string") return undefined;
  const s = value.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(s)) return true;
  if (["0", "false", "off", "no"].includes(s)) return false;
  return undefined;
}

/** Deband on: explicit flag wins, else implied by the SFT speed presets. */
export function wantsMossDeband(params: Record<string, unknown>): boolean {
  const explicit = flag(params.deband);
  if (explicit !== undefined) return explicit;
  const speed = parseMossSpeed(params.mossSpeed) ?? "off";
  return speed !== "off" && speed !== "turbo";
}

/** Krea 2 graft look: explicit flag, SFT graphs only (not turbo's Base UNET). */
export function wantsMossKrea2(params: Record<string, unknown>): boolean {
  if (flag(params.mossKrea2) !== true) return false;
  return (parseMossSpeed(params.mossSpeed) ?? "off") !== "turbo";
}

/** Photoreal LoRA: explicit flag, SFT graphs only (not turbo's Base UNET). */
export function wantsMossPhotoreal(params: Record<string, unknown>): boolean {
  if (flag(params.mossPhotoreal) !== true) return false;
  return (parseMossSpeed(params.mossSpeed) ?? "off") !== "turbo";
}

export function isMossImageWorkflow(workflow: Workflow): boolean {
  return Object.values(workflow).some(
    (n) =>
      n.class_type === "UNETLoader" &&
      /moss[_-]?image/i.test(String(n.inputs?.unet_name ?? "")),
  );
}

/** diffusion_models files the given params need beyond the pack graph's own. */
export function mossRequiredUnets(params: Record<string, unknown>): string[] {
  const unet = MOSS_SPEEDS[parseMossSpeed(params.mossSpeed) ?? "off"].unet;
  return unet ? [unet] : [];
}

/** LoRA files the given params need (for install checks). */
export function mossRequiredLoras(params: Record<string, unknown>): string[] {
  const out: string[] = [];
  const lora = MOSS_SPEEDS[parseMossSpeed(params.mossSpeed) ?? "off"].lora;
  if (lora) out.push(lora);
  if (wantsMossDeband(params)) out.push(MOSS_DEBAND_LORA);
  if (wantsMossKrea2(params)) out.push(MOSS_KREA2_GRAFT_LORA);
  if (wantsMossPhotoreal(params)) out.push(MOSS_PHOTOREAL_LORA);
  return out;
}

const findClass = (workflow: Workflow, cls: string) =>
  Object.keys(workflow).find((id) => workflow[id].class_type === cls);

/**
 * Apply speed / deband to a MOSS-Image graph in place. Model chain:
 * UNET -> [deband] -> [krea2 graft] -> [photoreal] -> [speed] -> ModelSamplingAuraFlow -> [TSR] -> SLG -> KSampler.
 * Speed presets set steps / cfg / sampler / scheduler on the KSampler unless
 * the caller pinned `steps` / `cfg` explicitly. Returns the inserted LoRA
 * node ids (deband first).
 */
export function applyMossImageOptions(
  workflow: Workflow,
  params: Record<string, unknown>,
): string[] {
  if (!isMossImageWorkflow(workflow)) return [];
  const speed = parseMossSpeed(params.mossSpeed) ?? "off";
  const deband = wantsMossDeband(params);
  const krea2 = wantsMossKrea2(params);
  const photoreal = wantsMossPhotoreal(params);
  if (speed === "off" && !deband && !krea2 && !photoreal) return [];

  const unetId = Object.keys(workflow).find(
    (id) =>
      workflow[id].class_type === "UNETLoader" &&
      /moss[_-]?image/i.test(String(workflow[id].inputs?.unet_name ?? "")),
  );
  if (!unetId) return [];

  const preset = MOSS_SPEEDS[speed];
  if (preset.unet) workflow[unetId].inputs.unet_name = preset.unet;
  const loras: LoraSpec[] = [];
  if (deband)
    loras.push({
      file: MOSS_DEBAND_LORA,
      strength: 1,
      title: "MOSS-Image DeBand (L37-41)",
    });
  if (krea2)
    loras.push({
      file: MOSS_KREA2_GRAFT_LORA,
      strength: 1,
      title: "Krea 2 graft (r64)",
    });
  if (photoreal)
    loras.push({
      file: MOSS_PHOTOREAL_LORA,
      strength: 1,
      title: "MOSS Photographic Realism (r128)",
    });
  if (preset.lora)
    loras.push({
      file: preset.lora,
      strength: preset.strength,
      title:
        speed === "fast4"
          ? "MOSS-Image 4-step adapter (partial)"
          : speed === "turbo"
            ? "MOSS-Image Base 8-step DMD"
            : "MOSS-Image 8-step DMD (partial)",
    });
  const ids = insertModelLoras(workflow, unetId, loras);
  const steps = typeof params.steps === "number" ? undefined : preset.steps ?? undefined;
  if (speed === "turbo") applyMossTurboRecipe(workflow, steps, params);
  else if (preset.steps !== null)
    applyMossSpeedRecipe(workflow, {
      steps,
      cfg: typeof params.cfg === "number" ? undefined : MOSS_SPEED_RECIPE.cfg,
    });
  return ids;
}

function applyMossTurboRecipe(
  workflow: Workflow,
  steps: number | undefined,
  params: Record<string, unknown>,
): void {
  const ks = findClass(workflow, "KSampler");
  if (!ks) return;
  const inputs = workflow[ks].inputs as Record<string, unknown>;
  if (steps !== undefined) inputs.steps = steps;
  if (typeof params.cfg !== "number") inputs.cfg = MOSS_TURBO_RECIPE.cfg;
  inputs.sampler_name = MOSS_TURBO_RECIPE.sampler_name;
  inputs.scheduler = MOSS_TURBO_RECIPE.scheduler;
}

/**
 * The DeBand speed-preset sampler recipe on a MOSS-Image graph: er_sde /
 * simple, SLG single layers 22,24 over 0.1-0.7, TemporalScoreRescaling before
 * SLG. `steps` / `cfg` are written only when given (callers that already set
 * them leave them undefined). Used by the imagine/action path above and by
 * the MOSS edit tools (src/lib/tools/editTools.ts).
 */
export function applyMossSpeedRecipe(
  workflow: Workflow,
  overrides: { steps?: number; cfg?: number } = {},
): void {
  const ks = findClass(workflow, "KSampler");
  if (ks) {
    const inputs = workflow[ks].inputs as Record<string, unknown>;
    if (overrides.steps !== undefined) inputs.steps = overrides.steps;
    if (overrides.cfg !== undefined) inputs.cfg = overrides.cfg;
    inputs.sampler_name = MOSS_SPEED_RECIPE.sampler_name;
    inputs.scheduler = MOSS_SPEED_RECIPE.scheduler;
  }

  const slg = findClass(workflow, "SkipLayerGuidanceDiTSimple");
  if (slg) {
    const slgInputs = workflow[slg].inputs as Record<string, unknown>;
    Object.assign(slgInputs, MOSS_SPEED_RECIPE.slg);
    if (!findClass(workflow, "TemporalScoreRescaling")) {
      const tsr = nextNodeId(workflow);
      workflow[tsr] = {
        class_type: "TemporalScoreRescaling",
        inputs: { model: slgInputs.model, ...MOSS_SPEED_RECIPE.tsr },
        _meta: { title: "Temporal Score Rescaling" },
      } as Workflow[string];
      slgInputs.model = [tsr, 0];
    }
  }
}

/**
 * Server-side install checks for the optional LoRAs (MOSS speed / deband and
 * the H3 extras). Kept apart from the pure option appliers so those stay
 * synchronous and import no filesystem code.
 */
import { listModelFiles } from "@/lib/tools/editTools";
import type { Workflow } from "@/types";
import { h3FlexLoraFor, requestedH3ExtraLoras } from "./h3Video";
import { h3FastUnetFor, h3SpeedLoraFor } from "./h3Speed";
import { backendLoraFiles, backendUnetFiles } from "@/lib/comfy/backendModels";
import {
  MOSS_DEBAND_LORA,
  MOSS_SPEED_4_LORA,
  MOSS_SPEED_8_LORA,
  MOSS_BASE_DMD_LORA,
  MOSS_BASE_UNET,
  mossRequiredLoras,
  mossRequiredUnets,
  parseMossSpeed,
  type MossSpeed,
} from "./mossImage";
import {
  SPEED_TIER_DISTILLED_PARAM,
  h3SpeedForTier,
  mossSpeedForTier,
  speedTierDistilledFiles,
} from "./speedTier";

export async function installedUnets(comfyRoot: string): Promise<Set<string>> {
  return listModelFiles(comfyRoot, "diffusion_models");
}

export async function installedLoras(comfyRoot: string): Promise<Set<string>> {
  return listModelFiles(comfyRoot, "loras");
}

const has = (installed: Set<string>, file: string) =>
  installed.has(file.replace(/\\/g, "/").toLowerCase());

/** "loras/<file>" hints for the files in `files` that are not installed. */
export function missingLoraFiles(
  installed: Set<string>,
  files: string[],
): string[] {
  return files.filter((f) => !has(installed, f)).map((f) => `loras/${f}`);
}

/**
 * Default MOSS speed: "balanced" when its LoRAs (8-step DMD + banding fix,
 * which every speed preset loads) are installed, else off.
 */
export function defaultMossSpeed(installed: Set<string>): MossSpeed {
  return has(installed, MOSS_SPEED_8_LORA) && has(installed, MOSS_DEBAND_LORA)
    ? "balanced"
    : "off";
}

export interface MossOptionCheck {
  /** Params with the default `mossSpeed` filled in. */
  params: Record<string, unknown>;
  /** Missing LoRAs for what was explicitly requested (empty = OK). */
  missing: string[];
}

/**
 * Fill the default speed (when the caller didn't choose one) and report
 * requested-but-missing LoRAs. An explicit request for a missing LoRA is an
 * error; a defaulted one silently falls back to "off".
 */
export async function resolveMossOptions(
  comfyRoot: string,
  params: Record<string, unknown>,
): Promise<MossOptionCheck> {
  const installed = await installedLoras(comfyRoot);
  const explicit = parseMossSpeed(params.mossSpeed);
  const next = { ...params };
  if (explicit === undefined) {
    // Speed tier (Draft / Quality) picks the preset when the user didn't;
    // a Draft preset whose LoRAs are missing falls back to the default.
    const tiered = mossSpeedForTier(params);
    next.mossSpeed =
      tiered &&
      missingLoraFiles(installed, mossRequiredLoras({ mossSpeed: tiered }))
        .length === 0
        ? tiered
        : defaultMossSpeed(installed);
  } else next.mossSpeed = explicit;
  const missing =
    explicit === undefined
      ? missingLoraFiles(
          installed,
          mossRequiredLoras({ ...next, mossSpeed: "off" }),
        )
      : missingLoraFiles(installed, mossRequiredLoras(next));
  const unets = mossRequiredUnets(next);
  if (unets.length > 0) {
    const have = await installedUnets(comfyRoot);
    for (const u of unets)
      if (!has(have, u)) missing.push(`diffusion_models/${u}`);
  }
  return { params: next, missing };
}

/**
 * LoRA files an H3 request adds on top of its graph (extras + speed LoRA,
 * plus the family-matched Flex LoRA when `workflow` is given).
 */
export function requestedH3LoraFiles(
  params: Record<string, unknown>,
  workflow?: Workflow,
): string[] {
  const files = requestedH3ExtraLoras(params).map((l) => l.file);
  const flex = workflow ? h3FlexLoraFor(workflow, params) : null;
  if (flex) files.push(flex.file);
  const turbo = workflow ? h3SpeedLoraFor(workflow, params) : null;
  if (turbo) files.push(turbo);
  return files;
}

/**
 * Where a job's model files are checked. `backendUrl` is the ComfyUI that will
 * run the job: its /object_info list wins, since the web host's COMFY_ROOT
 * can be another machine's disk (ComfyUI on a LAN box or remote GPU). An
 * unreachable backend falls back to the local folder unless `strict` (a
 * dedicated non-main host, where the local disk says nothing about it).
 */
export interface JobHost {
  backendUrl?: string;
  strict?: boolean;
}

async function filesOnHost(
  kind: "loras" | "diffusion_models",
  comfyRoot: string,
  host: JobHost | undefined,
): Promise<Set<string> | null> {
  if (host?.backendUrl) {
    const remote =
      kind === "loras"
        ? await backendLoraFiles(host.backendUrl)
        : await backendUnetFiles(host.backendUrl);
    if (remote || host.strict) return remote;
  }
  return kind === "loras" ? installedLoras(comfyRoot) : installedUnets(comfyRoot);
}

/**
 * Missing optional H3 LoRAs requested in `params`: motionRepair / handheld,
 * plus the h3Flex and h3Speed Turbo LoRAs when `workflow` is given (both
 * files depend on the graph family; Turbo is skipped when the graph already
 * has a speed LoRA). Checked on `host` (see JobHost).
 */
export async function missingH3ExtraLoras(
  comfyRoot: string,
  params: Record<string, unknown>,
  workflow?: Workflow,
  host?: JobHost,
): Promise<string[]> {
  const files = requestedH3LoraFiles(params, workflow);
  if (!files.length) return [];
  const have = await filesOnHost("loras", comfyRoot, host);
  return have ? missingLoraFiles(have, files) : files.map((f) => `loras/${f}`);
}

/**
 * `h3Speed: "fast8"` swaps in a FastH3 DiT: ["diffusion_models/<file>"] when
 * it is not on `host` (see JobHost). Empty when fast8 is a no-op for
 * `workflow`.
 */
export async function missingH3FastUnet(
  comfyRoot: string,
  params: Record<string, unknown>,
  workflow: Workflow,
  host?: JobHost,
): Promise<string[]> {
  const unet = h3FastUnetFor(workflow, params);
  if (!unet) return [];
  const have = await filesOnHost("diffusion_models", comfyRoot, host);
  return have && has(have, unet) ? [] : [`diffusion_models/${unet}`];
}

export {
  MOSS_BASE_DMD_LORA,
  MOSS_BASE_UNET,
  MOSS_DEBAND_LORA,
  MOSS_SPEED_4_LORA,
  MOSS_SPEED_8_LORA,
};

/**
 * Speed tier install checks (speedTier.ts). Returns the params to merge:
 * `_speedTierDistilled: true` when the Draft distilled variant's files exist
 * (else the engine falls back to fewer steps), and `h3Speed: "turbo8"` for
 * an H3 graph at Draft when its Turbo LoRA is installed. Never an error: a
 * tier is a preference, not an explicit request.
 */
export async function resolveSpeedTierParams(
  comfyRoot: string,
  workflow: Workflow,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const need = speedTierDistilledFiles(workflow, params);
  if (need.loras.length || need.unets.length) {
    const loras = need.loras.length ? await installedLoras(comfyRoot) : null;
    const unets = need.unets.length ? await installedUnets(comfyRoot) : null;
    const ok =
      need.loras.every((f) => loras && has(loras, f)) &&
      need.unets.every(
        (f) =>
          unets &&
          [f, ...(need.alts[f] ?? [])].some((name) => has(unets, name)),
      );
    if (ok) out[SPEED_TIER_DISTILLED_PARAM] = true;
  }
  const h3 = h3SpeedForTier(params);
  if (h3) {
    const lora = h3SpeedLoraFor(workflow, { ...params, h3Speed: h3 });
    if (lora && has(await installedLoras(comfyRoot), lora)) out.h3Speed = h3;
  }
  return out;
}

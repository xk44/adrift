/**
 * Memory hygiene for ComfyUI submits (pure, isomorphic: no fetch here).
 *
 *  - Free-on-switch: when the model family changes between submits, ask
 *    ComfyUI to unload (POST /free {unload_models, free_memory}) BEFORE the
 *    new /prompt is queued. ComfyUI's prompt worker consumes the flag after
 *    the currently running prompt, so ordering free -> queue is what matters.
 *  - Preflight: compare a rough per-pack peak footprint against
 *    GET /system_stats and warn before submit when a known-heavy pack won't fit.
 *  - Mac/MPS: unified memory, so system RAM (not "VRAM") is the budget; the
 *    Metal working-set cap defaults to ~75% of RAM.
 *
 * Per-pack estimate table (GiB, peak resident at ~1 MP, as shipped)
 * Derived from the shipped weights (diffusion + text encoder + VAE file sizes
 * in ComfyUI/models) plus ~10-15% activation/workspace headroom.
 * Deliberately rough: the point is "will this obviously not fit", not a model.
 *
 *  pack             weights (GiB)                         est   +/MP
 *  sd15             ~2 ckpt                                 4    0.5
 *  sdxl             ~6.9 ckpt                               8    1
 *  flux             ~12 unet fp8 + 9 t5 + vae               24   1.5
 *  ideogram4        2x nvfp4 unet + 8b nvfp4 TE             24   1.5
 *  zimage           ~12 unet + 8 qwen3-4b TE                22   1.5
 *  flux3            10 unet + 8.3 qwen3vl-4b                20   1.5
 *  krea2(-raw)      25 unet + 8.3 qwen3vl-4b + 0.25 vae     38   2
 *  krea2-edit       25 unet + 8.3 TE + ref latents          40   2
 *  krea2-draft      ~7 Q4 gguf + 4.5 fp8 TE                 14   1.5
 *  qwen-image-21    13 unet + 16 qwen3vl-8b                 32   2
 *  qwen-image-edit  38 unet + 8.7 qwen2.5vl-7b fp8          52   2
 *  moss-image       9.5 unet + 18 qwen3.5-9b                30   2
 *  ltxv             5.9 ckpt + 9.1 t5                       18   (video)
 *  wan              9.3 5B unet + 11 umt5 + vae             22   (video)
 *  minimax (H3)     37 unet + 48 qwen3vl-32b + 4.8 vae      95   (video)
 */

import { settingsVideoModel } from "@/lib/oj/videoDefault";

export interface PackMemoryEstimate {
  /** Peak resident GiB at ~1 MP. */
  gb: number;
  /** Extra GiB per megapixel above 1 MP (image packs). */
  perMpGb?: number;
  /** Family group used for switch detection (shared weights = same group). */
  group: string;
}

export const PACK_MEMORY_ESTIMATES: Readonly<
  Record<string, PackMemoryEstimate>
> = {
  sd15: { gb: 4, perMpGb: 0.5, group: "sd" },
  sdxl: { gb: 8, perMpGb: 1, group: "sd" },
  flux: { gb: 24, perMpGb: 1.5, group: "flux" },
  ideogram4: { gb: 24, perMpGb: 1.5, group: "ideogram4" },
  zimage: { gb: 22, perMpGb: 1.5, group: "zimage" },
  flux3: { gb: 20, perMpGb: 1.5, group: "flux3" },
  krea2: { gb: 38, perMpGb: 2, group: "krea2" },
  "krea2-raw": { gb: 38, perMpGb: 2, group: "krea2" },
  "krea2-edit": { gb: 40, perMpGb: 2, group: "krea2" },
  "krea2-draft": { gb: 14, perMpGb: 1.5, group: "krea2" },
  "qwen-image-21": { gb: 32, perMpGb: 2, group: "qwen-image-21" },
  "qwen-image-edit": { gb: 52, perMpGb: 2, group: "qwen-image-edit" },
  "moss-image": { gb: 30, perMpGb: 2, group: "moss-image" },
  ltxv: { gb: 18, group: "ltxv" },
  // 22B int8 DiT (21.5 GB) + Gemma 4 12B int8 encoder (15.4 GB) + VAEs/upscaler.
  ltx25: { gb: 40, group: "ltx25" },
  wan: { gb: 22, group: "wan" },
  minimax: { gb: 95, group: "minimax" },
};

/** Packs heavy enough that the preflight warns (everything except SD-class). */
export const HEAVY_PACK_MIN_GB = 12;

/** Metal working-set cap as a fraction of unified RAM (macOS default ~75%). */
export const MPS_WORKING_SET_FRACTION = 0.75;

/** Below this much usable accelerator memory we treat the box as low-VRAM. */
export const LOW_VRAM_CAPACITY_GB = 12;

const GiB = 1024 ** 3;

// system_stats parsing

export interface MemorySnapshot {
  /** "cuda" | "mps" | "cpu" | other torch device type */
  deviceType: string;
  deviceName?: string;
  /** Unified memory (Apple Silicon): RAM is the accelerator budget. */
  unified: boolean;
  /** Usable accelerator capacity in GiB (MPS: RAM x working-set fraction). */
  capacityGb: number;
  /** Free accelerator memory right now in GiB (MPS: free RAM). */
  freeGb: number;
  ramTotalGb: number;
  ramFreeGb: number;
}

type AnyRecord = Record<string, unknown>;

function n(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Parse either raw ComfyUI GET /system_stats (snake_case) or Adrift's
 * GET /api/comfy/system (camelCase) into a memory snapshot.
 */
export function parseSystemStats(raw: unknown): MemorySnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as AnyRecord;
  const sys = (r.system ?? {}) as AnyRecord;
  const devices = Array.isArray(r.devices) ? (r.devices as AnyRecord[]) : [];
  const dev = devices[0] ?? {};
  const ramTotal = n(sys.ram_total) ?? n(sys.ramTotal);
  const ramFree = n(sys.ram_free) ?? n(sys.ramFree);
  const vramTotal = n(dev.vram_total) ?? n(dev.vramTotal);
  const vramFree = n(dev.vram_free) ?? n(dev.vramFree);
  const deviceType = String(dev.type ?? (devices.length ? "unknown" : "cpu"));
  const os = String(sys.os ?? "");
  if (ramTotal === undefined && vramTotal === undefined) return null;

  const unified =
    deviceType === "mps" || (os === "darwin" && deviceType !== "cuda");
  const ramTotalGb = (ramTotal ?? 0) / GiB;
  const ramFreeGb = (ramFree ?? 0) / GiB;
  if (unified || deviceType === "cpu") {
    return {
      deviceType,
      deviceName: typeof dev.name === "string" ? dev.name : undefined,
      unified,
      capacityGb: unified ? ramTotalGb * MPS_WORKING_SET_FRACTION : ramTotalGb,
      freeGb: ramFreeGb,
      ramTotalGb,
      ramFreeGb,
    };
  }
  return {
    deviceType,
    deviceName: typeof dev.name === "string" ? dev.name : undefined,
    unified: false,
    capacityGb: (vramTotal ?? 0) / GiB,
    freeGb: (vramFree ?? 0) / GiB,
    ramTotalGb,
    ramFreeGb,
  };
}

// Estimates + preflight

export function estimatePackMemoryGb(
  packId: string,
  megapixels = 1,
): number | undefined {
  const est = PACK_MEMORY_ESTIMATES[packId];
  if (!est) return undefined;
  const extraMp = Math.max(0, megapixels - 1);
  return Math.round((est.gb + extraMp * (est.perMpGb ?? 0)) * 10) / 10;
}

export type PreflightLevel = "ok" | "tight" | "exceeds" | "unknown";

export interface PreflightResult {
  level: PreflightLevel;
  packId?: string;
  estimateGb?: number;
  freeGb?: number;
  capacityGb?: number;
  unified?: boolean;
  /** Suggest tiled VAE decode (small card or tight memory). */
  lowVram: boolean;
  message?: string;
}

/**
 * - exceeds: estimate > usable capacity (CUDA VRAM total / MPS working set).
 *   CUDA will partially offload (slow); MPS risks swap/kernel watchdog.
 * - tight: fits capacity but not what's free now. Skipped when the same
 *   family is already resident (its weights ARE the "used" memory).
 * Only packs >= HEAVY_PACK_MIN_GB warn; SD-class never nags.
 */
export function preflightMemory(
  snapshot: MemorySnapshot | null,
  packId: string | undefined,
  opts: { megapixels?: number; sameFamilyResident?: boolean } = {},
): PreflightResult {
  const lowCapacity =
    !!snapshot &&
    snapshot.capacityGb > 0 &&
    snapshot.capacityGb < LOW_VRAM_CAPACITY_GB;
  if (!snapshot || !packId)
    return { level: "unknown", packId, lowVram: lowCapacity };
  const estimateGb = estimatePackMemoryGb(packId, opts.megapixels ?? 1);
  const base = {
    packId,
    estimateGb,
    freeGb: Math.round(snapshot.freeGb * 10) / 10,
    capacityGb: Math.round(snapshot.capacityGb * 10) / 10,
    unified: snapshot.unified,
  };
  if (estimateGb === undefined)
    return { level: "unknown", ...base, lowVram: lowCapacity };
  const what = snapshot.unified ? "unified memory" : "VRAM";
  if (estimateGb < HEAVY_PACK_MIN_GB)
    return { level: "ok", ...base, lowVram: lowCapacity };
  if (estimateGb > snapshot.capacityGb) {
    return {
      level: "exceeds",
      ...base,
      lowVram: true,
      message:
        `${packId} needs ~${estimateGb} GB but this machine has ~${base.capacityGb} GB usable ${what}` +
        (snapshot.unified
          ? " (Metal working-set cap). Expect heavy swapping or a crash."
          : ". ComfyUI will offload to RAM — expect it to be very slow."),
    };
  }
  if (!opts.sameFamilyResident && estimateGb > snapshot.freeGb) {
    return {
      level: "tight",
      ...base,
      lowVram: true,
      message: `${packId} needs ~${estimateGb} GB; only ~${base.freeGb} GB ${what} free. Other models will be evicted first.`,
    };
  }
  return { level: "ok", ...base, lowVram: lowCapacity };
}

// Free-on-switch

export function packFamilyGroup(
  packId: string | undefined | null,
): string | undefined {
  if (!packId) return undefined;
  return PACK_MEMORY_ESTIMATES[packId]?.group ?? packId;
}

/** True only on an actual family switch (both known, different groups). */
export function shouldFreeOnSwitch(
  previousPackId: string | undefined | null,
  nextPackId: string | undefined | null,
  enabled = true,
): boolean {
  if (!enabled) return false;
  const prev = packFamilyGroup(previousPackId);
  const next = packFamilyGroup(nextPackId);
  return Boolean(prev && next && prev !== next);
}

/** Body ComfyUI's POST /free expects for a full unload. */
export const FREE_MEMORY_BODY = Object.freeze({
  unload_models: true,
  free_memory: true,
});

// Pack resolution for the client (mirrors the imagine route's routing)

const FILE_TO_PACK: Array<[RegExp, string]> = [
  [/(^|\/)krea2_draft\.json$/, "krea2-draft"],
  [/(^|\/)krea2_[^/]*\.json$/, "krea2"],
  [/(^|\/)ideogram4[^/]*\.json$/, "ideogram4"],
  [/(^|\/)zimageturbo\.json$/, "zimage"],
  [/(^|\/)wan22?_[^/]*\.json$/, "wan"],
];

/**
 * Best-effort pack id for a submit, from the same inputs the imagine route
 * uses: explicit --packId, --video (+ --vmodel), the workflow path
 * (packs/<id>/...), or the checkpoint family. Returns undefined for
 * user/saved/overlay graphs we can't classify (no preflight then).
 */
export function resolveSubmitPackId(input: {
  params: Record<string, unknown>;
  workflowPath?: string | null;
  checkpointFamilyToPack?: (checkpoint: string) => string | undefined;
  defaultVideoPack?: string;
}): string | undefined {
  const { params, workflowPath } = input;
  const str = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const explicit = str(params.packId) ?? str(params.pack_id);
  if (params.video) {
    return (
      explicit ?? str(params.vmodel) ?? settingsVideoModel(input.defaultVideoPack)
    );
  }
  if (explicit) return explicit;
  if (workflowPath) {
    const m = /(?:^|\/)packs\/([^/]+)\//.exec(workflowPath);
    if (m) return m[1];
    for (const [re, id] of FILE_TO_PACK) if (re.test(workflowPath)) return id;
    if (
      /^(saved:|__overlay__\/)/.test(workflowPath) ||
      workflowPath.startsWith("/")
    ) {
      return undefined;
    }
  }
  const model = str(params.model);
  if (model && input.checkpointFamilyToPack)
    return input.checkpointFamilyToPack(model);
  return undefined;
}

/**
 * "Will this model file run on this ComfyUI?" Single source of truth for the
 * first-run wizard's pack chips and (later) the Explore "Compatible with my
 * GPU" filter, best-quant badges and Civitai workflow model overrides.
 *
 * Pure: no React, no fetch, no Node APIs. Feed it the backend's
 * /system_stats (snake_case from ComfyUI or the camelCase /api/comfy/system
 * shape) and a file name / size / format hint.
 *
 * Units: memory is compared in bytes and reported in GiB ("GB" in copy, the
 * way GPU vendors and torch report VRAM: a 24 GB card is ~23.8 GiB).
 *
 * Everything here is a conservative ballpark, not a promise: ComfyUI offloads
 * text encoders / VAEs between stages and can stream weights from system RAM
 * when VRAM runs out (slow but it works), which is what "tight" means.
 */

const GiB = 1024 ** 3;

// Backend profile

export type DeviceKind = "cuda" | "rocm" | "mps" | "xpu" | "cpu" | "unknown";

/** GPU generation, inferred from the device name. */
export type GpuArch =
  | "blackwell"
  | "hopper"
  | "ada"
  | "ampere"
  | "turing"
  | "older_nvidia"
  | "amd"
  | "apple"
  | "intel"
  | "cpu"
  | "unknown";

export interface BackendProfile {
  device: DeviceKind;
  arch: GpuArch;
  /** Device name as ComfyUI reports it (e.g. "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync"). */
  gpuName?: string;
  /** Short display name ("NVIDIA GeForce RTX 4090", "Apple GPU"). */
  displayName: string;
  /** VRAM (or, on Apple / CPU, system RAM) in bytes. */
  memoryTotalBytes: number;
  memoryFreeBytes?: number;
  /** Shares system RAM with the CPU (Apple Silicon). */
  unified: boolean;
  /** What a model may realistically use, in bytes (unified: a fraction of RAM). */
  usableBytes: number;
  ramTotalBytes?: number;
  comfyuiVersion?: string;
  os?: string;
  supports: {
    /** Fast native fp8 math (compute capability >= 8.9). */
    fp8Compute: boolean;
    /** fp8 weights load at all (upcast to bf16/fp16 when no native fp8). */
    fp8Load: boolean;
    /** Native fp4 (nvfp4 / mxfp4): Blackwell only. */
    fp4: boolean;
    /** CUDA-only kernels: SVDQuant (Nunchaku), AWQ. */
    cudaKernels: boolean;
    bf16: boolean;
  };
}

/**
 * Apple Silicon: a model can use roughly this share of unified memory before
 * macOS starts swapping (the GPU working-set limit is ~70-75% of RAM and the
 * OS + browser + Adrift need the rest). Deliberately a bit below memory.ts's
 * 0.75 (that one sizes a single job; this one decides what we recommend).
 */
export const MPS_USABLE_FRACTION = 0.7;

/** Guess the NVIDIA / AMD / Intel generation from a device name. */
export function inferGpuArch(
  name: string | undefined,
  device: DeviceKind,
): GpuArch {
  if (device === "mps") return "apple";
  if (device === "cpu") return "cpu";
  const n = (name ?? "").toLowerCase();
  if (!n) return "unknown";
  if (/\b(amd|radeon|instinct|gfx\d)/.test(n)) return "amd";
  if (/\b(intel|arc\b|xpu)/.test(n)) return "intel";
  // Order: newest first, so "RTX PRO 6000 Blackwell" is not read as Ada.
  if (
    /blackwell|\brtx\s*50\d0|\b(gb|b)(100|200|300)\b|\brtx pro \d{4}\b(?! ada)|\bdgx spark\b|\bgb10\b|\bthor\b/.test(
      n,
    )
  )
    return "blackwell";
  if (/\b(h100|h200|gh200|h800|h20)\b/.test(n)) return "hopper";
  if (/\brtx\s*40\d0|\b(l4|l40s?|l20)\b|\brtx \d{4} ada|\bada\b/.test(n))
    return "ada";
  if (
    /\brtx\s*30\d0|\ba(100|800|10g?|16|30|40|2)\b|\brtx a\d{4}|\ba\d{4}\b|\bjetson orin/.test(
      n,
    )
  )
    return "ampere";
  if (/\brtx\s*20\d0|\btitan rtx|\bgtx\s*16\d0|\bt4\b|\bquadro rtx/.test(n))
    return "turing";
  if (/\b(gtx|titan|tesla|quadro|v100|p100|p40|k80)\b/.test(n))
    return "older_nvidia";
  if (/nvidia|geforce|cuda/.test(n)) return "unknown";
  return "unknown";
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync" -> "NVIDIA GeForce RTX 4090". */
export function cleanDeviceName(
  name: string | undefined,
  device: DeviceKind,
): string {
  if (device === "mps") return "Apple GPU";
  if (device === "cpu") return "CPU only";
  if (!name) return "GPU";
  return (
    name
      .replace(/^(cuda|xpu|mps|cpu)(:\d+)?\s*/i, "")
      .replace(/\s*:\s*(cudaMallocAsync|native|[\w-]+Allocator)\s*$/i, "")
      .trim() || name
  );
}

/**
 * Build a profile from ComfyUI's /system_stats (or the camelCase
 * /api/comfy/system body). Returns null when the payload has no memory info.
 */
export function profileFromSystemStats(raw: unknown): BackendProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const sys = (r.system ?? {}) as Record<string, unknown>;
  const devices = Array.isArray(r.devices)
    ? (r.devices as Record<string, unknown>[])
    : [];
  const dev = devices[0] ?? {};
  const ramTotal = num(sys.ram_total) ?? num(sys.ramTotal);
  const vramTotal = num(dev.vram_total) ?? num(dev.vramTotal);
  const vramFree = num(dev.vram_free) ?? num(dev.vramFree);
  const ramFree = num(sys.ram_free) ?? num(sys.ramFree);
  if (ramTotal === undefined && vramTotal === undefined) return null;
  const name = typeof dev.name === "string" ? dev.name : undefined;
  const os = typeof sys.os === "string" ? sys.os : undefined;
  const rawType = String(
    dev.type ?? (devices.length ? "unknown" : "cpu"),
  ).toLowerCase();
  let device: DeviceKind =
    rawType === "cuda" ||
    rawType === "mps" ||
    rawType === "xpu" ||
    rawType === "cpu"
      ? rawType
      : "unknown";
  // ROCm builds of torch report type "cuda".
  if (device === "cuda" && /\b(amd|radeon|instinct|gfx\d)/i.test(name ?? ""))
    device = "rocm";
  if (device === "unknown" && os === "darwin") device = "mps";
  const arch = inferGpuArch(name, device);
  const unified = device === "mps";
  const memoryTotalBytes =
    unified || device === "cpu"
      ? (ramTotal ?? vramTotal ?? 0)
      : (vramTotal ?? 0);
  const memoryFreeBytes = unified || device === "cpu" ? ramFree : vramFree;
  const usableBytes = unified
    ? memoryTotalBytes * MPS_USABLE_FRACTION
    : memoryTotalBytes;
  const isNvidia = device === "cuda";
  const fp8Compute =
    isNvidia && (arch === "ada" || arch === "hopper" || arch === "blackwell");
  const version =
    typeof sys.comfyui_version === "string"
      ? sys.comfyui_version
      : typeof sys.comfyuiVersion === "string"
        ? sys.comfyuiVersion
        : undefined;
  return {
    device,
    arch,
    gpuName: name,
    displayName: cleanDeviceName(name, device),
    memoryTotalBytes,
    memoryFreeBytes,
    unified,
    usableBytes,
    ramTotalBytes: ramTotal,
    comfyuiVersion: version,
    os,
    supports: {
      fp8Compute,
      // MPS cannot hold fp8 tensors at all. CUDA/ROCm/CPU upcast fp8 weights.
      fp8Load: device !== "mps" && device !== "xpu",
      fp4: isNvidia && arch === "blackwell",
      cudaKernels: isNvidia && arch !== "older_nvidia",
      bf16: device !== "cpu" && arch !== "older_nvidia",
    },
  };
}

/** Memory in whole GB for copy ("24 GB"). */
export function memoryGb(profile: BackendProfile): number {
  return Math.round(profile.memoryTotalBytes / GiB);
}

// Quantization

export type QuantKind =
  "float" | "fp8" | "int8" | "fp4" | "svdq" | "awq" | "gguf" | "unknown";

export interface QuantInfo {
  kind: QuantKind;
  /** Normalized id: "bf16", "fp8_e4m3fn", "fp8_scaled", "int8", "nvfp4", "gguf_q4_k_m", ... */
  id: string;
  /** Approximate bits per weight. */
  bits: number;
  /** Relative output quality, higher is better (only used for ranking). */
  quality: number;
  /** Node pack ComfyUI needs to load this format, if any. */
  needsNodePack?: string;
}

/** GGUF quant -> [bits per weight, quality]. */
const GGUF_TABLE: Record<string, [number, number]> = {
  f32: [32, 99],
  f16: [16, 94],
  bf16: [16, 94],
  q8_0: [8.5, 90],
  q6_k: [6.6, 80],
  q5_k_m: [5.7, 72],
  q5_k_s: [5.5, 71],
  q5_k: [5.6, 71],
  q5_1: [6, 70],
  q5_0: [5.5, 69],
  q4_k_m: [4.8, 62],
  q4_k_s: [4.6, 61],
  q4_k: [4.7, 61],
  q4_1: [5, 60],
  q4_0: [4.5, 59],
  iq4_xs: [4.3, 58],
  iq4_nl: [4.5, 58],
  q3_k_l: [4.3, 45],
  q3_k_m: [3.9, 44],
  q3_k_s: [3.5, 42],
  q3_k: [3.9, 43],
  iq3_xxs: [3.1, 38],
  iq3_s: [3.4, 40],
  q2_k: [2.6, 25],
  iq2_xs: [2.3, 20],
  iq2_xxs: [2.1, 18],
};

/**
 * Detect the weight format from a file name (and optional metadata hint such
 * as Civitai's `metadata.fp` / `metadata.format`). Unknown stays "unknown".
 */
export function detectQuant(fileName: string, hint?: string): QuantInfo {
  const f = `${fileName} ${hint ?? ""}`.toLowerCase().replace(/\\/g, "/");
  const isGguf = /\.gguf\b/.test(f) || /\bgguf\b/.test(f);
  if (isGguf) {
    const m =
      /(?:^|[^a-z0-9])(i?q[2-8](?:_k)?(?:_[a-z0-9]+)?|f16|bf16|f32)(?=[^a-z0-9]|$)/.exec(
        f.replace(/-/g, "_"),
      );
    const key = m?.[1] ?? "";
    const entry =
      GGUF_TABLE[key] ??
      GGUF_TABLE[key.replace(/_[a-z]$/, "")] ??
      (key ? [Number(key.match(/q(\d)/)?.[1] ?? 4) + 0.5, 50] : undefined);
    return {
      kind: "gguf",
      id: key ? `gguf_${key}` : "gguf",
      bits: entry?.[0] ?? 4.5,
      quality: entry?.[1] ?? 50,
      needsNodePack: "ComfyUI-GGUF",
    };
  }
  const has = (re: RegExp) => re.test(f);
  if (has(/svdq|nunchaku/)) {
    const fp4 = has(/fp4/);
    return {
      kind: "svdq",
      id: fp4 ? "svdq_fp4" : "svdq_int4",
      bits: 4.3,
      quality: 58,
      needsNodePack: "ComfyUI-nunchaku",
    };
  }
  if (has(/(^|[^a-z])awq([^a-z]|$)|w4a16/))
    return { kind: "awq", id: "awq", bits: 4.3, quality: 55 };
  if (has(/nvfp4/)) return { kind: "fp4", id: "nvfp4", bits: 4.5, quality: 62 };
  if (has(/mxfp4/)) return { kind: "fp4", id: "mxfp4", bits: 4.3, quality: 60 };
  if (has(/w4a8/)) return { kind: "fp4", id: "w4a8", bits: 4.5, quality: 58 };
  if (has(/fp8|float8|f8_?e4m3|f8_?e5m2|e4m3fn|e5m2/)) {
    const scaled = has(/scaled|mixed/);
    const e5 = has(/e5m2/);
    return {
      kind: "fp8",
      id: scaled ? "fp8_scaled" : e5 ? "fp8_e5m2" : "fp8_e4m3fn",
      bits: 8,
      quality: scaled ? 88 : 86,
    };
  }
  if (has(/(^|[^a-z0-9])int8([^a-z0-9]|$)|int8_convrot|int8-convrot|w8a8/))
    return { kind: "int8", id: "int8", bits: 8, quality: 86 };
  if (has(/(^|[^a-z0-9])(bf16)([^a-z0-9]|$)/))
    return { kind: "float", id: "bf16", bits: 16, quality: 95 };
  if (has(/(^|[^a-z0-9])(fp16|f16|half)([^a-z0-9]|$)/))
    return { kind: "float", id: "fp16", bits: 16, quality: 95 };
  if (has(/(^|[^a-z0-9])(fp32|f32|full)([^a-z0-9]|$)/))
    return { kind: "float", id: "fp32", bits: 32, quality: 96 };
  return { kind: "unknown", id: "unknown", bits: 16, quality: 70 };
}

// Size heuristic

/** What role a file plays; drives the activation overhead. */
export type ModelRole =
  | "image" // diffusion model / UNET for stills
  | "video" // video diffusion model
  | "audio"
  | "checkpoint" // all-in-one (UNET + text encoder + VAE)
  | "text_encoder"
  | "vae"
  | "upscale"
  | "lora"
  | "other";

/**
 * Peak memory ≈ weights × factor + fixed GiB. Conservative on purpose: we would
 * rather say "tight" for something that runs than "fits" for something that
 * swaps. Sources: observed ComfyUI peaks on a 4090 / M-series at 1 MP images
 * and short (≈5 s, 720p) clips.
 */
export const OVERHEAD: Record<
  ModelRole,
  { factor: number; fixedGb: number; note: string }
> = {
  image: { factor: 1.15, fixedGb: 1.0, note: "1 MP latents + attention" },
  video: {
    factor: 1.3,
    fixedGb: 2.5,
    note: "many frames of latents; activations dominate",
  },
  audio: { factor: 1.2, fixedGb: 0.75, note: "short clips" },
  // Checkpoints bundle text encoders + VAE that ComfyUI offloads after use.
  checkpoint: {
    factor: 0.95,
    fixedGb: 0.75,
    note: "TE/VAE part offloads after encode",
  },
  text_encoder: {
    factor: 1.05,
    fixedGb: 0.5,
    note: "runs once per prompt, then offloads",
  },
  vae: {
    factor: 1.0,
    fixedGb: 1.5,
    note: "decode peak; tiled decode lowers it",
  },
  upscale: { factor: 1.0, fixedGb: 1.5, note: "tiled" },
  // A LoRA rides on a base model; on its own it needs almost nothing.
  lora: { factor: 1.0, fixedGb: 0.1, note: "added to its base model" },
  other: { factor: 1.15, fixedGb: 1.0, note: "unknown role" },
};

/** Map a family / base-model string (Civitai baseModel, repo name) to a role. */
export function roleForFamily(
  family: string | undefined,
): ModelRole | undefined {
  if (!family) return undefined;
  const f = family.toLowerCase();
  if (
    /\b(wan|ltx|ltxv|hunyuan ?video|mochi|cogvideo|svd|video|animatediff|kandinsky ?5|skyreels)\b/.test(
      f,
    )
  )
    return "video";
  if (/\b(stable[ _-]?audio|ace[ _-]?step|audio|musicgen|tts)\b/.test(f))
    return "audio";
  if (/\b(esrgan|upscal|seedvr|swinir|4x|2x)\b/.test(f)) return "upscale";
  if (/\b(t5|clip|umt5|gemma|qwen.*(vl|text)|text.?encoder|llm)\b/.test(f))
    return "text_encoder";
  if (/\bvae\b/.test(f)) return "vae";
  if (/\blora\b/.test(f)) return "lora";
  return "image";
}

export interface ModelCandidate {
  fileName: string;
  /** File size in bytes when known (Civitai sizeKB * 1024, HF siblings size). */
  bytes?: number | null;
  /** Format hint (Civitai metadata.fp / metadata.format, "gguf", "fp8", ...). */
  formatHint?: string;
  role?: ModelRole;
  /** Base family ("Flux.1 D", "Wan Video 14B", "SDXL 1.0", "ltx-2.5"). */
  family?: string;
}

export type CompatVerdict =
  "fits" | "tight" | "too_big" | "unsupported" | "unknown";

export interface CompatResult {
  verdict: CompatVerdict;
  /** One plain-language line for the UI. */
  reason: string;
  /** Ballpark peak memory in GiB, null when the size is unknown. */
  estimatedVramGB: number | null;
  quant: QuantInfo;
  role: ModelRole;
}

/** Fits when the estimate is at most this share of usable memory. */
export const FIT_FRACTION = 0.9;
/**
 * Up to this share it still runs: CUDA streams weights from system RAM
 * (slower); Apple has no such offload, so past usable memory macOS swaps.
 */
export const TIGHT_FRACTION_CUDA = 1.3;
export const TIGHT_FRACTION_UNIFIED = 1.1;

export function estimateVramGb(bytes: number, role: ModelRole): number {
  const o = OVERHEAD[role];
  return Math.round(((bytes / GiB) * o.factor + o.fixedGb) * 10) / 10;
}

function roleFromName(fileName: string): ModelRole | undefined {
  const f = fileName.toLowerCase().replace(/\\/g, "/");
  if (/(^|\/)loras?\//.test(f) || /lora/.test(f)) return "lora";
  if (/(^|\/)(text_encoders|clip)\//.test(f)) return "text_encoder";
  if (/(^|\/)vae\//.test(f) || /[_-]vae[_.-]/.test(f)) return "vae";
  if (/(^|\/)(upscale_models|latent_upscale_models)\//.test(f))
    return "upscale";
  if (/(^|\/)checkpoints\//.test(f)) return "checkpoint";
  return undefined;
}

/** Can this backend load this format at all? Returns a reason when not. */
function formatBlocker(q: QuantInfo, p: BackendProfile): string | null {
  if (q.kind === "fp8" && !p.supports.fp8Load)
    return p.device === "mps"
      ? "fp8 isn't supported on Apple GPUs — pick a GGUF or bf16 file."
      : "This GPU can't load fp8 files — pick a GGUF or fp16 file.";
  if (q.kind === "fp4" && !p.supports.fp4)
    return "fp4 files need an NVIDIA RTX 50-series (Blackwell) GPU — pick fp8, GGUF or bf16.";
  if ((q.kind === "svdq" || q.kind === "awq") && !p.supports.cudaKernels)
    return p.device === "mps"
      ? "This format needs an NVIDIA GPU — pick a GGUF or bf16 file."
      : "This format needs a recent NVIDIA GPU — pick a GGUF or fp16 file.";
  if (q.kind === "svdq" && q.id === "svdq_fp4" && !p.supports.fp4)
    return "This fp4 file needs an RTX 50-series GPU — pick the int4 version.";
  return null;
}

/** Judge one file against one backend. */
export function checkCompat(
  c: ModelCandidate,
  p: BackendProfile,
): CompatResult {
  const quant = detectQuant(c.fileName, c.formatHint);
  const role =
    c.role ?? roleFromName(c.fileName) ?? roleForFamily(c.family) ?? "other";
  const blocker = formatBlocker(quant, p);
  const bytes = typeof c.bytes === "number" && c.bytes > 0 ? c.bytes : null;
  const est = bytes === null ? null : estimateVramGb(bytes, role);
  if (blocker)
    return {
      verdict: "unsupported",
      reason: blocker,
      estimatedVramGB: est,
      quant,
      role,
    };
  if (est === null)
    return {
      verdict: "unknown",
      reason: "Size unknown, so we can't tell if it fits.",
      estimatedVramGB: null,
      quant,
      role,
    };
  const usableGb = p.usableBytes / GiB;
  const memWord = p.unified ? "memory" : p.device === "cpu" ? "RAM" : "VRAM";
  const have = `${Math.round(usableGb)} GB`;
  const tightLimit = p.unified ? TIGHT_FRACTION_UNIFIED : TIGHT_FRACTION_CUDA;
  let verdict: CompatVerdict;
  let reason: string;
  if (est <= usableGb * FIT_FRACTION) {
    verdict = "fits";
    reason = `Needs about ${est} GB; you have ${have} of ${memWord}${p.unified ? " for models" : ""}.`;
  } else if (est <= usableGb * tightLimit) {
    verdict = "tight";
    reason = p.unified
      ? `Needs about ${est} GB of the ~${have} available — it may run slowly or swap.`
      : `Needs about ${est} GB; you have ${have} of ${memWord}. It runs, but slower (parts move to system RAM).`;
  } else {
    verdict = "too_big";
    reason = `Needs about ${est} GB, more than your ${have} of ${memWord}. Pick a smaller file (GGUF Q4/Q5) if there is one.`;
  }
  // Caveats that don't change the verdict but are worth a word.
  if (verdict !== "too_big") {
    if (p.device === "cpu") {
      verdict = "tight";
      reason =
        "No GPU found: this would run on the CPU and take a very long time.";
    } else if (quant.kind === "fp8" && !p.supports.fp8Compute) {
      reason +=
        " Your GPU loads fp8 but can't speed it up; bf16 or GGUF can be as fast.";
    } else if (quant.kind === "int8" && p.device === "mps") {
      if (verdict === "fits") verdict = "tight";
      reason = `int8 files run slowly on Apple GPUs. ${reason}`;
    }
    if (quant.needsNodePack)
      reason += ` Needs the ${quant.needsNodePack} node pack.`;
  }
  return { verdict, reason, estimatedVramGB: est, quant, role };
}

const VERDICT_RANK: Record<CompatVerdict, number> = {
  fits: 0,
  tight: 1,
  unknown: 2,
  too_big: 3,
  unsupported: 4,
};

/** The more pessimistic of two verdicts. */
export function worseVerdict(
  a: CompatVerdict,
  b: CompatVerdict,
): CompatVerdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

/** Worst verdict over several files (a pack, a workflow's models). */
export function combineVerdicts(list: CompatVerdict[]): CompatVerdict {
  return list.reduce<CompatVerdict>((acc, v) => worseVerdict(acc, v), "fits");
}

export interface RankedCandidate<T extends ModelCandidate = ModelCandidate> {
  candidate: T;
  compat: CompatResult;
}

/**
 * Rank several files / versions of ONE model (Civitai modelVersion files, HF
 * repo siblings, a pack's alternatives): best first. Order: verdict (fits >
 * tight > unknown > too_big > unsupported), then quality (bf16/fp16 > fp8 >
 * GGUF Q8 > Q6 > Q5 > Q4 ...), then smaller size.
 */
export function rankCandidates<T extends ModelCandidate>(
  candidates: T[],
  p: BackendProfile,
): RankedCandidate<T>[] {
  return candidates
    .map((candidate) => ({ candidate, compat: checkCompat(candidate, p) }))
    .sort((a, b) => {
      const v = VERDICT_RANK[a.compat.verdict] - VERDICT_RANK[b.compat.verdict];
      if (v) return v;
      const q = b.compat.quant.quality - a.compat.quant.quality;
      if (q) return q;
      return (a.candidate.bytes ?? Infinity) - (b.candidate.bytes ?? Infinity);
    });
}

/**
 * The best file to recommend: highest quality that fits, else that runs
 * (tight). Null when nothing will run (all too big / unsupported / unknown).
 */
export function pickBestCandidate<T extends ModelCandidate>(
  candidates: T[],
  p: BackendProfile,
): RankedCandidate<T> | null {
  const best = rankCandidates(candidates, p)[0];
  if (!best) return null;
  return best.compat.verdict === "fits" || best.compat.verdict === "tight"
    ? best
    : null;
}

/** Short chip label for a verdict. */
export const VERDICT_LABEL: Record<CompatVerdict, string> = {
  fits: "Fits your GPU",
  tight: "Tight",
  too_big: "Too big",
  unsupported: "Won't run here",
  unknown: "Size unknown",
};

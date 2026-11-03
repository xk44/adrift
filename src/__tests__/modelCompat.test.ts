import { describe, expect, it } from "vitest";
import {
  checkCompat,
  combineVerdicts,
  detectQuant,
  inferGpuArch,
  pickBestCandidate,
  profileFromSystemStats,
  rankCandidates,
  roleForFamily,
  type BackendProfile,
} from "@/lib/models/compat";

const GiB = 1024 ** 3;

/** Real shape from a ComfyUI 0.42 /system_stats on an RTX 4090 box. */
const STATS_4090 = {
  system: {
    os: "linux",
    ram_total: 100904390656,
    ram_free: 67231457280,
    comfyui_version: "0.42.0",
  },
  devices: [
    {
      name: "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync",
      type: "cuda",
      index: 0,
      vram_total: 25503596544,
      vram_free: 16231071354,
    },
  ],
};

/** Apple Silicon: ComfyUI reports the unified RAM as the device memory. */
const STATS_MAC = {
  system: {
    os: "darwin",
    ram_total: 128 * GiB,
    ram_free: 80 * GiB,
    comfyui_version: "0.42.0",
  },
  devices: [
    {
      name: "mps",
      type: "mps",
      index: null,
      vram_total: 128 * GiB,
      vram_free: 80 * GiB,
    },
  ],
};

function cudaProfile(name: string, vramGb: number): BackendProfile {
  return profileFromSystemStats({
    system: { os: "linux", ram_total: 64 * GiB },
    devices: [{ name, type: "cuda", vram_total: vramGb * GiB }],
  })!;
}

describe("profileFromSystemStats", () => {
  it("reads an RTX 4090 (Ada: native fp8)", () => {
    const p = profileFromSystemStats(STATS_4090)!;
    expect(p.device).toBe("cuda");
    expect(p.arch).toBe("ada");
    expect(p.displayName).toBe("NVIDIA GeForce RTX 4090");
    expect(p.unified).toBe(false);
    expect(p.memoryTotalBytes).toBe(25503596544);
    expect(p.usableBytes).toBe(25503596544);
    expect(p.comfyuiVersion).toBe("0.42.0");
    expect(p.supports).toMatchObject({
      fp8Compute: true,
      fp8Load: true,
      fp4: false,
      cudaKernels: true,
    });
  });

  it("reads Apple MPS as unified memory with a usable share", () => {
    const p = profileFromSystemStats(STATS_MAC)!;
    expect(p.device).toBe("mps");
    expect(p.unified).toBe(true);
    expect(p.displayName).toBe("Apple GPU");
    expect(p.usableBytes).toBeCloseTo(128 * GiB * 0.7);
    expect(p.supports.fp8Load).toBe(false);
  });

  it("accepts the camelCase /api/comfy/system body", () => {
    const p = profileFromSystemStats({
      system: { ramTotal: 32 * GiB, comfyuiVersion: "0.40.1" },
      devices: [
        {
          name: "cuda:0 NVIDIA GeForce RTX 3060",
          type: "cuda",
          vramTotal: 12 * GiB,
        },
      ],
    })!;
    expect(p.arch).toBe("ampere");
    expect(p.memoryTotalBytes).toBe(12 * GiB);
    expect(p.comfyuiVersion).toBe("0.40.1");
    expect(p.supports.fp8Compute).toBe(false);
    expect(p.supports.fp8Load).toBe(true);
  });

  it("treats a ROCm card (type cuda, AMD name) as rocm", () => {
    const p = profileFromSystemStats({
      system: { ram_total: 64 * GiB },
      devices: [
        {
          name: "cuda:0 AMD Radeon RX 7900 XTX",
          type: "cuda",
          vram_total: 24 * GiB,
        },
      ],
    })!;
    expect(p.device).toBe("rocm");
    expect(p.arch).toBe("amd");
    expect(p.supports.cudaKernels).toBe(false);
  });

  it("returns null without memory info", () => {
    expect(profileFromSystemStats(null)).toBeNull();
    expect(profileFromSystemStats({ system: {} })).toBeNull();
  });
});

describe("inferGpuArch", () => {
  it.each([
    ["NVIDIA GeForce RTX 5090", "blackwell"],
    ["NVIDIA RTX PRO 6000 Blackwell Workstation Edition", "blackwell"],
    ["NVIDIA H100 80GB HBM3", "hopper"],
    ["NVIDIA GeForce RTX 4070", "ada"],
    ["NVIDIA RTX 6000 Ada Generation", "ada"],
    ["NVIDIA GeForce RTX 3090", "ampere"],
    ["NVIDIA A100-SXM4-80GB", "ampere"],
    ["NVIDIA GeForce RTX 2080 Ti", "turing"],
    ["Tesla T4", "turing"],
    ["NVIDIA GeForce GTX 1080", "older_nvidia"],
  ])("%s -> %s", (name, arch) => {
    expect(inferGpuArch(name, "cuda")).toBe(arch);
  });
});

describe("detectQuant", () => {
  it.each([
    ["Krea-2-Turbo-Q4_K_M.gguf", "gguf", "gguf_q4_k_m"],
    ["flux1-dev-Q8_0.gguf", "gguf", "gguf_q8_0"],
    ["wan2.2-14b-Q6_K.gguf", "gguf", "gguf_q6_k"],
    ["model-q5_k_s.gguf", "gguf", "gguf_q5_k_s"],
    ["krea2_turbo_fp8_scaled.safetensors", "fp8", "fp8_scaled"],
    ["flux1-dev-fp8-e4m3fn.safetensors", "fp8", "fp8_e4m3fn"],
    ["krea2_turbo_bf16.safetensors", "float", "bf16"],
    ["t5xxl_fp16.safetensors", "float", "fp16"],
    ["flux1-dev-nvfp4.safetensors", "fp4", "nvfp4"],
    ["svdq-int4-flux.1-dev.safetensors", "svdq", "svdq_int4"],
    ["sd_xl_base_1.0.safetensors", "unknown", "unknown"],
  ])("%s", (file, kind, id) => {
    const q = detectQuant(file);
    expect(q.kind).toBe(kind);
    expect(q.id).toBe(id);
  });

  it("uses a format hint (Civitai metadata.fp)", () => {
    expect(detectQuant("model.safetensors", "fp8").kind).toBe("fp8");
    expect(detectQuant("model.safetensors", "bf16").id).toBe("bf16");
  });

  it("ranks GGUF Q8 > Q6 > Q5 > Q4 by quality", () => {
    const q = (n: string) => detectQuant(`m-${n}.gguf`).quality;
    expect(q("Q8_0")).toBeGreaterThan(q("Q6_K"));
    expect(q("Q6_K")).toBeGreaterThan(q("Q5_K_M"));
    expect(q("Q5_K_M")).toBeGreaterThan(q("Q4_K_M"));
    expect(q("Q4_K_M")).toBeGreaterThan(q("Q3_K_M"));
    expect(detectQuant("m-Q4_K_M.gguf").needsNodePack).toBe("ComfyUI-GGUF");
  });
});

describe("checkCompat", () => {
  const p4090 = profileFromSystemStats(STATS_4090)!;
  const mac = profileFromSystemStats(STATS_MAC)!;

  it("fp8 on Apple is unsupported", () => {
    const r = checkCompat(
      { fileName: "x_fp8_scaled.safetensors", bytes: 13e9, role: "image" },
      mac,
    );
    expect(r.verdict).toBe("unsupported");
    expect(r.reason).toMatch(/Apple/);
  });

  it("fp8 on pre-Ada CUDA still runs, with a no-speedup note", () => {
    const r = checkCompat(
      { fileName: "x_fp8_scaled.safetensors", bytes: 6e9, role: "image" },
      cudaProfile("NVIDIA GeForce RTX 3090", 24),
    );
    expect(r.verdict).toBe("fits");
    expect(r.reason).toMatch(/can't speed it up/);
  });

  it("fp4 needs Blackwell", () => {
    const c = {
      fileName: "x-nvfp4.safetensors",
      bytes: 6e9,
      role: "image" as const,
    };
    expect(checkCompat(c, p4090).verdict).toBe("unsupported");
    expect(
      checkCompat(c, cudaProfile("NVIDIA GeForce RTX 5090", 32)).verdict,
    ).toBe("fits");
  });

  it("sizes: fits / tight / too_big on a 4090", () => {
    const img = (bytes: number) =>
      checkCompat(
        { fileName: "m_bf16.safetensors", bytes, role: "image" },
        p4090,
      );
    expect(img(13e9).verdict).toBe("fits"); // ~13 GiB
    expect(img(26.28e9).verdict).toBe("tight"); // Krea 2 bf16
    expect(img(40e9).verdict).toBe("too_big");
  });

  it("unknown size is 'unknown', not a guess", () => {
    const r = checkCompat({ fileName: "m.safetensors" }, p4090);
    expect(r.verdict).toBe("unknown");
    expect(r.estimatedVramGB).toBeNull();
  });

  it("CPU-only is at best tight", () => {
    const cpu = profileFromSystemStats({
      system: { ram_total: 64 * GiB },
      devices: [{ name: "cpu", type: "cpu", vram_total: 64 * GiB }],
    })!;
    expect(
      checkCompat(
        { fileName: "small.safetensors", bytes: 1e9, role: "image" },
        cpu,
      ).verdict,
    ).toBe("tight");
  });

  it("combineVerdicts keeps the worst", () => {
    expect(combineVerdicts(["fits", "tight"])).toBe("tight");
    expect(combineVerdicts(["fits", "unsupported", "too_big"])).toBe(
      "unsupported",
    );
    expect(combineVerdicts([])).toBe("fits");
  });

  it("roleForFamily", () => {
    expect(roleForFamily("Wan Video 14B t2v")).toBe("video");
    expect(roleForFamily("LTXV")).toBe("video");
    expect(roleForFamily("SDXL 1.0")).toBe("image");
    expect(roleForFamily("Stable Audio")).toBe("audio");
    expect(roleForFamily(undefined)).toBeUndefined();
  });
});

describe("rankCandidates / pickBestCandidate", () => {
  const gguf = (q: string, gb: number) => ({
    fileName: `flux-${q}.gguf`,
    bytes: gb * 1e9,
    role: "image" as const,
  });
  const files = [
    gguf("Q4_K_M", 6.8),
    gguf("Q8_0", 12.7),
    gguf("Q5_K_M", 8.4),
    gguf("Q6_K", 9.9),
  ];

  it("picks the best GGUF that fits (Q8 > Q6 > Q5 > Q4)", () => {
    expect(
      pickBestCandidate(files, cudaProfile("NVIDIA GeForce RTX 4090", 24))!
        .candidate.fileName,
    ).toBe("flux-Q8_0.gguf");
    // 12 GB card: Q8/Q6 are tight (est > 90%), Q5 fits -> fitting beats tight.
    expect(
      pickBestCandidate(files, cudaProfile("NVIDIA GeForce RTX 3060", 12))!
        .candidate.fileName,
    ).toBe("flux-Q5_K_M.gguf");
    // 10 GB: only Q4 fits (on 8 GB nothing fits; the best tight one wins).
    expect(
      pickBestCandidate(files, cudaProfile("NVIDIA GeForce RTX 3080", 10))!
        .candidate.fileName,
    ).toBe("flux-Q4_K_M.gguf");
  });

  it("prefers bf16 over fp8 when both fit; fp8 when only it fits", () => {
    const pair = [
      {
        fileName: "k_bf16.safetensors",
        bytes: 26.28e9,
        role: "image" as const,
      },
      {
        fileName: "k_fp8_scaled.safetensors",
        bytes: 13.14e9,
        role: "image" as const,
      },
    ];
    const big = cudaProfile("NVIDIA RTX PRO 6000 Blackwell", 96);
    expect(pickBestCandidate(pair, big)!.candidate.fileName).toBe(
      "k_bf16.safetensors",
    );
    const p4090 = profileFromSystemStats(STATS_4090)!;
    expect(pickBestCandidate(pair, p4090)!.candidate.fileName).toBe(
      "k_fp8_scaled.safetensors",
    );
    // Apple can't load fp8: bf16 even though it's bigger.
    const mac = profileFromSystemStats(STATS_MAC)!;
    expect(pickBestCandidate(pair, mac)!.candidate.fileName).toBe(
      "k_bf16.safetensors",
    );
  });

  it("returns null when nothing runs; ranking still lists everything", () => {
    const tiny = cudaProfile("NVIDIA GeForce GTX 1050", 2);
    expect(pickBestCandidate(files, tiny)).toBeNull();
    expect(rankCandidates(files, tiny)).toHaveLength(4);
  });
});

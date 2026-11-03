import { describe, expect, it } from "vitest";
import type { CivitaiModel, CivitaiModelVersion } from "@/lib/civitai";
import { mapHfModel, mapHfSiblings, type HfModelSummary } from "@/lib/hfModels";
import {
  profileFromSystemStats,
  type BackendProfile,
} from "@/lib/models/compat";
import {
  civitaiModelCompat,
  civitaiRole,
  civitaiVersionCandidates,
  civitaiVersionCompat,
  compatChip,
  hfCandidates,
  hfModelCompat,
  hfRole,
  hiddenByFitsFilter,
  unsizedCount,
  quantLabel,
} from "@/lib/models/exploreCompat";
import { detectQuant } from "@/lib/models/compat";

const GiB = 1024 ** 3;
const kb = (gib: number) => gib * 1024 * 1024;

function cuda(name: string, vramGb: number): BackendProfile {
  return profileFromSystemStats({
    system: { os: "linux", ram_total: 64 * GiB },
    devices: [{ name, type: "cuda", vram_total: vramGb * GiB }],
  })!;
}
const P4090 = cuda("cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync", 24);
const P3090 = cuda("cuda:0 NVIDIA GeForce RTX 3090 : cudaMallocAsync", 24);
const P3060 = cuda("cuda:0 NVIDIA GeForce RTX 3060 : cudaMallocAsync", 12);
const MAC64 = profileFromSystemStats({
  system: { os: "darwin", ram_total: 64 * GiB },
  devices: [{ name: "mps", type: "mps", vram_total: 64 * GiB }],
})!;

type File = CivitaiModelVersion["files"][number];
const file = (
  name: string,
  gib: number | undefined,
  extra: Partial<File> = {},
): File => ({
  name,
  sizeKB: gib === undefined ? (undefined as unknown as number) : kb(gib),
  downloadUrl: "https://civitai.com/api/download/models/1",
  type: "Model",
  ...extra,
});
const version = (
  files: File[],
  baseModel = "Flux.1 D",
  id = 1,
): CivitaiModelVersion => ({
  id,
  name: `v${id}`,
  modelId: 9,
  downloadUrl: "",
  baseModel,
  files,
  images: [],
});
const model = (
  type: string,
  versions: CivitaiModelVersion[],
): CivitaiModel => ({
  id: 9,
  name: "Test model",
  type,
  modelVersions: versions,
});

const GGUF_SET = [
  file("flux1-dev-Q4_K_S.gguf", 6.8, {
    metadata: { format: "GGUF", fp: "fp16" },
  }),
  file("flux1-dev-Q6_K.gguf", 9.8, {
    metadata: { format: "GGUF", fp: "fp16" },
  }),
  file("flux1-dev-Q8_0.gguf", 12.7, {
    primary: true,
    metadata: { format: "GGUF", fp: "fp16" },
  }),
  file("flux1-dev-F16.gguf", 23.8, {
    metadata: { format: "GGUF", fp: "fp16" },
  }),
];

describe("civitaiRole", () => {
  it("add-ons (LoRA, embeddings, ControlNet...) get no verdict", () => {
    for (const t of [
      "LORA",
      "LoCon",
      "DoRA",
      "TextualInversion",
      "Controlnet",
      "Hypernetwork",
      "MotionModule",
    ])
      expect(civitaiRole(t, "SDXL 1.0")).toBeNull();
  });
  it("checkpoints: all-in-one unless video / audio / GGUF", () => {
    expect(civitaiRole("Checkpoint", "SDXL 1.0")).toBe("checkpoint");
    expect(civitaiRole("Checkpoint", "Wan Video 14B t2v")).toBe("video");
    expect(civitaiRole("Checkpoint", "Flux.1 D", true)).toBe("image");
    expect(civitaiRole("VAE", "Flux.1 D")).toBe("vae");
    expect(civitaiRole("Upscaler", undefined)).toBe("upscale");
    expect(civitaiRole("Other", undefined)).toBe("other");
  });
});

describe("civitaiVersionCandidates", () => {
  it("keeps only model weights, maps sizeKB to bytes and missing sizeKB to null", () => {
    const c = civitaiVersionCandidates(
      "Checkpoint",
      version(
        [
          file("a.safetensors", 6.5, {
            metadata: { fp: "fp16", format: "SafeTensor", size: "full" },
          }),
          file("b.safetensors", undefined),
          file("config.yaml", 0.001, { type: "Config" }),
          file("vae.safetensors", 0.3, { type: "VAE" }),
          file("data.zip", 1, { type: "Training Data" }),
        ],
        "SDXL 1.0",
      ),
    );
    expect(c.map((x) => x.key)).toEqual(["a.safetensors", "b.safetensors"]);
    expect(c[0].bytes).toBe(6.5 * GiB);
    expect(c[0].formatHint).toBe("fp16 SafeTensor");
    expect(c[1].bytes).toBeNull();
    expect(c[0].role).toBe("checkpoint");
  });

  it("ignores metadata.fp on GGUF (it is the source precision, not the quant)", () => {
    const [c] = civitaiVersionCandidates(
      "Checkpoint",
      version([
        file("fluxKreaQ8FromFP16.gguf", 12, {
          metadata: { format: "GGUF", fp: "bf16" },
        }),
      ]),
    );
    expect(c.formatHint).toBe("gguf");
    expect(detectQuant(c.fileName, c.formatHint).id).not.toBe("gguf_bf16");
  });

  it("prefers safetensors over pickle files, but keeps pickle-only versions", () => {
    const mixed = civitaiVersionCandidates(
      "Checkpoint",
      version([file("a.ckpt", 4), file("a.safetensors", 4)], "SD 1.5"),
    );
    expect(mixed.map((x) => x.key)).toEqual(["a.safetensors"]);
    const pickle = civitaiVersionCandidates(
      "Checkpoint",
      version([file("old.ckpt", 4)], "SD 1.5"),
    );
    expect(pickle.map((x) => x.key)).toEqual(["old.ckpt"]);
  });

  it("LoRA versions yield no candidates (no chip, never filtered)", () => {
    expect(
      civitaiVersionCandidates(
        "LORA",
        version([file("style.safetensors", 0.2)]),
      ),
    ).toEqual([]);
    const m = model("LORA", [version([file("style.safetensors", 0.2)])]);
    expect(civitaiModelCompat(m, P4090)).toBeNull();
    expect(hiddenByFitsFilter(civitaiModelCompat(m, P4090))).toBe(false);
  });
});

describe("civitaiVersionCompat — GGUF multi-quant", () => {
  it("24 GB 4090: Q8_0 is best, F16 is tight, badge 'Best: Q8_0'", () => {
    const c = civitaiVersionCompat("Checkpoint", version(GGUF_SET), P4090)!;
    expect(c.recommendedKey).toBe("flux1-dev-Q8_0.gguf");
    expect(c.bestQuantLabel).toBe("Q8_0");
    expect(c.verdict).toBe("fits");
    expect(c.perFile["flux1-dev-F16.gguf"].verdict).toBe("tight");
    expect(c.perFile["flux1-dev-Q4_K_S.gguf"].verdict).toBe("fits");
    expect(c.quantLabels).toEqual(["F16", "Q8_0", "Q6_K", "Q4_K_S"]);
  });

  it("12 GB card: picks the biggest quant that fits (Q4_K_S), not the primary Q8", () => {
    const c = civitaiVersionCompat("Checkpoint", version(GGUF_SET), P3060)!;
    expect(c.recommendedKey).toBe("flux1-dev-Q4_K_S.gguf");
    expect(c.bestQuantLabel).toBe("Q4_K_S");
    expect(c.perFile["flux1-dev-Q6_K.gguf"].verdict).toBe("tight");
    expect(c.perFile["flux1-dev-F16.gguf"].verdict).toBe("too_big");
  });

  it("no badge when the version has a single quant", () => {
    const c = civitaiVersionCompat(
      "Checkpoint",
      version([GGUF_SET[2]]),
      P4090,
    )!;
    expect(c.bestQuantLabel).toBeNull();
    expect(c.quantLabels).toEqual(["Q8_0"]);
  });

  it("all files unknown size: verdict unknown, nothing recommended, stays visible", () => {
    const c = civitaiVersionCompat(
      "Checkpoint",
      version([
        file("x-Q4_K_M.gguf", undefined),
        file("x-Q8_0.gguf", undefined),
      ]),
      P4090,
    )!;
    expect(c.verdict).toBe("unknown");
    expect(c.recommendedKey).toBeNull();
    expect(c.bestQuantLabel).toBeNull();
    expect(compatChip(c, P4090)).toMatchObject({
      label: "Size unknown",
      tone: "warn",
    });
    expect(hiddenByFitsFilter(c)).toBe(false);
    expect(unsizedCount([c, null])).toBe(1);
  });
});

describe("fp8 and Apple unified memory", () => {
  const fp8 = version([
    file("model_fp8_e4m3fn.safetensors", 11.9, {
      metadata: { fp: "fp8", format: "SafeTensor" },
    }),
    file("model_bf16.safetensors", 23.8, {
      metadata: { fp: "bf16", format: "SafeTensor" },
    }),
  ]);

  it("3090 loads fp8 (no fast path): fits, with a caveat in the reason", () => {
    const c = civitaiVersionCompat("Checkpoint", fp8, P3090)!;
    const r = c.perFile["model_fp8_e4m3fn.safetensors"];
    expect(r.verdict).toBe("fits");
    expect(r.reason).toMatch(/can't speed it up/);
  });

  it("Mac can't hold fp8: the bf16 file wins and the fp8 one is 'won't run here'", () => {
    const c = civitaiVersionCompat("Checkpoint", fp8, MAC64)!;
    expect(c.perFile["model_fp8_e4m3fn.safetensors"].verdict).toBe(
      "unsupported",
    );
    expect(c.recommendedKey).toBe("model_bf16.safetensors");
    expect(c.verdict).toBe("fits");
  });

  it("fp8-only version on a Mac is hidden by 'Fits my GPU' and chipped 'Won't run here'", () => {
    const m = model("Checkpoint", [version([fp8.files[0]])]);
    const c = civitaiModelCompat(m, MAC64);
    expect(c?.verdict).toBe("unsupported");
    expect(compatChip(c, MAC64)?.label).toBe("Won't run here");
    expect(hiddenByFitsFilter(c)).toBe(true);
  });

  it("unified memory: chip names total RAM, uses ~70% for models", () => {
    // 40 GiB checkpoint on 64 GB Mac: 40*0.95+0.75 = 38.75 <= 44.8*0.9 -> fits
    const c = civitaiVersionCompat(
      "Checkpoint",
      version([file("big_bf16.safetensors", 40)], "SDXL 1.0"),
      MAC64,
    )!;
    expect(c.verdict).toBe("fits");
    const huge = civitaiVersionCompat(
      "Checkpoint",
      version([file("huge_bf16.safetensors", 60)], "SDXL 1.0"),
      MAC64,
    )!;
    expect(huge.verdict).toBe("too_big");
    expect(compatChip(huge, MAC64)?.label).toBe("Too big for 64 GB");
  });
});

describe("civitaiModelCompat / filter", () => {
  it("judges the best version: an older Q4 that fits keeps the model visible", () => {
    const m = model("Checkpoint", [
      version([file("new_bf16.safetensors", 40)], "Flux.1 D", 2),
      version([file("old-Q4_K_S.gguf", 6.8)], "Flux.1 D", 1),
    ]);
    const c = civitaiModelCompat(m, P4090);
    expect(c?.verdict).toBe("fits");
    expect(c?.topKey).toBe("old-Q4_K_S.gguf");
    expect(hiddenByFitsFilter(c)).toBe(false);
  });

  it("hidden only when every version is too big", () => {
    const m = model("Checkpoint", [
      version([file("new_bf16.safetensors", 40)], "Flux.1 D", 2),
      version([file("old_fp32.safetensors", 45)], "Flux.1 D", 1),
    ]);
    const c = civitaiModelCompat(m, P4090);
    expect(c?.verdict).toBe("too_big");
    expect(hiddenByFitsFilter(c)).toBe(true);
    expect(compatChip(c, P4090)).toMatchObject({
      label: "Too big for 24 GB",
      tone: "bad",
    });
  });

  it("no versions / no profile -> no chip, not hidden", () => {
    expect(civitaiModelCompat(model("Checkpoint", []), P4090)).toBeNull();
    expect(compatChip(null, P4090)).toBeNull();
    expect(hiddenByFitsFilter(null)).toBe(false);
  });

  it("chip labels and tones per verdict, with the reason as tooltip", () => {
    const fits = civitaiVersionCompat(
      "Checkpoint",
      version([file("a_fp16.safetensors", 6.5)], "SDXL 1.0"),
      P4090,
    );
    expect(compatChip(fits, P4090)).toMatchObject({
      label: "Fits",
      tone: "good",
    });
    expect(compatChip(fits, P4090)?.title).toMatch(/Ballpark/);
    const tight = civitaiVersionCompat(
      "Checkpoint",
      version([file("flux1-dev-F16.gguf", 23.8)]),
      P4090,
    );
    expect(compatChip(tight, P4090)).toMatchObject({
      label: "Tight",
      tone: "warn",
    });
  });
});

describe("quantLabel", () => {
  it("formats ids for badges", () => {
    expect(quantLabel(detectQuant("x-Q6_K.gguf"))).toBe("Q6_K");
    expect(quantLabel(detectQuant("x.gguf"))).toBe("GGUF");
    expect(quantLabel(detectQuant("x_bf16.safetensors"))).toBe("BF16");
    expect(quantLabel(detectQuant("x_fp8_scaled.safetensors"))).toBe(
      "FP8 scaled",
    );
    expect(quantLabel(detectQuant("x_nvfp4.safetensors"))).toBe("NVFP4");
    expect(quantLabel(detectQuant("x.safetensors"))).toBeNull();
  });
});

describe("Hugging Face", () => {
  const raw = {
    id: "city96/FLUX.1-dev-gguf",
    tags: ["gguf", "text-to-image"],
    pipeline_tag: "text-to-image",
    library_name: "gguf",
    siblings: [
      { rfilename: ".gitattributes" },
      { rfilename: "README.md" },
      { rfilename: "flux1-dev-F16.gguf" },
      { rfilename: "flux1-dev-Q4_K_S.gguf" },
      { rfilename: "flux1-dev-Q8_0.gguf" },
      {
        rfilename:
          "transformer/diffusion_pytorch_model-00001-of-00003.safetensors",
      },
    ],
  };

  it("maps weight siblings (names only) and sizes when the Hub sends them", () => {
    const m = mapHfModel(raw)!;
    expect(m.files?.map((f) => f.name)).toEqual([
      "flux1-dev-F16.gguf",
      "flux1-dev-Q4_K_S.gguf",
      "flux1-dev-Q8_0.gguf",
    ]);
    expect(
      mapHfSiblings([
        { rfilename: "a.safetensors", size: 1234 },
        { rfilename: 5 },
        null,
      ]),
    ).toEqual([{ name: "a.safetensors", bytes: 1234 }]);
    expect(mapHfSiblings(undefined)).toEqual([]);
  });

  it("skips diffusers shards; names only -> unknown verdict, quant count, no chip", () => {
    const m = mapHfModel(raw)!;
    expect(hfCandidates(m).map((c) => c.key)).not.toContain(
      "transformer/diffusion_pytorch_model-00001-of-00003.safetensors",
    );
    const c = hfModelCompat(m, P4090)!;
    expect(c.verdict).toBe("unknown");
    expect(c.bestQuantLabel).toBeNull();
    expect(c.quantLabels).toEqual(["F16", "Q8_0", "Q4_K_S"]);
    expect(compatChip(c, P4090)).toMatchObject({
      label: "Size unknown",
      tone: "warn",
    });
    expect(hiddenByFitsFilter(c)).toBe(false);
    expect(unsizedCount([c, null])).toBe(1);
  });

  it("uses sibling sizes when present", () => {
    const m: HfModelSummary = {
      ...mapHfModel(raw)!,
      files: [
        { name: "flux1-dev-Q4_K_S.gguf", bytes: 6.8 * GiB },
        { name: "flux1-dev-Q8_0.gguf", bytes: 12.7 * GiB },
      ],
    };
    const c = hfModelCompat(m, P3060)!;
    expect(c.recommendedKey).toBe("flux1-dev-Q4_K_S.gguf");
    expect(c.bestQuantLabel).toBe("Q4_K_S");
  });

  it("fp8-only repo on a Mac is 'won't run here'", () => {
    const m = mapHfModel({
      id: "org/model-fp8",
      pipeline_tag: "text-to-image",
      siblings: [{ rfilename: "model_fp8_e4m3fn.safetensors" }],
    })!;
    const c = hfModelCompat(m, MAC64);
    expect(c?.verdict).toBe("unsupported");
    expect(hiddenByFitsFilter(c)).toBe(true);
  });

  it("roles: LoRA repos get no verdict; task decides video / audio / image", () => {
    const base = mapHfModel({ id: "a/b" })!;
    expect(hfRole({ ...base, library: "peft" })).toBeNull();
    expect(hfRole({ ...base, tags: ["lora"] })).toBeNull();
    expect(hfRole({ ...base, pipelineTag: "text-to-video" })).toBe("video");
    expect(hfRole({ ...base, pipelineTag: "text-to-audio" })).toBe("audio");
    expect(hfRole({ ...base, pipelineTag: "text-to-image" })).toBe("image");
    expect(hfRole({ ...base, tags: ["super-resolution"] })).toBe("upscale");
    expect(
      hfModelCompat(
        { ...base, library: "peft", files: [{ name: "x.safetensors" }] },
        P4090,
      ),
    ).toBeNull();
  });
});

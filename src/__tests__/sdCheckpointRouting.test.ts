/**
 * Unrecognised Civitai SD checkpoints (plantMilkModelSuite_walnut, noobaiXL_*,
 * ponyDiffusionV6XL, juggernautXL_v9 ...) must route to the sdxl pack and keep
 * SD-only controls (--clipskip, regional) even when CJ_DEFAULT_PACK=krea2.
 * CJ_DEFAULT_PACK only applies when no model is chosen at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Workflow } from "@/types";

const PLANT = "plantMilkModelSuite_walnut.safetensors";

async function load() {
  vi.resetModules();
  const packs = await import("@/lib/oj/packs");
  const gc = await import("@/lib/oj/graphControls");
  const lm = await import("@/lib/loraMetadata");
  return { ...packs, ...gc, ...lm };
}

const WF_DIR = path.join(process.cwd(), "public/workflows");
const t2i = (ckpt: string): Workflow => {
  const wf = JSON.parse(
    fs.readFileSync(path.join(WF_DIR, "t2i.json"), "utf8"),
  ) as Workflow;
  wf["4"].inputs.ckpt_name = ckpt;
  return wf;
};

describe("SD checkpoint family detection with CJ_DEFAULT_PACK=krea2", () => {
  beforeEach(() => {
    for (const g of ["CJ_QWEN_IMAGE_21", "CJ_FLUX3", "CJ_MOSS_IMAGE"])
      vi.stubEnv(g, "");
    vi.stubEnv("CJ_DEFAULT_PACK", "krea2");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    [PLANT, "unknown", "sdxl", "sdxl"],
    [
      "noobaiXL_vPred10Version.safetensors",
      "illustrious",
      "illustrious",
      "sdxl",
    ],
    ["NoobAI-XL-v1.1.safetensors", "illustrious", "illustrious", "sdxl"],
    [
      "hassakuXLIllustrious_v21.safetensors",
      "illustrious",
      "illustrious",
      "sdxl",
    ],
    [
      "prefectIllustriousXL_v3.safetensors",
      "illustrious",
      "illustrious",
      "sdxl",
    ],
    ["ilxl_animeMix_v2.safetensors", "illustrious", "illustrious", "sdxl"],
    ["ponyDiffusionV6XL_v6.safetensors", "pony", "pony", "sdxl"],
    ["juggernautXL_v9Rundiffusion.safetensors", "sdxl", "sdxl", "sdxl"],
    ["realvisxlV40_v40Bakedvae.safetensors", "sdxl", "sdxl", "sdxl"],
    ["animagineXL31.safetensors", "sdxl", "sdxl", "sdxl"],
    ["v1-5-pruned-emaonly.safetensors", "unknown", "sdxl", "sdxl"],
  ])(
    "%s -> strict %s, routing %s, pack %s",
    async (name, strict, family, pack) => {
      const m = await load();
      expect(m.detectModelFamilyStrict(name)).toBe(strict);
      expect(m.detectModelFamily(name)).toBe(family);
      expect(m.getPackForCheckpoint(name).id).toBe(pack);
    },
  );

  it.each([
    ["flux1-dev-fp8.safetensors", "flux"],
    ["flux1-schnell.safetensors", "flux"],
    ["krea2_turbo_keep22_g6.safetensors", "krea2"],
    ["ltx-2-19b-dev-fp8.safetensors", "ltxv"],
    ["wan2.2_ti2v_5B_fp16.safetensors", "wan"],
    ["sd_xl_base_1.0.safetensors", "sdxl"],
  ])("pack patterns still win: %s -> %s", async (name, family) => {
    const m = await load();
    expect(m.detectModelFamily(name)).toBe(family);
  });

  it.each([
    "qwen_image_fp8_e4m3fn.safetensors",
    "hidream_i1_full_fp16.safetensors",
    "chroma-unlocked-v37.safetensors",
    "sd3.5_large.safetensors",
    "lumina_2.safetensors",
    "hunyuan_image_2.1.safetensors",
    "",
  ])("non-SD hint / no model keeps the default pack: %j", async (name) => {
    const m = await load();
    expect(m.detectModelFamilyStrict(name)).toBe("unknown");
    expect(m.detectModelFamily(name)).toBe("krea2");
  });

  it("names merely containing 'chromatic' / 'xl' inside a word stay SD", async () => {
    const m = await load();
    expect(m.detectModelFamily("chromaticXL_v2.safetensors")).toBe("sdxl");
    expect(m.detectModelFamilyStrict("pixlartMix.safetensors")).toBe("unknown");
  });

  it("illustrious/pony resolve through the sdxl pack (LoRA loader, defaults)", async () => {
    const m = await load();
    expect(m.getLoraLoaderClass("illustrious")).toBe("LoraLoader");
    expect(m.getLoraLoaderClass("pony")).toBe("LoraLoader");
    expect(m.getPackForModelFamily("sd15").id).toBe("sdxl");
    expect(
      m.resolveWorkflow({ templateOrAction: "t2i", checkpointName: PLANT }).pack
        ?.id,
    ).toBe("sdxl");
    // No model at all: the configured default pack.
    expect(m.resolveWorkflow({ templateOrAction: "t2i" }).pack?.id).toBe(
      "krea2",
    );
  });

  it("clip-skip gating uses the structural SD family, not the default pack", async () => {
    const m = await load();
    for (const [ckpt, family] of [
      [PLANT, "sdxl"],
      ["noobaiXL_vPred10Version.safetensors", "illustrious"],
      ["ponyDiffusionV6XL_v6.safetensors", "pony"],
    ]) {
      expect(m.getGraphControlSupport(t2i(ckpt))).toMatchObject({
        family,
        clipSkip: true,
      });
    }
    expect(m.detectWorkflowFamily(t2i("")).family).toBe("sdxl");
    // A non-SD all-in-one checkpoint in a checkpoint loader: no guess.
    expect(
      m.getGraphControlSupport(t2i("qwen_image_aio.safetensors")).clipSkip,
    ).toBe(false);
  });

  it("LoRA base mismatch fires for name-identified SD derivatives", async () => {
    const m = await load();
    const noob = m.detectModelFamilyStrict(
      "noobaiXL_vPred10Version.safetensors",
    );
    expect(m.loraBaseMismatch("Flux.1 D", noob).mismatch).toBe(true);
    expect(m.loraBaseMismatch("Illustrious", noob).mismatch).toBe(false);
    expect(m.loraBaseMismatch("SDXL 1.0", noob).mismatch).toBe(false);
    // No name hint: stays quiet (sd15 vs sdxl is not knowable from the name).
    const plant = m.detectModelFamilyStrict(PLANT);
    expect(m.loraBaseMismatch("Flux.1 D", plant).mismatch).toBe(false);
  });
});

describe("browser default-pack mirror", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("NEXT_PUBLIC_CJ_DEFAULT_PACK stands in when CJ_DEFAULT_PACK is absent", async () => {
    vi.stubEnv("CJ_DEFAULT_PACK", "");
    vi.stubEnv("NEXT_PUBLIC_CJ_DEFAULT_PACK", "krea2");
    const m = await load();
    expect(m.getDefaultPack().id).toBe("krea2");
    // Named checkpoints never depend on the default: client == server.
    expect(m.getPackForCheckpoint(PLANT).id).toBe("sdxl");
  });
});

describe("POST /api/jobs/imagine --model <unrecognised SD checkpoint>", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("CJ_DEFAULT_PACK", "krea2");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function importRoute(loaderKind: "checkpoint" | "unet" | null) {
    const realFs =
      await vi.importActual<typeof import("fs/promises")>("fs/promises");
    const readFile = vi.fn((p: string, enc?: BufferEncoding) =>
      realFs.readFile(p, enc ?? "utf8"),
    );
    vi.doMock("fs/promises", () => ({ default: { ...realFs, readFile } }));
    const queuePrompt = vi.fn().mockResolvedValue({ prompt_id: "p1" });
    vi.doMock("@/lib/comfy/http", () => ({
      queuePrompt,
      ComfyAPIError: class ComfyAPIError extends Error {},
      fetchAvailableCheckpoints: vi.fn().mockResolvedValue([PLANT]),
    }));
    vi.doMock("@/lib/comfy/runs", () => ({ addActiveRun: vi.fn() }));
    vi.doMock("@/lib/db", () => ({
      insertPrompt: vi.fn(),
      insertRun: vi.fn(),
      insertJob: vi.fn(),
    }));
    const actualOic = await vi.importActual<
      typeof import("@/lib/comfy/objectInfoCache")
    >("@/lib/comfy/objectInfoCache");
    vi.doMock("@/lib/comfy/objectInfoCache", () => ({
      ...actualOic,
      modelLoaderKind: vi.fn().mockResolvedValue(loaderKind),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
    );
    const { POST } = await import("@/app/api/jobs/imagine/route");
    return { POST, queuePrompt, readFile };
  }

  const submit = (
    POST: (r: import("next/server").NextRequest) => Promise<Response>,
    prompt: string,
  ) =>
    POST(
      new Request("http://localhost:3000/api/jobs/imagine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, client_id: "c1", batch_size: 1 }),
      }) as unknown as import("next/server").NextRequest,
    );

  type Node = { class_type: string; inputs: Record<string, unknown> };

  it("routes to the sdxl checkpoint graph and applies --clipskip", async () => {
    const { POST, queuePrompt } = await importRoute("checkpoint");
    const res = await submit(POST, `a fox --model ${PLANT} --clipskip 2`);
    expect(res.status).toBe(200);
    const wf = queuePrompt.mock.calls[0][0] as Record<string, Node>;
    const nodes = Object.values(wf);
    const ckpt = nodes.find((n) => n.class_type === "CheckpointLoaderSimple");
    expect(ckpt?.inputs.ckpt_name).toBe(PLANT);
    expect(nodes.some((n) => n.class_type === "UNETLoader")).toBe(false);
    const skip = nodes.find((n) => n.class_type === "CLIPSetLastLayer");
    expect(skip?.inputs.stop_at_clip_layer).toBe(-2);
  });

  it("a name ComfyUI lists only as a bare UNET keeps the default pack", async () => {
    const { POST, readFile } = await importRoute("unet");
    await submit(POST, "a fox --model mystery_dit.safetensors");
    const paths = readFile.mock.calls.map((c) => String(c[0]));
    expect(paths.some((p) => p.includes(path.join("packs", "krea2")))).toBe(
      true,
    );
  });
});

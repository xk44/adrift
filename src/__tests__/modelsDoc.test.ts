import { describe, it, expect } from "vitest";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  buildModelsDoc,
  folderForRef,
  formatBytes,
  MODEL_SIZES,
  PIPELINE_TOOLS,
} from "@/lib/tools/modelsDoc";
import { familyFor, workflowWeightRefs } from "@/lib/tools/toolsDoc";
import { dubVideoCard, voiceChangerCard } from "@/lib/tools/pipelineCards";
import type { EngineContext } from "@/lib/tools/templates";
import type { Workflow } from "@/types";

const ROOT = path.resolve(__dirname, "../..");
const WF_DIR = path.join(ROOT, "public/workflows");
const DOC = path.join(ROOT, "docs/models.md");
const SIZES = path.join(ROOT, "src/lib/tools/modelSizes.json");

function loadWorkflow(rel: string): Workflow | null {
  const p = path.join(WF_DIR, rel);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Workflow;
}

function packGraphs(dir = path.join(WF_DIR, "packs")): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...packGraphs(p));
    // `*_cached.json` are local derived caches (never committed): the doc
    // must come out the same from a clean checkout.
    else if (name.endsWith(".json") && !name.endsWith("_cached.json"))
      out.push(path.relative(WF_DIR, p).split(path.sep).join("/"));
  }
  return out;
}

const GRAPHS = packGraphs();
const result = buildModelsDoc(loadWorkflow, GRAPHS);
const BRAND = new RegExp(`${"mid"}${"journey"}`, "i");

describe("modelsDoc helpers", () => {
  it("formats decimal sizes like the Hugging Face file list", () => {
    expect(formatBytes(21504034224)).toBe("21.50 GB");
    expect(formatBytes(444000000)).toBe("444 MB");
    expect(formatBytes(null)).toBe("unknown");
  });

  it("resolves a loader reference to its models folder plus sub-path", () => {
    const node = { class_type: "VAELoader", inputs: {} } as Workflow[string];
    expect(
      folderForRef({
        file: "split_files/vae/wan_2.1_vae.safetensors",
        classType: "VAELoader",
        input: "vae_name",
        node,
      }),
    ).toBe("vae/split_files/vae/");
    const tts = {
      class_type: "ChatterboxMTLTTS",
      inputs: { model_pack_name: "chatterbox_local" },
    } as unknown as Workflow[string];
    expect(
      folderForRef({
        file: "t3_mtl23ls_v3.safetensors",
        classType: "ChatterboxMTLTTS",
        input: "model_version",
        node: tts,
      }),
    ).toBe("tts/chatterbox/chatterbox_local/");
  });

  it("pipeline tool titles match their Tools-page cards", () => {
    const ctx = {} as EngineContext;
    expect(PIPELINE_TOOLS.map((p) => p.title)).toEqual([
      dubVideoCard(ctx).title,
      voiceChangerCard(ctx).title,
    ]);
  });
});

describe("docs/models.md", () => {
  it("every tool graph resolves and every loader input maps to a folder", () => {
    expect(result.missingWorkflows).toEqual([]);
    expect(result.unmappedLoaders).toEqual([]);
  });

  it("every loader file in every pack graph has a modelSizes.json entry", () => {
    const files = new Set<string>();
    for (const rel of GRAPHS) {
      const wf = loadWorkflow(rel);
      if (!wf) continue;
      for (const ref of workflowWeightRefs(wf, { includeInert: true }))
        files.add(ref.file.slice(ref.file.lastIndexOf("/") + 1));
    }
    expect(files.size).toBeGreaterThan(100);
    const missing = [...files].filter((f) => !(f in MODEL_SIZES.files));
    expect(missing).toEqual([]);
    expect(result.missingSizes).toEqual([]);
    expect(result.staleSizes).toEqual([]);
  });

  it("unknown sizes are explicit and explained", () => {
    for (const [file, info] of Object.entries(MODEL_SIZES.files)) {
      expect(info.bytes === null || info.bytes > 0, file).toBe(true);
      if (info.bytes === null) expect(info.note, file).toBeTruthy();
      expect(["minimal", "full", null]).toContain(info.set);
    }
  });

  it("every file shown has a model family", () => {
    expect(
      result.files
        .filter((f) => f.familyLabel === "unmapped")
        .map((f) => f.file),
    ).toEqual([]);
  });

  it("lists the LTX-2.5 pack, the LTX VFX LoRAs, Chatterbox and Wan Animate", () => {
    const md = result.markdown;
    for (const t of [
      "Animate (LTX-2.5)",
      "Transition (LTX-2.5)",
      "Alpha Matte",
      "Clean Plate",
      "Day to Night",
      "Add Water",
      "Cinemagraph",
      "Slow Motion",
      "Restore video",
      "SDR to HDR (video)",
      "Animate character",
      "Video Translator",
    ])
      expect(md).toContain(`| ${t} |`);
    expect(md).toContain("`wan_animate_2_distill_int8_convrot.safetensors`");
    expect(md).toContain("`t3_mtl23ls_v3.safetensors`");
    expect(md).toContain("ResembleAI/chatterbox");
    const vfx = result.files.filter((f) => f.family?.id === "ltx-25-vfx");
    // Six VFX LoRAs, five Restore modes, x2 pixel upscaler, SDR to HDR, Layout to Render, Ingredients.
    expect(vfx.length).toBe(15);
    for (const f of vfx) {
      expect(f.info?.gated, f.file).toBe(true);
      expect(f.info?.source, f.file).toMatch(/^Lightricks\/LTX-2\.5-22b-/);
      expect(f.folders).toEqual(["loras/ltx25/"]);
    }
    expect(md).toMatch(/gated/i);
  });

  it("marks non-commercial weights nc and keeps H3 optional", () => {
    const nc = (file: string) =>
      result.files.find((f) => f.file === file)?.commercial;
    for (const f of [
      "fibo2_dev_bf16.safetensors",
      "mmaudio_large_44k_v2_fp16.safetensors",
      "lucy-edit-dev-cui-fp16.safetensors",
      "qwen_image_2.1_bf16.safetensors",
    ])
      expect(nc(f), f).toBe("no");
    expect(
      familyFor("Wan2_1-MiniMaxRemover_1_3B_fp16.safetensors")?.commercial,
    ).toBe("no");
    expect(familyFor("matanyone2.safetensors")?.commercial).toBe("no");
    expect(familyFor("t3_mtl23ls_v3.safetensors")?.commercial).toBe("yes");
    // Meta SAM License: royalty-free, commercial use allowed.
    expect(nc("sam3.1_multiplex_fp16.safetensors")).toBe("yes");
    for (const f of result.files.filter((x) => x.family?.id === "h3"))
      expect(f.info?.set, f.file).not.toBe("minimal");
    expect(result.markdown).toContain("never a default");
  });

  it("does not name the brand the app is inspired by", () => {
    expect(result.markdown).not.toMatch(BRAND);
    expect(readFileSync(SIZES, "utf8")).not.toMatch(BRAND);
    expect(
      readFileSync(path.join(ROOT, "src/lib/tools/modelsDoc.ts"), "utf8"),
    ).not.toMatch(BRAND);
  });

  it("committed docs/models.md is up to date (npm run docs:models)", () => {
    if (process.env.UPDATE_MODELS_DOC === "1")
      writeFileSync(DOC, result.markdown);
    expect(readFileSync(DOC, "utf8")).toBe(result.markdown);
  });
});

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  familyFor,
  renderToolsDoc,
  vramTier,
  workflowWeightFiles,
  worstCommercial,
  actionInputs,
  MODEL_FAMILIES,
  type HubToolCounts,
} from "@/lib/tools/toolsDoc";
import { ACTION_TOOLS } from "@/lib/tools/toolsPage";
import { getEditTools } from "@/lib/tools/editTools";
import type { Workflow } from "@/types";

const ROOT = path.resolve(__dirname, "../..");
const WF_DIR = path.join(ROOT, "public/workflows");
const DOC = path.join(ROOT, "docs/TOOLS.md");

function loadWorkflow(rel: string): Workflow | null {
  const p = path.join(WF_DIR, rel);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Workflow;
}

describe("toolsDoc helpers", () => {
  it("maps weight files to families, first match wins", () => {
    expect(
      familyFor("wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors")?.id,
    ).toBe("wan22-i2v");
    expect(familyFor("qwen_image_2.1_bf16.safetensors")?.commercial).toBe("no");
    expect(
      familyFor("qwen_image_edit_2509_fp8_e4m3fn.safetensors")?.commercial,
    ).toBe("yes");
    expect(familyFor("qwen3vl_32b_minimax_h3.safetensors")?.id).toBe(
      "qwen3vl-h3",
    );
    expect(familyFor("qwen3vl_8b_fp8.safetensors")?.id).toBe("qwen3vl");
    expect(familyFor("ae.safetensors")?.id).toBe("flux1-vae");
    expect(familyFor("sub\\dir\\krea2_bf16.safetensors")?.id).toBe("krea2");
    expect(familyFor("totally_unknown.safetensors")).toBeUndefined();
  });

  it("every family id is unique", () => {
    const ids = MODEL_FAMILIES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("scans any weight-like input and skips inert and filter LoRAs", () => {
    const wf = {
      "1": { class_type: "UNETLoader", inputs: { unet_name: "a.safetensors" } },
      "2": {
        class_type: "CustomLoader",
        inputs: { model_path: "b.gguf", other: "c.txt" },
      },
      "3": {
        class_type: "LoraLoaderModelOnly",
        inputs: { lora_name: "off.safetensors", strength_model: 0 },
      },
      "4": {
        class_type: "LoraLoaderModelOnly",
        inputs: { lora_name: "on.safetensors", strength_model: 0.8 },
      },
      "5": { class_type: "UNETLoader", inputs: { unet_name: "A.safetensors" } },
    } as unknown as Workflow;
    (wf as Record<string, unknown>)["6"] = {
      class_type: "LoraLoaderModelOnly",
      inputs: { lora_name: "hidden.safetensors", strength_model: 1 },
      _meta: { title: ["Filter", "LoRA"].join(" ") + " (optional)" },
    };
    expect(workflowWeightFiles(wf)).toEqual([
      "a.safetensors",
      "b.gguf",
      "on.safetensors",
    ]);
  });

  it("combines commercial status as the most restrictive", () => {
    expect(worstCommercial([])).toBe("yes");
    expect(worstCommercial(["yes", "unverified"])).toBe("unverified");
    expect(worstCommercial(["restricted", "yes"])).toBe("restricted");
    expect(worstCommercial(["restricted", "no", "yes"])).toBe("no");
  });

  it("buckets VRAM from the largest main model", () => {
    const fam = (gb?: number) => ({
      id: "x",
      label: "x",
      match: /x/,
      license: "",
      commercial: "yes" as const,
      gb,
    });
    expect(vramTier([])).toBe("n/a");
    expect(vramTier([fam()])).toBe("light");
    expect(vramTier([fam(5.5)])).toBe("8 GB");
    expect(vramTier([fam(14.3), fam(3)])).toBe("16 GB");
    expect(vramTier([fam(20.4)])).toBe("24 GB");
    expect(vramTier([fam(40.9)])).toBe("24 GB + offload");
  });

  it("summarises card inputs", () => {
    const spec = ACTION_TOOLS.find((t) => t.secondImage && t.text);
    expect(spec).toBeDefined();
    const s = actionInputs(spec!);
    expect(s.startsWith("image") || s.startsWith("video")).toBe(true);
    expect(s).toContain(spec!.secondImage!.toLowerCase());
  });
});

describe("docs/TOOLS.md", () => {
  const hub = JSON.parse(
    readFileSync(path.join(ROOT, "src/lib/tools/hubCounts.json"), "utf8"),
  ) as HubToolCounts;
  const result = renderToolsDoc(loadWorkflow, hub);

  it("maps every weight file in every tool graph to a licensed family", () => {
    expect(result.unmapped).toEqual([]);
    expect(result.missingWorkflows).toEqual([]);
  });

  it("lists every action tool and catalog tool", () => {
    for (const t of ACTION_TOOLS)
      expect(result.markdown).toContain(`| ${t.title.replace(/\|/g, "\\|")} |`);
    for (const t of getEditTools())
      expect(result.markdown).toContain(`| ${t.label.replace(/\|/g, "\\|")} |`);
    expect(result.rows.length).toBe(
      ACTION_TOOLS.length + getEditTools().length,
    );
  });

  it("covers the speech pipelines (Whisper ASR, Chatterbox TTS/VC)", () => {
    expect(result.markdown).toContain("## Speech pipelines");
    expect(result.markdown).toMatch(/Whisper/);
    expect(result.markdown).toMatch(/Chatterbox multilingual/);
    expect(result.markdown).toMatch(/\| Voice Changer \|.*Chatterbox VC/);
  });

  it("flags non-commercial catalog tools as nc", () => {
    const nc = getEditTools().filter((t) => t.base === "qwen21");
    expect(nc.length).toBeGreaterThan(0);
    for (const t of nc)
      expect(
        result.rows.find((r) => r.key === `catalog:${t.id}`)?.commercial,
      ).toBe("no");
  });

  it("contains no reference-site branding or private filter weights", () => {
    // Built from parts so this file does not itself contain the brand name.
    const brand = new RegExp(`${"mid"}${"journey"}|\\b${"M"}${"J"}\\b`, "i");
    expect(result.markdown).not.toMatch(brand);
    expect(result.markdown).not.toMatch(/filter lora/i);
  });

  it("matches the committed file (regenerate: npm run docs:tools)", () => {
    if (process.env.UPDATE_TOOLS_DOC === "1")
      writeFileSync(DOC, result.markdown);
    expect(existsSync(DOC)).toBe(true);
    expect(readFileSync(DOC, "utf8")).toBe(result.markdown);
  });
});

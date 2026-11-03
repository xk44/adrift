/**
 * Qwen-Image-2.1 native edit + FLUX.3 Klein pack: graph wiring, slot discovery
 * (single-node pos/neg encoder, ReferenceMultiLatent pass-through), action routing.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  discoverT2ISlots,
  followCondBranch,
  detectWorkflowType,
} from "@/lib/oj/discovery";
import { buildActionWorkflow, injectParams } from "@/lib/oj/engine";
import registry from "@/lib/oj/registry.json";
import type { ImagineRun, Workflow } from "@/types";

const WORKFLOWS_DIR = path.join(process.cwd(), "public", "workflows");
type G = Record<
  string,
  { class_type: string; inputs?: Record<string, unknown> }
>;

function load(rel: string): G {
  const g = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, rel), "utf-8"));
  delete g._meta;
  return g;
}

function danglingRefs(graph: G): string[] {
  const ids = new Set(Object.keys(graph));
  const bad: string[] = [];
  for (const [nodeId, node] of Object.entries(graph)) {
    for (const val of Object.values(node.inputs ?? {})) {
      if (Array.isArray(val) && typeof val[0] === "string" && !ids.has(val[0]))
        bad.push(`${nodeId} -> ${val[0]}`);
    }
  }
  return bad;
}

const sourceRun = {
  run_id: "run-q",
  prompt: "portrait",
  parsedPrompt: "portrait",
  width: 1024,
  height: 1024,
  jobs: [
    {
      seed: 1,
      index: 0,
      status: "done",
      progress: 100,
      images: ["/view?filename=portrait.png&subfolder=out&type=output"],
      prompt_id: "p-q",
    },
  ],
  createdAt: new Date().toISOString(),
  status: "done",
  params: {},
} as unknown as ImagineRun;

const ALL = [
  "packs/qwen-image-21/edit.json",
  "packs/qwen-image-21/edit_turbo.json",
  "packs/flux3/t2i.json",
  "packs/flux3/t2i_fast.json",
  "packs/flux3/edit.json",
  "packs/flux3/edit_fast.json",
];

describe("Qwen 2.1 edit + FLUX.3 graphs", () => {
  it.each(ALL)("%s has no dangling refs", (rel) => {
    expect(danglingRefs(load(rel))).toEqual([]);
  });

  it("qwen21 edit: prompt + negative_prompt both land on TextEncodeQwenImage21", () => {
    const wf = load("packs/qwen-image-21/edit.json");
    const slots = discoverT2ISlots(wf as unknown as Workflow);
    expect(wf[slots.posTextId].class_type).toBe("TextEncodeQwenImage21");
    expect(slots.posTextInputName).toBe("prompt");
    expect(slots.negTextId).toBe(slots.posTextId);
    expect(slots.negTextInputName).toBe("negative_prompt");

    const w = structuredClone(wf) as unknown as Workflow;
    injectParams(w, slots, {}, "make it snowy", "blurry", 7);
    const n = (w as unknown as G)[slots.posTextId].inputs!;
    expect(n.prompt).toBe("make it snowy");
    expect(n.negative_prompt).toBe("blurry");
    expect(n.text).toBeUndefined();
  });

  it("qwen21 edit action injects the source image into LoadImage", () => {
    const { workflow, slots } = buildActionWorkflow(
      load("packs/qwen-image-21/edit.json") as unknown as Workflow,
      "edit_qwen21",
      sourceRun,
      0,
      { prompt: "make it snowy" },
    );
    const w = workflow as unknown as G;
    const imageInputId = (slots as { imageInputId?: string }).imageInputId!;
    expect(w[imageInputId].class_type).toBe("LoadImage");
    expect(w[imageInputId].inputs?.image).toBe("out/portrait.png [output]");
    expect(w[slots.posTextId].inputs?.prompt).toBe("make it snowy");
  });

  it("flux3 edit: negative traces through ReferenceMultiLatent to the negative encoder", () => {
    const wf = load("packs/flux3/edit.json");
    const slots = discoverT2ISlots(wf as unknown as Workflow);
    expect(slots.posTextId).toBe("4");
    expect(slots.negTextId).toBe("5"); // plain BFS would have returned "4"
    expect(slots.negTextInputName).toBeUndefined();
    expect(followCondBranch(wf as unknown as Workflow, "17", "negative")).toBe(
      "5",
    );
  });

  it("flux3 t2i discovers the Flux2 latent node for --ar", () => {
    const wf = load("packs/flux3/t2i.json");
    const slots = discoverT2ISlots(wf as unknown as Workflow);
    expect(wf[slots.latentDimsId].class_type).toBe("EmptyFlux2LatentImage");
    expect(detectWorkflowType(wf as unknown as Workflow)).toBe("t2i");
  });

  it("registers the edit actions as image-requiring refine actions", () => {
    const actions = registry.actions as Record<
      string,
      { requiresImage?: boolean; template?: string }
    >;
    const templates = registry.templates as Record<string, { file: string }>;
    for (const id of [
      "edit_qwen21",
      "edit_qwen21_fast",
      "edit_flux3",
      "edit_flux3_fast",
    ]) {
      expect(actions[id]?.requiresImage).toBe(true);
      expect(actions[id]?.template).toBe(id);
      expect(fs.existsSync(path.join(WORKFLOWS_DIR, templates[id].file))).toBe(
        true,
      );
    }
  });

  it("flux.1 detection no longer swallows FLUX.3 checkpoints", async () => {
    vi.stubEnv("CJ_FLUX3", "1");
    vi.resetModules();
    const packs = await import("@/lib/oj/packs");
    expect(packs.detectModelFamily("flux1-dev.safetensors")).toBe("flux");
    expect(packs.detectModelFamily("flux3_image_klein_bf16.safetensors")).toBe(
      "flux3",
    );
    expect(
      packs.resolveWorkflow({ templateOrAction: "edit_flux3", packId: "flux3" })
        .workflowPath,
    ).toBe("packs/flux3/edit.json");
    vi.unstubAllEnvs();
  });
});

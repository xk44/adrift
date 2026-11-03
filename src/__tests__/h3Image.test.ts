/**
 * MiniMax H3 Text to Image (packs/minimax/t2i.json): graph shape, Create
 * engine wiring, and isolation from the H3 video options.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Workflow } from "@/types";
import { discoverT2ISlots } from "@/lib/oj/discovery";
import { injectParams } from "@/lib/oj/engine";
import { resolveWorkflow } from "@/lib/oj/packs";
import registry from "@/lib/oj/registry.json";
import { isH3Graph } from "@/lib/oj/h3Video";
import { applyH3Speed } from "@/lib/oj/h3Speed";
import {
  detectSpeedEngine,
  speedEngineForWorkflowPath,
} from "@/lib/oj/speedTier";
import {
  applyH3ImageGrid,
  H3_IMAGE_ENGINE,
  H3_IMAGE_STEPS,
  H3_IMAGE_WORKFLOW,
  isH3ImageGraph,
} from "@/lib/oj/h3Image";
import { activeFamilyGroup } from "@/lib/characters/characterLoras";
import { isH3Model } from "@/lib/tools/h3License";

const OI_FILE = process.env.LIVE_OBJECT_INFO;
const OI: Record<string, unknown> | null =
  OI_FILE && fs.existsSync(OI_FILE)
    ? JSON.parse(fs.readFileSync(OI_FILE, "utf-8"))
    : null;

function load(): Workflow {
  const p = path.join(process.cwd(), "public", "workflows", H3_IMAGE_WORKFLOW);
  return JSON.parse(fs.readFileSync(p, "utf-8")) as Workflow;
}

const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(([, n]) => n.class_type === cls);

describe("H3 Text to Image graph", () => {
  it.skipIf(!OI)("uses only node classes from the live object_info", () => {
    const missing = Object.values(load())
      .map((n) => n.class_type)
      .filter((c) => !(c in (OI as Record<string, unknown>)));
    expect(missing).toEqual([]);
  });

  it.skipIf(!OI)("uses only input names the live nodes declare", () => {
    type Info = { input?: Record<string, Record<string, unknown>> };
    const unknown: string[] = [];
    for (const [id, node] of Object.entries(load())) {
      const info = (OI as Record<string, Info>)[node.class_type]?.input ?? {};
      const declared = { ...info.required, ...info.optional };
      for (const name of Object.keys(node.inputs ?? {}))
        if (!(name in declared)) unknown.push(`${id}.${name}`);
    }
    expect(unknown).toEqual([]);
  });

  it("is plain API format with in-range links", () => {
    const wf = load();
    for (const [id, node] of Object.entries(wf)) {
      expect(typeof node.class_type, id).toBe("string");
      for (const v of Object.values(node.inputs ?? {})) {
        if (Array.isArray(v) && typeof v[0] === "string")
          expect(wf[v[0]], `${id} -> ${v[0]}`).toBeDefined();
      }
    }
  });

  it("pins the pruned DiT, the Turbo 8-step LoRA and turbo sampling", () => {
    const wf = load();
    expect(byClass(wf, "UNETLoader")[0][1].inputs.unet_name).toBe(
      "minimax_h3_fl2va_pruned_bf16.safetensors",
    );
    const lora = byClass(wf, "LoraLoaderModelOnly")[0][1].inputs;
    expect(lora.lora_name).toBe(
      "minimax_h3_fl2v_turbo_8step_v1.1_768p_comfyui_bf16.safetensors",
    );
    expect(lora.strength_model).toBe(1);
    const sched = byClass(wf, "BasicScheduler")[0][1].inputs;
    expect(sched.steps).toBe(H3_IMAGE_STEPS);
    expect(byClass(wf, "BasicGuider")).toHaveLength(1);
    expect(byClass(wf, "SaveImage")).toHaveLength(1);
    expect(byClass(wf, "EmptyLatentImage")[0][1].inputs.batch_size).toBe(1);
  });

  it("is an H3 image graph, not an H3 video graph", () => {
    const wf = load();
    expect(isH3ImageGraph(wf)).toBe(true);
    expect(isH3Graph(wf)).toBe(false);
    const before = JSON.stringify(wf);
    expect(applyH3Speed(wf, { h3Speed: "turbo" })).toEqual([]);
    expect(JSON.stringify(wf)).toBe(before);
  });

  it("has no speed tier (Turbo is baked in)", () => {
    expect(speedEngineForWorkflowPath(H3_IMAGE_WORKFLOW)).toBeNull();
    expect(speedEngineForWorkflowPath("packs/minimax/t2v.json")).toBe(
      "h3-video",
    );
    expect(detectSpeedEngine(load())).toBeNull();
  });
});

describe("H3 Text to Image injection", () => {
  function inject(params: Record<string, unknown>) {
    const wf = load();
    const slots = discoverT2ISlots(wf);
    injectParams(wf, slots, params, "a red fox in snow", "", 7);
    return { wf, slots };
  }

  it("finds prompt, latent and custom-sampling slots", () => {
    const slots = discoverT2ISlots(load());
    expect(slots.posTextId).toBe("5");
    expect(slots.latentDimsId).toBe("7");
    expect(slots.customSampling?.noiseId).toBe("8");
    expect(slots.customSampling?.sigmasId).toBe("10");
    expect(slots.customSampling?.guiderId).toBe("11");
  });

  it("sets the prompt, seed and aspect preset and keeps 8 steps", () => {
    const { wf } = inject({ ar: "16:9" });
    expect(wf["5"].inputs.text).toContain("a red fox in snow");
    expect(wf["8"].inputs.noise_seed).toBe(7);
    expect(wf["7"].inputs.width).toBe(1344);
    expect(wf["7"].inputs.height).toBe(768);
    expect(wf["10"].inputs.steps).toBe(8);
  });

  it("scales the pinned 8 steps by Create quality", () => {
    expect(inject({ quality: 0.5 }).wf["10"].inputs.steps).toBe(4);
    expect(inject({ quality: 2 }).wf["10"].inputs.steps).toBe(16);
    expect(inject({ quality: 2, steps: 10 }).wf["10"].inputs.steps).toBe(20);
  });

  it("snaps draft-scaled dims to the 32-px grid", () => {
    const { wf } = inject({ ar: "16:9", draft: true, draft_scale: 0.55 });
    expect((wf["7"].inputs.width as number) % 32).toBe(0);
    expect((wf["7"].inputs.height as number) % 32).toBe(0);
  });

  it("applyH3ImageGrid leaves non-H3 graphs alone", () => {
    const wf: Workflow = {
      "1": {
        class_type: "UNETLoader",
        inputs: { unet_name: "flux1-dev.safetensors" },
      },
      "2": {
        class_type: "EmptyLatentImage",
        inputs: { width: 1000, height: 1000, batch_size: 1 },
      },
    };
    applyH3ImageGrid(wf);
    expect(wf["2"].inputs.width).toBe(1000);
  });
});

describe("H3 Text to Image wiring", () => {
  it("resolves as the minimax pack's t2i workflow", () => {
    const r = resolveWorkflow({ templateOrAction: "t2i", packId: "minimax" });
    expect(r.workflowPath).toContain(H3_IMAGE_WORKFLOW);
  });

  it("is registered as a t2i template", () => {
    const tpl = (registry as any).templates?.minimax_t2i;
    expect(tpl?.file).toBe(H3_IMAGE_WORKFLOW);
    expect(tpl?.kind).toBe("t2i");
  });

  it("maps the Create engine to the minimax family", () => {
    expect(activeFamilyGroup({ modelVersion: H3_IMAGE_ENGINE })).toBe(
      "minimax",
    );
  });

  it("offers the engine in Create with the H3 license notice", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/components/SettingsPanel.tsx"),
      "utf-8",
    );
    const label = src.match(
      /value: H3_IMAGE_ENGINE,\s*label: "([^"]+)",\s*workflow: H3_IMAGE_WORKFLOW/,
    )?.[1];
    expect(label && isH3Model(label)).toBe(true);
    expect(src).toMatch(
      /engine\.value === H3_IMAGE_ENGINE[\s\S]{0,80}<H3Attribution/,
    );
  });
});

/**
 * buildWorkflowForAction: the pure "any tool action → final API workflow"
 * step behind /api/jobs/action (and its dry_run used by the ComfyUI overlay
 * "Send to graph"). Real pack graphs from public/workflows, no ComfyUI.
 * Five representative tools: image (vary), edit (Qwen 2.1 edit), video
 * (LTX-2.5 animate), audio (music), app (Figurine via its edit engine).
 */
import path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import {
  buildWorkflowForAction,
  canonicalActionId,
} from "@/lib/oj/actionWorkflow";
import { resolveWorkflow } from "@/lib/oj/packs";
import { loadWorkflowFromSelection } from "@/lib/comfy/workflows";
import { findMaskSlotIds } from "@/lib/comfy/actionMask";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import { buildEngineRequest } from "@/lib/tools/engineRequest";
import { EDIT_ENGINES } from "@/lib/tools/templates";
import { compileAppPrompt, getApp } from "@/lib/tools/apps";

const SOURCE = "cj/src_photo.png [input]";

const seededRun = (): ImagineRun => ({
  run_id: "seed",
  prompt: "a ceramic teapot on a table",
  parsedPrompt: "a ceramic teapot on a table",
  width: 1024,
  height: 1024,
  createdAt: "2026-10-25T00:00:00Z",
  status: "done",
  jobs: [
    {
      seed: 7,
      index: 0,
      status: "done",
      progress: 100,
      images: [
        "/api/comfy/view?filename=src_photo.png&subfolder=cj&type=input",
      ],
    },
  ],
  params: {},
});

/** Same resolution as the action route: registry / pack graph on disk. */
async function baseFor(
  action: string,
  params: Record<string, unknown>,
): Promise<Workflow> {
  const packId =
    typeof params.pack_id === "string" ? params.pack_id : undefined;
  const { workflowPath } = resolveWorkflow({
    templateOrAction: action,
    packId,
  });
  return loadWorkflowFromSelection(
    path.join(process.cwd(), "public/workflows", workflowPath),
  );
}

/** Action request exactly as the Tools runner sends it. */
function toolRequest(id: string, patch: Partial<ToolSettings> = {}) {
  const spec = getActionTool(id);
  if (!spec) throw new Error(`no action tool ${id}`);
  return buildActionRequest(spec, { ...defaultSettings(spec), ...patch }, null);
}

function danglingLinks(wf: Workflow): string[] {
  const out: string[] = [];
  for (const [id, node] of Object.entries(wf)) {
    for (const [key, v] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(v) && typeof v[0] === "string" && !wf[v[0]])
        out.push(`${id}.${key}->${v[0]}`);
    }
  }
  return out;
}

const json = (wf: Workflow) => JSON.stringify(wf);
const classes = (wf: Workflow) =>
  new Set(Object.values(wf).map((n) => n.class_type));

/** API-format, self-consistent graph that loads in ComfyUI as-is. */
function expectApiGraph(wf: Workflow) {
  expect(Object.keys(wf).length).toBeGreaterThan(0);
  for (const node of Object.values(wf)) {
    expect(typeof node.class_type).toBe("string");
    expect(node.inputs).toBeTypeOf("object");
  }
  expect(danglingLinks(wf)).toEqual([]);
}

describe("buildWorkflowForAction: five representative tools", () => {
  it("image: Vary (subtle) slot id, generic builder, source image", async () => {
    const action = canonicalActionId("single.vary_subtle");
    const params = { prompt: "a ceramic teapot on a table" };
    const base = await baseFor(action, params);
    const before = json(base);
    const out = buildWorkflowForAction(action, params, {
      baseWorkflow: base,
      sourceRun: seededRun(),
    });
    expect(out.builder).toBe("generic");
    expect(out.action).toBe("vary_subtle");
    expectApiGraph(out.workflow);
    expect(json(out.workflow)).toContain(SOURCE);
    expect(classes(out.workflow).has("KSampler")).toBe(true);
    expect(typeof out.seed).toBe("number");
    // Pure: the loaded base graph is never mutated.
    expect(json(base)).toBe(before);
  });

  it("edit: Qwen 2.1 edit carries the instruction and source", async () => {
    const req = toolRequest("edit_qwen21", { text: "make it porcelain blue" });
    const base = await baseFor(req.action, req.params);
    const out = buildWorkflowForAction(req.action, req.params, {
      baseWorkflow: base,
      sourceRun: seededRun(),
      overrides: req.overrides,
    });
    expectApiGraph(out.workflow);
    expect(json(out.workflow)).toContain("make it porcelain blue");
    expect(json(out.workflow)).toContain(SOURCE);
  });

  it("video: LTX-2.5 animate (custom builder) wires the start frame", async () => {
    const req = toolRequest("ltx25_animate", { text: "steam rises slowly" });
    const base = await baseFor(req.action, req.params);
    const out = buildWorkflowForAction(req.action, req.params, {
      baseWorkflow: base,
      sourceRun: seededRun(),
      overrides: req.overrides,
    });
    expect(out.builder).toBe("custom");
    expectApiGraph(out.workflow);
    expect(json(out.workflow)).toContain("steam rises slowly");
    expect(json(out.workflow)).toContain(SOURCE);
  });

  it("audio: Music (text-only) sets tags and duration", async () => {
    const req = toolRequest("music", {
      text: "lofi piano, rain",
    });
    const base = await baseFor(req.action, req.params);
    const out = buildWorkflowForAction(req.action, req.params, {
      baseWorkflow: base,
      sourceRun: { ...seededRun(), jobs: [] } as unknown as ImagineRun,
      overrides: req.overrides,
    });
    expect(out.builder).toBe("custom");
    expectApiGraph(out.workflow);
    const enc = Object.values(out.workflow).find(
      (n) => n.class_type === "TextEncodeAceStepAudio1.5",
    );
    expect(enc?.inputs.tags).toBe("lofi piano, rain");
    expect(classes(out.workflow).has("KSampler")).toBe(true);
  });

  it("app: Figurine via its Qwen Edit 2511 engine applies engine overrides", async () => {
    const app = getApp("figurine");
    expect(app).toBeTruthy();
    const prompt = compileAppPrompt(app!);
    const req = buildEngineRequest(EDIT_ENGINES.qwen2511, prompt, {
      catalog: null,
      packIds: null,
      editLoras: null,
    });
    if (req.kind !== "action") throw new Error("expected an action engine");
    const base = await baseFor(req.action, req.params);
    const out = buildWorkflowForAction(req.action, req.params, {
      baseWorkflow: base,
      sourceRun: seededRun(),
      overrides: req.overrides,
    });
    expectApiGraph(out.workflow);
    expect(json(out.workflow)).toContain(SOURCE);
    // Engine override "2.strength_model": 0 (no camera rotation LoRA).
    expect(out.workflow["2"]?.inputs.strength_model).toBe(0);
    expect(json(out.workflow)).toContain(prompt.slice(0, 40));
  });
});

describe("buildWorkflowForAction: mask + overrides", () => {
  it("points mask slots at the mask ref, explicit overrides win", async () => {
    const base: Workflow = {
      "1": { class_type: "LoadImage", inputs: { image: "x.png" } },
      "2": {
        class_type: "LoadImageMask",
        inputs: { image: "mask.png", channel: "red" },
        _meta: { title: "mask" },
      },
      "3": { class_type: "GrowMask", inputs: { mask: ["2", 0], expand: 4 } },
      "4": {
        class_type: "KSampler",
        inputs: { seed: 1, steps: 20, cfg: 4, denoise: 1, model: ["5", 0] },
      },
      "5": { class_type: "UNETLoader", inputs: { unet_name: "m.safetensors" } },
    } as unknown as Workflow;
    const slots = findMaskSlotIds(base);
    expect(slots).toEqual(["2"]);
    const out = buildWorkflowForAction(
      "bg_remove",
      { maskExpand: 12 },
      {
        baseWorkflow: base,
        sourceRun: seededRun(),
        maskSlotIds: slots,
        maskRef: "cj/m.png [input]",
        overrides: { "4.steps": 8 },
      },
    );
    expect(out.workflow["1"].inputs.image).toBe(SOURCE);
    expect(out.workflow["2"].inputs.image).toBe("cj/m.png [input]");
    expect(out.workflow["3"].inputs.expand).toBe(12);
    expect(out.workflow["4"].inputs.steps).toBe(8);
    expect(base["2"].inputs.image).toBe("mask.png");
  });
});

describe("canonicalActionId", () => {
  it("maps slot ids and UI aliases like the route", () => {
    expect(canonicalActionId("music")).toBe("music");
    expect(canonicalActionId("zoom_out_1_5x")).toBe("zoom_1_5x");
    expect(canonicalActionId("single.vary_subtle")).toBe("vary_subtle");
  });
});

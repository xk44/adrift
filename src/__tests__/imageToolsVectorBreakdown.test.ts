/**
 * Vectorize (CJVectorize -> SVG download) and Breakdown (SAM3 per part ->
 * CJCutouts): graphs, builders, registry, routing, tool cards, hub, and the
 * file-download row for the .svg output.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import registry from "@/lib/oj/registry.json";
import { resolveWorkflow } from "@/lib/oj/packs";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  BREAKDOWN_ACTION,
  VECTORIZE_ACTION,
  breakdownParts,
  buildBreakdownWorkflow,
  buildVectorizeWorkflow,
  vectorizeColors,
  vectorizePreset,
} from "@/lib/oj/imageTools";
import { DEFAULT_VIDEO_PACKS, routeBackend } from "@/lib/comfy/backends";
import { workflowModelRequirements } from "@/lib/tools/modelStatus";
import { CARD_OVERRIDES } from "@/lib/tools/hub";
import { extractOutputs } from "@/lib/comfy/outputs";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";
import type { ImagineRun, Workflow } from "@/types";

const WORKFLOWS_DIR = path.join(process.cwd(), "public/workflows");
const VEC_FILE = "packs/image-tools/vectorize.json";
const BRK_FILE = "packs/image-tools/breakdown.json";
const load = (file: string): Workflow => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(WORKFLOWS_DIR, file), "utf-8"),
  );
  delete raw._meta;
  return raw;
};

const run = (images: string[]): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "src",
    width: 1024,
    height: 1024,
    jobs: [{ seed: 11, index: 0, status: "completed", progress: 100, images }],
    createdAt: new Date().toISOString(),
    status: "completed",
    params: {},
  }) as unknown as ImagineRun;

const IMG = "/api/comfy/view?filename=logo.png&subfolder=&type=input";

const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf)
    .filter(([, n]) => n.class_type === cls)
    .sort(([a], [b]) => Number(a) - Number(b));

function expectLinksResolve(wf: Workflow) {
  for (const [id, node] of Object.entries(wf)) {
    for (const [k, v] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(v) && typeof v[0] === "string") {
        expect(wf[v[0]], `${id}.${k} → ${v[0]}`).toBeDefined();
      }
    }
  }
}

describe("vectorize graph + builder", () => {
  it("is LoadImage -> CJVectorize, no models", () => {
    const wf = load(VEC_FILE);
    expectLinksResolve(wf);
    const [[, vec]] = byClass(wf, "CJVectorize");
    expect(vec.inputs).toMatchObject({
      image: ["1", 0],
      engine: "opencv",
      filename_prefix: "CJ_Vector/vector",
    });
    expect(workflowModelRequirements(wf)).toEqual([]);
  });

  it("patches image, preset, colours and detail (clamped)", () => {
    const { workflow, slots } = buildVectorizeWorkflow(
      load(VEC_FILE),
      run([IMG]),
      0,
      { preset: "poster", colors: 99, detail: 9 },
    );
    expect(workflow[slots.imageInputId!].inputs.image).toBe("logo.png [input]");
    expect(byClass(workflow, "CJVectorize")[0][1].inputs).toMatchObject({
      preset: "poster",
      colors: 64,
      detail: 4,
    });
    expect(vectorizePreset("nope")).toBe("logo");
    expect(vectorizeColors("0")).toBe(0);
    expect(vectorizeColors(1)).toBe(2);
    expect(() =>
      buildVectorizeWorkflow(load(VEC_FILE), run([]), 0, {}),
    ).toThrow(/no image/);
  });

  it("classifies the node's ui: preview PNG is an image, the .svg a downloadable file", () => {
    const outs = extractOutputs({
      prompt: [0, "p", { "2": { class_type: "CJVectorize", inputs: {} } }],
      outputs: {
        "2": {
          images: [
            {
              filename: "vector_00001_.png",
              subfolder: "CJ_Vector",
              type: "output",
            },
          ],
          svg: [
            {
              filename: "vector_00001_.svg",
              subfolder: "CJ_Vector",
              type: "output",
            },
          ],
        },
      },
    } as never);
    expect(outs.map((o) => [o.key, o.kind])).toEqual([
      ["images", "image"],
      ["svg", "unknown"],
    ]);
    expect(outs[1].view?.filename).toBe("vector_00001_.svg");
  });
});

describe("breakdown graph + builder", () => {
  it("SAM3 (individual masks) feeds CJCutouts; needs the SAM3.1 checkpoint", () => {
    const wf = load(BRK_FILE);
    expectLinksResolve(wf);
    const [[detId, det]] = byClass(wf, "SAM3_Detect");
    expect(det.inputs.individual_masks).toBe(true);
    const [[, cut]] = byClass(wf, "CJCutouts");
    expect(cut.inputs.masks).toEqual([detId, 0]);
    expect(cut.inputs.dedupe_iou).toBe(0.85);
    expect(
      workflowModelRequirements(wf).map((r) => `${r.dir}/${r.file}`),
    ).toEqual(["checkpoints/sam3.1_multiplex_fp16.safetensors"]);
  });

  it("parses parts: sanitized, deduped, :N kept, max 8, default list", () => {
    expect(breakdownParts("person, bag:2, <b>ox!, Person")).toEqual([
      { label: "person", prompt: "person:4" },
      { label: "bag", prompt: "bag:2" },
      { label: "box", prompt: "box:4" },
    ]);
    expect(breakdownParts("").map((p) => p.label)).toEqual([
      "person",
      "clothing",
      "bag",
      "background objects",
    ]);
    expect(breakdownParts("a,b,c,d,e,f,g,h,i,j")).toHaveLength(8);
    expect(breakdownParts(" , ,")).toHaveLength(4);
  });

  it("clones one CLIPTextEncode + SAM3_Detect per part into masks_N", () => {
    const { workflow } = buildBreakdownWorkflow(load(BRK_FILE), run([IMG]), 0, {
      parts: "person:2, jacket, bag",
    });
    expectLinksResolve(workflow);
    const dets = byClass(workflow, "SAM3_Detect");
    const texts = byClass(workflow, "CLIPTextEncode");
    expect(dets).toHaveLength(3);
    expect(texts.map(([, n]) => n.inputs.text)).toEqual([
      "person:2",
      "jacket:4",
      "bag:4",
    ]);
    const [[, cut]] = byClass(workflow, "CJCutouts");
    expect(cut.inputs.labels).toBe("person, jacket, bag");
    const wired = [
      cut.inputs.masks,
      cut.inputs.masks_2,
      cut.inputs.masks_3,
    ].map((l) => workflow[(l as [string, number])[0]]);
    expect(wired.map((n) => n.class_type)).toEqual([
      "SAM3_Detect",
      "SAM3_Detect",
      "SAM3_Detect",
    ]);
    expect(
      wired.map(
        (n) =>
          workflow[(n.inputs.conditioning as [string, number])[0]].inputs.text,
      ),
    ).toEqual(["person:2", "jacket:4", "bag:4"]);
    for (const [, d] of dets) {
      expect(d.inputs).toMatchObject({
        individual_masks: true,
        image: ["1", 0],
      });
    }
    expect(cut.inputs.masks_4).toBeUndefined();
    expect(workflow["1"].inputs.image).toBe("logo.png [input]");
  });

  it("defaults to the four standard parts", () => {
    const { workflow } = buildBreakdownWorkflow(load(BRK_FILE), run([IMG]), 0);
    expect(byClass(workflow, "SAM3_Detect")).toHaveLength(4);
    expect(byClass(workflow, "CJCutouts")[0][1].inputs.labels).toBe(
      "person, clothing, bag, background objects",
    );
  });
});

describe("registry, routing, tools page, hub", () => {
  const templates = registry.templates as Record<string, { file: string }>;
  const actions = registry.actions as Record<string, Record<string, unknown>>;

  it("registers both image actions with builders", () => {
    expect(templates[VECTORIZE_ACTION].file).toBe(VEC_FILE);
    expect(templates[BREAKDOWN_ACTION].file).toBe(BRK_FILE);
    for (const a of [VECTORIZE_ACTION, BREAKDOWN_ACTION]) {
      expect(actions[a]).toMatchObject({ requiresImage: true, template: a });
      expect(VIDEO_INPUT_ACTIONS.has(a)).toBe(false);
    }
    expect(actionBuilderFor(VECTORIZE_ACTION)).toBe(buildVectorizeWorkflow);
    expect(actionBuilderFor(BREAKDOWN_ACTION)).toBe(buildBreakdownWorkflow);
    expect(
      resolveWorkflow({ templateOrAction: VECTORIZE_ACTION }).workflowPath,
    ).toBe(VEC_FILE);
    expect(
      resolveWorkflow({ templateOrAction: BREAKDOWN_ACTION }).workflowPath,
    ).toBe(BRK_FILE);
  });

  it("routes the image-tools pack to the video host (where the nodes live)", () => {
    expect(DEFAULT_VIDEO_PACKS).toContain("image-tools");
    const prev = process.env.COMFY_VIDEO_HTTP_URL;
    process.env.COMFY_VIDEO_HTTP_URL = "http://10.0.0.2:8188";
    try {
      expect(
        routeBackend({ action: VECTORIZE_ACTION, workflowPath: VEC_FILE }),
      ).toBe("video");
      expect(
        routeBackend({ action: BREAKDOWN_ACTION, workflowPath: BRK_FILE }),
      ).toBe("video");
    } finally {
      if (prev === undefined) delete process.env.COMFY_VIDEO_HTTP_URL;
      else process.env.COMFY_VIDEO_HTTP_URL = prev;
    }
  });

  it("tool specs map settings to action params", () => {
    const vec = getActionTool("vectorize")!;
    expect(vec.modelCheck).toEqual({
      pack: "image-tools",
      action: "vectorize",
    });
    expect(buildActionRequest(vec, defaultSettings(vec), null)).toEqual({
      action: "vectorize",
      params: { preset: "logo", colors: 0 },
      overrides: {},
    });
    expect(
      buildActionRequest(
        vec,
        { ...defaultSettings(vec), picks: { preset: "poster", colors: "16" } },
        null,
      ).params,
    ).toEqual({ preset: "poster", colors: 16 });

    const brk = getActionTool("breakdown")!;
    expect(brk.modelCheck).toEqual({
      pack: "image-tools",
      action: "breakdown",
    });
    expect(buildActionRequest(brk, defaultSettings(brk), null)).toEqual({
      action: "breakdown",
      params: {},
      overrides: {},
    });
    expect(
      buildActionRequest(
        brk,
        { ...defaultSettings(brk), text: "cat, hat" },
        null,
      ).params,
    ).toEqual({ parts: "cat, hat" });
  });

  it("hub cards", () => {
    expect(CARD_OVERRIDES["action:vectorize"]).toMatchObject({ hub: "Edit" });
    expect(CARD_OVERRIDES["action:breakdown"]).toMatchObject({ hub: "Edit" });
  });
});

describe("ExtraOutputList file outputs", () => {
  it("offers an unknown file output with a url as a download, not JSON", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { ExtraOutputList } = await import("@/components/ExtraOutputs");
    const url =
      "/api/comfy/image?filename=vector_00001_.svg&subfolder=CJ_Vector&type=output";
    const html = renderToStaticMarkup(
      createElement(ExtraOutputList, {
        outputs: [
          {
            nodeId: "2",
            nodeTitle: "Vectorize",
            kind: "unknown",
            key: "svg",
            url,
            view: { filename: "vector_00001_.svg" },
            raw: { filename: "vector_00001_.svg" },
          },
        ],
      }),
    );
    expect(html).toContain('data-output-kind="file"');
    expect(html).toContain('download="vector_00001_.svg"');
    expect(html).toContain(`href="${url.replace(/&/g, "&amp;")}"`);
    expect(html).not.toContain("&quot;filename&quot;");
  });
});

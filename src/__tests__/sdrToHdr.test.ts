/**
 * SDR to HDR: core ImageSDRToHDR -> SaveImageAdvanced (HLG AVIF + EXR
 * master) graph, builder, param sanitizers, registry, routing, tool card,
 * request mapping and the before/after compare source memory.
 */
import { describe, it, expect } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunnerStage } from "@/components/tools/RunnerStudio";
import { HdrCompareResult } from "@/components/tools/HdrCompareResult";
import fs from "fs";
import path from "path";
import registry from "@/lib/oj/registry.json";
import { resolveWorkflow } from "@/lib/oj/packs";
import { actionBuilderFor, VIDEO_INPUT_ACTIONS } from "@/lib/oj/actionBuilders";
import {
  SDR_TO_HDR_ACTION,
  SDR_TO_HDR_DEFAULT_PEAK,
  buildSdrToHdrWorkflow,
  sdrToHdrExrDepth,
  sdrToHdrPeak,
} from "@/lib/oj/sdrToHdr";
import { routeBackend } from "@/lib/comfy/backends";
import { lintErrors, lintGraph } from "@/lib/tools/graphLint";
import { CARD_OVERRIDES } from "@/lib/tools/hub";
import { TOOL_NAMES } from "@/lib/tools/toolNames";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";
import {
  COMPARE_SOURCE_TOOLS,
  compareSourceFor,
  rememberCompareSource,
} from "@/lib/tools/compareSources";
import {
  MASTER_SUBFOLDER,
  addMasterOutputs,
  isMasterNode,
} from "@/lib/output/saveNodes";
import type { ImagineRun, Workflow } from "@/types";

const FILE = "packs/image-tools/sdr_to_hdr.json";
const RAW = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "public/workflows", FILE), "utf-8"),
) as Record<string, unknown>;
const load = (): Workflow => {
  const { _meta, ...wf } = RAW;
  return wf as Workflow;
};
const { _meta: _fixtureMeta, ...FIXTURE } = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/sdrToHdrNodes.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;
const BASE_INFO = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/graphLint.objectInfo.json"),
    "utf-8",
  ),
) as Record<string, unknown>;

const IMG = "/api/comfy/view?filename=photo.png&subfolder=&type=input";
const srcRun = (images: string[] = [IMG]): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "src",
    width: 1024,
    height: 768,
    jobs: [{ seed: 1, index: 0, status: "completed", progress: 100, images }],
    createdAt: new Date().toISOString(),
    status: "completed",
    params: {},
  }) as unknown as ImagineRun;

const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(([, n]) => n.class_type === cls);

describe("sdr_to_hdr graph", () => {
  it("is core-only: LoadImage -> ImageSDRToHDR -> AVIF preview + EXR master", () => {
    const wf = load();
    expect(byClass(wf, "LoadImage")).toHaveLength(1);
    const [[hdrId, hdr]] = byClass(wf, "ImageSDRToHDR");
    expect(hdr.inputs).toMatchObject({
      algorithm: "lottes",
      "algorithm.target_luminance": SDR_TO_HDR_DEFAULT_PEAK,
    });
    const savers = byClass(wf, "SaveImageAdvanced").map(([, n]) => n);
    expect(savers).toHaveLength(2);
    for (const s of savers) {
      expect(s.inputs.images).toEqual([hdrId, 0]);
      // HLG in: the AVIF is tagged BT.2020/HLG, the EXR is linearised.
      expect(s.inputs["format.input_color_space"]).toBe("HDR");
    }
    const avif = savers.find((s) => s.inputs.format === "avif")!;
    expect(avif.inputs["format.bit_depth"]).toBe("10-bit YUV420");
    expect(isMasterNode(avif)).toBe(false);
    const exr = savers.find((s) => s.inputs.format === "exr")!;
    expect(isMasterNode(exr)).toBe(true);
    expect(String(exr.inputs.filename_prefix).split("/")[0]).toBe(
      MASTER_SUBFOLDER,
    );
  });

  it("says honestly which formats come out", () => {
    const desc = String((RAW._meta as { description: string }).description);
    expect(desc).toMatch(/AVIF/);
    expect(desc).toMatch(/EXR/);
    expect(desc).toMatch(/not recovered highlights/);
  });

  it("only uses node classes on the reference box (fixture + live object_info)", () => {
    const info = { ...BASE_INFO, ...FIXTURE };
    const built = buildSdrToHdrWorkflow(load(), srcRun(), 0, {}).workflow;
    for (const wf of [load(), built]) {
      for (const n of Object.values(wf))
        expect(info[n.class_type]).toBeDefined();
      expect(lintErrors(lintGraph(wf, info, { templateSlots: true }))).toEqual(
        [],
      );
    }
    const oiPath = process.env.LIVE_OBJECT_INFO;
    if (!oiPath || !fs.existsSync(oiPath)) return;
    const live = JSON.parse(fs.readFileSync(oiPath, "utf-8")) as Record<
      string,
      unknown
    >;
    for (const wf of [load(), built]) {
      for (const n of Object.values(wf))
        expect(live[n.class_type]).toBeDefined();
      expect(lintErrors(lintGraph(wf, live, { templateSlots: true }))).toEqual(
        [],
      );
    }
  });

  it("is not doubled by the opt-in master files (they mirror SaveImage only)", () => {
    const { added } = addMasterOutputs(load(), { image: "exr" }, { tool: "x" });
    expect(added).toEqual([]);
  });
});

describe("sdr_to_hdr builder", () => {
  it("sanitizes peak and EXR depth", () => {
    expect(sdrToHdrPeak(undefined)).toBe(SDR_TO_HDR_DEFAULT_PEAK);
    expect(sdrToHdrPeak("abc")).toBe(SDR_TO_HDR_DEFAULT_PEAK);
    expect(sdrToHdrPeak("1000")).toBe(1000);
    expect(sdrToHdrPeak(-5)).toBe(0);
    expect(sdrToHdrPeak(99999)).toBe(10000);
    expect(sdrToHdrPeak(0)).toBe(0);
    expect(sdrToHdrExrDepth("float")).toBe("32-bit float");
    expect(sdrToHdrExrDepth("half")).toBe("16-bit float");
    expect(sdrToHdrExrDepth("nope")).toBe("16-bit float");
  });

  it("patches the source, the peak and the EXR depth only", () => {
    const { workflow, slots, seed } = buildSdrToHdrWorkflow(
      load(),
      srcRun(),
      0,
      { peak: 1200, exr: "float" },
    );
    const [[loadId, loadNode]] = byClass(workflow, "LoadImage");
    expect(loadNode.inputs.image).toBe("photo.png [input]");
    expect(slots.imageInputId).toBe(loadId);
    expect(seed).toBe(0);
    const [[, hdr]] = byClass(workflow, "ImageSDRToHDR");
    expect(hdr.inputs["algorithm.target_luminance"]).toBe(1200);
    const savers = byClass(workflow, "SaveImageAdvanced").map(([, n]) => n);
    expect(
      savers.find((s) => s.inputs.format === "exr")!.inputs["format.bit_depth"],
    ).toBe("32-bit float");
    expect(
      savers.find((s) => s.inputs.format === "avif")!.inputs[
        "format.bit_depth"
      ],
    ).toBe("10-bit YUV420");
    // Template untouched.
    expect(
      byClass(load(), "ImageSDRToHDR")[0][1].inputs[
        "algorithm.target_luminance"
      ],
    ).toBe(650);
  });

  it("throws without a source image", () => {
    expect(() => buildSdrToHdrWorkflow(load(), srcRun([]), 0)).toThrow(
      /no image/,
    );
  });
});

describe("sdr_to_hdr wiring", () => {
  it("is registered, resolves to the pack file and routes like image-tools", () => {
    expect(actionBuilderFor(SDR_TO_HDR_ACTION)).toBe(buildSdrToHdrWorkflow);
    expect(VIDEO_INPUT_ACTIONS.has(SDR_TO_HDR_ACTION)).toBe(false);
    const reg = registry as unknown as {
      actions: Record<string, { template: string; requiresImage: boolean }>;
      templates: Record<string, { file: string }>;
    };
    expect(reg.actions.sdr_to_hdr).toMatchObject({
      template: "sdr_to_hdr",
      requiresImage: true,
    });
    expect(reg.templates.sdr_to_hdr.file).toBe(FILE);
    expect(
      resolveWorkflow({ templateOrAction: SDR_TO_HDR_ACTION }).workflowPath,
    ).toBe(FILE);
    const prev = process.env.COMFY_VIDEO_HTTP_URL;
    process.env.COMFY_VIDEO_HTTP_URL = "http://video-host:8188";
    try {
      expect(
        routeBackend({ action: SDR_TO_HDR_ACTION, workflowPath: FILE }),
      ).toBe(
        routeBackend({
          action: "refocus",
          workflowPath: "packs/image-tools/refocus.json",
        }),
      );
    } finally {
      if (prev === undefined) delete process.env.COMFY_VIDEO_HTTP_URL;
      else process.env.COMFY_VIDEO_HTTP_URL = prev;
    }
  });

  it("has an Enhance card with a peak slider and EXR depth picker", () => {
    expect(CARD_OVERRIDES["action:sdr_to_hdr"]).toMatchObject({
      hub: "Enhance",
    });
    expect(TOOL_NAMES["action:sdr_to_hdr"].aliases).toContain("hdr");
    const spec = getActionTool("sdr_to_hdr")!;
    expect(spec.category).toBe("Enhance");
    expect(spec.modelCheck).toEqual({
      pack: "image-tools",
      action: "sdr_to_hdr",
    });
    expect(spec.subtitle).toMatch(/AVIF/);
    expect(spec.subtitle).toMatch(/EXR/);
    const peak = spec.sliders!.find((s) => s.key === "peak")!;
    expect(peak.default).toBe(SDR_TO_HDR_DEFAULT_PEAK);
    expect(peak.max).toBeLessThanOrEqual(10000);
    expect(peak.min).toBe(0);
  });

  it("maps settings to action params", () => {
    const spec = getActionTool("sdr_to_hdr")!;
    const s = defaultSettings(spec);
    expect(buildActionRequest(spec, s, null)).toEqual({
      action: "sdr_to_hdr",
      params: { peak: 650, exr: "half" },
      overrides: {},
    });
    s.picks.peak = "1234";
    s.picks.exr = "float";
    expect(buildActionRequest(spec, s, null).params).toEqual({
      peak: 1250,
      exr: "float",
    });
  });

  it("remembers the compare source per run, bounded", () => {
    expect(COMPARE_SOURCE_TOOLS.has("sdr_to_hdr")).toBe(true);
    rememberCompareSource("hdr-a", { url: "data:a", width: 4, height: 3 });
    expect(compareSourceFor("hdr-a")).toEqual({
      url: "data:a",
      width: 4,
      height: 3,
    });
    for (let i = 0; i < 40; i++)
      rememberCompareSource(`hdr-${i}`, { url: `u${i}`, width: 1, height: 1 });
    expect(compareSourceFor("hdr-a")).toBeUndefined();
    expect(compareSourceFor("hdr-39")?.url).toBe("u39");
  });

  it("stage shows the wipe compare, or the default result without a source", () => {
    const done = (id: string): ImagineRun =>
      ({
        ...srcRun(["/api/comfy/image?filename=hdr_00001_.avif"]),
        run_id: id,
        jobs: [
          {
            seed: 0,
            index: 0,
            status: "done",
            progress: 100,
            images: ["/api/comfy/image?filename=hdr_00001_.avif"],
          },
        ],
      }) as unknown as ImagineRun;
    const renderResult = (r: ImagineRun, fallback: ReactNode) =>
      createElement(HdrCompareResult, { run: r, fallback });
    rememberCompareSource("hdr-cmp", {
      url: "data:x",
      width: 600,
      height: 900,
    });
    const cmp = renderToStaticMarkup(
      createElement(RunnerStage, { runs: [done("hdr-cmp")], renderResult }),
    );
    expect(cmp).toContain('data-testid="hdr-compare-result"');
    expect(cmp).toContain('aria-label="Compare position"');
    expect(cmp).toContain("aspect-ratio:600 / 900");
    expect(cmp).not.toContain('data-testid="tool-run-result"');
    const plain = renderToStaticMarkup(
      createElement(RunnerStage, { runs: [done("hdr-none")], renderResult }),
    );
    expect(plain).toContain('data-testid="tool-run-result"');
    expect(plain).not.toContain("Compare position");
    const queued = renderToStaticMarkup(
      createElement(RunnerStage, {
        runs: [
          {
            ...done("hdr-q"),
            jobs: [{ ...done("hdr-q").jobs[0], status: "running", images: [] }],
          },
        ],
        renderResult,
      }),
    );
    expect(queued).toContain("Working...");
    const failed = renderToStaticMarkup(
      createElement(RunnerStage, {
        runs: [
          {
            ...done("hdr-e"),
            jobs: [
              {
                ...done("hdr-e").jobs[0],
                status: "error",
                error: "boom",
                images: [],
              },
            ],
          },
        ],
        renderResult,
        onRetry: () => {},
      }),
    );
    expect(failed).not.toContain("hdr-compare-result");
    expect(failed.length).toBeGreaterThan(plain.length / 4);
  });
});

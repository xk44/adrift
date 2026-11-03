/**
 * Unit tests for detectWorkflowType (workflow-analysis.ts)
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { detectWorkflowType } from "@/lib/oj/workflow-analysis";
import type { Workflow } from "@/lib/oj/workflow-analysis";

function node(class_type: string): {
  class_type: string;
  inputs: Record<string, unknown>;
} {
  return { class_type, inputs: {} };
}

function wf(nodes: Record<string, string>): Workflow {
  return Object.fromEntries(
    Object.entries(nodes).map(([id, ct]) => [id, node(ct)]),
  ) as Workflow;
}

function loadWorkflow(relativePath: string): Workflow {
  return JSON.parse(
    readFileSync(join(process.cwd(), relativePath), "utf8"),
  ) as Workflow;
}

describe("detectWorkflowType", () => {
  it("t2i — checkpoint + KSampler, no image input", () => {
    expect(
      detectWorkflowType(
        wf({ "1": "CheckpointLoaderSimple", "2": "KSampler" }),
      ),
    ).toBe("t2i");
  });

  it("t2i — KSampler alone triggers t2i", () => {
    expect(detectWorkflowType(wf({ "1": "KSampler" }))).toBe("t2i");
  });

  it("i2i — has LoadImage + KSampler", () => {
    expect(
      detectWorkflowType(
        wf({
          "1": "CheckpointLoaderSimple",
          "2": "KSampler",
          "3": "LoadImage",
        }),
      ),
    ).toBe("i2i");
  });

  it("i2i — LoadImageFromUrl qualifies as image input", () => {
    expect(
      detectWorkflowType(
        wf({
          "1": "CheckpointLoaderSimple",
          "2": "KSampler",
          "3": "LoadImageFromUrl",
        }),
      ),
    ).toBe("i2i");
  });

  it("inpaint — VAEEncodeForInpaint triggers inpaint", () => {
    expect(
      detectWorkflowType(
        wf({ "1": "CheckpointLoaderSimple", "2": "VAEEncodeForInpaint" }),
      ),
    ).toBe("inpaint");
  });

  it("inpaint — node class containing 'Inpaint' string triggers inpaint", () => {
    expect(
      detectWorkflowType(wf({ "1": "InpaintPreprocessor", "2": "KSampler" })),
    ).toBe("inpaint");
  });

  it("t2v — VHS_VideoCombine with no image loader", () => {
    expect(
      detectWorkflowType(wf({ "1": "KSampler", "2": "VHS_VideoCombine" })),
    ).toBe("t2v");
  });

  it("i2v — VHS_VideoCombine + LoadImage", () => {
    expect(
      detectWorkflowType(
        wf({ "1": "KSampler", "2": "VHS_VideoCombine", "3": "LoadImage" }),
      ),
    ).toBe("i2v");
  });

  it("classifies native LTXV video workflow JSONs", () => {
    expect(detectWorkflowType(loadWorkflow("public/workflows/t2v.json"))).toBe(
      "t2v",
    );
    expect(detectWorkflowType(loadWorkflow("public/workflows/i2v.json"))).toBe(
      "i2v",
    );
  });

  it("classifies native Wan pack workflow JSONs", () => {
    expect(
      detectWorkflowType(loadWorkflow("public/workflows/packs/wan/t2v.json")),
    ).toBe("t2v");
    expect(
      detectWorkflowType(loadWorkflow("public/workflows/packs/wan/i2v.json")),
    ).toBe("i2v");
  });

  it("t23d — SaveGLB with no image loader", () => {
    expect(
      detectWorkflowType(wf({ "1": "TripoSRSampler", "2": "SaveGLB" })),
    ).toBe("t23d");
  });

  it("i23d — SaveGLB + LoadImage", () => {
    expect(
      detectWorkflowType(
        wf({ "1": "TripoSRSampler", "2": "SaveGLB", "3": "LoadImage" }),
      ),
    ).toBe("i23d");
  });

  it("t2a — SaveAudio node", () => {
    expect(detectWorkflowType(wf({ "1": "SaveAudio" }))).toBe("t2a");
  });

  it("t2a — PreviewAudio node", () => {
    expect(detectWorkflowType(wf({ "1": "PreviewAudio" }))).toBe("t2a");
  });

  it("upscale — upscale node without KSampler", () => {
    expect(detectWorkflowType(wf({ "1": "ImageUpscaleWithModel" }))).toBe(
      "upscale",
    );
  });

  it("upscale — ESRGAN string in class_type without sampler", () => {
    expect(detectWorkflowType(wf({ "1": "ESRGAN_4x" }))).toBe("upscale");
  });

  it("NOT upscale — upscale node WITH KSampler falls through to i2i/t2i", () => {
    const type = detectWorkflowType(
      wf({ "1": "ImageUpscaleWithModel", "2": "KSampler" }),
    );
    expect(type).not.toBe("upscale");
  });

  it("unknown — empty workflow", () => {
    expect(detectWorkflowType({})).toBe("unknown");
  });

  it("unknown — unrecognized node only", () => {
    expect(detectWorkflowType(wf({ "1": "SomeRandomCustomNode" }))).toBe(
      "unknown",
    );
  });

  it("3d takes priority over video when both output types present", () => {
    expect(
      detectWorkflowType(wf({ "1": "SaveGLB", "2": "VHS_VideoCombine" })),
    ).toBe("t23d");
  });
});

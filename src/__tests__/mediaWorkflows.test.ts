import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseImagineInput } from "@/lib/oj/parser";
import { detectWorkflowType } from "@/lib/oj/workflow-analysis";
import { discoverVideoSlots } from "@/lib/oj/discovery";
import { injectParams } from "@/lib/oj/engine";
import type { Workflow } from "@/lib/oj/workflow-analysis";

// ============================================================================
// Parser: media flags
// ============================================================================

describe("media workflow flags", () => {
  it("parses --video flag", () => {
    const result = parseImagineInput("a cat --video");
    expect(result.params.video).toBe(true);
    expect(result.unknownFlags).not.toContain("--video");
  });

  it("parses --3d flag", () => {
    const result = parseImagineInput("a sculpture --3d");
    expect(result.params["3d"]).toBe(true);
    expect(result.unknownFlags).not.toContain("--3d");
  });

  it("parses --audio flag", () => {
    const result = parseImagineInput("ocean waves --audio");
    expect(result.params.audio).toBe(true);
    expect(result.unknownFlags).not.toContain("--audio");
  });

  it("parses --duration with value", () => {
    const result = parseImagineInput("ocean waves --audio --duration 30");
    expect(result.params.audio).toBe(true);
    expect(result.params.duration).toBe(30);
  });

  it("parses --bs for video batch size", () => {
    const result = parseImagineInput("a cat --video --bs 24");
    expect(result.params.video).toBe(true);
    expect(result.params.bs).toBe(24);
  });

  it("parses --loop for video loop count", () => {
    const result = parseImagineInput("a cat --video --loop 3");
    expect(result.params.loop).toBe(3);
  });

  it("rejects --duration below min (1)", () => {
    const result = parseImagineInput("ocean waves --audio --duration 0");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.params.duration).toBeUndefined();
  });

  it("rejects --duration above max (380, Stable Audio 3 Medium)", () => {
    const result = parseImagineInput("ocean waves --audio --duration 400");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.params.duration).toBeUndefined();
  });
});

// ============================================================================
// detectWorkflowType
// ============================================================================

function makeWorkflow(classTypes: string[]): Workflow {
  return Object.fromEntries(
    classTypes.map((ct, i) => [String(i + 1), { class_type: ct, inputs: {} }]),
  );
}

function loadWorkflow(relativePath: string): Workflow {
  return JSON.parse(
    readFileSync(join(process.cwd(), relativePath), "utf8"),
  ) as Workflow;
}

describe("workflow type detection", () => {
  it("detects t2v workflow (VHS_VideoCombine, no image input)", () => {
    const wf = makeWorkflow([
      "CheckpointLoaderSimple",
      "KSampler",
      "VHS_VideoCombine",
    ]);
    expect(detectWorkflowType(wf)).toBe("t2v");
  });

  it("detects i2v workflow (VHS_VideoCombine + LoadImage)", () => {
    const wf = makeWorkflow(["LoadImage", "KSampler", "VHS_VideoCombine"]);
    expect(detectWorkflowType(wf)).toBe("i2v");
  });

  it("detects native SaveVideo/CreateVideo t2v workflow", () => {
    const wf = makeWorkflow(["KSampler", "CreateVideo", "SaveVideo"]);
    expect(detectWorkflowType(wf)).toBe("t2v");
  });

  it("detects native SaveVideo/CreateVideo i2v workflow", () => {
    const wf = makeWorkflow(["LoadImage", "KSampler", "CreateVideo", "SaveVideo"]);
    expect(detectWorkflowType(wf)).toBe("i2v");
  });

  it("detects t23d workflow (SaveGLB, no image input)", () => {
    const wf = makeWorkflow(["CheckpointLoaderSimple", "SaveGLB"]);
    expect(detectWorkflowType(wf)).toBe("t23d");
  });

  it("detects i23d workflow (SaveGLB + LoadImage)", () => {
    const wf = makeWorkflow(["LoadImage", "TripoSRSampler", "SaveGLB"]);
    expect(detectWorkflowType(wf)).toBe("i23d");
  });

  it("detects t2a workflow (SaveAudio)", () => {
    const wf = makeWorkflow(["CheckpointLoaderSimple", "SaveAudio"]);
    expect(detectWorkflowType(wf)).toBe("t2a");
  });

  it("detects t2a workflow (PreviewAudio)", () => {
    const wf = makeWorkflow(["KSampler", "PreviewAudio"]);
    expect(detectWorkflowType(wf)).toBe("t2a");
  });

  it("3D takes priority over audio", () => {
    // If both SaveGLB and SaveAudio present, 3D wins
    const wf = makeWorkflow(["SaveGLB", "SaveAudio"]);
    expect(detectWorkflowType(wf)).toBe("t23d");
  });

  it("audio takes priority over video", () => {
    const wf = makeWorkflow(["SaveAudio", "VHS_VideoCombine"]);
    expect(detectWorkflowType(wf)).toBe("t2a");
  });
});

describe("native video injection", () => {
  it("keeps the LTXV distilled turbo recipe after video params are injected", () => {
    const workflow = loadWorkflow("public/workflows/packs/ltxv/i2v_fast.json");
    injectParams(
      workflow,
      discoverVideoSlots(workflow),
      { video: true, turbo: true, bs: 49, end: 12 },
      "a fast camera dolly",
      "blurry",
      123,
    );

    expect(workflow["8"]?.inputs.steps).toBe(7);
    expect(workflow["10"]?.inputs.cfg).toBe(1);
    expect(workflow["6"]?.inputs.length).toBe(49);
    expect(workflow["5"]?.inputs.frame_rate).toBe(12);
    expect(workflow["11"]?.inputs.noise_seed).toBe(123);
  });

  it("maps --bs to native video length and --end to conditioning/fps", () => {
    const workflow = loadWorkflow("public/workflows/t2v.json");
    const slots = discoverVideoSlots(workflow);

    injectParams(
      workflow,
      slots,
      { video: true, bs: 49, end: 12 },
      "a cat running",
      "blurry",
      123,
    );

    expect(workflow["6"]?.inputs.length).toBe(49);
    expect(workflow["6"]?.inputs.batch_size).toBe(1);
    expect(workflow["5"]?.inputs.frame_rate).toBe(12);
    expect(workflow["14"]?.inputs.fps).toBe(12);
    expect(workflow["11"]?.inputs.noise_seed).toBe(123);
  });

  it("uses motion presets only when --bs is absent", () => {
    const lowMotion = loadWorkflow("public/workflows/t2v.json");
    injectParams(
      lowMotion,
      discoverVideoSlots(lowMotion),
      { motion: "low" },
      "a slow pan",
      "",
      1,
    );
    expect(lowMotion["6"]?.inputs.length).toBe(49);

    const explicitFrames = loadWorkflow("public/workflows/t2v.json");
    injectParams(
      explicitFrames,
      discoverVideoSlots(explicitFrames),
      { motion: "low", bs: 97 },
      "a slow pan",
      "",
      1,
    );
    expect(explicitFrames["6"]?.inputs.length).toBe(97);
  });
});

import { describe, it, expect } from "vitest";
import fixture from "./fixtures/objectInfo.trimmed.json";
import {
  validatePrompt,
  findMissingClassTypes,
  parseAnnotatedFilePath,
  PromptValidationError,
} from "@/lib/comfy/validatePrompt";

const info = fixture as Record<string, unknown>;
const ckpt = (
  (info.CheckpointLoaderSimple as any).input.required.ckpt_name[0] as string[]
)[0];

function goodPrompt() {
  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: ckpt },
      _meta: { title: "Load Model" },
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: "hi", clip: ["1", 1] },
      _meta: { title: "Positive" },
    },
    "3": {
      class_type: "EmptyLatentImage",
      inputs: { width: 512, height: 512, batch_size: 1 },
    },
  } as Record<string, any>;
}

describe("validatePrompt", () => {
  it("accepts a valid prompt", () => {
    expect(validatePrompt(goodPrompt(), info)).toEqual([]);
  });

  it("flags unknown class_type with title", () => {
    const p = goodPrompt();
    p["9"] = {
      class_type: "NopeNode",
      inputs: {},
      _meta: { title: "Cool Node" },
    };
    const [prob] = validatePrompt(p, info);
    expect(prob).toMatchObject({
      kind: "unknown_class_type",
      nodeId: "9",
      nodeTitle: "Cool Node",
      classType: "NopeNode",
    });
    expect(findMissingClassTypes(p, info)).toEqual(["NopeNode"]);
  });

  it("flags missing required input", () => {
    const p = goodPrompt();
    delete p["3"].inputs.height;
    const probs = validatePrompt(p, info);
    expect(probs).toHaveLength(1);
    expect(probs[0]).toMatchObject({
      kind: "missing_required_input",
      nodeId: "3",
      nodeTitle: "EmptyLatentImage",
      input: "height",
    });
  });

  it("flags a COMBO value that is not installed", () => {
    const p = goodPrompt();
    p["1"].inputs.ckpt_name = "not-installed.safetensors";
    const [prob] = validatePrompt(p, info);
    expect(prob).toMatchObject({
      kind: "invalid_combo_value",
      nodeId: "1",
      nodeTitle: "Load Model",
      input: "ckpt_name",
    });
    expect(prob.message).toContain("not-installed.safetensors");
  });

  it("supports the new COMBO spec form", () => {
    const custom = {
      X: {
        input: { required: { m: ["COMBO", { options: ["a", "b"] }] } },
        output: [],
      },
    };
    expect(
      validatePrompt({ "1": { class_type: "X", inputs: { m: "a" } } }, custom),
    ).toEqual([]);
    expect(
      validatePrompt(
        { "1": { class_type: "X", inputs: { m: "c" } } },
        custom,
      )[0].kind,
    ).toBe("invalid_combo_value");
  });

  it("flags links to nonexistent nodes and output indexes", () => {
    const p = goodPrompt();
    p["2"].inputs.clip = ["42", 0];
    expect(validatePrompt(p, info)[0]).toMatchObject({
      kind: "invalid_link",
      nodeId: "2",
      nodeTitle: "Positive",
      input: "clip",
    });
    p["2"].inputs.clip = ["1", 7];
    const [prob] = validatePrompt(p, info);
    expect(prob.kind).toBe("invalid_link");
    expect(prob.message).toContain("output 7");
  });

  it("flags INT/FLOAT out of range, accepts in range", () => {
    const p = goodPrompt();
    p["3"].inputs.width = 4;
    p["3"].inputs.batch_size = 99999;
    const probs = validatePrompt(p, info);
    expect(probs.map((x) => [x.input, x.kind])).toEqual([
      ["width", "out_of_range"],
      ["batch_size", "out_of_range"],
    ]);
    expect(probs[0].message).toContain("minimum");
    expect(probs[1].message).toContain("maximum");
  });

  it("PromptValidationError is a 422 with a readable summary", () => {
    const p = goodPrompt();
    p["1"].inputs.ckpt_name = "x";
    const err = new PromptValidationError(validatePrompt(p, info));
    expect(err.statusCode).toBe(422);
    expect(err.message).toContain("Load Model (#1) / ckpt_name");
  });
});

describe("validatePrompt: file combos and V3 dynamic inputs", () => {
  // Shapes as served by a live ComfyUI /object_info.
  const live = {
    VHS_LoadVideo: {
      input: {
        required: { video: [["clip_a.mp4", "clip_b.mp4"]] },
      },
      output: ["IMAGE", "INT", "AUDIO", "VHS_VIDEOINFO"],
    },
    ConcatenateVideo: {
      input: {
        required: {
          videos: [
            "COMFY_AUTOGROW_V3",
            {
              template: {
                input: { required: { video: ["VIDEO", {}] } },
                prefix: "video",
                min: 1,
                max: 100,
              },
            },
          ],
          codec: ["COMBO", { options: ["auto", "h264", "av1"] }],
        },
      },
      output: ["VIDEO"],
    },
  } as Record<string, unknown>;

  it("leaves annotated paths to ComfyUI (VHS_LoadVideo has no upload flag)", () => {
    for (const video of [
      "cj_clip_123.mp4 [input]",
      "video/CJ_Short_00001_.mp4 [output]",
      "ComfyUI_temp_abcde_00001_.mp4 [temp]",
    ]) {
      expect(
        validatePrompt(
          { "1": { class_type: "VHS_LoadVideo", inputs: { video } } },
          live,
        ),
      ).toEqual([]);
    }
    // A bare name still has to be listed.
    const [p] = validatePrompt(
      { "1": { class_type: "VHS_LoadVideo", inputs: { video: "nope.mp4" } } },
      live,
    );
    expect(p).toMatchObject({ kind: "invalid_combo_value", input: "video" });
  });

  it("still combo-checks malformed or unsafe annotated paths", () => {
    for (const video of [
      " [input]",
      "clip.mp4[input]",
      "clip.mp4 [Input]",
      "clip.mp4 [cache]",
      "../secret.mp4 [input]",
      "/etc/passwd [output]",
    ]) {
      const [p] = validatePrompt(
        { "1": { class_type: "VHS_LoadVideo", inputs: { video } } },
        live,
      );
      expect(p).toMatchObject({ kind: "invalid_combo_value", input: "video" });
    }
  });

  it("accepts autogrow inputs sent as <name>.<child> keys", () => {
    const prompt = {
      "1": {
        class_type: "ConcatenateVideo",
        inputs: { "videos.video0": ["2", 0], codec: "auto" },
      },
      "2": { class_type: "ConcatenateVideo", inputs: { codec: "auto" } },
    };
    const probs = validatePrompt(prompt, live);
    expect(probs.map((p) => [p.nodeId, p.kind, p.input])).toEqual([
      ["2", "missing_required_input", "videos"],
    ]);
  });
});

describe("parseAnnotatedFilePath", () => {
  it("parses every ComfyUI annotation", () => {
    expect(parseAnnotatedFilePath("a.png [input]")).toEqual({
      name: "a.png",
      type: "input",
    });
    expect(parseAnnotatedFilePath("video/x_00001_.mp4 [output]")).toEqual({
      name: "video/x_00001_.mp4",
      type: "output",
    });
    expect(parseAnnotatedFilePath("ComfyUI_temp_q_00001_.png [temp]")).toEqual(
      { name: "ComfyUI_temp_q_00001_.png", type: "temp" },
    );
    expect(parseAnnotatedFilePath("my clip.mp4 [input]")).toEqual({
      name: "my clip.mp4",
      type: "input",
    });
  });

  it("rejects bare, malformed and traversal names", () => {
    for (const v of [
      "a.png",
      "a.png[input]",
      "a.png [input] ",
      " [temp]",
      "a.png [INPUT]",
      "../a.png [input]",
      "sub/../../a.png [output]",
      "sub\\..\\a.png [output]",
      "/abs/a.png [input]",
      "C:/a.png [input]",
      42,
      null,
    ]) {
      expect(parseAnnotatedFilePath(v)).toBeNull();
    }
  });
});

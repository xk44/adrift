/**
 * extractOutputs() — one classifier for every ComfyUI output payload.
 *
 * Payload shapes mirror ComfyUI 0.42 comfy_api/latest/_ui.py (SavedImages,
 * PreviewVideo, SavedAudios, Saved3DModels, PreviewUI3D, PreviewText) plus
 * VideoHelperSuite's VHS_VideoCombine and SaveLatent.
 */
import { describe, expect, it } from "vitest";
import {
  comfyProxyUrl,
  extractOutputs,
  groupOutputs,
  type ExtractedOutput,
} from "@/lib/comfy/outputs";

const prompt = {
  "3": { class_type: "SaveImage", inputs: {}, _meta: { title: "Final Save" } },
  "4": { class_type: "SaveAnimatedWEBP", inputs: {} },
  "5": { class_type: "SaveVideo", inputs: {} },
  "6": {
    class_type: "VHS_VideoCombine",
    inputs: {},
    _meta: { title: "Combine" },
  },
  "7": { class_type: "SaveAudio", inputs: {} },
  "8": { class_type: "SaveGLB", inputs: {} },
  "9": { class_type: "Preview3D", inputs: {} },
  "10": { class_type: "PreviewAny", inputs: {}, _meta: { title: "Caption" } },
  "11": { class_type: "ShowText|pysssss", inputs: {} },
  "12": { class_type: "SaveLatent", inputs: {} },
  "13": { class_type: "MysteryNode", inputs: {} },
};

const entry = {
  prompt: [0, "p1", prompt, {}, ["3"]],
  meta: {
    "3": { node_id: "3", display_node: "3" },
    "14:2": { display_node: "14" },
  },
  outputs: {
    "3": {
      images: [
        {
          filename: "img_00001_.png",
          subfolder: "",
          type: "output",
          metadata: { kind: "image", width: 1024, height: 1024 },
        },
      ],
    },
    "4": {
      images: [{ filename: "anim_00001_.webp", subfolder: "", type: "output" }],
      animated: [true],
    },
    "5": {
      images: [
        { filename: "clip_00001_.mp4", subfolder: "video", type: "output" },
      ],
      animated: [true],
    },
    "6": {
      gifs: [
        {
          filename: "AnimateDiff_00001.mp4",
          subfolder: "",
          type: "output",
          format: "video/h264-mp4",
          frame_rate: 8,
          workflow: "AnimateDiff_00001.png",
          fullpath: "/home/someone/ComfyUI/output/AnimateDiff_00001.mp4",
        },
        {
          filename: "AnimateDiff_00002.gif",
          subfolder: "",
          type: "output",
          format: "image/gif",
        },
      ],
    },
    "7": {
      audio: [
        { filename: "audio_00001_.flac", subfolder: "audio", type: "output" },
      ],
    },
    "8": {
      "3d": [{ filename: "mesh_00001_.glb", subfolder: "3d", type: "output" }],
      camera_info: [null],
      model_3d_info: [],
    },
    "9": { result: ["3d/preview_ab.glb", null, null] },
    "10": { text: ["a cat on a mat"] },
    "11": { text: ["line one", "line two"], string: "s" },
    "12": {
      latents: [
        {
          filename: "latent_00001_.latent",
          subfolder: "latents",
          type: "output",
        },
      ],
    },
    "13": { custom_blob: [{ score: 0.93 }] },
    "14:2": {
      images: [{ filename: "sub_00001_.png", subfolder: "", type: "temp" }],
    },
  },
};

function only(outputs: ExtractedOutput[], nodeId: string) {
  return outputs.filter((o) => o.nodeId === nodeId);
}

describe("extractOutputs", () => {
  const outputs = extractOutputs(entry);

  it("classifies a plain SaveImage output with title, type and /view params", () => {
    expect(only(outputs, "3")).toEqual([
      {
        nodeId: "3",
        nodeTitle: "Final Save",
        classType: "SaveImage",
        kind: "image",
        key: "images",
        view: { filename: "img_00001_.png", subfolder: "", type: "output" },
        format: "png",
        metadata: { kind: "image", width: 1024, height: 1024 },
      },
    ]);
  });

  it("flags animated webp and GIFs as animated images, not video", () => {
    expect(only(outputs, "4")[0]).toMatchObject({
      kind: "animated",
      nodeTitle: "SaveAnimatedWEBP",
    });
    const vhs = only(outputs, "6");
    expect(vhs.map((o) => o.kind)).toEqual(["video", "animated"]);
  });

  it("reads core SaveVideo (images + animated) and VHS gifs as video", () => {
    expect(only(outputs, "5")[0]).toMatchObject({
      kind: "video",
      key: "images",
      view: { filename: "clip_00001_.mp4", subfolder: "video", type: "output" },
      format: "mp4",
    });
    expect(only(outputs, "6")[0]).toMatchObject({
      kind: "video",
      key: "gifs",
      nodeTitle: "Combine",
      format: "video/h264-mp4",
    });
  });

  it("never leaks VHS fullpath (absolute server path) into the output", () => {
    expect(JSON.stringify(only(outputs, "6"))).not.toContain("/home/someone");
  });

  it('reads audio, SaveGLB "3d" and Preview3D result paths', () => {
    expect(only(outputs, "7")[0]).toMatchObject({
      kind: "audio",
      key: "audio",
    });
    expect(only(outputs, "8")).toHaveLength(1);
    expect(only(outputs, "8")[0]).toMatchObject({ kind: "mesh", key: "3d" });
    expect(only(outputs, "9")[0]).toMatchObject({
      kind: "mesh",
      key: "result",
      view: { filename: "preview_ab.glb", subfolder: "3d", type: "output" },
    });
  });

  it('emits one text output per PreviewAny/ShowText string, incl. the "string" key', () => {
    expect(only(outputs, "10")).toEqual([
      {
        nodeId: "10",
        nodeTitle: "Caption",
        classType: "PreviewAny",
        kind: "text",
        key: "text",
        text: "a cat on a mat",
      },
    ]);
    expect(only(outputs, "11").map((o) => [o.key, o.text])).toEqual([
      ["text", "line one"],
      ["text", "line two"],
      ["string", "s"],
    ]);
  });

  it("keeps latents and unknown payloads as raw JSON", () => {
    const latent = only(outputs, "12")[0];
    expect(latent).toMatchObject({ kind: "unknown", key: "latents" });
    expect(latent.view?.filename).toBe("latent_00001_.latent");
    expect(latent.raw).toEqual(entry.outputs["12"].latents[0]);
    expect(only(outputs, "13")[0]).toMatchObject({
      kind: "unknown",
      key: "custom_blob",
      raw: [{ score: 0.93 }],
    });
  });

  it("falls back to display_node / Node <id> titles for subgraph outputs", () => {
    expect(only(outputs, "14:2")[0]).toMatchObject({
      displayNodeId: "14",
      nodeTitle: "Node 14",
      view: { type: "temp" },
    });
  });

  it("does not emit annotation keys (animated, camera_info, model_3d_info)", () => {
    expect(outputs.map((o) => o.key)).not.toContain("animated");
    expect(outputs.map((o) => o.key)).not.toContain("camera_info");
    expect(outputs.map((o) => o.key)).not.toContain("model_3d_info");
  });

  it("uses an explicit prompt graph over the entry's own", () => {
    const [first] = extractOutputs(entry, {
      "3": { class_type: "SaveImage", _meta: { title: "Override" } },
    });
    expect(first.nodeTitle).toBe("Override");
  });

  it("drops LoadVideo's type:input source echo so the saved result is the job's video", () => {
    const entry = {
      prompt: [
        0,
        "p",
        {
          "1": { class_type: "LoadVideo", inputs: {} },
          "11": { class_type: "SaveAnimatedPNG", inputs: {} },
          "12": { class_type: "SaveVideo", inputs: {} },
        },
      ],
      outputs: {
        "1": {
          images: [{ filename: "cj_clip.mp4", subfolder: "", type: "input" }],
          animated: [true],
        },
        "11": {
          images: [
            { filename: "cut_00001_.png", subfolder: "video", type: "output" },
          ],
          animated: [true],
        },
        "12": {
          images: [
            { filename: "out_00001_.mp4", subfolder: "video", type: "output" },
          ],
          animated: [true],
        },
      },
    };
    const out = extractOutputs(entry);
    expect(out.map((o) => o.nodeId)).toEqual(["11", "12"]);
    expect(out.some((o) => o.view?.type === "input")).toBe(false);
    expect(groupOutputs(out).video.map((o) => o.view?.filename)).toEqual([
      "out_00001_.mp4",
    ]);
  });

  it("tolerates empty / malformed entries", () => {
    expect(extractOutputs(null)).toEqual([]);
    expect(extractOutputs({ outputs: undefined })).toEqual([]);
    expect(
      extractOutputs({ outputs: { "1": null, "2": { images: [] } } }),
    ).toEqual([]);
  });

  it("groups by kind and builds legacy-compatible proxy URLs", () => {
    const groups = groupOutputs(outputs);
    expect(groups.text).toHaveLength(4);
    expect(groups.mesh).toHaveLength(2);
    expect(
      comfyProxyUrl({ filename: "a b.png", subfolder: "x/y", type: "output" }),
    ).toBe("/api/comfy/image?filename=a%20b.png&subfolder=x%2Fy&type=output");
  });
});

describe("ExtraOutputList", () => {
  it("renders text in a copyable block, raw JSON for unknown, and audio players", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { ExtraOutputList } = await import("@/components/ExtraOutputs");
    const html = renderToStaticMarkup(
      createElement(ExtraOutputList, {
        includeAudio: true,
        outputs: [
          {
            nodeId: "10",
            nodeTitle: "Caption",
            kind: "text",
            key: "text",
            text: "a <cat>",
          },
          {
            nodeId: "13",
            nodeTitle: "Mystery",
            kind: "unknown",
            key: "custom_blob",
            raw: [{ score: 0.93 }],
          },
          {
            nodeId: "7",
            nodeTitle: "SaveAudio",
            kind: "audio",
            key: "audio",
            url: "/api/comfy/image?filename=a.flac",
          },
          {
            nodeId: "3",
            nodeTitle: "Save",
            kind: "image",
            key: "images",
            url: "/x.png",
          },
        ],
      }),
    );
    expect(html).toContain('data-output-kind="text"');
    expect(html).toContain("a &lt;cat&gt;");
    expect(html).toContain('aria-label="Copy output"');
    expect(html).toContain("&quot;score&quot;: 0.93");
    expect(html).toContain('<audio src="/api/comfy/image?filename=a.flac"');
    expect(html).not.toContain("/x.png");
  });

  it("renders nothing for media-only outputs", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { ExtraOutputList } = await import("@/components/ExtraOutputs");
    expect(
      renderToStaticMarkup(
        createElement(ExtraOutputList, {
          outputs: [
            {
              nodeId: "7",
              nodeTitle: "A",
              kind: "audio",
              key: "audio",
              url: "/a.flac",
            },
          ],
        }),
      ),
    ).toBe("");
  });
});

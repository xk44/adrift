/**
 * Opt-in master files (16-bit PNG / EXR / ProRes 4444): detection from
 * /object_info, the graph rewrite, history classification, request parsing,
 * queuePrompt wiring, the availability route, and download names.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const objectInfo = vi.fn();
vi.mock("@/lib/env", () => ({
  env: { COMFY_HTTP_URL: "http://127.0.0.1:8188" },
}));
vi.mock("@/lib/comfy/objectInfoCache", () => ({
  assertPromptValid: vi.fn().mockResolvedValue(undefined),
  getObjectInfoCached: (...args: unknown[]) => objectInfo(...args),
  applyOptionalNodeBypass: vi.fn(async (prompt: unknown) => ({ prompt, bypassed: [] })),
}));

import { NextRequest } from "next/server";
import { queuePrompt } from "@/lib/comfy/http";
import { extractOutputs, jobMediaFromHistory } from "@/lib/comfy/outputs";
import { masterChoiceFromRequest } from "@/lib/output/masterRequest";
import {
  addMasterOutputs,
  decodeMasterCookie,
  detectMasterFormats,
  downloadName,
  encodeMasterCookie,
  extFromUrl,
  masterChoiceFromCookieHeader,
  parseMasterChoice,
  supportedChoice,
  toolFromParams,
} from "@/lib/output/saveNodes";
import { GET as formatsGET } from "@/app/api/comfy/output-formats/route";
import type { Workflow } from "@/types";

/** Trimmed copies of the real specs (pc ComfyUI /object_info). */
const INFO: Record<string, unknown> = {
  SaveImageAdvanced: {
    input: {
      required: {
        images: ["IMAGE"],
        filename_prefix: ["STRING", { default: "ComfyUI" }],
        format: [
          "COMFY_DYNAMICCOMBO_V3",
          {
            options: [
              {
                key: "png",
                inputs: {
                  required: {
                    bit_depth: ["COMBO", { options: ["8-bit", "16-bit"] }],
                    input_color_space: ["COMBO", { options: ["sRGB"] }],
                  },
                },
              },
              {
                key: "exr",
                inputs: {
                  required: {
                    bit_depth: ["COMBO", { options: ["32-bit float", "16-bit float"] }],
                    input_color_space: [
                      "COMBO",
                      { options: ["sRGB", "HDR", "linear", "linear ACEScg"] },
                    ],
                  },
                },
              },
            ],
          },
        ],
      },
    },
  },
  VHS_VideoCombine: {
    input: {
      required: {
        images: ["IMAGE"],
        format: [
          ["image/gif", "video/ProRes", "video/h264-mp4"],
          {
            formats: {
              "video/ProRes": [["profile", ["lt", "standard", "hq", "4444", "4444xq"], { default: "hq" }]],
            },
          },
        ],
      },
    },
  },
};

const IMAGE_WF = {
  "3": { class_type: "KSampler", inputs: {} },
  "8": { class_type: "VAEDecode", inputs: {} },
  "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "x" } },
  "10": { class_type: "PreviewImage", inputs: { images: ["8", 0] } },
} as unknown as Workflow;

const VIDEO_WF = {
  "1": { class_type: "VHS_LoadVideo", inputs: {} },
  "2": {
    class_type: "VHS_VideoCombine",
    inputs: {
      images: ["1", 0],
      frame_rate: 30,
      format: "video/h264-mp4",
      audio: ["1", 2],
      filename_prefix: "video/a",
    },
  },
  "3": {
    class_type: "VHS_VideoCombine",
    inputs: { images: ["1", 0], frame_rate: 30, format: "image/gif" },
  },
  "5": { class_type: "CreateVideo", inputs: { images: ["1", 0], fps: 24 } },
  "6": { class_type: "SaveVideo", inputs: { video: ["5", 0], filename_prefix: "video/b" } },
} as unknown as Workflow;

describe("detectMasterFormats", () => {
  it("lists only the defaults when ComfyUI is unreachable", () => {
    expect(detectMasterFormats(null)).toEqual({ image: ["png"], video: ["h264"] });
  });

  it("offers 16-bit PNG, EXR and ProRes 4444 when the nodes have them", () => {
    expect(detectMasterFormats(INFO)).toEqual({
      image: ["png", "png16", "exr"],
      video: ["h264", "prores4444"],
    });
  });

  it("hides ProRes when VHS lacks the 4444 profile", () => {
    const info = JSON.parse(JSON.stringify(INFO));
    info.VHS_VideoCombine.input.required.format[1].formats["video/ProRes"] = [
      ["profile", ["lt", "hq"]],
    ];
    expect(detectMasterFormats(info).video).toEqual(["h264"]);
  });

  it("drops choices the backend can't write", () => {
    expect(
      supportedChoice({ image: "exr", video: "prores4444" }, { image: ["png"], video: ["h264"] }),
    ).toBeNull();
    expect(
      supportedChoice({ image: "exr", video: "prores4444" }, detectMasterFormats(INFO)),
    ).toEqual({ image: "exr", video: "prores4444" });
  });
});

describe("addMasterOutputs", () => {
  it("is a no-op without a choice", () => {
    const r = addMasterOutputs(IMAGE_WF, null);
    expect(r.graph).toBe(IMAGE_WF);
    expect(r.added).toEqual([]);
  });

  it("adds an EXR saver beside each SaveImage (not PreviewImage), copy-on-write", () => {
    const r = addMasterOutputs(IMAGE_WF, { image: "exr" }, { tool: "Color grade", seed: 42 });
    expect(r.added).toHaveLength(1);
    const node = r.graph[r.added[0]] as unknown as {
      class_type: string;
      inputs: Record<string, unknown>;
      _meta: Record<string, unknown>;
    };
    expect(node.class_type).toBe("SaveImageAdvanced");
    expect(node.inputs).toEqual({
      images: ["8", 0],
      filename_prefix: "adrift_master/Adrift_color-grade_42_master",
      format: "exr",
      "format.bit_depth": "16-bit float",
      "format.input_color_space": "sRGB",
    });
    expect(node._meta.adrift_master).toBe(true);
    expect(IMAGE_WF[r.added[0]]).toBeUndefined();
    expect(r.graph["9"]).toEqual(IMAGE_WF["9"]);
  });

  it("png16 uses the png option at 16-bit", () => {
    const r = addMasterOutputs(IMAGE_WF, { image: "png16" });
    expect(r.graph[r.added[0]].inputs).toMatchObject({
      format: "png",
      "format.bit_depth": "16-bit",
      filename_prefix: "adrift_master/Adrift_create_0_master",
    });
  });

  it("mirrors real video encodes as ProRes 4444 and keeps audio + fps", () => {
    const r = addMasterOutputs(VIDEO_WF, { video: "prores4444" }, { tool: "upscale", seed: 7 });
    const nodes = r.added.map((id) => r.graph[id]);
    const vhs = nodes.filter((n) => n.class_type === "VHS_VideoCombine");
    // gif saver (3) is skipped; VHS h264 (2) and SaveVideo (6) are mirrored.
    expect(vhs).toHaveLength(2);
    expect(vhs[0].inputs).toMatchObject({
      images: ["1", 0],
      audio: ["1", 2],
      frame_rate: 30,
      format: "video/ProRes",
      profile: "4444",
      filename_prefix: "adrift_master/Adrift_upscale_7_master",
    });
    const parts = nodes.find((n) => n.class_type === "GetVideoComponents")!;
    expect(parts.inputs.video).toEqual(["5", 0]);
    const partsId = r.added[nodes.indexOf(parts)];
    expect(vhs[1].inputs).toMatchObject({
      images: [partsId, 0],
      audio: [partsId, 1],
      frame_rate: [partsId, 2],
    });
  });

  it("does not add image masters for a video-only choice", () => {
    expect(addMasterOutputs(IMAGE_WF, { video: "prores4444" }).added).toEqual([]);
  });
});

describe("extractOutputs with master files", () => {
  const entry = {
    outputs: {
      "9": { images: [{ filename: "a_00001_.png", subfolder: "", type: "output" }] },
      "9000": {
        images: [
          { filename: "Adrift_x_1_master_00001_.png", subfolder: "adrift_master", type: "output" },
        ],
      },
    },
    prompt: [0, "p", {
      "9": { class_type: "SaveImage" },
      "9000": { class_type: "SaveImageAdvanced", _meta: { title: "Master file", adrift_master: true } },
    }],
  };

  it("reports master files as downloads, not gallery media", () => {
    const out = extractOutputs(entry);
    expect(out.find((o) => o.nodeId === "9")?.kind).toBe("image");
    expect(out.find((o) => o.nodeId === "9000")?.kind).toBe("unknown");
    expect(jobMediaFromHistory(entry).images).toHaveLength(1);
  });

  it("spots master files by subfolder even without the prompt graph (video backend marker)", () => {
    const out = extractOutputs({
      outputs: {
        "7": {
          gifs: [
            { filename: "m_00001.mov", subfolder: "pc_video/adrift_master", type: "output", format: "video/ProRes" },
          ],
        },
      },
    });
    expect(out[0].kind).toBe("unknown");
  });
});

describe("choice parsing", () => {
  it("ignores defaults and junk", () => {
    expect(parseMasterChoice({ image: "png", video: "h264" })).toBeNull();
    expect(parseMasterChoice({ image: "tiff" })).toBeNull();
    expect(parseMasterChoice("exr")).toBeNull();
    expect(parseMasterChoice({ image: "exr" })).toEqual({ image: "exr" });
  });

  it("round-trips the cookie", () => {
    const c = encodeMasterCookie({ image: "png16", video: "prores4444" });
    expect(decodeMasterCookie(c)).toEqual({ image: "png16", video: "prores4444" });
    expect(masterChoiceFromCookieHeader(`a=1; adrift_master=${encodeURIComponent(c)}`)).toEqual({
      image: "png16",
      video: "prores4444",
    });
    expect(masterChoiceFromCookieHeader("a=1")).toBeNull();
  });

  it("ignores a malformed cookie instead of throwing", () => {
    expect(() => masterChoiceFromCookieHeader("adrift_master=%E0%A4%A")).not.toThrow();
    expect(masterChoiceFromCookieHeader("adrift_master=%E0%A4%A")).toBeNull();
  });

  it("body output_format overrides the cookie", () => {
    const req = new Request("http://localhost/x", {
      headers: { cookie: "adrift_master=image:exr" },
    });
    expect(masterChoiceFromRequest(req, {})).toEqual({ image: "exr" });
    expect(masterChoiceFromRequest(req, { output_format: { image: "png" } })).toBeNull();
    expect(masterChoiceFromRequest(req, { output_format: { video: "prores4444" } })).toEqual({
      video: "prores4444",
    });
  });
});

describe("queuePrompt master option", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    objectInfo.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ prompt_id: "p1", number: 1, node_errors: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sentPrompt(): Record<string, { class_type: string }> {
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/prompt"))!;
    return JSON.parse((call[1] as RequestInit).body as string).prompt;
  }

  it("adds the master saver when the backend supports it", async () => {
    objectInfo.mockResolvedValue(INFO);
    await queuePrompt(IMAGE_WF, "c1", undefined, {
      master: { choice: { image: "exr" }, tool: "upscale", seed: 5 },
    });
    const classes = Object.values(sentPrompt()).map((n) => n.class_type);
    expect(classes).toContain("SaveImageAdvanced");
    expect(IMAGE_WF["9000"]).toBeUndefined();
  });

  it("silently skips it when the backend lacks the nodes", async () => {
    objectInfo.mockResolvedValue({});
    await queuePrompt(IMAGE_WF, "c1", undefined, {
      master: { choice: { image: "exr" }, tool: "upscale", seed: 5 },
    });
    expect(Object.keys(sentPrompt())).toEqual(Object.keys(IMAGE_WF));
  });
});

describe("GET /api/comfy/output-formats", () => {
  beforeEach(() => objectInfo.mockReset());

  it("returns what the backend can write", async () => {
    objectInfo.mockResolvedValue(INFO);
    const res = await formatsGET(new NextRequest("http://localhost:3000/api/comfy/output-formats"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.image).toEqual(["png", "png16", "exr"]);
    expect(json.video).toEqual(["h264", "prores4444"]);
  });

  it("falls back to defaults when ComfyUI is down", async () => {
    objectInfo.mockResolvedValue(null);
    const json = await (
      await formatsGET(new NextRequest("http://localhost:3000/api/comfy/output-formats?fresh=1"))
    ).json();
    expect(json.image).toEqual(["png"]);
    expect(json.video).toEqual(["h264"]);
    expect(objectInfo).toHaveBeenCalledWith(undefined, { fresh: true });
  });
});

describe("download names", () => {
  it("formats Adrift_<tool>_<seed>_v<N>.<ext>", () => {
    expect(downloadName({ tool: "upscale", seed: 123, version: 2, ext: "png" })).toBe(
      "Adrift_upscale_123_v2.png",
    );
    expect(downloadName({ tool: null, seed: null, ext: ".MP4" })).toBe("Adrift_create_0_v1.mp4");
  });

  it("reads the tool from run params", () => {
    expect(toolFromParams({ action_provenance: { kind: "action", id: "vary_strong", via: "Remix" } })).toBe("remix");
    expect(toolFromParams({ action_provenance: { kind: "tool", id: "color_grade" } })).toBe("color-grade");
    expect(toolFromParams({ tool_id: "relight" })).toBe("relight");
    expect(toolFromParams(undefined)).toBe("create");
  });

  it("takes the extension from the real file name", () => {
    expect(extFromUrl("/api/comfy/image?filename=a_00001.webm&subfolder=&type=output", "mp4")).toBe("webm");
    expect(extFromUrl("blob:abc", "png")).toBe("png");
    expect(extFromUrl("https://x/y/z.GLB", "bin")).toBe("glb");
  });
});

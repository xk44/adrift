/**
 * Smart select (SAM3 click-to-mask): pure graph builder + the
 * /api/tools/smart-mask route with ComfyUI mocked (nothing reaches a GPU).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  buildSmartMaskWorkflow,
  isSafeInputRef,
  normalizePoints,
  SMART_MASK_CHECKPOINT,
  SMART_MASK_OUTPUT_NODE,
  SmartMaskError,
} from "@/lib/tools/smartMask";

const http = vi.hoisted(() => ({
  uploadImageToComfy: vi.fn(),
  queuePrompt: vi.fn(),
  fetchHistory: vi.fn(),
  fetchImageBase64: vi.fn(),
}));
vi.mock("@/lib/comfy/http", async (orig) => ({
  ...(await orig<typeof import("@/lib/comfy/http")>()),
  ...http,
}));

type Node = { class_type: string; inputs: Record<string, unknown> };
const nodes = (wf: unknown) => wf as Record<string, Node>;

describe("buildSmartMaskWorkflow", () => {
  it("builds the verified SAM3 graph with JSON-string int coords", () => {
    const wf = nodes(
      buildSmartMaskWorkflow({
        image: "probe_click.png",
        include: [
          { x: 290.4, y: 109.6 },
          { x: 250, y: 330 },
        ],
        exclude: [{ x: 10.5, y: 20.2 }],
      }),
    );
    expect(Object.keys(wf).sort()).toEqual(["1", "2", "3", "4", "5"]);
    expect(wf["1"]).toEqual({
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: SMART_MASK_CHECKPOINT },
    });
    expect(wf["2"].inputs.image).toBe("probe_click.png");
    const sam = wf["3"];
    expect(sam.class_type).toBe("SAM3_Detect");
    expect(sam.inputs.model).toEqual(["1", 0]);
    expect(sam.inputs.image).toEqual(["2", 0]);
    expect(sam.inputs.threshold).toBe(0.5);
    expect(sam.inputs.individual_masks).toBe(false);
    expect(sam.inputs.positive_coords).toBe(
      '[{"x":290,"y":110},{"x":250,"y":330}]',
    );
    expect(sam.inputs.negative_coords).toBe('[{"x":11,"y":20}]');
    expect(wf["4"]).toEqual({
      class_type: "MaskToImage",
      inputs: { mask: ["3", 0] },
    });
    expect(wf[SMART_MASK_OUTPUT_NODE].class_type).toBe("PreviewImage");
    expect(wf[SMART_MASK_OUTPUT_NODE].inputs.images).toEqual(["4", 0]);
  });

  it("defaults exclude to an empty JSON list and clamps threshold", () => {
    const wf = nodes(
      buildSmartMaskWorkflow({
        image: "a.png [input]",
        include: [{ x: 1, y: 1 }],
        threshold: 5,
      }),
    );
    expect(wf["3"].inputs.negative_coords).toBe("[]");
    expect(wf["3"].inputs.threshold).toBe(0.99);
  });

  it("clamps points into the natural image bounds", () => {
    const wf = nodes(
      buildSmartMaskWorkflow({
        image: "a.png",
        include: [
          { x: -5, y: 2000 },
          { x: 600, y: 10 },
        ],
        width: 576,
        height: 1024,
      }),
    );
    expect(JSON.parse(wf["3"].inputs.positive_coords as string)).toEqual([
      { x: 0, y: 1023 },
      { x: 575, y: 10 },
    ]);
  });

  it("rejects an empty include list", () => {
    expect(() =>
      buildSmartMaskWorkflow({ image: "a.png", include: [] }),
    ).toThrow(SmartMaskError);
    expect(() =>
      buildSmartMaskWorkflow({
        image: "a.png",
        include: undefined as never,
        exclude: [{ x: 1, y: 1 }],
      }),
    ).toThrow(/include point/);
  });

  it("rejects bad points and unsafe image refs", () => {
    expect(() => normalizePoints([{ x: NaN, y: 1 }], "include")).toThrow(
      SmartMaskError,
    );
    expect(() => normalizePoints([{ x: "1", y: 1 }], "include")).toThrow();
    expect(() => normalizePoints("nope", "include")).toThrow();
    expect(() =>
      normalizePoints(
        Array.from({ length: 33 }, () => ({ x: 1, y: 1 })),
        "include",
      ),
    ).toThrow(/too many/);
    for (const bad of ["../x.png", "/etc/x.png", "a.txt", "a b.png", ""]) {
      expect(isSafeInputRef(bad)).toBe(false);
      expect(() =>
        buildSmartMaskWorkflow({ image: bad, include: [{ x: 1, y: 1 }] }),
      ).toThrow(SmartMaskError);
    }
    expect(isSafeInputRef("sub/smartmask_ab12.png [input]")).toBe(true);
  });
});

describe("POST /api/tools/smart-mask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    http.uploadImageToComfy.mockResolvedValue("smartmask_x.png [input]");
    http.queuePrompt.mockResolvedValue({ prompt_id: "p1", number: 1 });
    http.fetchHistory.mockResolvedValue({
      outputs: {
        [SMART_MASK_OUTPUT_NODE]: {
          images: [{ filename: "m.png", subfolder: "", type: "temp" }],
        },
      },
      status: { completed: true, status_str: "success" },
    });
    http.fetchImageBase64.mockResolvedValue("data:image/png;base64,AAAA");
  });

  const post = async (body: unknown) => {
    const { POST } = await import("@/app/api/tools/smart-mask/route");
    return POST(
      new NextRequest("http://localhost/api/tools/smart-mask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  };

  it("uploads a data URL once and returns mask + reusable ref", async () => {
    const res = await post({
      image: "data:image/png;base64," + Buffer.from("png!").toString("base64"),
      include: [{ x: 3, y: 4 }],
    });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toMatchObject({
      ok: true,
      mask: "data:image/png;base64,AAAA",
      image: "smartmask_x.png [input]",
    });
    expect(typeof data.ms).toBe("number");
    expect(http.uploadImageToComfy).toHaveBeenCalledTimes(1);
    expect(http.uploadImageToComfy.mock.calls[0][1]).toMatch(
      /^smartmask_[0-9a-f]{16}\.png$/,
    );
    const wf = nodes(http.queuePrompt.mock.calls[0][0]);
    expect(wf["2"].inputs.image).toBe("smartmask_x.png [input]");
    expect(http.fetchImageBase64).toHaveBeenCalledWith("m.png", "", "temp");
  });

  it("reuses an existing ref without uploading", async () => {
    const res = await post({
      image: "smartmask_x.png [input]",
      include: [{ x: 3, y: 4 }],
    });
    expect(res.status).toBe(200);
    expect(http.uploadImageToComfy).not.toHaveBeenCalled();
  });

  it("400s on empty include / bad image, 502 on SAM error", async () => {
    let res = await post({ image: "a.png", include: [] });
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
    res = await post({ image: "../etc/passwd", include: [{ x: 1, y: 1 }] });
    expect(res.status).toBe(400);
    expect(http.queuePrompt).not.toHaveBeenCalled();

    http.fetchHistory.mockResolvedValue({
      outputs: {},
      status: { completed: false, status_str: "error" },
    });
    res = await post({ image: "a.png", include: [{ x: 1, y: 1 }] });
    expect(res.status).toBe(502);
  });
});

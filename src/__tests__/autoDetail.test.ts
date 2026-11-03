import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  buildAutoDetailPlan,
  parseProbeResponse,
  FACE_NODE,
  HAND_NODE,
  type AutoDetailProbe,
} from "@/lib/oj/autoDetail";
import {
  comfyImageRefFromViewUrl,
  buildActionWorkflow,
  validateViewRef,
} from "@/lib/oj/engine";
import { discoverDetailerSlots } from "@/lib/oj/discovery";
import type { ImagineRun, Workflow } from "@/types";

function probe(partial: Partial<AutoDetailProbe> = {}): AutoDetailProbe {
  return {
    people: 1,
    shot: "medium",
    facesSharp: false,
    handsVisible: true,
    subject: "a person",
    style: "photo",
    ...partial,
  };
}

const wfPath = (name: string) =>
  path.join(process.cwd(), "public/workflows/packs/krea2", name);

describe("parseProbeResponse", () => {
  it("parses clean JSON and JSON wrapped in prose", () => {
    const json =
      '{"people": 2, "shot": "medium", "faces_sharp": true, "hands_visible": false, "subject": "two hikers", "style": "photo"}';
    for (const text of [
      json,
      `Sure! Here you go:\n${json}\nHope that helps.`,
    ]) {
      const parsed = parseProbeResponse(text)!;
      expect(parsed).toMatchObject({
        people: 2,
        shot: "medium",
        facesSharp: true,
        handsVisible: false,
        style: "photo",
      });
    }
  });

  it("returns null on junk or invalid shot values", () => {
    expect(parseProbeResponse("a lovely painting of a fox")).toBeNull();
    expect(parseProbeResponse('{"shot": "extreme", "people": 1}')).toBeNull();
    expect(parseProbeResponse("{not json")).toBeNull();
  });
});

describe("buildAutoDetailPlan", () => {
  it("null probe falls back to workflow defaults with no overrides", () => {
    const plan = buildAutoDetailPlan(null);
    expect(plan.overrides).toEqual({});
    expect(plan.preferDetailEdit).toBe(false);
    expect(plan.summary).toContain("defaults");
  });

  it("scales face denoise with shot distance", () => {
    expect(
      buildAutoDetailPlan(probe({ shot: "closeup" })).overrides[
        `${FACE_NODE}.denoise`
      ],
    ).toBe(0.3);
    expect(
      buildAutoDetailPlan(probe({ shot: "medium" })).overrides[
        `${FACE_NODE}.denoise`
      ],
    ).toBe(0.38);
    expect(
      buildAutoDetailPlan(probe({ shot: "full" })).overrides[
        `${FACE_NODE}.denoise`
      ],
    ).toBe(0.45);
  });

  it("sharp faces and stylized images lower denoise, clamped to turbo-safe range", () => {
    const plan = buildAutoDetailPlan(
      probe({ shot: "closeup", facesSharp: true, style: "illustration" }),
    );
    // 0.30 - 0.08 - 0.05 = 0.17, above the 0.15 floor
    expect(plan.overrides[`${FACE_NODE}.denoise`]).toBe(0.17);
    expect(plan.overrides[`${FACE_NODE}.feather`]).toBe(12);
  });

  it("skips the hand pass when no hands are visible", () => {
    const plan = buildAutoDetailPlan(probe({ handsVisible: false }));
    expect(plan.overrides[`${HAND_NODE}.bbox_threshold`]).toBe(0.99);
    expect(plan.overrides[`${HAND_NODE}.drop_size`]).toBe(8192);
    expect(plan.overrides[`${HAND_NODE}.denoise`]).toBeUndefined();
  });

  it("crowds restrict to prominent faces", () => {
    const plan = buildAutoDetailPlan(probe({ people: 4 }));
    expect(plan.overrides[`${FACE_NODE}.bbox_threshold`]).toBe(0.6);
    expect(plan.overrides[`${FACE_NODE}.drop_size`]).toBe(24);
  });

  it("no people → prefer the whole-frame detail edit and disable both passes", () => {
    const plan = buildAutoDetailPlan(
      probe({ shot: "none", people: 0, subject: "a castle" }),
    );
    expect(plan.preferDetailEdit).toBe(true);
    expect(plan.overrides[`${FACE_NODE}.bbox_threshold`]).toBe(0.99);
    expect(plan.overrides[`${HAND_NODE}.bbox_threshold`]).toBe(0.99);
    expect(plan.summary).toContain("castle");
  });
});

describe("comfyImageRefFromViewUrl", () => {
  it("converts /view URLs to annotated LoadImage refs", () => {
    expect(
      comfyImageRefFromViewUrl(
        "http://127.0.0.1:8188/view?filename=img_01.png&subfolder=&type=output",
      ),
    ).toBe("img_01.png [output]");
    expect(
      comfyImageRefFromViewUrl(
        "http://127.0.0.1:8188/view?filename=a.png&subfolder=runs&type=temp",
      ),
    ).toBe("runs/a.png [temp]");
  });

  it("returns null for non-view URLs and missing input", () => {
    expect(comfyImageRefFromViewUrl(undefined)).toBeNull();
    expect(comfyImageRefFromViewUrl("http://x/prompt")).toBeNull();
    expect(comfyImageRefFromViewUrl("not a url at all")).toBeNull();
  });

  it("rejects traversal, absolute paths, bad types and injected annotations", () => {
    const v = (q: string) => comfyImageRefFromViewUrl(`/api/comfy/view?${q}`);
    expect(v("filename=a.mp4&subfolder=cj/clips&type=input")).toBe(
      "cj/clips/a.mp4 [input]",
    );
    expect(v("filename=a.png&subfolder=runs/&type=output")).toBe("runs/a.png [output]");
    for (const bad of [
      "filename=../secret.png&type=output",
      "filename=a.png&subfolder=../../etc&type=output",
      "filename=a.png&subfolder=runs/../..&type=output",
      "filename=a.png&subfolder=/etc&type=output",
      "filename=a.png&subfolder=C:%5Cwin&type=output",
      "filename=a.png&subfolder=.&type=input",
      "filename=a%5C..%5Cb.png&type=output",
      "filename=a.png%00.mp4&type=output",
      "filename=a%0Ab.png&type=output",
      "filename=a.png%20%5Binput%5D&type=output",
      "filename=a.png&type=models",
      "filename=a.png&type=..%2Foutput",
      "filename=a.png&subfolder=x%2F%2Fy&type=output",
    ]) {
      expect(v(bad), bad).toBeNull();
    }
    expect(validateViewRef("a.png", "", "output")).toBe("a.png [output]");
    expect(validateViewRef("a.png", "", "")).toBeNull();
    expect(validateViewRef("x".repeat(256), "", "output")).toBeNull();
  });
});

describe("detail workflows", () => {
  it("adetailer.json pins the node ids the auto policy targets", () => {
    const wf = JSON.parse(fs.readFileSync(wfPath("adetailer.json"), "utf8"));
    expect(wf[FACE_NODE].class_type).toBe("FaceDetailer");
    expect(wf[HAND_NODE].class_type).toBe("FaceDetailer");
    expect(wf[FACE_NODE].inputs.bbox_detector[0]).toBe("10");
    expect(wf["10"].inputs.model_name).toBe("bbox/face_yolov8m.pt");
    expect(wf["20"].inputs.model_name).toBe("bbox/hand_yolov8s.pt");
    // hand pass consumes the face pass output
    expect(wf[HAND_NODE].inputs.image).toEqual([FACE_NODE, 0]);
  });

  it("detail_edit.json regenerates at full denoise with the edit patch", () => {
    const wf = JSON.parse(fs.readFileSync(wfPath("detail_edit.json"), "utf8"));
    const sampler = Object.values(wf).find(
      (n) => (n as { class_type: string }).class_type === "KSampler",
    ) as { inputs: Record<string, unknown> };
    expect(sampler.inputs.denoise).toBe(1.0);
    expect(sampler.inputs.cfg).toBe(1.0);
    const classes = Object.values(wf).map(
      (n) => (n as { class_type: string }).class_type,
    );
    expect(classes).toContain("Krea2OstrisEditModelPatch");
    expect(classes).toContain("TextEncodeKrea2OstrisEdit");
    // 1 MP keeping the source aspect (no Kontext bucket crop). The edit
    // patch tiles the reference into a collage above ~1 MP (2 MP and 3.8 MP
    // both broke on the GPU), so the working size stays at 1 MP.
    expect(classes).not.toContain("FluxKontextImageScale");
    expect(wf["2"].class_type).toBe("ImageScaleToTotalPixels");
    expect(wf["2"].inputs.megapixels).toBe(1.0);
    expect(wf["13"].inputs.width).toEqual(["12", 0]);
  });

  it("upscale_detail.json feeds the detail pass into USDU on the plain model", () => {
    const wf = JSON.parse(
      fs.readFileSync(wfPath("upscale_detail.json"), "utf8"),
    );
    const usdu = wf["23"];
    expect(usdu.class_type).toBe("UltimateSDUpscale");
    expect(usdu.inputs.image).toEqual(["15", 0]); // detail pass VAEDecode
    expect(usdu.inputs.model).toEqual(["3", 0]); // UNETLoader, NOT the LoRA chain
    expect(usdu.inputs.denoise).toBe(0.2);
    expect(usdu.inputs.mode_type).toBe("Chess");
  });
});

describe("buildActionWorkflow with detailer graphs", () => {
  function runFor(images: string[]): ImagineRun {
    return {
      run_id: "r1",
      prompt: "a knight at dawn",
      parsedPrompt: "a knight at dawn",
      width: 1024,
      height: 1024,
      createdAt: "2026-07-05T00:00:00Z",
      status: "done",
      params: {},
      jobs: [
        {
          seed: 7,
          index: 0,
          status: "done",
          progress: 100,
          images,
        },
      ],
    } as ImagineRun;
  }

  it("discovers slots and injects source image + prompt + seed", () => {
    const wf = JSON.parse(
      fs.readFileSync(wfPath("adetailer.json"), "utf8"),
    ) as Workflow;
    const slots = discoverDetailerSlots(wf);
    expect(slots.ksamplerId).toBe(FACE_NODE);
    expect(slots.posTextId).toBe("6");

    const { workflow } = buildActionWorkflow(
      wf,
      "adetailer",
      runFor([
        "http://127.0.0.1:8188/view?filename=knight.png&subfolder=&type=output",
      ]),
      0,
      {},
    );
    expect(workflow["1"].inputs.image).toBe("knight.png [output]");
    expect(workflow["6"].inputs.text).toBe("a knight at dawn");
    // non-vary actions reseed randomly; just assert the seed landed on the detailer
    expect(typeof workflow[FACE_NODE].inputs.seed).toBe("number");
  });
});

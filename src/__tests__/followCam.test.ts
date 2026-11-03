/**
 * Follow subject (followCam.ts): crop / paste-back splice into the H3
 * masked swaps, per-person passes on cast_swap, and the Tools-page toggle.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { ImagineRun, Workflow } from "@/types";
import {
  buildCastSwapWorkflow,
  buildCharacterSwapMaskedWorkflow,
  FINISH_2K_IDS,
} from "@/lib/oj/h3MaskedEdit";
import { FOLLOW_CAM_ID_BASE, followSubjectOf } from "@/lib/oj/followCam";
import {
  ACTION_TOOLS,
  buildActionRequest,
  defaultSettings,
  pickerVisible,
} from "@/lib/tools/toolsPage";

const PACK_DIR = path.join(process.cwd(), "public/workflows/packs/minimax");
const load = (name: string): Workflow =>
  Object.fromEntries(
    Object.entries(
      JSON.parse(fs.readFileSync(path.join(PACK_DIR, `${name}.json`), "utf-8")),
    ).filter(([k]) => !k.startsWith("_")),
  ) as Workflow;
const run = {
  run_id: "t",
  prompt: "",
  jobs: [
    {
      seed: 1,
      index: 0,
      status: "done",
      videos: ["/api/comfy/view?filename=clip.mp4&subfolder=&type=input"],
    },
  ],
} as unknown as ImagineRun;
const REF = "mara.png [input]";
const REF2 = "pip.png [input]";
const REF3 = "lumen.png [input]";
const FC = (o: number) => String(FOLLOW_CAM_ID_BASE + o);

function expectLinked(wf: Workflow) {
  for (const [id, node] of Object.entries(wf))
    for (const [k, v] of Object.entries(node.inputs ?? {}))
      if (Array.isArray(v) && typeof v[0] === "string" && v.length === 2)
        expect(wf[v[0]], `${id}.${k} -> ${v[0]}`).toBeDefined();
}
const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf)
    .filter(([, n]) => n.class_type === cls)
    .map(([id]) => id);
const swap = (params: Record<string, unknown>) =>
  buildCharacterSwapMaskedWorkflow(load("character_swap_masked"), run, 0, {
    secondRefImage: REF,
    seed: 5,
    ...params,
  }).workflow;
const cast = (params: Record<string, unknown>) =>
  buildCastSwapWorkflow(load("cast_swap"), run, 0, {
    secondRefImage: REF,
    seed: 5,
    ...params,
  }).workflow;

describe("followSubjectOf", () => {
  it("defaults to off for API callers, passes valid modes", () => {
    expect(followSubjectOf({})).toBe("off");
    expect(followSubjectOf({ followSubject: "bogus" })).toBe("off");
    expect(followSubjectOf({ followSubject: "auto" })).toBe("auto");
    expect(followSubjectOf({ followSubject: "on" })).toBe("on");
  });
});

describe("character_swap_masked follow subject", () => {
  it("off leaves the graph exactly as before", () => {
    expect(swap({ followSubject: "off" })).toEqual(swap({}));
    expect(byClass(swap({}), "CJFollowCamTrack")).toEqual([]);
  });

  it("crops the tool inputs, keeps tracking + paste-back full frame", () => {
    const wf = swap({ followSubject: "on" });
    expectLinked(wf);
    const crop: [string, number] = [FC(2), 0];
    expect(wf[FC(0)].class_type).toBe("CJFollowCamPlate");
    expect(wf[FC(0)].inputs).toMatchObject({
      source: ["7", 0],
      frames: ["29", 0],
    });
    expect(wf[FC(1)].inputs).toMatchObject({
      mask: ["20", 0],
      width: ["29", 2],
      height: ["29", 3],
      mode: "on",
    });
    expect(wf[FC(2)].inputs.images).toEqual([FC(0), 0]);
    // SAM3 sees the prepared frames.
    expect(wf["12"].inputs.image).toEqual(["29", 0]);
    expect(wf["15"].inputs.images).toEqual(["29", 0]);
    // Tool inputs in crop space.
    expect(wf["30"].inputs.image).toEqual(crop);
    expect(wf["35"].inputs.destination).toEqual(crop);
    expect(wf["35"].inputs.mask).toEqual([FC(3), 0]);
    expect(wf["42"].inputs.pixels).toEqual(crop);
    expect(wf["43"].inputs.mask).toEqual([FC(4), 0]);
    expect(wf["63"].inputs.destination).toEqual(crop);
    expect(wf["62"].inputs.mask).toEqual([FC(4), 0]);
    expect(wf["70"].inputs.source_video).toEqual(crop);
    expect(wf["70"].inputs.mask).toEqual([FC(4), 0]);
    // No other node still reads the full prepared frames.
    const readers = Object.entries(wf)
      .filter(([, n]) =>
        Object.values(n.inputs).some(
          (v) => Array.isArray(v) && v[0] === "29" && v[1] === 0,
        ),
      )
      .map(([id]) => id)
      .sort();
    expect(readers).toEqual([FC(0), "12", "15"].sort());
    // Paste into the plate, then the full-frame paste-back.
    expect(wf[FC(5)].class_type).toBe("CJFollowCamPaste");
    expect(wf[FC(5)].inputs).toMatchObject({
      base: [FC(0), 0],
      crops: ["51", 0],
      followcam: [FC(1), 0],
      mask: [FC(4), 0],
    });
    expect(wf["52"].inputs).toMatchObject({
      frames: [FC(5), 0],
      source: ["7", 0],
      raw_mask: ["18", 0],
      expanded_mask: ["20", 0],
    });
  });

  it("auto passes the mode through (the node decides per clip)", () => {
    expect(swap({ followSubject: "auto" })[FC(1)].inputs.mode).toBe("auto");
  });

  it("smart clicks stay full frame", () => {
    const wf = swap({
      followSubject: "on",
      smartTrack: [{ t: 0, positive: [{ x: 0.5, y: 0.5 }], negative: [] }],
    });
    expectLinked(wf);
    const sam = Object.entries(wf).filter(([, n]) =>
      n.class_type.startsWith("SAM3_"),
    );
    expect(sam.length).toBeGreaterThan(0);
    for (const [, n] of sam)
      for (const v of Object.values(n.inputs))
        if (Array.isArray(v)) expect(v[0]).not.toBe(FC(2));
  });

  it("composes with the 2K finish and depth guide", () => {
    const wf = swap({
      followSubject: "on",
      finish: "2k",
      motionGuide: "depth",
    });
    expectLinked(wf);
    expect(wf[FC(5)].inputs.crops).toEqual([FINISH_2K_IDS.align, 0]);
    expect(wf["52"].inputs.frames).toEqual([FC(5), 0]);
    expect(wf["1901"].inputs.image).toEqual([FC(2), 0]);
    expect(wf["1904"].inputs.source_video).toEqual([FC(2), 0]);
    expect(wf["1904"].inputs.mask).toEqual([FC(4), 0]);
  });
});

describe("cast_swap follow subject", () => {
  it("off leaves the graph exactly as before", () => {
    expect(cast({ extraRefImages: [REF2], followSubject: "off" })).toEqual(
      cast({ extraRefImages: [REF2] }),
    );
  });

  it("one crop pass per person, chained through the pastes", () => {
    const wf = cast({ extraRefImages: [REF2, REF3], followSubject: "on" });
    expectLinked(wf);
    expect(byClass(wf, "CJFollowCamPlate")).toEqual([FC(0)]);
    expect(byClass(wf, "CJFollowCamTrack")).toHaveLength(3);
    const edit = { 1: "108", 2: "209", 3: "309" } as Record<number, string>;
    for (let k = 1; k <= 3; k++) {
      const b = 100 * k;
      const f = (o: number) => FC(10 * k + o);
      const base = k === 1 ? [FC(0), 0] : [String(b - 100 + 19), 0];
      expect(wf[f(0)].inputs.mask).toEqual([String(b + 8), 0]);
      expect(wf[f(1)].inputs.images).toEqual(base);
      expect(wf[f(4)].inputs.mask).toEqual([edit[k], 0]);
      expect(wf[String(b + 10)].inputs).toMatchObject({
        destination: [f(1), 0],
        source: [f(2), 0],
        mask: [f(3), 0],
      });
      expect(wf[String(b + 12)].inputs.pixels).toEqual([f(1), 0]);
      expect(wf[String(b + 13)].inputs.mask).toEqual([f(4), 0]);
      expect(wf[String(b + 19)].class_type).toBe("CJFollowCamPaste");
      expect(wf[String(b + 19)].inputs).toMatchObject({
        base,
        crops: [String(b + 18), 0],
        followcam: [f(0), 0],
        mask: [f(4), 0],
      });
    }
    expect(wf["15"].inputs.images).toEqual(["29", 0]);
    expect(wf["51"].inputs.image).toEqual(["319", 0]);
    expect(wf["52"].inputs).toMatchObject({
      raw_mask: ["320", 0],
      expanded_mask: ["321", 0],
    });
  });

  it("single person and clicked people", () => {
    const one = cast({ followSubject: "auto" });
    expectLinked(one);
    expect(byClass(one, "CJFollowCamTrack")).toEqual([FC(10)]);
    expect(one["51"].inputs.image).toEqual(["119", 0]);
    const clicked = cast({
      extraRefImages: [REF2],
      followSubject: "on",
      smartTrackSubjects: [
        [{ t: 0, positive: [{ x: 0.1, y: 0.2 }], negative: [] }],
        [{ t: 0, positive: [{ x: 0.9, y: 0.2 }], negative: [] }],
      ],
    });
    expectLinked(clicked);
    expect(byClass(clicked, "CJFollowCamPaste")).toEqual(["119", "219"]);
  });
});

describe("Follow subject picker", () => {
  const spec = (id: string) => ACTION_TOOLS.find((t) => t.id === id)!;

  it("character swap: mannequin only, default auto", () => {
    const s = spec("character_swap");
    const picker = s.pickers!.find((p) => p.key === "followSubject")!;
    const base = defaultSettings(s);
    const man = { ...base, picks: { ...base.picks, mode: "mannequin" } };
    expect(pickerVisible(picker, s, man)).toBe(true);
    expect(buildActionRequest(s, man, null, REF).params.followSubject).toBe(
      "auto",
    );
    const off = { ...man, picks: { ...man.picks, followSubject: "off" } };
    expect(buildActionRequest(s, off, null, REF).params.followSubject).toBe(
      "off",
    );
    const full = { ...base, picks: { ...base.picks, mode: "full" } };
    expect(pickerVisible(picker, s, full)).toBe(false);
  });

  it("cast swap sends it", () => {
    const s = spec("cast_swap");
    const on = defaultSettings(s);
    on.picks = { ...on.picks, followSubject: "on" };
    expect(buildActionRequest(s, on, null, REF).params.followSubject).toBe(
      "on",
    );
    expect(
      buildActionRequest(s, defaultSettings(s), null, REF).params.followSubject,
    ).toBe("auto");
  });
});

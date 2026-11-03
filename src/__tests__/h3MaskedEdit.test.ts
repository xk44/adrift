/**
 * H3 masked edits (openjutsu-style, MIT D3voz): mannequin character swap,
 * multi-person cast swap, background swap, object add. Pure builders on the
 * bundled minimax packs + the Tools-page request mapping.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { ImagineRun, Workflow } from "@/types";
import {
  CAST_SWAP_MAX_PEOPLE,
  EXACT_WINDOW_NODE,
  FINISH_2K_IDS,
  FINISH_2K_MODELS,
  FINISH_DEFAULT_STRENGTH,
  H3_MASKED_EDIT_SECONDS,
  ME_NODES,
  MOTION_LOCK_CONTROLNET,
  MOTION_LOCK_DEFAULTS,
  MOTION_LOCK_IDS,
  MOTION_GUIDE_POSE_DEFAULT_STRENGTH,
  MOTION_GUIDE_POSE_IDS,
  MOTION_GUIDE_POSE_MODELS,
  applyFinish2K,
  bgSwapPrompt,
  buildCastSwapWorkflow,
  buildCharacterSwapMaskedWorkflow,
  buildVideoBgSwapWorkflow,
  buildVideoObjectAddWorkflow,
  castRoles,
  maskedSwapPrompt,
  objectAddBox,
  objectAddPrompt,
  placementWords,
  swapRole,
} from "@/lib/oj/h3MaskedEdit";
import { ACTION_BUILDERS, VIDEO_INPUT_ACTIONS } from "@/lib/oj/actionBuilders";
import { getPack } from "@/lib/oj/packs";
import {
  ACTION_TOOLS,
  buildActionRequest,
  defaultSettings,
  pickerVisible,
  secondTextVisible,
  sliderVisible,
} from "@/lib/tools/toolsPage";
import { workflowModelRequirements } from "@/lib/tools/modelStatus";
import { resolveToolSetup } from "@/lib/tools/setupRequirements";
import { missingAgainstObjectInfo } from "@/lib/comfy/backendModels";
import { familyFor } from "@/lib/tools/toolsDoc";
import { isRegionLicense } from "@/lib/tools/licenseBadges";
import {
  SMART_TRACK_ACTIONS,
  SMART_TRACK_WINDOW_SECONDS,
} from "@/lib/tools/smartTrack";

const PACK_DIR = path.join(process.cwd(), "public/workflows/packs/minimax");
/** Pack graph as the loader hands it over (top-level "_" keys stripped). */
const load = (name: string): Workflow =>
  Object.fromEntries(
    Object.entries(
      JSON.parse(fs.readFileSync(path.join(PACK_DIR, `${name}.json`), "utf-8")),
    ).filter(([k]) => !k.startsWith("_")),
  ) as Workflow;

const view = (name: string) =>
  `/api/comfy/view?filename=${encodeURIComponent(name)}&subfolder=&type=input`;
const run = {
  run_id: "t",
  prompt: "",
  jobs: [{ seed: 1, index: 0, status: "done", videos: [view("clip.mp4")] }],
} as unknown as ImagineRun;

const REF = "mara.png [input]";
const REF2 = "pip.png [input]";
const REF3 = "lumen.png [input]";
const CLICK = [{ t: 0, positive: [{ x: 0.5, y: 0.5 }], negative: [] }];

const classes = (wf: Workflow) => Object.values(wf).map((n) => n.class_type);
const ids = (wf: Workflow) => new Set(Object.keys(wf));
/** Every [id, slot] link points at a node that exists. */
function expectLinked(wf: Workflow) {
  for (const [id, node] of Object.entries(wf)) {
    if (id.startsWith("_")) continue;
    for (const [k, v] of Object.entries(node.inputs ?? {}))
      if (Array.isArray(v) && typeof v[0] === "string" && v.length === 2)
        expect(wf[v[0]], `${id}.${k} -> ${v[0]}`).toBeDefined();
  }
}
const spec = (id: string) => {
  const s = ACTION_TOOLS.find((t) => t.id === id);
  if (!s) throw new Error(id);
  return s;
};

describe("prompt helpers", () => {
  it("swapRole words the target", () => {
    expect(swapRole("")).toBe("the main person");
    expect(swapRole("person")).toBe("the main person");
    expect(swapRole("man in red")).toBe("the man in red");
    expect(swapRole("a woman")).toBe("a woman");
  });

  it("mannequin prompt names the grey figure + outfit sentence", () => {
    const p = maskedSwapPrompt(
      "the man",
      undefined,
      false,
      "They wear a raincoat.",
    );
    expect(p).toContain("grey");
    expect(p).toContain("They wear a raincoat.");
    expect(p).toContain(`${H3_MASKED_EDIT_SECONDS.toFixed(3)}-second`);
    expect(p).not.toContain("<Subject 2> is every other person");
    expect(maskedSwapPrompt("the man", undefined, true)).toContain(
      "<Subject 2> is every other person",
    );
  });

  it("bg + object prompts reflect picture vs words", () => {
    expect(bgSwapPrompt("the people", "a snowy village", false)).toContain(
      "the new setting: a snowy village",
    );
    expect(bgSwapPrompt("the people", "", true)).toContain("from <Picture 1>");
    const words = objectAddPrompt(
      "a fox figurine",
      "on the table",
      "in the lower centre of the frame",
      false,
    );
    expect(words).toContain("a fox figurine is on the table");
    expect(words).not.toContain("<Picture 1>");
    expect(objectAddPrompt("", "", "x", true)).toContain("<Subject 1>");
  });

  it("castRoles parses numbered or ordered lines", () => {
    expect(castRoles("1: man in red\n2: kid", 2)).toEqual([
      "man in red",
      "kid",
    ]);
    expect(castRoles("left man; right man", 3)).toEqual([
      "left man",
      "right man",
      "",
    ]);
    expect(castRoles("3=dog", 2)).toEqual(["", ""]);
    expect(castRoles(undefined, 1)).toEqual([""]);
  });

  it("objectAddBox stays on the canvas and placementWords reads it", () => {
    for (const pos of ["top-left", "bottom-right", "center", "nope"])
      for (const size of ["small", "large", "x"]) {
        const b = objectAddBox(pos, size);
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.size).toBeLessThanOrEqual(1000);
        expect(b.y + b.size).toBeLessThanOrEqual(1000);
      }
    expect(objectAddBox("nope", "x")).toEqual(objectAddBox("bottom", "medium"));
    expect(placementWords(objectAddBox("center", "small"))).toBe(
      "in the centre of the frame",
    );
    expect(placementWords(objectAddBox("top-left", "small"))).toBe(
      "in the upper left of the frame",
    );
  });
});

describe("mannequin character swap", () => {
  it("fills the pack, keeps Qwen outfit nodes without a description", () => {
    const { workflow, seed } = buildCharacterSwapMaskedWorkflow(
      load("character_swap_masked"),
      run,
      0,
      { secondRefImage: REF, target: "man", seed: 7 },
    );
    expect(seed).toBe(7);
    expect(workflow[ME_NODES.loadVideo].inputs.file).toBe("clip.mp4 [input]");
    expect(workflow[ME_NODES.refImage].inputs.image).toBe(REF);
    expect(workflow[ME_NODES.samText].inputs.text).toBe("man");
    expect(workflow[ME_NODES.prep].inputs.duration_seconds).toBe(
      H3_MASKED_EDIT_SECONDS,
    );
    expect(classes(workflow)).toContain("TextGenerate");
    expect(Array.isArray(workflow[ME_NODES.ref2v].inputs.prompt)).toBe(true);
    expectLinked(workflow);
  });

  it("a typed outfit drops the Qwen describe nodes", () => {
    const { workflow } = buildCharacterSwapMaskedWorkflow(
      load("character_swap_masked"),
      run,
      0,
      { secondRefImage: REF, description: "They wear a yellow raincoat." },
    );
    expect(classes(workflow)).not.toContain("TextGenerate");
    expect(workflow[ME_NODES.ref2v].inputs.prompt).toContain("yellow raincoat");
    expectLinked(workflow);
  });

  it("clicks replace the SAM text track", () => {
    const { workflow } = buildCharacterSwapMaskedWorkflow(
      load("character_swap_masked"),
      run,
      0,
      { secondRefImage: REF, smartTrack: CLICK },
    );
    expect(workflow[ME_NODES.samText]).toBeUndefined();
    expectLinked(workflow);
  });

  it("requires the character photo", () => {
    expect(() =>
      buildCharacterSwapMaskedWorkflow(
        load("character_swap_masked"),
        run,
        0,
        {},
      ),
    ).toThrow(/character photo/);
  });
});

describe("cast swap", () => {
  it("one pass per photo, unused chains pruned", () => {
    const full = buildCastSwapWorkflow(load("cast_swap"), run, 0, {
      secondRefImage: REF,
      extraRefImages: [REF2, REF3],
      roles: "1: man left\n2: man right\n3: woman",
    }).workflow;
    for (const b of [100, 200, 300]) expect(full[String(b)]).toBeDefined();
    expect(full["100"].inputs.image).toBe(REF);
    expect(full["300"].inputs.image).toBe(REF3);
    expect(full["111"].inputs.prompt).toBeDefined();
    expectLinked(full);

    const two = buildCastSwapWorkflow(load("cast_swap"), run, 0, {
      secondRefImage: REF,
      extraRefImages: [REF2],
    }).workflow;
    expect(two["200"]).toBeDefined();
    expect(
      [...ids(two)].some((i) => Number(i) >= 300 && Number(i) <= 325),
    ).toBe(false);
    expect(two[ME_NODES.trim].inputs.image).toEqual(["219", 0]);
    expectLinked(two);

    const one = buildCastSwapWorkflow(load("cast_swap"), run, 0, {
      secondRefImage: REF,
    }).workflow;
    expect(one[ME_NODES.save].inputs.raw_mask).toEqual(["106", 0]);
    expectLinked(one);
  });

  it("caps at CAST_SWAP_MAX_PEOPLE and needs a photo", () => {
    const wf = buildCastSwapWorkflow(load("cast_swap"), run, 0, {
      secondRefImage: REF,
      extraRefImages: [REF2, REF3, "x.png [input]"],
    }).workflow;
    expect(wf[String(100 * CAST_SWAP_MAX_PEOPLE)]).toBeDefined();
    expect(wf["400"]).toBeUndefined();
    expect(() =>
      buildCastSwapWorkflow(load("cast_swap"), run, 0, {}),
    ).toThrow();
  });

  it("all-clicked drops the tint pick + text track", () => {
    const wf = buildCastSwapWorkflow(load("cast_swap"), run, 0, {
      secondRefImage: REF,
      extraRefImages: [REF2],
      smartTrackSubjects: [CLICK, CLICK],
    }).workflow;
    expect(wf[ME_NODES.samText]).toBeUndefined();
    expect(wf[ME_NODES.samTrack]).toBeUndefined();
    // Tint/pick subgraph gone; Qwen stays only for the outfit sentences.
    expect([...ids(wf)].some((x) => Number(x) >= 73 && Number(x) <= 93)).toBe(
      false,
    );
    expect(wf["123"]?.class_type).toBe("TextGenerate");
    expectLinked(wf);
  });
});

describe("background swap + object add", () => {
  it("bg swap: words only drops the picture slot", () => {
    const wf = buildVideoBgSwapWorkflow(load("video_bg_swap"), run, 0, {
      setting: "a snowy village",
    }).workflow;
    expect(wf[ME_NODES.refImage]).toBeUndefined();
    expect(wf[ME_NODES.ref2v].inputs["ref_images.ref_image_0"]).toBeUndefined();
    expect(wf[ME_NODES.ref2v].inputs.prompt).toContain("snowy village");
    expectLinked(wf);
    const pic = buildVideoBgSwapWorkflow(load("video_bg_swap"), run, 0, {
      secondRefImage: REF,
    }).workflow;
    expect(pic[ME_NODES.refImage].inputs.image).toBe(REF);
    expect(() =>
      buildVideoBgSwapWorkflow(load("video_bg_swap"), run, 0, {}),
    ).toThrow();
  });

  it("object add: box lands on the mask nodes", () => {
    const wf = buildVideoObjectAddWorkflow(load("video_object_add"), run, 0, {
      object: "a fox figurine",
      position: "top-left",
      size: "small",
    }).workflow;
    const box = objectAddBox("top-left", "small");
    expect(wf["61"].inputs.width).toBe(box.size);
    expect(wf["62"].inputs.x).toBe(box.x);
    expect(wf[ME_NODES.ref2v].inputs.prompt).toContain("upper left");
    expectLinked(wf);
    expect(() =>
      buildVideoObjectAddWorkflow(load("video_object_add"), run, 0, {}),
    ).toThrow();
  });
});

describe("wiring", () => {
  it("actions are registered, video-input and in the minimax pack", () => {
    for (const a of [
      "character_swap_masked",
      "cast_swap",
      "video_bg_swap",
      "video_object_add",
    ]) {
      expect(ACTION_BUILDERS[a], a).toBeDefined();
      expect(VIDEO_INPUT_ACTIONS.has(a), a).toBe(true);
      expect(Object.keys(getPack("minimax")?.workflows ?? {})).toContain(a);
    }
    for (const a of ["video_bg_swap", "cast_swap"])
      expect(SMART_TRACK_WINDOW_SECONDS[a]).toBe(H3_MASKED_EDIT_SECONDS);
    expect(SMART_TRACK_ACTIONS.has("video_bg_swap")).toBe(true);
  });

  it("character_swap mannequin mode maps to character_swap_masked", () => {
    const s = spec("character_swap");
    const settings = {
      ...defaultSettings(s),
      text: "man",
      secondText: "They wear a raincoat.",
      picks: { mode: "mannequin" },
      seed: 3,
    };
    expect(secondTextVisible(s, settings)).toBe(true);
    expect(buildActionRequest(s, settings, null, REF)).toEqual({
      action: "character_swap_masked",
      params: {
        pack_id: "minimax",
        secondRefImage: REF,
        target: "man",
        description: "They wear a raincoat.",
        motionGuide: "pose",
        motionGuideStrength: MOTION_GUIDE_POSE_DEFAULT_STRENGTH,
        finish: "off",
        followSubject: "auto",
        seed: 3,
      },
      overrides: {},
    });
    const full = { ...settings, picks: { mode: "full" } };
    expect(secondTextVisible(s, full)).toBe(false);
    const fullReq = buildActionRequest(s, full, null, REF);
    expect(fullReq.action).toBe("character_swap");
    expect(fullReq.params.motionGuide).toBeUndefined();
  });

  it("Motion guide: Pose by default, Off sends no strength, slider in %", () => {
    const s = spec("character_swap");
    const guide = s.pickers!.find((p) => p.key === "motionGuide")!;
    const slider = s.sliders!.find((sl) => sl.key === "poseStrength")!;
    expect(guide.options.map((o) => o.id)).toEqual(["pose", "off"]);
    expect(slider.default).toBe(MOTION_GUIDE_POSE_DEFAULT_STRENGTH * 100);
    const base = { ...defaultSettings(s), picks: { mode: "mannequin" } };
    expect(pickerVisible(guide, s, base)).toBe(true);
    expect(sliderVisible(slider, s, base)).toBe(true);
    // Nested showWhen: Full mode hides the guide AND its slider.
    const full = { ...base, picks: { mode: "full", motionGuide: "pose" } };
    expect(pickerVisible(guide, s, full)).toBe(false);
    expect(sliderVisible(slider, s, full)).toBe(false);
    const off = { ...base, picks: { mode: "mannequin", motionGuide: "off", poseStrength: "50" } };
    expect(sliderVisible(slider, s, off)).toBe(false);
    const offParams = buildActionRequest(s, off, null, REF).params;
    expect(offParams.motionGuide).toBe("off");
    expect(offParams.motionGuideStrength).toBeUndefined();
    const tuned = { ...base, picks: { mode: "mannequin", poseStrength: "65" } };
    expect(buildActionRequest(s, tuned, null, REF).params).toMatchObject({
      motionGuide: "pose",
      motionGuideStrength: 0.65,
    });
  });

  it("cast_swap passes extra photos, roles and per-person clicks", () => {
    const s = spec("cast_swap");
    const req = buildActionRequest(
      s,
      {
        ...defaultSettings(s),
        text: "1: left man",
        smartTrackSubjects: [[], CLICK],
      },
      null,
      REF,
      undefined,
      [REF2],
    );
    expect(req.action).toBe("cast_swap");
    expect(req.params).toMatchObject({
      secondRefImage: REF,
      extraRefImages: [REF2],
      roles: "1: left man",
    });
    expect((req.params.smartTrackSubjects as unknown[]).length).toBe(2);
    expect(() => buildActionRequest(s, defaultSettings(s), null)).toThrow();
  });

  it("bg swap + object add need words or a picture", () => {
    const bg = spec("video_bg_swap");
    expect(() => buildActionRequest(bg, defaultSettings(bg), null)).toThrow();
    expect(
      buildActionRequest(
        bg,
        { ...defaultSettings(bg), secondText: "a beach" },
        null,
      ).params,
    ).toMatchObject({ setting: "a beach" });
    const obj = spec("video_object_add");
    expect(() => buildActionRequest(obj, defaultSettings(obj), null)).toThrow();
    expect(
      buildActionRequest(obj, { ...defaultSettings(obj), text: "a lamp" }, null)
        .params,
    ).toMatchObject({ object: "a lamp", position: "bottom", size: "medium" });
  });
});

describe("character_swap_masked motion lock (H3 Fun ControlNet depth)", () => {
  const build = (params: Record<string, unknown>) =>
    buildCharacterSwapMaskedWorkflow(load("character_swap_masked"), run, 0, {
      secondRefImage: REF,
      seed: 7,
      ...params,
    }).workflow;

  it("is off without a request: guider samples the plain model", () => {
    const wf = build({ motionGuide: "off" });
    expect(wf["45"].inputs.model).toEqual(["9", 0]);
    expect(wf[MOTION_LOCK_IDS.apply]).toBeUndefined();
  });

  it("depth: DA3 depth of the prepared frames drives the masked ControlNet", () => {
    const wf = build({ motionLock: "depth" });
    for (const id of Object.values(MOTION_GUIDE_POSE_IDS))
      expect(wf[id], id).toBeUndefined();
    expect(build({ motionGuide: "depth" })).toEqual(wf);
    const apply = wf[MOTION_LOCK_IDS.apply];
    expect(apply.class_type).toBe("MiniMaxH3FunControlNetApply");
    expect(apply.inputs.model).toEqual(["9", 0]);
    expect(wf["45"].inputs.model).toEqual([MOTION_LOCK_IDS.apply, 0]);
    expect(apply.inputs.mask).toEqual(["20", 0]);
    expect(apply.inputs.source_video).toEqual([ME_NODES.prep, 0]);
    expect(apply.inputs.control_video).toEqual([MOTION_LOCK_IDS.depthImage, 0]);
    expect(apply.inputs.strength).toBe(MOTION_LOCK_DEFAULTS.strength);
    expect(apply.inputs.end_percent).toBe(MOTION_LOCK_DEFAULTS.end);
    expect(wf[MOTION_LOCK_IDS.patch].inputs.name).toBe(MOTION_LOCK_CONTROLNET);
    expect(wf[MOTION_LOCK_IDS.depth].inputs.image).toEqual([ME_NODES.prep, 0]);
    expect(wf[MOTION_LOCK_IDS.depthImage].inputs.output).toBe("depth");
    // every link points at a node that exists
    for (const [id, nd] of Object.entries(wf))
      for (const v of Object.values(nd.inputs))
        if (Array.isArray(v) && typeof v[0] === "string")
          expect(wf[v[0]], `${id} -> ${v[0]}`).toBeDefined();
  });

  it("clamps strength / end", () => {
    const wf = build({ motionLock: "depth", motionLockStrength: 9, motionLockEnd: 0 });
    expect(wf[MOTION_LOCK_IDS.apply].inputs.strength).toBe(2);
    expect(wf[MOTION_LOCK_IDS.apply].inputs.end_percent).toBe(0.05);
  });

  it("ids never collide with pack or smart-track nodes", () => {
    const off = build({ motionGuide: "off", smartTrack: CLICK });
    const wf = build({ motionLock: "depth", smartTrack: CLICK });
    for (const id of Object.values(MOTION_LOCK_IDS)) expect(off[id]).toBeUndefined();
    for (const [id, nd] of Object.entries(off))
      if (id !== "45") expect(wf[id]).toEqual(nd);
    expect(wf["45"].inputs.model).toEqual([MOTION_LOCK_IDS.apply, 0]);
    expect(wf[MOTION_LOCK_IDS.depthModel].class_type).toBe("LoadDA3Model");
  });
});

describe("character_swap_masked motion guide (SDPose pose, H3 Fun ControlNet)", () => {
  const P = MOTION_GUIDE_POSE_IDS;
  const build = (params: Record<string, unknown>, base = load("character_swap_masked")) =>
    buildCharacterSwapMaskedWorkflow(base, run, 0, {
      secondRefImage: REF,
      seed: 7,
      ...params,
    }).workflow;
  /** The pack as it was before the guide: pose nodes gone, guider on the LoRA model. */
  const legacyPack = (): Workflow => {
    const wf = load("character_swap_masked");
    for (const id of Object.values(P)) delete wf[id];
    wf["45"].inputs.model = ["9", 0];
    return wf;
  };

  it("pose is the default: skeleton drives the ControlNet on the sampling model", () => {
    const wf = build({});
    expect(build({ motionGuide: "pose" })).toEqual(wf);
    const apply = wf[P.apply];
    expect(apply.class_type).toBe("MiniMaxH3FunControlNetApply");
    expect(apply.inputs.model).toEqual(["9", 0]);
    expect(wf["45"].inputs.model).toEqual([P.apply, 0]);
    expect(wf["27"].inputs.model).toEqual(["9", 0]);
    expect(apply.inputs.strength).toBe(MOTION_GUIDE_POSE_DEFAULT_STRENGTH);
    expect(apply.inputs.start_percent).toBe(0);
    expect(apply.inputs.end_percent).toBe(1);
    expect(apply.inputs.control_video).toEqual([P.poseVideo, 0]);
    expect(apply.inputs.mask).toEqual(["20", 0]);
    expect(apply.inputs.source_video).toEqual([ME_NODES.prep, 0]);
    expect(wf[P.patch]).toMatchObject({
      class_type: "ModelPatchLoader",
      inputs: { name: MOTION_GUIDE_POSE_MODELS.controlnet },
    });
    expect(wf[P.detector].inputs.unet_name).toBe(MOTION_GUIDE_POSE_MODELS.detector);
    expect(wf[P.sdpose].inputs.ckpt_name).toBe(MOTION_GUIDE_POSE_MODELS.sdpose);
    expect(wf[P.keypoints].inputs.model).toEqual([P.sdpose, 0]);
    expect(wf[P.keypoints].inputs.vae).toEqual([P.sdpose, 2]);
    expect(wf[P.draw].inputs.keypoints).toEqual([P.keypoints, 0]);
    // pose frames at the H3 prepared size / frame count
    expect(wf[P.black].inputs).toMatchObject({
      width: [ME_NODES.prep, 2],
      height: [ME_NODES.prep, 3],
    });
    expect(classes(wf)).not.toContain("LoadDA3Model");
    expectLinked(wf);
  });

  it("only the masked subject drives the pose (other people never detected)", () => {
    const wf = build({ smartTrack: CLICK });
    // Detector and keypoints see the prepared frames with everything
    // outside the edit mask blacked out.
    const subject = wf[P.subject];
    expect(subject.class_type).toBe("ImageCompositeMasked");
    expect(subject.inputs.destination).toEqual([ME_NODES.prep, 0]);
    expect(subject.inputs.source).toEqual([P.black, 0]);
    expect(subject.inputs.mask).toEqual([P.outside, 0]);
    expect(wf[P.outside]).toMatchObject({
      class_type: "InvertMask",
      inputs: { mask: ["20", 0] },
    });
    expect(wf[P.black].inputs.color).toBe(0);
    expect(wf[P.detect]).toMatchObject({
      class_type: "RTDETR_detect",
      inputs: { image: [P.subject, 0], class_name: "person", max_detections: 1 },
    });
    expect(wf[P.keypoints].inputs.image).toEqual([P.subject, 0]);
    expect(wf[P.keypoints].inputs.bboxes).toEqual([P.detect, 0]);
    // The drawn skeleton is cut back to the edit area before the ControlNet.
    expect(wf[P.poseVideo].inputs).toMatchObject({
      destination: [P.draw, 0],
      source: [P.black, 0],
      mask: [P.outside, 0],
    });
    // Same mask the edit + paste-back use; it follows the clicked person.
    expect(wf["43"].inputs.mask).toEqual(["20", 0]);
    expect(wf["52"].inputs.expanded_mask).toEqual(["20", 0]);
    expect(wf["20"].inputs.mask).toEqual(["18", 0]);
    const tracked = wf["18"].inputs.mask as [string, number];
    expect(tracked).not.toEqual([ME_NODES.samMask, 0]);
    expect(Number(tracked[0])).toBeGreaterThanOrEqual(900);
    // single subject: one pose region, one detector, one apply
    expect(classes(wf).filter((c) => c === "RTDETR_detect")).toHaveLength(1);
    expect(classes(wf).filter((c) => c === "MiniMaxH3FunControlNetApply")).toHaveLength(1);
    expectLinked(wf);
  });

  it("Off reproduces the graph from before the guide, node for node", () => {
    for (const extra of [{}, { smartTrack: CLICK }, { target: "dancer", description: "a red coat" }]) {
      const off = build({ motionGuide: "off", ...extra });
      expect(off).toEqual(build(extra, legacyPack()));
      for (const id of Object.values(P)) expect(off[id], id).toBeUndefined();
      expect(off["45"].inputs.model).toEqual(["9", 0]);
      for (const c of ["RTDETR_detect", "SDPoseKeypointExtractor", "SDPoseDrawKeypoints", "MiniMaxH3FunControlNetApply"])
        expect(classes(off)).not.toContain(c);
      expectLinked(off);
    }
  });

  it("strength is clamped to 0.2..1.2; junk falls back to the default", () => {
    const s = (v: unknown) => build({ motionGuideStrength: v })[P.apply].inputs.strength;
    expect(s(0.65)).toBe(0.65);
    expect(s(9)).toBe(1.2);
    expect(s(0)).toBe(0.2);
    expect(s("x")).toBe(MOTION_GUIDE_POSE_DEFAULT_STRENGTH);
  });

  it("pose ids sit in the pack's free range, clear of smart-track (900+) and depth (1900+)", () => {
    const pack = load("character_swap_masked");
    const legacy = legacyPack();
    for (const id of Object.values(P)) {
      expect(legacy[id], id).toBeUndefined();
      expect(Number(id)).toBeLessThan(900);
      expect(pack[id], id).toBeDefined();
    }
    const tracked = build({ smartTrack: CLICK });
    for (const id of Object.values(MOTION_LOCK_IDS)) expect(tracked[id]).toBeUndefined();
  });
});

describe("character_swap_masked 2K finish (Open-H3-Regenerate)", () => {
  const F = FINISH_2K_IDS;
  const build = (params: Record<string, unknown>, base = load("character_swap_masked")) =>
    buildCharacterSwapMaskedWorkflow(base, run, 0, {
      secondRefImage: REF,
      seed: 7,
      ...params,
    }).workflow;
  /** The pack as it was before the finish: nodes 80-95 gone. */
  const preFinishPack = (): Workflow => {
    const wf = load("character_swap_masked");
    for (const id of Object.values(F)) delete wf[id];
    return wf;
  };
  /** ComfyMathExpression (Python // on positive ints) evaluated in JS. */
  const evalExpr = (expr: string, a: number): number => {
    const js = expr.replace(/\(([^()]*)\) \/\/ (\d+)/, "Math.floor(($1) / $2)");
    expect(js).not.toContain("//");
    return new Function("a", `return ${js}`)(a) as number;
  };

  it("pack ships the finish detached and optional; paste-back untouched", () => {
    const pack = load("character_swap_masked");
    for (const id of Object.values(F)) {
      expect(pack[id], id).toBeDefined();
      expect(pack[id]._meta?.optional, id).toBe(true);
      expect(Number(id)).toBeLessThan(900);
    }
    expect(pack["52"].inputs.frames).toEqual(["51", 0]);
    expect(pack["52"].inputs.output_res).toBeUndefined();
  });

  it("Off (default) reproduces the graph from before the finish, node for node", () => {
    for (const extra of [
      {},
      { motionGuide: "off" },
      { smartTrack: CLICK },
      { target: "dancer", description: "a red coat" },
      { finish: "nope", finishStrength: 0.7 },
    ]) {
      const off = build({ finish: "off", ...extra });
      expect(off).toEqual(build(extra, preFinishPack()));
      expect(build(extra)).toEqual(off);
      for (const id of Object.values(F)) expect(off[id], id).toBeUndefined();
      expect(off["52"].inputs.frames).toEqual(["51", 0]);
      expect(off["52"].inputs.output_res).toBeUndefined();
      for (const c of ["OpenH3RegenLora", "MiniMaxH3LatentUpscaleWithModel", "CJRegenAlign"])
        expect(classes(off)).not.toContain(c);
      expectLinked(off);
    }
  });

  it("2K: swap frames -> prepare -> latent upscale -> refine -> align -> paste-back", () => {
    const wf = build({ finish: "2k" });
    for (const id of Object.values(F)) expect(wf[id]._meta?.optional, id).toBeUndefined();
    // draft = the swap's own decoded, trimmed frames (generation geometry)
    expect(wf[F.prepare]).toMatchObject({
      class_type: "OpenH3RegenPrepareDraft",
      inputs: { images: ["51", 0], size: "576p (1024x576)", max_frames: 0, source_fps: 24 },
    });
    expect(wf[F.encode].inputs).toEqual({ pixels: [F.prepare, 0], vae: ["5", 0] });
    expect(wf[F.upscalerModel].inputs.model_name).toBe(FINISH_2K_MODELS.upscaler);
    expect(wf[F.upscale]).toMatchObject({
      class_type: "MiniMaxH3LatentUpscaleWithModel",
      inputs: {
        model: [F.upscalerModel, 0],
        samples: [F.encode, 0],
        width: [F.width, 1],
        height: [F.height, 1],
      },
    });
    expect(wf[F.width].inputs["values.a"]).toEqual([F.prepare, 2]);
    expect(wf[F.height].inputs["values.a"]).toEqual([F.prepare, 3]);
    expect(wf[F.refine].inputs).toEqual({
      latent: [F.upscale, 0],
      audio_mode: "silence (reference)",
      audio_vae: ["6", 0],
    });
    // LoRA on the raw UNET (no shift / turbo / swap LoRA), reused loaders
    expect(wf[F.lora]).toMatchObject({
      class_type: "OpenH3RegenLora",
      inputs: {
        model: ["1", 0],
        lora_name: FINISH_2K_MODELS.lora,
        curve_name: FINISH_2K_MODELS.curve,
        curve_table: wf["1"].inputs.unet_name,
        strength: 1,
      },
    });
    expect(wf[F.sigmas].inputs).toEqual({ steps: 3, start_sigma: FINISH_DEFAULT_STRENGTH });
    expect(wf[F.sampler].inputs.sampler_name).toBe("euler");
    // same Ref2VA conditioning + seeded noise as the swap
    expect(wf[F.guider].inputs).toEqual({ model: [F.lora, 0], conditioning: [ME_NODES.ref2v, 0] });
    expect(wf[F.sample].inputs).toEqual({
      noise: [ME_NODES.noise, 0],
      guider: [F.guider, 0],
      sampler: [F.sampler, 0],
      sigmas: [F.sigmas, 0],
      latent_image: [F.refine, 0],
    });
    expect(wf[F.decode].inputs).toEqual({ samples: [F.separate, 0], vae: ["5", 0] });
    expect(wf[F.finish].inputs).toEqual({
      images: [F.decode, 0],
      frame_count: [F.prepare, 1],
      crop: "auto (1088 -> 1080, 2176 -> 2160)",
    });
    expect(wf[F.align].inputs).toEqual({
      regen: [F.finish, 0],
      draft: ["51", 0],
      prepared_width: [F.prepare, 2],
      prepared_height: [F.prepare, 3],
    });
    expect(wf["52"].inputs.frames).toEqual([F.align, 0]);
    expect(wf["52"].inputs.output_res).toBe("frames");
    // one loader each: no duplicated UNET / VAE / text encoder
    for (const c of ["UNETLoader", "CLIPLoader"])
      expect(classes(wf).filter((x) => x === c)).toHaveLength(classes(build({})).filter((x) => x === c).length);
    expect(classes(wf).filter((x) => x === "VAELoader")).toHaveLength(2);
    expectLinked(wf);
    // the rest of the graph is the Off graph
    const off = build({});
    for (const [id, node] of Object.entries(off))
      if (id !== "52") expect(wf[id], id).toEqual(node);
  });

  it("2K combines with Motion guide Off and smart-track clicks", () => {
    for (const extra of [{ motionGuide: "off" }, { smartTrack: CLICK }]) {
      const wf = build({ finish: "2k", ...extra });
      expect(wf["52"].inputs.frames).toEqual([F.align, 0]);
      expect(wf[F.guider].inputs.conditioning).toEqual([ME_NODES.ref2v, 0]);
      expectLinked(wf);
    }
  });

  it("finish strength (start_sigma) is clamped to 0.4..0.8; junk falls back to 0.5", () => {
    const s = (v: unknown) => build({ finish: "2k", finishStrength: v })[F.sigmas].inputs.start_sigma;
    expect(s(0.65)).toBe(0.65);
    expect(s(0.35)).toBe(0.4);
    expect(s(2)).toBe(0.8);
    expect(s("x")).toBe(FINISH_DEFAULT_STRENGTH);
    expect(s(undefined)).toBe(0.5);
  });

  it("upscale size: 1080p grid of the prepared draft, portrait and landscape", () => {
    const wf = build({ finish: "2k" });
    const w = wf[F.width].inputs.expression as string;
    expect(wf[F.height].inputs.expression).toBe(w);
    const dims = (pw: number, ph: number) => [evalExpr(w, pw), evalExpr(w, ph)];
    expect(dims(576, 1024)).toEqual([1088, 1920]); // portrait (F1 reference)
    expect(dims(1024, 576)).toEqual([1920, 1088]); // landscape
    expect(dims(576, 576)).toEqual([1088, 1088]);
    for (const n of [512, 544, 576, 640, 768, 1024]) expect(evalExpr(w, n) % 32).toBe(0);
  });

  it("applyFinish2K on a graph without the finish nodes is a no-op for Off", () => {
    const wf = preFinishPack();
    const before = structuredClone(wf);
    applyFinish2K(wf, {});
    expect(wf).toEqual(before);
    applyFinish2K(wf, { finish: "2k" });
    expect(wf).toEqual(before);
  });

  it("model check: finish weights + nodes only gate the 2K graph, not the card", () => {
    const finishFiles = Object.values(FINISH_2K_MODELS);
    const reqs = (wf: Workflow) => workflowModelRequirements(wf).map((r) => r.file);
    // card check reads the pack: optional finish nodes are skipped
    const pack = load("character_swap_masked");
    for (const f of finishFiles) expect(reqs(pack)).not.toContain(f);
    expect(reqs(pack)).toContain("minimax_h3_ref2va_pruned_int8_convrot.safetensors");
    expect(missingAgainstObjectInfo(pack, {})).not.toContain("node:OpenH3RegenLora");
    // the built 2K graph requires them (flag dropped)
    const on = build({ finish: "2k" });
    for (const f of finishFiles) expect(reqs(on)).toContain(f);
    expect(missingAgainstObjectInfo(on, {})).toContain("node:OpenH3RegenLora");
    expect(
      workflowModelRequirements(on).find((r) => r.file === FINISH_2K_MODELS.upscaler)?.dir,
    ).toBe("latent_upscale_models");
    expect(reqs(build({}))).toEqual(reqs(pack));
    // setup drawer lists them as optional extras, region-limited
    const load2 = (rel: string): Workflow | null => {
      const p = path.join(process.cwd(), "public/workflows", rel);
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
    };
    const setup = resolveToolSetup("action:character_swap", load2)!;
    const files = setup.options.flatMap((o) => o.files);
    for (const f of ["open_h3_regenerate_2k_lora.safetensors", "sharp_curve_branches.safetensors", FINISH_2K_MODELS.upscaler]) {
      const hit = files.find((x) => x.file === f);
      expect(hit, f).toBeDefined();
      expect(hit!.optional, f).toBe(true);
      expect(hit!.commercial, f).toBe("restricted");
      expect(isRegionLicense(hit!.license), f).toBe(true);
    }
    expect(files.find((x) => x.file === "open_h3_regenerate_2k_lora.safetensors")!.folder).toBe("loras/h3/");
    // the default (full) mode's bf16 Ref2VA is required; the mannequin
    // mode's int8 Ref2VA is listed as that mode's (optional) extra
    expect(files.find((x) => x.file === "minimax_h3_ref2va_pruned_bf16.safetensors")!.optional).toBe(false);
    expect(files.find((x) => x.file === "minimax_h3_ref2va_pruned_int8_convrot.safetensors")!.optional).toBe(true);
    for (const f of finishFiles) expect(familyFor(f)?.license).toBe("MiniMax H3 Community License");
  });

  it("Tools page: Finish Off by default, 2K sends the strength from the Advanced slider", () => {
    const s = spec("character_swap");
    const finish = s.pickers!.find((p) => p.key === "finish")!;
    const slider = s.sliders!.find((sl) => sl.key === "finishStrength")!;
    expect(finish.options.map((o) => o.id)).toEqual(["off", "2k"]);
    expect(finish.paramOnly).toBe(true);
    expect(slider).toMatchObject({ min: 40, max: 80, default: 50, unit: "%", advanced: true });
    const base = { ...defaultSettings(s), picks: { mode: "mannequin" } };
    expect(pickerVisible(finish, s, base)).toBe(true);
    expect(sliderVisible(slider, s, base)).toBe(false);
    const offParams = buildActionRequest(s, base, null, REF).params;
    expect(offParams.finish).toBe("off");
    expect(offParams.finishStrength).toBeUndefined();
    const on = { ...base, picks: { mode: "mannequin", finish: "2k" } };
    expect(sliderVisible(slider, s, on)).toBe(true);
    expect(buildActionRequest(s, on, null, REF).params).toMatchObject({
      finish: "2k",
      finishStrength: 0.5,
    });
    const tuned = { ...base, picks: { mode: "mannequin", finish: "2k", finishStrength: "70" } };
    expect(buildActionRequest(s, tuned, null, REF).params.finishStrength).toBe(0.7);
    // Full mode hides the picker and its slider; nothing is sent.
    const full = { ...base, picks: { mode: "full", finish: "2k" } };
    expect(pickerVisible(finish, s, full)).toBe(false);
    expect(sliderVisible(slider, s, full)).toBe(false);
    expect(buildActionRequest(s, full, null, REF).params.finish).toBeUndefined();
  });
});

describe("character swap exact fidelity", () => {
  const base = load("character_swap_masked");
  const exactRun = (extra: Record<string, unknown> = {}) =>
    buildCharacterSwapMaskedWorkflow(base, run, 0, {
      secondRefImage: REF,
      fidelity: "exact",
      ...extra,
    }).workflow;

  it("uses the exact pair with no 5 s window", () => {
    const w = exactRun();
    expect(w["29"].class_type).toBe("CJExactPrepare");
    expect(w["29"].inputs.duration_seconds).toBe(0);
    expect(w["29"].inputs.resolution).toBe("480");
    expect(w["52"].class_type).toBe("CJExactPasteSave");
    // Wider edit area with a fade, so the repaint seam stays away from the person.
    expect(w["20"].inputs.expand).toBe(80);
    expect(w["52"].inputs.edge_ramp_px).toBe(28);
    // The character photo reaches the model cut out onto the scene.
    expect(w["41"].inputs["ref_images.ref_image_0"]).toEqual(["99", 0]);
    expect(w["99"].class_type).toBe("CJRefOnScene");
    expect(w["99"].inputs.reference).toEqual(["40", 0]);
    expect(w["98"].inputs.image).toEqual(["40", 0]);
    expect(w["99"].inputs.scene_mask).toEqual([ME_NODES.samSelect, 0]);
    expect(w["52"].inputs.source_frames).toEqual(["29", 5]);
    expect(w["52"].inputs.master).toBe(false);
    // Length stays linked: the count is only known after decoding.
    expect(w["41"].inputs.length).toEqual(["29", 4]);
    expect(w["51"].inputs.length).toEqual(["29", 5]);
  });

  it("samples in context windows, after the pose guide", () => {
    const w = exactRun({ motionGuide: "pose" });
    expect(w["45"].inputs.model).toEqual([EXACT_WINDOW_NODE, 0]);
    expect(w[EXACT_WINDOW_NODE].class_type).toBe("MiniMaxH3ContextWindows");
    expect(w[EXACT_WINDOW_NODE].inputs.model).toEqual(["70", 0]);
  });

  it("passes resolution and master through", () => {
    const w = exactRun({ resolution: "768", output: "master" });
    expect(w["29"].inputs.resolution).toBe("768");
    expect(w["52"].inputs.master).toBe(true);
  });

  it("ignores options that need the crop geometry or 24 fps clicks", () => {
    const w = exactRun({
      finish: "2k",
      followSubject: "on",
      smartTrack: [{ t: 1, points: [] }],
    });
    for (const id of Object.values(FINISH_2K_IDS)) expect(w[id]).toBeUndefined();
    expect(w["52"].inputs.frames).toEqual(["51", 0]);
    expect(
      Object.values(w).some((n) => n.class_type.startsWith("CJFollowCam")),
    ).toBe(false);
  });

  it("the card queues the masked action with the exact params", () => {
    const s = spec("character_swap");
    const settings = {
      ...defaultSettings(s),
      text: "man",
      picks: { mode: "exact", resolution: "768", output: "master" },
    };
    const outputPicker = (s.pickers ?? []).find((p) => p.key === "output")!;
    expect(pickerVisible(outputPicker, s, settings)).toBe(true);
    expect(buildActionRequest(s, settings, null, REF)).toMatchObject({
      action: "character_swap_masked",
      params: {
        fidelity: "exact",
        resolution: "768",
        output: "master",
        secondRefImage: REF,
        target: "man",
      },
    });
    const mannequin = { ...settings, picks: { mode: "mannequin" } };
    expect(buildActionRequest(s, mannequin, null, REF).params.fidelity).toBeUndefined();
    expect(pickerVisible(outputPicker, s, mannequin)).toBe(false);
  });

  it("leaves mannequin mode alone", () => {
    const w = buildCharacterSwapMaskedWorkflow(base, run, 0, {
      secondRefImage: REF,
    }).workflow;
    expect(w["29"].class_type).toBe("LabsH3PrepareVideo");
    expect(w["52"].class_type).toBe("CJPasteBackSave");
    expect(w[EXACT_WINDOW_NODE]).toBeUndefined();
  });
});

/**
 * Multiframe Reference (MiniMax H3 Ref2VA + MiniMaxH3AddGuide keyframes):
 * pack graph shape vs the official template, routing, client request and
 * the builder (frame indexes, pruning unused guides, keysAsRefs, speed).
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import {
  MULTIFRAME_LENGTHS,
  MULTIFRAME_REF_ACTION,
  buildMultiframeRefWorkflow,
  multiframeExtraKeys,
  multiframeFrames,
  multiframePrompt,
  multiframeTimestamp,
} from "@/lib/oj/h3MultiframeRef";
import { H3_TURBO_REF2V_8 } from "@/lib/oj/h3Speed";
import { resolveWorkflow } from "@/lib/oj/packs";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  MULTIFRAME_KEY_SLIDERS,
  ToolInputError,
  buildActionRequest,
  defaultSettings,
  getActionTool,
  type ActionToolSpec,
} from "@/lib/tools/toolsPage";
import { needsLikenessConsent } from "@/lib/tools/h3License";

const PACK_FILE = path.join(
  process.cwd(),
  "public/workflows/packs/minimax/multiframe_ref.json",
);
const RAW = JSON.parse(fs.readFileSync(PACK_FILE, "utf-8")) as Record<
  string,
  unknown
>;
const MF = Object.fromEntries(
  Object.entries(RAW).filter(([k]) => !k.startsWith("_")),
) as Workflow;
const R2V = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "public/workflows/packs/minimax/r2v.json"),
    "utf-8",
  ),
) as Workflow;

const IMAGE_URL =
  "http://127.0.0.1:8188/view?filename=mara.png&subfolder=qa&type=input";
const run: ImagineRun = {
  run_id: "seed-img",
  prompt: "",
  parsedPrompt: "",
  width: 1024,
  height: 1024,
  createdAt: new Date().toISOString(),
  status: "done",
  jobs: [
    { seed: 0, index: 0, status: "done", progress: 100, images: [IMAGE_URL] },
  ],
  params: { seed_upload: true },
} as unknown as ImagineRun;

const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(([, n]) => n.class_type === cls);
const spec = getActionTool("multiframe_ref") as ActionToolSpec;
const K2 = "qa/k2.png [input]";
const K3 = "qa/k3.png [input]";
const K4 = "qa/k4.png [input]";

function build(extra: string[], picks: Record<string, string> = {}, text = "") {
  const settings = {
    ...defaultSettings(spec),
    text,
    picks: { ...defaultSettings(spec).picks, ...picks },
  };
  const req = buildActionRequest(
    spec,
    settings,
    null,
    extra[0],
    undefined,
    extra.slice(1),
  );
  return buildMultiframeRefWorkflow(MF, run, 0, { ...req.params, seed: 7 });
}

/** Links point at existing nodes and outputs. */
function danglingLinks(wf: Workflow): string[] {
  const out: string[] = [];
  for (const [id, node] of Object.entries(wf))
    for (const [name, v] of Object.entries(node.inputs ?? {}))
      if (Array.isArray(v) && !wf[String(v[0])])
        out.push(`${id}.${name} -> ${v[0]}`);
  return out;
}

describe("multiframe_ref pack graph", () => {
  it("is the official template's node set on our installed weights", () => {
    expect(danglingLinks(MF)).toEqual([]);
    const classes = new Set(Object.values(MF).map((n) => n.class_type));
    for (const c of [
      "MiniMaxH3ReferenceToVideo",
      "MiniMaxH3AddGuide",
      "BasicGuider",
      "SamplerCustomAdvanced",
      "VAEDecodeAudio",
      "CreateVideo",
      "SaveVideo",
    ])
      expect(classes, c).toContain(c);
    // Same files as Reference to Video: no new downloads.
    const files = (wf: Workflow) =>
      Object.values(wf)
        .flatMap((n) =>
          Object.entries(n.inputs ?? {})
            .filter(([k]) => /_name$/.test(k))
            .map(([, v]) => v),
        )
        .sort();
    expect(files(MF)).toEqual(files(R2V));
    expect(byClass(MF, "CLIPLoader")[0][1].inputs.clip_name).toBe(
      "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
    );
  });

  it("chains 3 guides off the R2V latent and feeds the last to the guider", () => {
    const guides = byClass(MF, "MiniMaxH3AddGuide");
    expect(guides).toHaveLength(3);
    expect(guides.map(([, n]) => n.inputs.frame_idx)).toEqual([36, 72, 120]);
    let prev = "5";
    for (const [id, n] of guides) {
      expect(n.inputs.positive).toEqual([prev, 0]);
      expect(n.inputs.latent).toEqual(["5", 1]);
      expect(MF[String((n.inputs.image as unknown[])[0])].class_type).toBe(
        "LoadImage",
      );
      prev = id;
    }
    expect(byClass(MF, "BasicGuider")[0][1].inputs.conditioning).toEqual([
      prev,
      0,
    ]);
    // Keyframe 1 is only <Picture 1> (no guide at frame 0), as in the template.
    expect(MF["5"].inputs["ref_images.ref_image_0"]).toEqual(["15", 0]);
    expect(MF["5"].inputs["ref_images.ref_image_1"]).toBeUndefined();
  });

  it("every input name exists in the node definitions we have", () => {
    const fixtures = [
      "src/__tests__/fixtures/graphLint.objectInfo.json",
      "src/__tests__/fixtures/musicVideoNodes.objectInfo.json",
    ].map((f) =>
      JSON.parse(fs.readFileSync(path.join(process.cwd(), f), "utf-8")),
    );
    const info = Object.assign({}, ...fixtures) as Record<string, any>;
    for (const cls of ["MiniMaxH3ReferenceToVideo", "MiniMaxH3AddGuide"]) {
      const def = info[cls];
      expect(def, cls).toBeTruthy();
      const names = new Set(
        ["required", "optional"].flatMap((s) =>
          Object.keys(def.input?.[s] ?? {}),
        ),
      );
      for (const [, n] of byClass(MF, cls))
        for (const k of Object.keys(n.inputs))
          expect(names.has(k.split(".")[0]), `${cls}.${k}`).toBe(true);
    }
  });
});

describe("multiframe_ref routing and spec", () => {
  it("resolves to its pack and builder (image-in)", () => {
    expect(
      resolveWorkflow({
        templateOrAction: MULTIFRAME_REF_ACTION,
        packId: "minimax",
      }).workflowPath,
    ).toMatch(/packs\/minimax\/multiframe_ref\.json$/);
    expect(actionBuilderFor(MULTIFRAME_REF_ACTION)).toBe(
      buildMultiframeRefWorkflow,
    );
    expect(VIDEO_INPUT_ACTIONS.has(MULTIFRAME_REF_ACTION)).toBe(false);
  });

  it("names MiniMax H3, needs the minimax pack and likeness consent", () => {
    expect(spec).toBeTruthy();
    expect(spec.subtitle).toContain("MiniMax H3");
    expect(spec.requiredPack).toBe("minimax");
    expect(spec.modelCheck).toEqual({
      pack: "minimax",
      action: "multiframe_ref",
    });
    expect(spec.secondImageOptional).toBeFalsy();
    expect(spec.extraImages).toHaveLength(2);
    expect(spec.sliders).toBe(MULTIFRAME_KEY_SLIDERS);
    expect(needsLikenessConsent("action:multiframe_ref")).toBe(true);
  });
});

describe("multiframe_ref client request", () => {
  it("defaults: one shot, even timing, 16:9, 5 s, 768p, Turbo 8-step", () => {
    const req = buildActionRequest(spec, defaultSettings(spec), null, K2);
    expect(req.action).toBe("multiframe_ref");
    expect(req.params).toEqual({
      pack_id: "minimax",
      secondRefImage: K2,
      flow: "continuous",
      timing: "even",
      aspect: "16:9",
      duration: "5",
      resolution: "768",
      h3Speed: "turbo8",
    });
  });

  it("needs keyframe 2", () => {
    expect(() => buildActionRequest(spec, defaultSettings(spec), null)).toThrow(
      ToolInputError,
    );
  });

  it("custom timing sends one position per filled slot", () => {
    const s = defaultSettings(spec);
    const req = buildActionRequest(
      spec,
      {
        ...s,
        picks: {
          ...s.picks,
          timing: "custom",
          keysAsRefs: "refs",
          key2At: "20",
          key3At: "60",
          key4At: "90",
        },
      },
      null,
      K2,
      undefined,
      ["", K4],
    );
    expect(req.params.extraRefImages).toEqual([K4]);
    // Keyframe 3's slot was empty: keyframe 4 keeps its own slider.
    expect(req.params.keyPositions).toEqual([20, 90]);
    expect(req.params.keysAsRefs).toBe(true);
  });
});

describe("multiframeFrames", () => {
  it("even: last keyframe on the final frame", () => {
    expect(multiframeFrames(2, 124)).toEqual([123]);
    expect(multiframeFrames(3, 124)).toEqual([62, 123]);
    expect(multiframeFrames(4, 124)).toEqual([41, 82, 123]);
  });

  it("custom: clamped inside the clip, sorted and distinct", () => {
    expect(multiframeFrames(4, 124, [0, 0, 100])).toEqual([1, 2, 123]);
    expect(multiframeFrames(4, 124, [100, 100, 100])).toEqual([121, 122, 123]);
    expect(multiframeFrames(3, 73, [80, 20])).toEqual([14, 58]);
  });

  it("timestamps at 24 fps", () => {
    expect(multiframeTimestamp(36)).toBe("00:01.500");
    expect(multiframeTimestamp(123)).toBe("00:05.125");
  });
});

describe("buildMultiframeRefWorkflow", () => {
  it("2 keyframes: one guide on the last frame, others pruned", () => {
    const { workflow: wf, slots } = build([K2]);
    expect(danglingLinks(wf)).toEqual([]);
    const guides = byClass(wf, "MiniMaxH3AddGuide");
    expect(guides).toHaveLength(1);
    const [gid, g] = guides[0];
    expect(g.inputs.frame_idx).toBe(123);
    expect(wf[String((g.inputs.image as unknown[])[0])].inputs.image).toBe(K2);
    expect(byClass(wf, "LoadImage")).toHaveLength(2);
    expect(byClass(wf, "BasicGuider")[0][1].inputs.conditioning).toEqual([
      gid,
      0,
    ]);
    const [, r2v] = byClass(wf, "MiniMaxH3ReferenceToVideo")[0];
    expect(r2v.inputs).toMatchObject({ width: 1344, height: 768, length: 124 });
    expect(r2v.inputs["ref_images.ref_image_1"]).toBeUndefined();
    expect(wf[slots.imageInputId as string].inputs.image).toBe(
      "qa/mara.png [input]",
    );
    // Turbo 8-step speed applied at runtime, like Reference to Video.
    expect(
      byClass(wf, "LoraLoaderModelOnly").map(([, n]) => n.inputs.lora_name),
    ).toEqual([H3_TURBO_REF2V_8]);
    expect(byClass(wf, "BasicScheduler")[0][1].inputs.steps).toBe(8);
    expect(byClass(wf, "MiniMaxH3SigmaShift")).toHaveLength(1);
    expect(byClass(wf, "RandomNoise")[0][1].inputs.noise_seed).toBe(7);
    expect(byClass(wf, "SaveVideo")[0][1].inputs.filename_prefix).toBe(
      "video/CJ_H3_Multiframe",
    );
    // Source graph untouched.
    expect(byClass(MF, "MiniMaxH3AddGuide")).toHaveLength(3);
  });

  it("4 keyframes as references: all guides, Pictures 2-4 bound", () => {
    const { workflow: wf } = build(
      [K2, K3, K4],
      { keysAsRefs: "refs", duration: "8", flow: "cuts" },
      "a chase across rooftops",
    );
    expect(danglingLinks(wf)).toEqual([]);
    const guides = byClass(wf, "MiniMaxH3AddGuide");
    expect(guides.map(([, n]) => n.inputs.frame_idx)).toEqual([64, 127, 191]);
    const [, r2v] = byClass(wf, "MiniMaxH3ReferenceToVideo")[0];
    expect(r2v.inputs.length).toBe(MULTIFRAME_LENGTHS["8"]);
    guides.forEach(([, g], i) =>
      expect(r2v.inputs[`ref_images.ref_image_${i + 1}`]).toEqual(
        g.inputs.image,
      ),
    );
    const prompt = String(r2v.inputs.prompt);
    for (const section of [
      "subject_definitions:",
      "summary:",
      "retention_analysis:",
      "detailed_description:",
      "overall_soundscape:",
    ])
      expect(prompt).toContain(section);
    expect(prompt).toContain("<Picture 4> is the first frame of [Shot 4]");
    expect(prompt).toContain("A chase across rooftops.");
  });

  it("768p + custom timing + quality keeps 20 steps", () => {
    const { workflow: wf } = build([K2, K3], {
      resolution: "768",
      timing: "custom",
      key2At: "25",
      key3At: "50",
      h3Speed: "off",
    });
    const [, r2v] = byClass(wf, "MiniMaxH3ReferenceToVideo")[0];
    expect(r2v.inputs).toMatchObject({ width: 1344, height: 768 });
    expect(
      byClass(wf, "MiniMaxH3AddGuide").map(([, n]) => n.inputs.frame_idx),
    ).toEqual([31, 62]);
    expect(byClass(wf, "BasicScheduler")[0][1].inputs.steps).toBe(20);
  });

  it("drops unsafe keyframe refs and needs at least one", () => {
    expect(
      multiframeExtraKeys({
        secondRefImage: "../etc/passwd [input]",
        extraRefImages: ["ok.png [input]", "bad.png", 3],
      }),
    ).toEqual(["ok.png [input]"]);
    expect(() =>
      buildMultiframeRefWorkflow(MF, run, 0, {
        secondRefImage: "../x.png [input]",
      }),
    ).toThrow(/at least 2 keyframes/);
  });

  it("unbound keyframes are not named <Picture k>", () => {
    const p = multiframePrompt({ frames: [41, 82, 123], length: 124 });
    expect(p).not.toMatch(/<Picture [2-4]>/);
    expect(p).toContain("keyframe 4 at 00:05.125");
    expect(p).toContain("One continuous shot.");
  });
});

/**
 * Reference to Video (MiniMax H3 Ref2VA): routing, client defaults (Turbo
 * 8-step, 3 s at 864x480, market scene), reference wiring and the
 * structured Ref2VA prompt.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import {
  REF_VIDEO_ACTION,
  REF_VIDEO_SCENES,
  buildRefVideoWorkflow,
  refVideoExtraRefs,
  refVideoLength,
  refVideoPrompt,
} from "@/lib/oj/h3RefVideo";
import { H3_TURBO_REF2V_4, H3_TURBO_REF2V_8 } from "@/lib/oj/h3Speed";
import { resolveWorkflow } from "@/lib/oj/packs";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
  type ActionToolSpec,
} from "@/lib/tools/toolsPage";
import { needsLikenessConsent } from "@/lib/tools/h3License";
import { FEATURED_KEYS } from "@/lib/tools/hubVisuals";

const R2V: Workflow = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "public/workflows/packs/minimax/r2v.json"),
    "utf-8",
  ),
);
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
const spec = getActionTool("ref_video") as ActionToolSpec;

describe("ref_video routing", () => {
  it("resolves to the r2v pack graph and its own builder (image-in)", () => {
    expect(
      resolveWorkflow({ templateOrAction: REF_VIDEO_ACTION, packId: "minimax" })
        .workflowPath,
    ).toMatch(/packs\/minimax\/r2v\.json$/);
    expect(actionBuilderFor(REF_VIDEO_ACTION)).toBe(buildRefVideoWorkflow);
    expect(VIDEO_INPUT_ACTIONS.has(REF_VIDEO_ACTION)).toBe(false);
  });

  it("r2v uses the int8 ref2va checkpoint GPU hosts install", () => {
    expect(byClass(R2V, "UNETLoader")[0][1].inputs.unet_name).toBe(
      "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    );
  });

  it("spec names MiniMax H3, needs the minimax pack, consent and is featured", () => {
    expect(spec).toBeTruthy();
    expect(spec.subtitle).toContain("MiniMax H3");
    expect(spec.requiredPack).toBe("minimax");
    expect(spec.modelCheck).toEqual({ pack: "minimax", action: "ref_video" });
    expect(spec.secondImageOptional).toBe(true);
    expect(spec.extraImages).toHaveLength(1);
    expect(needsLikenessConsent("action:ref_video")).toBe(true);
    expect(FEATURED_KEYS).toContain("action:ref_video");
  });
});

describe("ref_video client request", () => {
  it("defaults: market scene, 16:9, 3 s, Turbo 8-step", () => {
    const req = buildActionRequest(spec, defaultSettings(spec), null);
    expect(req.action).toBe("ref_video");
    expect(req.params).toMatchObject({
      pack_id: "minimax",
      scene: "market",
      aspect: "16:9",
      duration: "3",
      h3Speed: "turbo8",
    });
    expect(req.params.secondRefImage).toBeUndefined();
    expect(req.params.lastIsSetting).toBeUndefined();
  });

  it("packs references 2..3 and the setting flag", () => {
    const s = defaultSettings(spec);
    s.picks = { ...s.picks, lastRef: "setting", h3Speed: "off" };
    s.text = "they run for the tram";
    const req = buildActionRequest(
      spec,
      s,
      null,
      "pip.png [input]",
      undefined,
      ["market.png [input]"],
    );
    expect(req.params).toMatchObject({
      secondRefImage: "pip.png [input]",
      extraRefImages: ["market.png [input]"],
      lastIsSetting: true,
      h3Speed: "off",
      prompt: "they run for the tram",
    });
    // Third slot filled with the second left empty: still reference 2.
    const gap = buildActionRequest(
      spec,
      defaultSettings(spec),
      null,
      undefined,
      undefined,
      ["market.png [input]"],
    );
    expect(gap.params.secondRefImage).toBe("market.png [input]");
    expect(gap.params.extraRefImages).toBeUndefined();
  });
});

describe("buildRefVideoWorkflow", () => {
  it("default request -> Turbo 8 LoRA, 8 euler steps, 1344x768x73, one ref", () => {
    const req = buildActionRequest(spec, defaultSettings(spec), null);
    const { workflow: wf, slots } = buildRefVideoWorkflow(R2V, run, 0, {
      ...req.params,
      seed: 7,
    });
    const [, r2v] = byClass(wf, "MiniMaxH3ReferenceToVideo")[0];
    expect(r2v.inputs).toMatchObject({ width: 1344, height: 768, length: 73 });
    expect(wf[slots.imageInputId as string].inputs.image).toBe(
      "qa/mara.png [input]",
    );
    expect(r2v.inputs["ref_images.ref_image_1"]).toBeUndefined();
    const loras = byClass(wf, "LoraLoaderModelOnly").map(
      ([, n]) => n.inputs.lora_name,
    );
    expect(loras).toEqual([H3_TURBO_REF2V_8]);
    expect(byClass(wf, "BasicScheduler")[0][1].inputs.steps).toBe(8);
    expect(byClass(wf, "KSamplerSelect")[0][1].inputs.sampler_name).toBe(
      "euler",
    );
    expect(byClass(wf, "MiniMaxH3SigmaShift")).toHaveLength(1);
    expect(byClass(wf, "RandomNoise")[0][1].inputs.noise_seed).toBe(7);
    const prompt = String(r2v.inputs.prompt);
    for (const section of [
      "subject_definitions:",
      "summary:",
      "retention_analysis:",
      "detailed_description:",
      "sound:",
    ])
      expect(prompt).toContain(section);
    expect(prompt).toContain("<Subject 1> is the character from <Picture 1>.");
    expect(prompt).toContain("3.0-second");
    // Source graph untouched.
    expect(R2V["7"].inputs.steps).toBe(20);
  });

  it("wires refs 2..3 as new LoadImage nodes in order", () => {
    const { workflow: wf } = buildRefVideoWorkflow(R2V, run, 0, {
      secondRefImage: "qa/pip.png [input]",
      extraRefImages: ["qa/market.png [input]"],
      lastIsSetting: true,
      aspect: "9:16",
      duration: "5",
      h3Speed: "turbo4",
    });
    const [, r2v] = byClass(wf, "MiniMaxH3ReferenceToVideo")[0];
    const ref = (i: number) => {
      const link = r2v.inputs[`ref_images.ref_image_${i}`] as [string, number];
      return wf[link[0]].inputs.image;
    };
    expect([ref(1), ref(2)]).toEqual([
      "qa/pip.png [input]",
      "qa/market.png [input]",
    ]);
    expect(r2v.inputs).toMatchObject({ width: 480, height: 864, length: 124 });
    expect(byClass(wf, "LoraLoaderModelOnly")[0][1].inputs.lora_name).toBe(
      H3_TURBO_REF2V_4,
    );
    expect(byClass(wf, "BasicScheduler")[0][1].inputs.steps).toBe(4);
    const prompt = String(r2v.inputs.prompt);
    expect(prompt).toContain("<Subject 3> is the setting from <Picture 3>.");
    expect(prompt).toContain(
      "starring <Subject 1> and <Subject 2>, set in <Subject 3>",
    );
  });

  it("768p is the default: native max canvas per aspect; 480p is opt-in", () => {
    const s = defaultSettings(spec);
    // 480p smeared the side edges on portrait refs; 768p renders clean.
    expect(buildActionRequest(spec, s, null).params.resolution).toBe("768");
    s.picks = { ...s.picks, resolution: "480" };
    expect(buildActionRequest(spec, s, null).params.resolution).toBeUndefined();
    s.picks = { ...s.picks, resolution: "768" };
    const req = buildActionRequest(spec, s, null);
    expect(req.params.resolution).toBe("768");
    for (const [aspect, width, height] of [
      ["16:9", 1344, 768],
      ["9:16", 768, 1344],
      ["1:1", 768, 768],
    ] as const) {
      const { workflow: wf } = buildRefVideoWorkflow(R2V, run, 0, {
        ...req.params,
        aspect,
      });
      const [, r2v] = byClass(wf, "MiniMaxH3ReferenceToVideo")[0];
      expect(r2v.inputs).toMatchObject({ width, height, length: 73 });
    }
  });

  it("quality (off) keeps the base 20-step graph", () => {
    const { workflow: wf } = buildRefVideoWorkflow(R2V, run, 0, {
      h3Speed: "off",
    });
    expect(byClass(wf, "LoraLoaderModelOnly")).toHaveLength(0);
    expect(byClass(wf, "BasicScheduler")[0][1].inputs.steps).toBe(20);
  });

  it("drops unsafe or malformed refs and caps at 3 total", () => {
    expect(
      refVideoExtraRefs({
        secondRefImage: "../../etc/passwd [input]",
        extraRefImages: [
          "a.png [input]",
          "b.png",
          "c.png [input]",
          "d.png [input]",
        ],
      }),
    ).toEqual(["a.png [input]", "c.png [input]"]);
  });
});

describe("refVideoPrompt", () => {
  it("custom text replaces the action; every preset has the sound section", () => {
    const p = refVideoPrompt({ refs: 1, scene: "custom", text: "she waves" });
    expect(p).toContain("<Subject 1>. She waves.");
    for (const scene of REF_VIDEO_SCENES)
      expect(refVideoPrompt({ refs: 2, scene: scene.id })).toMatch(
        /\nsound:\n\S/,
      );
  });

  it("setting flag needs at least two references", () => {
    expect(refVideoPrompt({ refs: 1, lastIsSetting: true })).not.toContain(
      "setting from",
    );
  });

  it("maps durations onto the 17k+5 grid", () => {
    expect([
      refVideoLength("2"),
      refVideoLength("3"),
      refVideoLength("5"),
    ]).toEqual([39, 73, 124]);
    expect(refVideoLength("99")).toBe(73);
  });
});

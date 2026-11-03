/**
 * --region regional prompting: parser, family/structure gating, and graph
 * rewrites validated against the recorded ComfyUI 0.42.0 object_info
 * contract fixture (input names, link types, numeric bounds).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  applyRegionalPrompts,
  parseRegionSpec,
  parseRegions,
  regionalSupport,
  REGION_MAX,
  REGION_PRESETS,
} from "@/lib/oj/regionalPrompt";
import { injectParams } from "@/lib/oj/engine";
import { discoverT2ISlots } from "@/lib/oj/discovery";
import { parseImagineInput, formatParams } from "@/lib/oj/parser";
import type { Workflow } from "@/types";

const WF_DIR = path.join(process.cwd(), "public/workflows");
const load = (rel: string): Workflow =>
  JSON.parse(fs.readFileSync(path.join(WF_DIR, rel), "utf8")) as Workflow;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const objectInfo: Record<string, any> = JSON.parse(
  fs.readFileSync(
    path.join(
      process.cwd(),
      "src/__tests__/fixtures/comfy-contract/object_info.json",
    ),
    "utf8",
  ),
);

const sdGraph = () => {
  const wf = load("t2i.json");
  wf["4"].inputs.ckpt_name = "sd_xl_base_1.0.safetensors";
  return wf;
};

const isLink = (v: unknown): v is [string, number] =>
  Array.isArray(v) &&
  v.length === 2 &&
  typeof v[0] === "string" &&
  typeof v[1] === "number";

/**
 * Validate the given nodes against object_info: every required input is
 * present, no unknown inputs, link sources exist and their output type
 * matches the declared input type, numbers sit inside min/max.
 */
function contractErrors(wf: Workflow, ids: string[]): string[] {
  const errs: string[] = [];
  for (const id of ids) {
    const node = wf[id];
    const info = objectInfo[node.class_type];
    if (!info) {
      errs.push(`${id}: ${node.class_type} not in fixture`);
      continue;
    }
    const specs: Record<string, unknown[]> = {
      ...(info.input.required ?? {}),
      ...(info.input.optional ?? {}),
    };
    for (const name of Object.keys(info.input.required ?? {})) {
      if (!(name in node.inputs)) errs.push(`${id}.${name} missing`);
    }
    for (const [name, value] of Object.entries(node.inputs)) {
      const spec = specs[name];
      if (!spec) {
        errs.push(`${id}.${name} unknown input`);
        continue;
      }
      const [type, opts] = spec as [unknown, Record<string, number>?];
      if (isLink(value)) {
        const src = wf[value[0]];
        const out = src && objectInfo[src.class_type]?.output?.[value[1]];
        if (!src) errs.push(`${id}.${name} -> missing node ${value[0]}`);
        else if (out !== undefined && out !== type)
          errs.push(`${id}.${name}: ${String(out)} into ${String(type)}`);
        continue;
      }
      if (type === "FLOAT" || type === "INT") {
        if (typeof value !== "number") errs.push(`${id}.${name} not a number`);
        else if (opts?.min !== undefined && value < opts.min)
          errs.push(`${id}.${name} ${value} < ${opts.min}`);
        else if (opts?.max !== undefined && value > opts.max)
          errs.push(`${id}.${name} ${value} > ${opts.max}`);
        if (type === "INT" && !Number.isInteger(value))
          errs.push(`${id}.${name} not an int`);
      }
      if (type === "STRING" && typeof value !== "string")
        errs.push(`${id}.${name} not a string`);
    }
  }
  return errs;
}

const newIds = (before: Workflow, after: Workflow) =>
  Object.keys(after).filter((id) => !(id in before));

describe("fixture carries the injected core nodes", () => {
  it("ConditioningSetAreaPercentage / ConditioningCombine shapes", () => {
    const area = objectInfo.ConditioningSetAreaPercentage;
    expect(Object.keys(area.input.required).sort()).toEqual(
      ["conditioning", "height", "strength", "width", "x", "y"].sort(),
    );
    expect(area.output).toEqual(["CONDITIONING"]);
    expect(
      Object.keys(objectInfo.ConditioningCombine.input.required).sort(),
    ).toEqual(["conditioning_1", "conditioning_2"]);
    expect(objectInfo.ConditioningCombine.output).toEqual(["CONDITIONING"]);
  });
});

describe("parseRegionSpec", () => {
  it("named presets", () => {
    expect(parseRegionSpec("left a red car")).toEqual({
      x: 0,
      y: 0,
      w: 0.5,
      h: 1,
      prompt: "a red car",
      strength: 1,
    });
    expect(parseRegionSpec("Top-Right a moon")).toMatchObject({
      x: 0.5,
      y: 0,
      w: 0.5,
      h: 0.5,
    });
    expect(parseRegionSpec("right-third a tree")).toMatchObject({
      x: 0.6667,
      w: 0.3333,
    });
    for (const [name, [x, y, w, h]] of Object.entries(REGION_PRESETS)) {
      expect(x + w).toBeLessThanOrEqual(1.0001);
      expect(y + h).toBeLessThanOrEqual(1.0001);
      expect(parseRegionSpec(`${name} p`)).not.toHaveProperty("error");
    }
  });

  it("x,y,w,h fractions and ::strength", () => {
    expect(parseRegionSpec("0.6,0.5,0.4,0.5::1.4 a sailboat")).toEqual({
      x: 0.6,
      y: 0.5,
      w: 0.4,
      h: 0.5,
      prompt: "a sailboat",
      strength: 1.4,
    });
  });

  it("errors", () => {
    expect(parseRegionSpec("middle a cat")).toHaveProperty("error");
    expect(parseRegionSpec("left")).toHaveProperty("error");
    expect(parseRegionSpec("0.6,0.6,0.5,0.5 off canvas")).toHaveProperty(
      "error",
    );
    expect(parseRegionSpec("0,0,0,1 zero width")).toHaveProperty("error");
    expect(parseRegionSpec("left::11 too strong")).toHaveProperty("error");
    expect(parseRegionSpec("left::1::2 x")).toHaveProperty("error");
  });

  it("caps the region count", () => {
    const { regions, errors } = parseRegions(
      Array.from({ length: REGION_MAX + 2 }, () => "left x"),
    );
    expect(regions).toHaveLength(REGION_MAX);
    expect(errors[0]).toMatch(/at most/);
  });
});

describe("prompt parser integration", () => {
  it("--region is a repeatable flag that leaves the base prompt clean", () => {
    const r = parseImagineInput(
      'a quiet harbor --region left a red lighthouse --region top-right::1.4 "a full moon" --ar 16:9',
    );
    expect(r.prompt).toBe("a quiet harbor");
    expect(r.params.region).toEqual([
      "left a red lighthouse",
      "top-right::1.4 a full moon",
    ]);
    expect(r.params.ar).toBe("16:9");
    expect(r.unknownFlags).toEqual([]);
    expect(formatParams({ region: r.params.region })).toBe(
      "--region left a red lighthouse --region top-right::1.4 a full moon",
    );
  });
});

describe("parser validation", () => {
  it("bad --region specs become parse errors", () => {
    const r = parseImagineInput("a cat --region nowhere a hat");
    expect(r.errors.join(" ")).toMatch(/unknown area "nowhere"/);
    expect(parseImagineInput("a cat --region left a hat").errors).toEqual([]);
  });
});

describe("graph rewrite", () => {
  const regionParams = {
    region: ["left a red lighthouse", "0.6,0.5,0.4,0.5::1.4 a sailboat"],
  };

  it("SDXL t2i: encoders -> area -> combine chain into KSampler.positive", () => {
    const wf = sdGraph();
    const before = structuredClone(wf);
    const slots = discoverT2ISlots(wf);
    const res = applyRegionalPrompts(wf, slots, regionParams);
    expect(res).toMatchObject({ applied: 2, family: "sdxl", errors: [] });

    const added = newIds(before, wf);
    expect(added.map((id) => wf[id].class_type)).toEqual([
      "CLIPTextEncode",
      "ConditioningSetAreaPercentage",
      "ConditioningCombine",
      "CLIPTextEncode",
      "ConditioningSetAreaPercentage",
      "ConditioningCombine",
    ]);
    const [enc1, area1, comb1, enc2, area2, comb2] = added;
    expect(wf[enc1].inputs).toEqual({
      clip: before[slots.posTextId].inputs.clip,
      text: "a red lighthouse",
    });
    expect(wf[area1].inputs).toEqual({
      conditioning: [enc1, 0],
      width: 0.5,
      height: 1,
      x: 0,
      y: 0,
      strength: 1,
    });
    expect(wf[area2].inputs).toMatchObject({ x: 0.6, strength: 1.4 });
    expect(wf[comb1].inputs).toEqual({
      conditioning_1: [slots.posTextId, 0],
      conditioning_2: [area1, 0],
    });
    expect(wf[comb2].inputs).toEqual({
      conditioning_1: [comb1, 0],
      conditioning_2: [area2, 0],
    });
    expect(wf[enc2].inputs.text).toBe("a sailboat");
    expect(wf[slots.ksamplerId].inputs.positive).toEqual([comb2, 0]);
    // negative untouched
    expect(wf[slots.ksamplerId].inputs.negative).toEqual(
      before[slots.ksamplerId].inputs.negative,
    );
    expect(
      contractErrors(wf, [...added, slots.posTextId, slots.ksamplerId]),
    ).toEqual([]);
  });

  it("Krea2: combine lands before ConditioningKrea2Rebalance", () => {
    const wf = load("packs/krea2/t2i.json");
    const before = structuredClone(wf);
    const slots = discoverT2ISlots(wf);
    const res = applyRegionalPrompts(wf, slots, regionParams);
    expect(res).toMatchObject({ applied: 2, family: "krea2" });
    const added = newIds(before, wf);
    const lastComb = added[added.length - 1];
    const rebalanceId = Object.keys(wf).find(
      (id) => wf[id].class_type === "ConditioningKrea2Rebalance",
    )!;
    expect(wf[rebalanceId].inputs.conditioning).toEqual([lastComb, 0]);
    expect(wf[slots.ksamplerId].inputs.positive).toEqual(
      before[slots.ksamplerId].inputs.positive,
    );
    expect(contractErrors(wf, [...added, rebalanceId])).toEqual([]);
  });

  // GPU smoke c09b (2026-10-21): percentage areas IndexError on Krea2's 5-D
  // latent inside ComfyUI's area resolver; Krea2 must use rect masks.
  it.each(["packs/krea2/t2i.json", "packs/krea2-raw/t2i.json"])(
    "%s: regions are rect masks, never percentage areas",
    (rel) => {
      const wf = load(rel);
      const before = structuredClone(wf);
      const slots = discoverT2ISlots(wf);
      const res = applyRegionalPrompts(wf, slots, {
        region: ["right a green pear", "0.25,0.5,0.75,0.5::1.5 a vase"],
      });
      expect(res.applied).toBe(2);
      const added = newIds(before, wf);
      const cls = added.map((id) => wf[id].class_type);
      expect(cls).not.toContain("ConditioningSetAreaPercentage");
      expect(cls.filter((c) => c === "SolidMask")).toHaveLength(3);
      expect(cls.filter((c) => c === "ConditioningSetMask")).toHaveLength(2);
      const comps = added.filter((id) => wf[id].class_type === "MaskComposite");
      const [c1, c2] = comps.map((id) => wf[id].inputs);
      // 256 canvas
      expect(c1).toMatchObject({ x: 128, y: 0, operation: "add" });
      expect(c2).toMatchObject({ x: 64, y: 128 });
      // box fills to the canvas edge
      const box2 = wf[(c2.source as [string, number])[0]].inputs;
      expect(box2).toMatchObject({ value: 1, width: 192, height: 128 });
      const sets = added.filter(
        (id) => wf[id].class_type === "ConditioningSetMask",
      );
      expect(wf[sets[1]].inputs).toMatchObject({
        strength: 1.5,
        set_cond_area: "default",
      });
      // feathered: SetMask reads ImageToMask <- ImageBlur <- MaskToImage <- composite
      const m = wf[(wf[sets[1]].inputs.mask as [string, number])[0]];
      expect(m.class_type).toBe("ImageToMask");
      const blur = wf[(m.inputs.image as [string, number])[0]];
      expect(blur).toMatchObject({
        class_type: "ImageBlur",
        inputs: { blur_radius: 31, sigma: 10 },
      });
      // regions drop out after 60% of the schedule
      const ranges = added.filter(
        (id) => wf[id].class_type === "ConditioningSetTimestepRange",
      );
      expect(ranges).toHaveLength(2);
      expect(wf[ranges[0]].inputs).toMatchObject({ start: 0, end: 0.6 });
      expect(contractErrors(wf, added)).toEqual([]);
    },
  );

  it("4-D families keep the cheaper cropped percentage area", () => {
    for (const rel of [
      "packs/flux3/t2i.json",
      "packs/qwen-image-21/t2i.json",
    ]) {
      const wf = load(rel);
      const before = structuredClone(wf);
      applyRegionalPrompts(wf, discoverT2ISlots(wf), regionParams);
      const cls = newIds(before, wf).map((id) => wf[id].class_type);
      expect(cls).toContain("ConditioningSetAreaPercentage");
      expect(cls).not.toContain("ConditioningSetMask");
    }
  });

  it.each([
    ["packs/flux3/t2i.json", "flux3"],
    ["packs/qwen-image-21/t2i.json", "qwen-image-21"],
    ["packs/krea2-raw/t2i.json", "krea2-raw"],
    ["i2i.json", "sdxl"],
  ])("%s is supported (%s)", (rel, family) => {
    const wf = load(rel);
    const before = structuredClone(wf);
    const slots = discoverT2ISlots(wf);
    const res = applyRegionalPrompts(wf, slots, regionParams);
    expect(res).toMatchObject({ applied: 2, family });
    expect(contractErrors(wf, newIds(before, wf))).toEqual([]);
  });

  it.each([
    "packs/ltxv/t2v.json",
    "packs/wan/t2v.json",
    "packs/moss-image/t2i.json",
    "packs/krea2/control_regions.json",
    "packs/krea2/control_depth.json",
    "packs/flux3/edit.json",
    "packs/qwen-image-21/edit.json",
    "packs/krea2-edit/edit_inpaint.json",
    "controlnet.json",
    "zimageturbo.json",
  ])("%s is left untouched", (rel) => {
    const wf = load(rel);
    const before = structuredClone(wf);
    const slots = discoverT2ISlots(wf);
    const res = applyRegionalPrompts(wf, slots, regionParams);
    expect(res.applied).toBe(0);
    expect(res.skipped).toBeTruthy();
    expect(wf).toEqual(before);
  });

  it("--controlnet disables regions (hint would be squashed per box)", () => {
    const wf = sdGraph();
    const before = structuredClone(wf);
    const res = applyRegionalPrompts(wf, discoverT2ISlots(wf), {
      ...regionParams,
      controlnet: "canny",
    });
    expect(res.skipped).toMatch(/controlnet/);
    expect(wf).toEqual(before);
  });

  it("parse errors are reported and valid regions still apply", () => {
    const wf = sdGraph();
    const res = applyRegionalPrompts(wf, discoverT2ISlots(wf), {
      region: ["nowhere a cat", "right a dog"],
    });
    expect(res.applied).toBe(1);
    expect(res.errors).toHaveLength(1);
  });

  it("regionalSupport reports the reason", () => {
    const wf = load("packs/moss-image/t2i.json");
    const s = regionalSupport(wf, discoverT2ISlots(wf));
    expect(s.ok).toBe(false);
  });
});

describe("injectParams end to end", () => {
  it("SDXL: prompt text, regions and clip skip compose", () => {
    const wf = sdGraph();
    const slots = discoverT2ISlots(wf);
    const { prompt, params } = parseImagineInput(
      "a harbor --region left a lighthouse --region right a boat --clipskip 2 --ar 16:9",
    );
    injectParams(wf, slots, params, prompt, "blurry", 7);
    expect(wf[slots.posTextId].inputs.text).toBe("a harbor");
    const encoders = Object.entries(wf).filter(
      ([, n]) => n.class_type === "CLIPTextEncode",
    );
    // base + negative + 2 regions, all routed through the clip-skip node
    expect(encoders).toHaveLength(4);
    for (const [, n] of encoders) {
      expect(wf[(n.inputs.clip as [string, number])[0]].class_type).toBe(
        "CLIPSetLastLayer",
      );
    }
    const pos = wf[slots.ksamplerId].inputs.positive as [string, number];
    expect(wf[pos[0]].class_type).toBe("ConditioningCombine");
    expect(
      contractErrors(wf, Object.keys(wf)).filter(
        (e) => !/ckpt_name|CLIPSetLastLayer not in fixture/.test(e),
      ),
    ).toEqual([]);
  });

  it("no --region leaves the graph shape unchanged", () => {
    const wf = sdGraph();
    const slots = discoverT2ISlots(wf);
    injectParams(wf, slots, {}, "a cat", "", 1);
    expect(
      Object.values(wf).some((n) => n.class_type === "ConditioningCombine"),
    ).toBe(false);
  });
});

/**
 * Ingredients (src/lib/oj/ltxIngredients.ts, packs/ltx25/vfx_ingredients.json):
 * LTX-2.5 IC-LoRA Ingredients 0.9. The pack is checked against the LTX
 * object_info snapshot, the builder against the model card (black-panel
 * reference sheet, 768x448, 121 frames, strength 1.4, two-part prompt).
 */
import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { COMFY_HTTP_URL: "http://mac:8188", COMFY_ROOT: "/nonexistent" },
}));

import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import ltxNodes from "./fixtures/ltxVfxNodes.objectInfo.json";
import { validatePrompt } from "@/lib/comfy/validatePrompt";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  LTX_INGREDIENTS_ACTION,
  ltxIngredientRefs,
  ltxIngredientsPrompt,
  ltxIngredientsStrength,
} from "@/lib/oj/ltxIngredients";
import { LTX_BUILTIN_IC_LORA_FILES } from "@/lib/oj/ltxCommunityLoras";
import {
  buildActionRequest,
  buildToolCards,
  defaultSettings,
  getActionTool,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import { toHubCard } from "@/lib/tools/hub";
import { isNewCard } from "@/lib/tools/hubVisuals";
import weightClasses from "@/lib/tools/toolWeightClasses.json";

const reg = registry as unknown as {
  templates: Record<string, { file: string }>;
  actions: Record<string, { template: string; requiresImage?: boolean }>;
};
const file = reg.templates[reg.actions[LTX_INGREDIENTS_ACTION].template].file;
const raw = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "public/workflows", file), "utf8"),
) as Record<string, unknown>;
const pack = Object.fromEntries(
  Object.entries(raw).filter(([k]) => !k.startsWith("_")),
) as Workflow;

const INFO = ltxNodes as unknown as Record<
  string,
  {
    input: {
      required?: Record<string, unknown>;
      optional?: Record<string, unknown>;
    };
  }
>;
function problems(wf: Workflow): string[] {
  const out = validatePrompt(wf, INFO).map(
    (p) => `${p.nodeId} ${p.kind}: ${p.message}`,
  );
  for (const [id, node] of Object.entries(wf)) {
    const info = INFO[node.class_type];
    if (!info) continue;
    const declared = { ...info.input.required, ...info.input.optional };
    for (const key of Object.keys(node.inputs))
      if (!(key in declared)) out.push(`${id}.${key}: undeclared input`);
  }
  return out;
}

const byClass = (wf: Workflow, cls: string) =>
  Object.keys(wf).filter((id) => wf[id].class_type === cls);
const one = (wf: Workflow, cls: string) => {
  const ids = byClass(wf, cls);
  expect(ids).toHaveLength(1);
  return wf[ids[0]].inputs;
};
const src = (wf: Workflow, id: string, input: string) =>
  String((wf[id].inputs[input] as unknown[])[0]);

const photoRun = (over: Partial<ImagineRun> = {}): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "",
    parsedPrompt: "",
    width: 1024,
    height: 1024,
    createdAt: "2026-10-31T00:00:00Z",
    status: "done",
    params: {},
    jobs: [
      {
        seed: 0,
        index: 0,
        status: "done",
        progress: 100,
        images: [
          "http://127.0.0.1:8188/view?filename=hero.png&subfolder=&type=output",
        ],
      },
    ],
    ...over,
  }) as unknown as ImagineRun;

const build = (params: Record<string, unknown>, run = photoRun()) =>
  actionBuilderFor(LTX_INGREDIENTS_ACTION)!(structuredClone(pack), run, 0, {
    seed: 5,
    prompt: "she plays the guitar on the rooftop",
    ...params,
  });

/** The image feeding ResizeAndPadImage. */
const sheetNode = (wf: Workflow) =>
  src(wf, byClass(wf, "ResizeAndPadImage")[0], "image");

describe("Ingredients pack", () => {
  it("is registered as an image-in LTX VFX pack and validates", () => {
    expect(file).toBe("packs/ltx25/vfx_ingredients.json");
    expect(reg.actions[LTX_INGREDIENTS_ACTION].requiresImage).toBe(true);
    expect(VIDEO_INPUT_ACTIONS.has(LTX_INGREDIENTS_ACTION)).toBe(false);
    const meta = raw._meta as { title: string; description: string };
    expect(meta.title).toMatch(/^LTX VFX/);
    expect(meta.description).toMatch(/LTX-2 Community License/);
    expect(problems(pack)).toEqual([]);
    expect(one(pack, "UNETLoader").unet_name).toMatch(
      /^ltx-2\.5-22b-distilled/,
    );
    expect(one(pack, "LoraLoaderModelOnly")).toMatchObject({
      lora_name: "ltx25/ltx-2.5-22b-ic-lora-ingredients-0.9.safetensors",
      strength_model: 1.4,
    });
    expect(LTX_BUILTIN_IC_LORA_FILES).toContain(
      "ltx25/ltx-2.5-22b-ic-lora-ingredients-0.9.safetensors",
    );
    expect(one(pack, "ResizeAndPadImage").padding_color).toBe("black");
    for (const id of byClass(pack, "ImageStitch"))
      expect(pack[id].inputs.spacing_color).toBe("black");
    expect(one(pack, "LTXVAddGuide")).toMatchObject({
      frame_idx: 0,
      strength: 1,
    });
    expect(byClass(pack, "LTXVCropGuides")).toHaveLength(1);
  });
});

describe("Ingredients builder", () => {
  it("one image is the sheet; card size, frames and strength", () => {
    const { workflow, slots, seed } = build({});
    expect(seed).toBe(5);
    expect(problems(workflow)).toEqual([]);
    expect(byClass(workflow, "ImageStitch")).toEqual([]);
    expect(one(workflow, "LoadImage").image).toBe("hero.png [output]");
    expect(slots.imageInputId).toBe(byClass(workflow, "LoadImage")[0]);
    expect(workflow[sheetNode(workflow)].class_type).toBe("LoadImage");
    expect(one(workflow, "ResizeAndPadImage")).toMatchObject({
      target_width: 768,
      target_height: 448,
    });
    expect(one(workflow, "RepeatImageBatch").amount).toBe(121);
    expect(one(workflow, "EmptyLTXVLatentVideo")).toMatchObject({
      width: 768,
      height: 448,
      length: 121,
    });
    expect(one(workflow, "LTXVEmptyLatentAudio").frames_number).toBe(121);
    expect(one(workflow, "LTXVConditioning").frame_rate).toBe(24);
    expect(one(workflow, "LoraLoaderModelOnly").strength_model).toBe(1.4);
    const guide = byClass(workflow, "LTXVAddGuide")[0];
    expect(workflow[src(workflow, guide, "image")].class_type).toBe(
      "RepeatImageBatch",
    );
    expect(workflow[slots.posTextId].inputs.text).toBe(
      "Reference sheet: the characters, objects and location shown in the panels on the black background.\n\nGenerated video: she plays the guitar on the rooftop.",
    );
    expect(one(workflow, "CreateVideo").audio).toBeDefined();
  });

  it("stitches 2, 3 and 4 ingredients on black", () => {
    const two = build({ secondRefImage: "guitar.png [input]" }).workflow;
    expect(problems(two)).toEqual([]);
    expect(byClass(two, "LoadImage")).toHaveLength(2);
    expect(two[sheetNode(two)]._meta?.title).toBe("Sheet: 1 + 2");
    expect(byClass(two, "ImageStitch")).toHaveLength(1);

    const three = build({
      secondRefImage: "guitar.png [input]",
      extraRefImages: ["roof.png [input]"],
    }).workflow;
    expect(problems(three)).toEqual([]);
    const s3 = sheetNode(three);
    expect(three[s3]._meta?.title).toBe("Sheet: 1 + 2 + 3");
    expect(three[s3].inputs.direction).toBe("right");
    expect(three[src(three, s3, "image2")].inputs.image).toBe(
      "roof.png [input]",
    );

    const four = build({
      secondRefImage: "guitar.png [input]",
      extraRefImages: ["roof.png [input]", "dog.png [input]", "x.png [input]"],
    }).workflow;
    expect(problems(four)).toEqual([]);
    const s4 = sheetNode(four);
    expect(four[s4]._meta?.title).toBe("Sheet: 2x2");
    expect(four[s4].inputs.direction).toBe("down");
    expect(byClass(four, "ImageStitch")).toHaveLength(3);
    expect(
      byClass(four, "LoadImage").map((id) => four[id].inputs.image),
    ).toEqual([
      "hero.png [output]",
      "guitar.png [input]",
      "roof.png [input]",
      "dog.png [input]",
    ]);
  });

  it("stacks a 2-3 panel sheet vertically for a portrait shot", () => {
    const tall = photoRun({ width: 720, height: 1280 });
    const three = build(
      {
        secondRefImage: "guitar.png [input]",
        extraRefImages: ["roof.png [input]"],
      },
      tall,
    ).workflow;
    expect(problems(three)).toEqual([]);
    for (const id of byClass(three, "ImageStitch")) {
      expect(three[id].inputs.direction).toBe("down");
    }
    const four = build(
      {
        secondRefImage: "guitar.png [input]",
        extraRefImages: ["roof.png [input]", "dog.png [input]"],
      },
      tall,
    ).workflow;
    expect(
      byClass(four, "ImageStitch").map((id) => four[id].inputs.direction),
    ).toEqual(["right", "right", "down"]);
  });

  it("refs, prompt, strength and orientation helpers", () => {
    expect(
      ltxIngredientRefs({
        secondRefImage: "../a.png",
        extraRefImages: ["b.png [input]", 3, "c.png [input]"],
      }),
    ).toEqual(["b.png [input]", "c.png [input]"]);
    expect(ltxIngredientsPrompt("A dog runs.", "Panel 1: a corgi.")).toBe(
      "Reference sheet: Panel 1: a corgi.\n\nGenerated video: A dog runs.",
    );
    const full = "Reference sheet: a corgi.\n\nGenerated video: it runs.";
    expect(ltxIngredientsPrompt(full)).toBe(full);
    expect(ltxIngredientsStrength(undefined)).toBe(1.4);
    expect(ltxIngredientsStrength("1.6")).toBe(1.6);
    expect(ltxIngredientsStrength(9)).toBe(2);

    const portrait = build({}, photoRun({ width: 720, height: 1280 })).workflow;
    expect(one(portrait, "EmptyLTXVLatentVideo")).toMatchObject({
      width: 448,
      height: 768,
    });
    expect(() => build({ prompt: "" })).toThrow(/prompt is required/);
    expect(() =>
      build({}, photoRun({ jobs: [] } as Partial<ImagineRun>)),
    ).toThrow(/no image/);
  });
});

describe("Ingredients tool page", () => {
  const spec = getActionTool(LTX_INGREDIENTS_ACTION)!;
  const settings = (over: Partial<ToolSettings> = {}): ToolSettings => ({
    ...defaultSettings(spec),
    ...over,
  });

  it("spec: LTX VFX, up to four images, sheet text, model check", () => {
    expect(spec.category).toBe("LTX VFX");
    expect(spec.subtitle).toMatch(/^LTX VFX: /);
    expect(spec.videoInput).toBeUndefined();
    expect(spec.secondImageOptional).toBe(true);
    expect(spec.extraImages).toHaveLength(2);
    expect(spec.modelCheck).toEqual({
      pack: "ltx25",
      action: LTX_INGREDIENTS_ACTION,
    });
  });

  it("request packs every uploaded ingredient in order", () => {
    const req = buildActionRequest(
      spec,
      settings({
        text: "she plays",
        secondText: "Panel 1: a woman.",
        picks: { strength: "1.6" },
        seed: 2,
      }),
      null,
      undefined,
      undefined,
      [undefined as unknown as string, "roof.png [input]"],
    );
    expect(req).toMatchObject({
      action: LTX_INGREDIENTS_ACTION,
      params: {
        prompt: "she plays",
        sheet: "Panel 1: a woman.",
        secondRefImage: "roof.png [input]",
        strength: 1.6,
        seed: 2,
      },
    });
    expect(req.params.extraRefImages).toBeUndefined();
    const bare = buildActionRequest(spec, settings({ text: "x" }), null);
    expect(bare.params).toMatchObject({ prompt: "x", strength: 1.4 });
    expect(() => buildActionRequest(spec, settings(), null)).toThrow();
  });

  it("hub card: VFX, LTX-2.5, new, LTX licence", () => {
    const cards = buildToolCards({
      catalog: [],
      packIds: null,
      editLoras: null,
      modelStatus: {
        tools: {
          [LTX_INGREDIENTS_ACTION]: { missing: [] },
          ltx_layout_render: { missing: [] },
        },
      },
    }).filter((c) =>
      [LTX_INGREDIENTS_ACTION, "ltx_layout_render"].includes(c.id),
    );
    expect(cards).toHaveLength(2);
    const { classes, sources } = weightClasses as unknown as {
      classes: Record<string, string>;
      sources: Record<string, { license: string }[]>;
    };
    for (const card of cards) {
      const hub = toHubCard(card, null);
      expect(hub.hubCategory).toBe("VFX");
      expect(hub.model).toMatch(/^LTX-2\.5 IC-LoRA /);
      expect(hub.nc).toBe(false);
      expect(isNewCard(hub)).toBe(true);
      const key = `action:${card.id}`;
      expect(classes[key]).toBe("cap");
      expect(sources[key].map((l) => l.license)).toContain(
        "LTX-2 Community License",
      );
    }
  });
});

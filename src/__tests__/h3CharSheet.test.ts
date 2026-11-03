/**
 * H3 Character Sheet: the view/layout/prompt compiler, the pack graph
 * (r2v without audio, 5 frames, frame 0 saved), routing, the client
 * request and the builder.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import {
  CHAR_SHEET_ACTION,
  CHAR_SHEET_DEFAULT_VIEWS,
  CHAR_SHEET_FRAMES,
  CHAR_SHEET_MIN_CELL,
  CHAR_SHEET_SIZES,
  CHAR_SHEET_VIEWS,
  buildCharSheetWorkflow,
  charSheetExtraRefs,
  charSheetLayout,
  charSheetPrompt,
  charSheetSize,
  parseCharSheetViews,
  type CharSheetLayout,
} from "@/lib/oj/h3CharSheet";
import { H3_TURBO_REF2V_4, H3_TURBO_REF2V_8 } from "@/lib/oj/h3Speed";
import { resolveWorkflow } from "@/lib/oj/packs";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  ToolInputError,
  buildActionRequest,
  defaultSettings,
  getActionTool,
  type ActionToolSpec,
} from "@/lib/tools/toolsPage";
import { needsLikenessConsent } from "@/lib/tools/h3License";
import { engineGroupOf } from "@/lib/tools/engineGroups";
import { renderToolsDoc } from "@/lib/tools/toolsDoc";

const ROOT = process.cwd();
const PACK_FILE = path.join(
  ROOT,
  "public/workflows/packs/minimax/charsheet.json",
);
const CS = JSON.parse(fs.readFileSync(PACK_FILE, "utf-8")) as Workflow;
const R2V = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, "public/workflows/packs/minimax/r2v.json"),
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
const noImageRun = {
  ...run,
  jobs: [{ seed: 0, index: 0, status: "done", progress: 100, images: [] }],
} as unknown as ImagineRun;

const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(([, n]) => n.class_type === cls);
const spec = getActionTool("h3_charsheet") as ActionToolSpec;
const R2 = "qa/outfit.png [input]";
const R3 = "qa/props.png [input]";
const ALL = CHAR_SHEET_VIEWS.map((v) => v.id);

function request(
  opts: {
    picks?: Record<string, string>;
    text?: string;
    name?: string;
    second?: string;
    extra?: string[];
  } = {},
) {
  const base = defaultSettings(spec);
  return buildActionRequest(
    spec,
    {
      ...base,
      text: opts.text ?? "",
      secondText: opts.name,
      picks: { ...base.picks, ...opts.picks },
    },
    null,
    opts.second,
    undefined,
    opts.extra,
  );
}

function danglingLinks(wf: Workflow): string[] {
  const out: string[] = [];
  for (const [id, node] of Object.entries(wf))
    for (const [name, v] of Object.entries(node.inputs ?? {}))
      if (Array.isArray(v) && !wf[String(v[0])])
        out.push(`${id}.${name} -> ${v[0]}`);
  return out;
}

const cellCount = (l: CharSheetLayout) =>
  l.rows.reduce((n, r) => n + r.cells.length, 0);

/** Rows tile the height and cells tile each row, all on the 32-px grid. */
function expectTiles(l: CharSheetLayout) {
  let y = 0;
  for (const row of l.rows) {
    expect(row.y).toBe(y);
    expect(row.h % 32).toBe(0);
    expect(row.h).toBeGreaterThanOrEqual(32);
    let x = 0;
    for (const c of row.cells) {
      expect(c.x).toBe(x);
      expect(c.y).toBe(row.y);
      expect(c.h).toBe(row.h);
      expect(c.w % 32).toBe(0);
      expect(c.w).toBeGreaterThanOrEqual(32);
      x += c.w;
    }
    expect(x).toBe(l.width);
    y += row.h;
  }
  expect(y).toBe(l.height);
}

describe("view catalog", () => {
  it("has 13 views: head x6, body x3, outfit front/back, hands, feet", () => {
    const by = (g: string) =>
      CHAR_SHEET_VIEWS.filter((v) => v.group === g).map((v) => v.id);
    expect(by("head")).toHaveLength(6);
    expect(by("body")).toEqual(["body_front", "body_side", "body_back"]);
    expect(by("outfit")).toEqual(["outfit_front", "outfit_back"]);
    expect(by("details")).toEqual(["hands", "feet"]);
    expect(new Set(ALL).size).toBe(13);
  });

  it("profile views name the nose direction on screen", () => {
    const pose = (id: string) =>
      CHAR_SHEET_VIEWS.find((v) => v.id === id)!.pose;
    expect(pose("head_profile_right")).toContain("nose points to screen RIGHT");
    expect(pose("head_profile_left")).toContain("nose points to screen LEFT");
    expect(pose("head_34_right")).toContain("screen RIGHT");
    expect(pose("head_34_left")).toContain("screen LEFT");
  });

  it("parses CSV or arrays: known ids, deduped, catalog order", () => {
    expect(parseCharSheetViews("feet, head_front,bogus,head_front")).toEqual([
      "head_front",
      "feet",
    ]);
    expect(parseCharSheetViews(["body_back", "body_front", 3, null])).toEqual([
      "body_front",
      "body_back",
    ]);
    expect(parseCharSheetViews("")).toEqual([]);
    expect(parseCharSheetViews(undefined)).toEqual([]);
    expect(parseCharSheetViews({})).toEqual([]);
    expect(parseCharSheetViews(CHAR_SHEET_DEFAULT_VIEWS)).toEqual(
      CHAR_SHEET_DEFAULT_VIEWS,
    );
  });

  it("sizes are on the 32-px grid; all but Large within 1344x768 px", () => {
    for (const s of CHAR_SHEET_SIZES) {
      expect(s.width % 32, s.id).toBe(0);
      expect(s.height % 32, s.id).toBe(0);
      if (s.id !== "large")
        expect(s.width * s.height, s.id).toBeLessThanOrEqual(1_032_192);
    }
    expect(charSheetSize("large")).toMatchObject({ width: 2816, height: 1280 });
    expect(charSheetSize("nope")).toMatchObject({ width: 1344, height: 768 });
  });
});

describe("charSheetLayout", () => {
  it("default views: heads row on top, taller figure row below", () => {
    const l = charSheetLayout(CHAR_SHEET_DEFAULT_VIEWS, 1344, 768);
    expect(l.rows.map((r) => r.band)).toEqual(["head", "figure"]);
    expect(l.rows[0].cells.map((c) => c.view)).toEqual([
      "head_front",
      "head_34_right",
      "head_profile_right",
    ]);
    expect(l.rows[1].h).toBeGreaterThan(l.rows[0].h);
    expectTiles(l);
  });

  it("every view on every size tiles the canvas and keeps each view once", () => {
    for (const s of CHAR_SHEET_SIZES) {
      const l = charSheetLayout(ALL, s.width, s.height);
      expectTiles(l);
      expect(cellCount(l), s.id).toBe(13);
      expect(
        new Set(l.rows.flatMap((r) => r.cells.map((c) => c.view))).size,
      ).toBe(13);
    }
  });

  it("wraps a band onto more rows when panels would be too narrow", () => {
    const l = charSheetLayout(ALL, 768, 1344);
    const perRow = Math.floor(768 / CHAR_SHEET_MIN_CELL);
    for (const r of l.rows) expect(r.cells.length).toBeLessThanOrEqual(perRow);
    // 6 heads at 4 per row split evenly into 3 + 3, not 4 + 2.
    expect(
      l.rows.filter((r) => r.band === "head").map((r) => r.cells.length),
    ).toEqual([3, 3]);
    const wide = charSheetLayout(ALL, 2816, 1280);
    expect(wide.rows.map((r) => r.band)).toEqual(["head", "figure", "details"]);
  });

  it("one view fills the canvas; no views give no rows", () => {
    const one = charSheetLayout(["hands"], 992, 992);
    expect(one.rows).toHaveLength(1);
    expect(one.rows[0].cells[0]).toEqual({
      view: "hands",
      x: 0,
      y: 0,
      w: 992,
      h: 992,
    });
    expect(charSheetLayout([], 1344, 768).rows).toEqual([]);
  });
});

describe("charSheetPrompt", () => {
  const layout = charSheetLayout(CHAR_SHEET_DEFAULT_VIEWS, 1344, 768);

  it("Ref2VA sections, explicit panel count, still-image line", () => {
    const p = charSheetPrompt({ layout, refCount: 1 });
    const sections = p.split("\n").filter((l) => /^[a-z_]+:$/.test(l));
    expect(sections).toEqual([
      "subject_definitions:",
      "summary:",
      "retention_analysis:",
      "detailed_description:",
      "overall_soundscape:",
    ]);
    expect(p).toContain("exactly 6 panels in 2 rows");
    expect(p).toContain("no motion, no camera movement");
    expect(p).toContain("<Subject 1> is the character in <Picture 1>.");
    expect(p).toContain(
      "Top row, 3 panels from left to right: (1) head and shoulders, facing the viewer",
    );
    expect(p).toContain("Second row, 3 panels");
    expect(p).toContain("nose points to screen RIGHT");
    expect(p).toMatch(/Gloves and footwear: keep them exactly/);
    expect(p).toMatch(/do not add, remove or swap clothing/);
    expect(p).toMatch(/No text, labels, captions/);
    expect(p.trimEnd().endsWith("overall_soundscape:\nSilence.")).toBe(true);
    expect(p).not.toContain("<Picture 2>");
    expect(p).not.toContain("Rendering technique");
  });

  it("names, describes and styles the character", () => {
    const p = charSheetPrompt({
      layout,
      refCount: 1,
      name: "  Mara  ",
      description: "wiry courier   in a red jacket",
      render: "anime",
    });
    expect(p).toContain("named Mara");
    expect(p).toContain("Mara (<Subject 1>)");
    expect(p).toContain("Wiry courier in a red jacket.");
    expect(p).toMatch(/Rendering technique: clean anime model-sheet style/);
    expect(
      charSheetPrompt({ layout, refCount: 1, render: "bogus" }),
    ).not.toContain("Rendering technique");
  });

  it("references 2-3 get their roles as <Picture k>", () => {
    const p = charSheetPrompt({
      layout,
      refCount: 3,
      refRoles: ["outfit", "props"],
    });
    expect(p).toContain("<Picture 2> shows the same <Subject 1>: the outfit");
    expect(p).toContain(
      "<Picture 3> shows the same <Subject 1>: props and small details",
    );
    expect(p).toMatch(/<Picture 3>: fully_preserved/);
    // Unknown role falls back to the default (outfit).
    expect(charSheetPrompt({ layout, refCount: 2, refRoles: ["x"] })).toContain(
      "<Picture 2> shows the same <Subject 1>: the outfit",
    );
  });

  it("clamps the reference count to 1-3 (reference 1 is always wired)", () => {
    const many = charSheetPrompt({ layout, refCount: 9 });
    expect(many).toContain("<Picture 3>");
    expect(many).not.toContain("<Picture 4>");
    const none = charSheetPrompt({ layout, refCount: 0, name: "Mara" });
    expect(none).toContain("<Subject 1> is the character in <Picture 1>, named Mara.");
    expect(none).not.toContain("<Picture 2>");
  });

  it("singular wording for one panel; throws on zero views", () => {
    const p = charSheetPrompt({
      layout: charSheetLayout(["feet"], 992, 992),
      refCount: 1,
    });
    expect(p).toContain("exactly 1 panel in 1 row ");
    expect(p).toContain(
      "One row, 1 panel from left to right: (1) close-up of both feet",
    );
    expect(() =>
      charSheetPrompt({ layout: charSheetLayout([], 992, 992), refCount: 1 }),
    ).toThrow(/at least one view/);
  });

  it("stays bounded with every view and long text", () => {
    const p = charSheetPrompt({
      layout: charSheetLayout(ALL, 2816, 1280),
      refCount: 3,
      description: "x ".repeat(5000),
      name: "n".repeat(500),
    });
    expect(p.length).toBeLessThanOrEqual(6000);
    expect(p).toContain("exactly 13 panels in 3 rows");
    expect(p).toContain("overall_soundscape:\nSilence.");
  });
});

describe("charSheetExtraRefs", () => {
  it("keeps roles aligned when slots are empty or unsafe", () => {
    expect(
      charSheetExtraRefs({
        secondRefImage: "",
        extraRefImages: [R3],
        refRoles: ["face", "props"],
      }),
    ).toEqual([{ ref: R3, role: "props" }]);
    expect(
      charSheetExtraRefs({
        secondRefImage: "../etc/passwd [input]",
        extraRefImages: ["plain.png", R2, R3],
      }),
    ).toEqual([
      { ref: R2, role: "outfit" },
      { ref: R3, role: "outfit" },
    ]);
    expect(charSheetExtraRefs({})).toEqual([]);
  });
});

describe("h3_charsheet pack graph", () => {
  it("is r2v on the same weights, minus audio, 5 frames, frame 0 saved", () => {
    expect(danglingLinks(CS)).toEqual([]);
    const files = (wf: Workflow) =>
      Object.values(wf)
        .flatMap((n) =>
          Object.entries(n.inputs ?? {})
            .filter(([k]) => /_name$/.test(k))
            .map(([, v]) => String(v))
            .filter((v) => v.endsWith(".safetensors")),
        )
        .sort();
    const r2vFiles = files(R2V).filter((f) => !/audio/i.test(String(f)));
    expect(files(CS)).toEqual(r2vFiles);
    const classes = Object.values(CS).map((n) => n.class_type);
    for (const c of ["VAEDecodeAudio", "CreateVideo", "SaveVideo"])
      expect(classes).not.toContain(c);
    const [, r2v] = byClass(CS, "MiniMaxH3ReferenceToVideo")[0];
    expect(r2v.inputs.length).toBe(CHAR_SHEET_FRAMES);
    expect(r2v.inputs.audio_vae).toBeUndefined();
    const [, pick] = byClass(CS, "ImageFromBatch")[0];
    expect(pick.inputs).toMatchObject({ batch_index: 0, length: 1 });
    const [, save] = byClass(CS, "SaveImage")[0];
    expect(CS[String((save.inputs.images as unknown[])[0])].class_type).toBe(
      "ImageFromBatch",
    );
  });

  it("every input name exists in the node definitions we have", () => {
    const info = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "src/__tests__/fixtures/graphLint.objectInfo.json"),
        "utf-8",
      ),
    ) as Record<string, any>;
    for (const [id, n] of Object.entries(CS)) {
      const def = info[n.class_type];
      if (!def) continue;
      const names = new Set(
        ["required", "optional"].flatMap((s) =>
          Object.keys(def.input?.[s] ?? {}),
        ),
      );
      for (const k of Object.keys(n.inputs))
        expect(names.has(k.split(".")[0]), `${id} ${n.class_type}.${k}`).toBe(
          true,
        );
    }
  });

  const OI = process.env.LIVE_OBJECT_INFO;
  it.skipIf(!OI || !fs.existsSync(OI))(
    "every node class (base and built) exists in the live object_info",
    () => {
      const info = JSON.parse(fs.readFileSync(OI!, "utf-8")) as Record<
        string,
        any
      >;
      const built = buildCharSheetWorkflow(CS, run, 0, {
        ...request({ second: R2, extra: [R3], picks: { views: ALL.join(",") } })
          .params,
        seed: 1,
      }).workflow;
      for (const wf of [CS, built])
        for (const [id, n] of Object.entries(wf)) {
          expect(info[n.class_type], `${id} ${n.class_type}`).toBeTruthy();
          const def = info[n.class_type];
          const names = new Set(
            ["required", "optional"].flatMap((s) =>
              Object.keys(def.input?.[s] ?? {}),
            ),
          );
          for (const k of Object.keys(n.inputs))
            expect(
              names.has(k.split(".")[0]),
              `${id} ${n.class_type}.${k}`,
            ).toBe(true);
        }
      // 5 is on MiniMaxH3ReferenceToVideo's 17k+5 length grid.
      const len = info.MiniMaxH3ReferenceToVideo.input.required.length[1];
      expect((CHAR_SHEET_FRAMES - len.min) % len.step).toBe(0);
    },
  );
});

describe("h3_charsheet routing and spec", () => {
  it("resolves to its pack and builder (image-in)", () => {
    expect(
      resolveWorkflow({
        templateOrAction: CHAR_SHEET_ACTION,
        packId: "minimax",
      }).workflowPath,
    ).toMatch(/packs\/minimax\/charsheet\.json$/);
    expect(actionBuilderFor(CHAR_SHEET_ACTION)).toBe(buildCharSheetWorkflow);
    expect(VIDEO_INPUT_ACTIONS.has(CHAR_SHEET_ACTION)).toBe(false);
  });

  it("is an H3 image tool with likeness consent, credit and an engine group", () => {
    expect(spec.requiredPack).toBe("minimax");
    expect(spec.subtitle).toContain("MiniMax H3");
    expect(spec.modelCheck).toEqual({
      pack: "minimax",
      action: "h3_charsheet",
    });
    expect(spec.secondImageOptional).toBe(true);
    expect(spec.extraImages).toHaveLength(1);
    expect(spec.credit).toMatch(/MIT © ukr8b3g-cmyk/);
    expect(needsLikenessConsent("action:h3_charsheet")).toBe(true);
    expect(engineGroupOf("action:h3_charsheet")?.primary).toBe(
      "catalog:qwen21-character-sheet",
    );
  });

  it("TOOLS.md credits the source project", () => {
    const md = renderToolsDoc((rel) =>
      JSON.parse(
        fs.readFileSync(path.join(ROOT, "public/workflows", rel), "utf-8"),
      ),
    ).markdown;
    expect(md).toContain("## Credits");
    expect(md).toMatch(
      /\*\*H3 Character Sheet\*\*: View catalog \+ structured Ref2VA sheet prompt idea, MIT © ukr8b3g-cmyk/,
    );
  });
});

describe("h3_charsheet client request", () => {
  it("defaults: default views, 16:9, no style, Turbo 8-step, no refs", () => {
    const req = request();
    expect(req.action).toBe("h3_charsheet");
    expect(req.params).toEqual({
      pack_id: "minimax",
      views: CHAR_SHEET_DEFAULT_VIEWS.join(","),
      size: "landscape",
      render: "none",
      h3Speed: "turbo8",
    });
  });

  it("sends views, text, name and refs with aligned roles", () => {
    const req = request({
      picks: {
        views: "feet,head_front,bogus",
        size: "large",
        render: "photo",
        ref2Role: "face",
        ref3Role: "props",
        h3Speed: "turbo4",
      },
      text: "tall courier",
      name: " Mara ",
      second: R2,
      extra: [R3],
    });
    expect(req.params).toMatchObject({
      views: "head_front,feet",
      size: "large",
      render: "photo",
      secondRefImage: R2,
      extraRefImages: [R3],
      refRoles: ["face", "props"],
      h3Speed: "turbo4",
      prompt: "tall courier",
      name: "Mara",
    });
  });

  it("an empty reference 2 slot moves reference 3 and its role up", () => {
    const req = request({
      picks: { ref2Role: "face", ref3Role: "props" },
      extra: [R3],
    });
    expect(req.params.secondRefImage).toBe(R3);
    expect(req.params.extraRefImages).toBeUndefined();
    expect(req.params.refRoles).toEqual(["props"]);
  });

  it("rejects an empty view set", () => {
    expect(() => request({ picks: { views: "" } })).toThrow(ToolInputError);
    expect(() => request({ picks: { views: "bogus" } })).toThrow(
      /at least one view/,
    );
  });
});

describe("buildCharSheetWorkflow", () => {
  it("defaults: 1 ref, 1344x768, 5 frames, Turbo 8-step, sheet saved", () => {
    const {
      workflow: wf,
      slots,
      seed,
    } = buildCharSheetWorkflow(CS, run, 0, {
      ...request().params,
      seed: 7,
    });
    expect(seed).toBe(7);
    expect(danglingLinks(wf)).toEqual([]);
    const [r2vId, r2v] = byClass(wf, "MiniMaxH3ReferenceToVideo")[0];
    expect(r2v.inputs).toMatchObject({ width: 1344, height: 768, length: 5 });
    expect(r2v.inputs["ref_images.ref_image_1"]).toBeUndefined();
    expect(String(r2v.inputs.prompt)).toContain("exactly 6 panels");
    expect(slots.posTextId).toBe(r2vId);
    expect(wf[slots.imageInputId as string].inputs.image).toBe(
      "qa/mara.png [input]",
    );
    expect(byClass(wf, "LoadImage")).toHaveLength(1);
    expect(
      byClass(wf, "LoraLoaderModelOnly").map(([, n]) => n.inputs.lora_name),
    ).toEqual([H3_TURBO_REF2V_8]);
    expect(byClass(wf, "BasicScheduler")[0][1].inputs.steps).toBe(8);
    expect(byClass(wf, "MiniMaxH3SigmaShift")).toHaveLength(1);
    expect(byClass(wf, "RandomNoise")[0][1].inputs.noise_seed).toBe(7);
    expect(byClass(wf, "SaveImage")[0][1].inputs.filename_prefix).toBe(
      "CJ_H3_CharSheet",
    );
    // The pack graph is untouched.
    expect(byClass(CS, "LoraLoaderModelOnly")).toHaveLength(0);
    expect(CS["5"].inputs.prompt).toBe("");
  });

  it("3 refs: extra LoadImage nodes bound as Pictures 2-3", () => {
    const { workflow: wf } = buildCharSheetWorkflow(CS, run, 0, {
      ...request({
        second: R2,
        extra: [R3],
        picks: {
          size: "portrait",
          views: ALL.join(","),
          ref3Role: "props",
          h3Speed: "turbo4",
        },
      }).params,
      seed: 1,
    });
    expect(danglingLinks(wf)).toEqual([]);
    const [, r2v] = byClass(wf, "MiniMaxH3ReferenceToVideo")[0];
    expect(r2v.inputs).toMatchObject({ width: 768, height: 1344, length: 5 });
    const ref = (k: number) =>
      wf[String((r2v.inputs[`ref_images.ref_image_${k}`] as unknown[])[0])];
    expect(ref(1).inputs.image).toBe(R2);
    expect(ref(2).inputs.image).toBe(R3);
    expect(ref(1).class_type).toBe("LoadImage");
    const prompt = String(r2v.inputs.prompt);
    expect(prompt).toContain("exactly 13 panels");
    expect(prompt).toContain("<Picture 3> shows the same <Subject 1>: props");
    expect(
      byClass(wf, "LoraLoaderModelOnly").map(([, n]) => n.inputs.lora_name),
    ).toEqual([H3_TURBO_REF2V_4]);
  });

  it("quality speed keeps 20 steps; fast8 swaps the UNET without a LoRA", () => {
    const q = buildCharSheetWorkflow(CS, run, 0, {
      h3Speed: "off",
      seed: 1,
    }).workflow;
    expect(byClass(q, "LoraLoaderModelOnly")).toHaveLength(0);
    expect(byClass(q, "BasicScheduler")[0][1].inputs.steps).toBe(20);
    const f = buildCharSheetWorkflow(CS, run, 0, {
      h3Speed: "fast8",
      seed: 1,
    }).workflow;
    expect(byClass(f, "LoraLoaderModelOnly")).toHaveLength(0);
    expect(byClass(f, "BasicScheduler")[0][1].inputs.steps).toBe(8);
  });

  it("no params: default views and Turbo 8-step", () => {
    const { workflow: wf } = buildCharSheetWorkflow(CS, run, 0);
    expect(String(wf["5"].inputs.prompt)).toContain("exactly 6 panels");
    expect(byClass(wf, "BasicScheduler")[0][1].inputs.steps).toBe(8);
  });

  it("errors: no source image, no views, wrong graph", () => {
    expect(() => buildCharSheetWorkflow(CS, noImageRun, 0, {})).toThrow(
      /no image/,
    );
    expect(() =>
      buildCharSheetWorkflow(CS, run, 0, { views: "bogus" }),
    ).toThrow(/at least one view/);
    const noR2v = Object.fromEntries(
      Object.entries(CS).filter(
        ([, n]) => n.class_type !== "MiniMaxH3ReferenceToVideo",
      ),
    ) as Workflow;
    expect(() => buildCharSheetWorkflow(noR2v, run, 0, {})).toThrow(
      /needs MiniMaxH3/,
    );
  });
});

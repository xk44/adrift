import { describe, it, expect, vi } from "vitest";
import rawApps from "@/lib/tools/appTemplates.json";
import {
  APP_TEMPLATES,
  appEngines,
  compileAppPrompt,
  compileMotionPrompt,
  getApp,
  validateAppTemplates,
} from "@/lib/tools/apps";
import {
  CAST_FIELDS,
  DUAL_ENGINES,
  EDIT_ENGINES,
  SINGLE_ENGINES,
  TEMPLATES,
  availableEngines,
  compileBatchPrompts,
  compileCastPrompt,
  compileTemplatePrompt,
  defaultCastSelection,
  engineAvailability,
  engineLicenseNote,
  enginesAvailability,
  getTemplate,
  type EngineContext,
} from "@/lib/tools/templates";
import { buildEngineRequest } from "@/lib/tools/engineRequest";
import {
  COLOR_GRADE_KEY,
  HUB_CATEGORIES,
  HUB_CATEGORY_LABELS,
  HUB_CATEGORY_NOTES,
  SOUL_CAST_KEY,
  buildHubCards,
  filterHubCards,
  groupHubCards,
  type HubCard,
} from "@/lib/tools/hub";
import {
  GRADE_PRESETS,
  NEUTRAL_GRADE,
  applyGrade,
  fitWithin,
  gradeRgb,
  isNeutral,
  presetSettings,
} from "@/lib/tools/colorGrade";
import {
  ACTION_TOOLS,
  ToolInputError,
  actionAvailability,
  buildActionRequest,
  buildToolCards,
  defaultSettings,
  getActionTool,
  type CatalogTool,
  type EditLoraListResponse,
} from "@/lib/tools/toolsPage";
import {
  submitAnimate,
  submitEngineEdit,
  submitVideoTool,
  type ToolImage,
} from "@/lib/tools/runTool";

function catalogTool(over: Partial<CatalogTool> = {}): CatalogTool {
  return {
    id: "t1",
    label: "Tool One",
    category: "Camera",
    base: "qwen",
    baseLabel: "Qwen Edit",
    description: "d",
    loras: [{ file: "edit_tools/foo.safetensors", strength: 1 }],
    extras: { keepFraming: null },
    speed: { supported: false },
    defaults: { steps: 20, cfg: 4 },
    refCount: 1,
    refLabels: ["Photo"],
    needsMask: false,
    outpaint: null,
    promptMode: "none",
    promptTemplate: "",
    promptHint: "",
    options: [],
    requiresNodes: null,
    license: { name: "MIT", commercial: true, note: "" },
    sourceUrl: "",
    installed: true,
    packAvailable: true,
    available: true,
    ...over,
  } as CatalogTool;
}

const loras: EditLoraListResponse = {
  families: { krea2edit: { label: "Krea 2 Edit" } },
  loras: [
    {
      id: "k1",
      name: "K1",
      file: "k1.safetensors",
      family: "krea2edit",
      base: "krea2",
      defaultStrength: 0.9,
      installed: true,
    },
  ] as EditLoraListResponse["loras"],
};

const fullCtx: EngineContext = {
  catalog: [
    catalogTool({ id: "krea2-general-edit", promptMode: "required" }),
    catalogTool({ id: "qwen2511-remove", promptMode: "required" }),
    catalogTool({ id: "qwen21-realism", promptMode: "none" }),
  ],
  packIds: new Set(["qwen-image-edit", "krea2-edit", "qwen-image-21", "flux3"]),
  editLoras: loras,
};

const emptyCtx: EngineContext = {
  catalog: [],
  packIds: new Set(),
  editLoras: { families: {}, loras: [] },
};

const loadingCtx: EngineContext = {
  catalog: null,
  packIds: null,
  editLoras: null,
};

// ---------------------------------------------------------------------------

describe("app templates", () => {
  it("the shipped JSON validates cleanly", () => {
    expect(validateAppTemplates(rawApps)).toEqual([]);
    expect(APP_TEMPLATES.length).toBeGreaterThanOrEqual(25);
  });

  it("flags malformed apps", () => {
    const errs = validateAppTemplates({
      apps: [
        {
          id: "Bad Id",
          name: "",
          category: "Nope",
          description: "",
          prompt: "short",
        },
        {
          id: "dup",
          name: "A",
          category: "Portraits",
          description: "d",
          prompt: "Turn this photo into {text} with lots of detail",
        },
        {
          id: "dup",
          name: "B",
          category: "Portraits",
          description: "d",
          prompt: "Turn this photo into a {thing} with lots of detail",
          editMode: "tryon",
        },
      ],
    });
    const joined = errs.join("\n");
    expect(joined).toMatch(/Bad Id/);
    expect(joined).toMatch(/duplicate/i);
    expect(joined).toMatch(/\{text\}/);
    expect(joined).toMatch(/thing/);
    expect(joined).toMatch(/editMode/);
    expect(validateAppTemplates(null).length).toBeGreaterThan(0);
  });

  it("compiles the edit prompt with text and its default", () => {
    const withText = APP_TEMPLATES.find((a) => a.inputs?.text)!;
    expect(compileAppPrompt(withText, "  NEON CITY ")).toContain("NEON CITY");
    expect(compileAppPrompt(withText, "")).not.toContain("{text}");
    const plain = APP_TEMPLATES.find((a) => !a.inputs?.text)!;
    expect(compileAppPrompt(plain)).toBe(plain.prompt);
  });

  it("motion prompt: custom text overrides the template", () => {
    const app = APP_TEMPLATES.find((a) => a.motion)!;
    expect(compileMotionPrompt(app, "")).toBe(app.motion);
    expect(compileMotionPrompt(app, " slow pan ")).toBe("slow pan");
  });

  it("two-image apps use dual engines; others single", () => {
    for (const app of APP_TEMPLATES) {
      expect(appEngines(app)).toBe(
        app.inputs?.second ? DUAL_ENGINES : SINGLE_ENGINES,
      );
    }
    expect(getApp("nope")).toBeUndefined();
  });
});

describe("edit engines", () => {
  it("availability: catalog, pack and grounded-LoRA engines", () => {
    expect(engineAvailability(EDIT_ENGINES.krea2, fullCtx).available).toBe(
      true,
    );
    expect(engineAvailability(EDIT_ENGINES.krea2, loadingCtx).checking).toBe(
      true,
    );
    expect(engineAvailability(EDIT_ENGINES.qwen2511, emptyCtx).reason).toMatch(
      /qwen-image-edit/,
    );
    expect(
      engineAvailability(EDIT_ENGINES["krea2-dual"], {
        ...fullCtx,
        editLoras: { families: {}, loras: [] },
      }).reason,
    ).toMatch(/grounded/);
    expect(
      engineAvailability(EDIT_ENGINES.krea2, {
        ...fullCtx,
        catalog: [catalogTool({ id: "krea2-general-edit", available: false })],
      }).available,
    ).toBe(false);
  });

  it("availableEngines keeps preference order; enginesAvailability rolls up", () => {
    const ids = availableEngines(SINGLE_ENGINES, {
      ...fullCtx,
      catalog: [],
    }).map((e) => e.id);
    expect(ids).toEqual(["qwen2511", "qwen21", "flux3"]);
    expect(enginesAvailability(SINGLE_ENGINES, fullCtx).available).toBe(true);
    expect(enginesAvailability(SINGLE_ENGINES, loadingCtx).checking).toBe(true);
    const none = enginesAvailability(SINGLE_ENGINES, emptyCtx);
    expect(none.available).toBe(false);
    expect(none.reason).toMatch(/Needs one of/);
  });

  it("license notes", () => {
    expect(engineLicenseNote(EDIT_ENGINES.qwen21)).toMatch(/Non-commercial/);
    // Krea 2 edit loads the non-commercial Identity Edit V2 LoRA.
    expect(engineLicenseNote(EDIT_ENGINES.krea2)).toMatch(/^Non-commercial/);
    expect(engineLicenseNote(EDIT_ENGINES.flux3)).toMatch(/US\$5M/);
    expect(engineLicenseNote(EDIT_ENGINES["krea2-dual"])).toMatch(/US\$1M/);
    expect(engineLicenseNote(EDIT_ENGINES.qwen2511)).toBeNull();
  });

  it("buildEngineRequest: catalog engine puts the prompt in settings.text", () => {
    const req = buildEngineRequest(
      EDIT_ENGINES.krea2,
      " make it blue ",
      fullCtx,
    );
    expect(req.kind).toBe("catalog");
    if (req.kind === "catalog") {
      expect(req.tool.id).toBe("krea2-general-edit");
      expect(req.settings.text).toBe("make it blue");
    }
    expect(() => buildEngineRequest(EDIT_ENGINES.krea2, "  ", fullCtx)).toThrow(
      ToolInputError,
    );
    expect(() => buildEngineRequest(EDIT_ENGINES.krea2, "x", emptyCtx)).toThrow(
      /isn't installed/,
    );
    // promptStyle none: empty prompt is fine.
    expect(
      buildEngineRequest(EDIT_ENGINES["qwen21-realism"], "", fullCtx).kind,
    ).toBe("catalog");
  });

  it("buildEngineRequest: action, dual and grounded engines", () => {
    const single = buildEngineRequest(EDIT_ENGINES.qwen2511, "edit", fullCtx);
    expect(single).toEqual({
      kind: "action",
      action: "edit_qwen",
      params: { pack_id: "qwen-image-edit", prompt: "edit" },
      // The Multi-Angle dropdown LoRA is zeroed for template edits.
      overrides: { "2.strength_model": 0 },
    });
    expect(() =>
      buildEngineRequest(EDIT_ENGINES["qwen2511-dual"], "edit", fullCtx),
    ).toThrow(/reference/);
    const dual = buildEngineRequest(
      EDIT_ENGINES["qwen2511-dual"],
      "edit",
      fullCtx,
      {
        secondRef: "r.png [input]",
        editMode: "tryon",
      },
    );
    expect(dual.kind === "action" && dual.params).toEqual({
      pack_id: "qwen-image-edit",
      prompt: "edit",
      secondRefImage: "r.png [input]",
    });
    const grounded = buildEngineRequest(
      EDIT_ENGINES["krea2-dual"],
      "edit",
      fullCtx,
      {
        secondRef: "r.png [input]",
        editMode: "insert",
      },
    );
    expect(grounded.kind).toBe("action");
    if (grounded.kind === "action") {
      expect(grounded.action).toBe("edit_instruct_dual");
      expect(grounded.params).toMatchObject({
        pack_id: "krea2-edit",
        editMode: "insert",
      });
      expect(grounded.overrides).toEqual({
        "2.lora_name": "k1.safetensors",
        "2.strength_model": 0.9,
      });
    }
  });
});

describe("template prompts", () => {
  const removeText = getTemplate("remove_text")!;
  const restyle = getTemplate("batch_restyle")!;

  it("every template has unique preset ids and known engines", () => {
    for (const t of TEMPLATES) {
      const ids = t.presets.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const e of t.engines) expect(EDIT_ENGINES[e]).toBeDefined();
    }
  });

  it("instruction / fragment / none engines", () => {
    const p = removeText.presets[0];
    expect(
      compileTemplatePrompt(removeText, p.id, EDIT_ENGINES.krea2, "keep logo"),
    ).toContain(p.prompt.replace(/\.$/, ""));
    const frag = compileTemplatePrompt(
      removeText,
      p.id,
      EDIT_ENGINES["qwen2511-remove"],
      "keep logo",
    );
    expect(frag).toBe(`${p.fragment ?? p.prompt}, and keep logo`);
    expect(
      compileTemplatePrompt(
        getTemplate("skin_enhancer")!,
        "natural",
        EDIT_ENGINES["qwen21-realism"],
      ),
    ).toBe("");
    // Unknown preset falls back to the first.
    expect(compileTemplatePrompt(removeText, "zzz", EDIT_ENGINES.krea2)).toBe(
      compileTemplatePrompt(removeText, p.id, EDIT_ENGINES.krea2),
    );
  });

  it("batch: dedupes, drops unknown ids, caps at max", () => {
    const ids = restyle.presets.map((p) => p.id);
    const out = compileBatchPrompts(
      restyle,
      [ids[0], ids[0], "bogus", ...ids, ids[1]],
      EDIT_ENGINES.krea2,
    );
    expect(out.map((o) => o.presetId)).toEqual(
      ids.slice(0, restyle.multi!.max),
    );
    expect(new Set(out.map((o) => o.prompt)).size).toBe(out.length);
  });

  it("cast prompt is deterministic and reflects choices", () => {
    const sel = defaultCastSelection();
    expect(compileCastPrompt(sel)).toBe(compileCastPrompt({ ...sel }));
    const noir = compileCastPrompt(
      { ...sel, genre: "noir", era: "1960s" },
      "red coat",
    );
    expect(noir).toContain("film noir");
    expect(noir).toContain("1960s");
    expect(noir).toContain("red coat");
    // "Any" look adds no "with" clause.
    expect(compileCastPrompt({ ...sel, build: "any" })).not.toMatch(/, with ,/);
    for (const f of CAST_FIELDS) expect(f.options.length).toBeGreaterThan(1);
  });
});

describe("hub cards", () => {
  const toolCards = buildToolCards({
    catalog: fullCtx.catalog,
    packIds: fullCtx.packIds,
    editLoras: loras,
    modelStatus: { tools: {} },
  });
  const cards = buildHubCards({ toolCards, ctx: fullCtx });
  const byKey = (k: string) => cards.find((c) => c.key === k)!;

  it("includes every tool, template, app, special and placeholder card", () => {
    const keys = new Set(cards.map((c) => c.key));
    expect(keys.size).toBe(cards.length);
    for (const t of toolCards) expect(keys.has(t.key)).toBe(true);
    for (const t of TEMPLATES) expect(keys.has(`template:${t.id}`)).toBe(true);
    for (const a of APP_TEMPLATES) expect(keys.has(`app:${a.id}`)).toBe(true);
    expect(keys.has(COLOR_GRADE_KEY)).toBe(true);
    expect(keys.has(SOUL_CAST_KEY)).toBe(true);
    // Relight is a real tool now (Qwen-Image-Edit-2509 Relight LoRA).
    expect(keys.has("action:relight")).toBe(true);
    expect(keys.has("placeholder:relight")).toBe(false);
    // Shots / Zooms (Qwen-Image-Edit-2509 + Multiple-Angles LoRA).
    expect(byKey("action:shots").hubCategory).toBe("Enhance");
    expect(byKey("action:zooms").hubCategory).toBe("Enhance");
    for (const c of cards) expect(HUB_CATEGORIES).toContain(c.hubCategory);
  });

  it("applies display names, sections and NC flags", () => {
    expect(byKey("action:transition").title).toBe("Transitions");
    expect(byKey("action:transition").hubCategory).toBe("Video");
    expect(byKey("action:edit_qwen21").nc).toBe(true);
    expect(byKey("catalog:krea2-general-edit").nc).toBe(false);
    expect(byKey("action:lipsync").hubCategory).toBe("Audio");
    expect(byKey("action:lipsync").model).toBe("InfiniteTalk (Wan 2.1)");
    expect(byKey("action:wan_animate").hubCategory).toBe("Identity");
    // Voiceover / video sound are real tools now (no placeholder cards).
    expect(byKey("action:voiceover").hubCategory).toBe("Audio");
    expect(byKey("action:add_sound").nc).toBe(true);
    expect(byKey("action:voiceover").nc).toBe(false);
  });

  it("groups the LTX VFX tools in their own LTX VFX section", () => {
    const ltx = [
      "action:ltx_alpha_matte",
      "action:ltx_clean_plate",
      "action:ltx_day_to_night",
      "action:ltx_add_water",
      "action:ltx_cinemagraph",
      "action:ltx_slow_motion",
      "action:ltx_ripple",
      "action:ltx_edge_control",
      "action:ltx_blockout_render",
      "action:ltx_sdr_to_hdr",
      "action:ltx_layout_render",
      "action:ltx_ingredients",
      "action:ltx_exploded_view",
      "action:ltx_paint_fluid",
    ];
    for (const key of ltx) {
      expect(byKey(key).hubCategory).toBe("VFX");
      expect(byKey(key).model).toMatch(/^LTX-2\.5 /);
      expect(byKey(key).nc).toBe(false);
    }
    // Re-shoot re-angles the first frame with Qwen-Image 2.1 (research license).
    const reshoot = byKey("action:ltx_reshoot");
    expect(reshoot.hubCategory).toBe("VFX");
    expect(reshoot.model).toMatch(/^LTX-2\.5 \+ Qwen-Image 2\.1/);
    expect(reshoot.nc).toBe(true);
    const shots = [
      "special:ltx_shot_night_rain",
      "special:ltx_shot_plate_matte",
      "special:ltx_shot_living_photo",
    ];
    expect(cards.filter((c) => c.hubCategory === "VFX").map((c) => c.key).sort()).toEqual(
      [...ltx, "action:ltx_reshoot", ...shots].sort(),
    );
    expect(HUB_CATEGORY_LABELS.VFX).toBe("LTX VFX");
    expect(HUB_CATEGORY_NOTES.VFX).toMatch(/LTX-2\.5/);
    expect(HUB_CATEGORIES.indexOf("VFX")).toBe(
      HUB_CATEGORIES.indexOf("Video") + 1,
    );
    const group = groupHubCards(cards, "VFX");
    expect(group).toHaveLength(1);
    expect(group[0].label).toBe("LTX VFX");
    expect(filterHubCards(cards, "ltx vfx").map((c) => c.key)).toEqual(
      expect.arrayContaining(ltx),
    );
  });

  it("NC also comes from a catalog tool's license", () => {
    const tool = catalogTool({
      id: "x-nc",
      license: { name: "NC", commercial: false, note: "" },
    });
    const nc = buildHubCards({
      toolCards: buildToolCards({
        catalog: [tool],
        packIds: new Set(),
        editLoras: null,
      }),
      ctx: { ...emptyCtx, catalog: [tool] },
    }).find((c) => c.key === "catalog:x-nc")!;
    expect(nc.nc).toBe(true);
  });

  it("video tools without a model-status entry stay disabled with a reason", () => {
    for (const id of [
      "transition",
      "video_bg_remove",
      "character_swap",
      "make_3d",
    ]) {
      const spec = getActionTool(id)!;
      const av = actionAvailability(
        spec,
        new Set(["minimax", "utility"]),
        loras,
        { tools: {} },
      );
      expect(av.available).toBe(false);
      expect(av.reason).toMatch(/not set up/i);
    }
    const ok = actionAvailability(
      getActionTool("transition")!,
      new Set(["minimax"]),
      loras,
      { tools: { transition: { missing: [] } } },
    );
    expect(ok.available).toBe(true);
  });

  it("search: AND of words over title, model, aliases and NC", () => {
    expect(filterHubCards(cards, "")).toBe(cards);
    const hits = filterHubCards(cards, "color grade").map((c) => c.key);
    expect(hits).toContain(COLOR_GRADE_KEY);
    expect(filterHubCards(cards, "non-commercial").every((c) => c.nc)).toBe(
      true,
    );
    expect(filterHubCards(cards, "zzzz-nothing")).toEqual([]);
  });

  it("groups in hub order; ready → checking → disabled → placeholder", () => {
    const mk = (key: string, over: Partial<HubCard>): HubCard =>
      ({
        key,
        kind: "action",
        id: key,
        title: key,
        subtitle: "",
        icon: "",
        hubCategory: "Edit",
        available: true,
        unavailableReason: null,
        licenseNote: null,
        checking: false,
        model: null,
        nc: false,
        aliases: [],
        ...over,
      }) as HubCard;
    const groups = groupHubCards([
      mk("p", { kind: "placeholder", available: false }),
      mk("d", { available: false }),
      mk("c", { available: false, checking: true }),
      mk("a", {}),
      mk("v", { hubCategory: "Video" }),
      mk("i", { hubCategory: "Image" }),
    ]);
    expect(groups.map((g) => g.category)).toEqual(["Image", "Edit", "Video"]);
    expect(groups[1].cards.map((c) => c.key)).toEqual(["a", "c", "d", "p"]);
    expect(
      groupHubCards(cards, "Ads").every((g) => g.category === "Ads"),
    ).toBe(true);
  });
});

describe("color grade", () => {
  it("neutral settings are an identity", () => {
    expect(isNeutral(NEUTRAL_GRADE)).toBe(true);
    const [r, g, b] = gradeRgb(0.2, 0.5, 0.8, NEUTRAL_GRADE);
    expect(r).toBeCloseTo(0.2);
    expect(g).toBeCloseTo(0.5);
    expect(b).toBeCloseTo(0.8);
    const buf = new Uint8ClampedArray([10, 20, 30, 255, 200, 100, 50, 128]);
    const copy = buf.slice();
    applyGrade(buf, 2, 1, NEUTRAL_GRADE);
    expect(buf).toEqual(copy);
  });

  it("grades move pixels in the expected direction; alpha kept", () => {
    const warm = gradeRgb(0.5, 0.5, 0.5, {
      ...NEUTRAL_GRADE,
      temperature: 100,
    });
    expect(warm[0]).toBeGreaterThan(warm[2]);
    const mono = gradeRgb(0.9, 0.2, 0.1, {
      ...NEUTRAL_GRADE,
      saturation: -100,
    });
    expect(mono[0]).toBeCloseTo(mono[1]);
    const buf = new Uint8ClampedArray([100, 100, 100, 77]);
    applyGrade(buf, 1, 1, { ...NEUTRAL_GRADE, exposure: 1 });
    expect(buf[0]).toBeGreaterThan(100);
    expect(buf[3]).toBe(77);
  });

  it("presets resolve to full settings; grain is deterministic", () => {
    for (const p of GRADE_PRESETS) {
      expect(Object.keys(presetSettings(p.id)).sort()).toEqual(
        Object.keys(NEUTRAL_GRADE).sort(),
      );
    }
    const s = { ...NEUTRAL_GRADE, grain: 50 };
    const a = new Uint8ClampedArray(64).fill(128);
    const b = new Uint8ClampedArray(64).fill(128);
    applyGrade(a, 4, 4, s);
    applyGrade(b, 4, 4, s);
    expect(a).toEqual(b);
    expect(fitWithin(4000, 2000, 1200)).toEqual({ width: 1200, height: 600 });
    expect(fitWithin(100, 50, 1200)).toEqual({ width: 100, height: 50 });
  });
});

describe("new action requests", () => {
  it("character_swap / transition / video_bg_remove payloads", () => {
    const cs = getActionTool("character_swap")!;
    expect(() => buildActionRequest(cs, defaultSettings(cs), null)).toThrow(
      /character photo/,
    );
    expect(
      buildActionRequest(
        cs,
        { ...defaultSettings(cs), text: "the man in red" },
        null,
        "c.png [input]",
      ),
    ).toMatchObject({
      action: "character_swap",
      params: {
        pack_id: "minimax",
        secondRefImage: "c.png [input]",
        target: "the man in red",
      },
    });
    const tr = getActionTool("transition")!;
    expect(
      buildActionRequest(
        tr,
        { ...defaultSettings(tr), text: "slow dolly" },
        null,
        "e.png [input]",
      ),
    ).toMatchObject({
      action: "transition",
      params: {
        pack_id: "minimax",
        secondRefImage: "e.png [input]",
        prompt: "slow dolly",
      },
    });
    const bg = getActionTool("video_bg_remove")!;
    expect(buildActionRequest(bg, defaultSettings(bg), null).params).toEqual({
      background: "alpha",
    });
    expect(
      buildActionRequest(
        bg,
        { ...defaultSettings(bg), picks: { background: "green" } },
        null,
      ).params,
    ).toEqual({ background: "green" });
    expect(ACTION_TOOLS.map((t) => t.id)).toEqual(
      expect.arrayContaining([
        "character_swap",
        "transition",
        "video_bg_remove",
      ]),
    );
  });
});

// ---------------------------------------------------------------------------

function mockFetch() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url, body });
    const json =
      url === "/api/comfy/upload"
        ? { ok: true, ref: `${body.filename} [input]` }
        : url === "/api/jobs/seed-run"
          ? { ok: true, run: { run_id: "SEED", jobs: [{ index: 0 }] } }
          : { ok: true, run: { run_id: `NEW${calls.length}`, jobs: [] } };
    return { ok: true, status: 200, json: async () => json };
  });
  return { calls, fetchImpl };
}

const upload: ToolImage = {
  id: "u",
  source: "upload",
  previewUrl: "data:image/png;base64,AA",
  dataUrl: "data:image/png;base64,AA",
  label: "u.png",
  width: 512,
  height: 512,
};

describe("submitEngineEdit / submitAnimate", () => {
  it("action engine: uploads + seeds once across a batch", async () => {
    const { calls, fetchImpl } = mockFetch();
    const prepared = {};
    for (const prompt of ["one", "two"]) {
      await submitEngineEdit({
        fetchImpl,
        engine: EDIT_ENGINES.qwen2511,
        prompt,
        image: upload,
        ctx: fullCtx,
        clientId: "c",
        title: "t",
        prepared,
      });
    }
    expect(calls.map((c) => c.url)).toEqual([
      "/api/comfy/upload",
      "/api/jobs/seed-run",
      "/api/jobs/action",
      "/api/jobs/action",
    ]);
    expect(calls[3].body).toMatchObject({
      run_id: "SEED",
      action: "edit_qwen",
      params: { pack_id: "qwen-image-edit", prompt: "two" },
    });
    expect(calls[3].body.workflow_control_overrides).toEqual({
      "2.strength_model": 0,
    });
  });

  it("catalog engine posts to /api/jobs/tool with the prompt as text", async () => {
    const { calls, fetchImpl } = mockFetch();
    await submitEngineEdit({
      fetchImpl,
      engine: EDIT_ENGINES.krea2,
      prompt: "make it night",
      image: { ...upload, source: "gallery", runId: "G", jobIndex: 2 },
      ctx: fullCtx,
      clientId: "c",
      title: "t",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/jobs/tool");
    expect(calls[0].body).toMatchObject({
      toolId: "krea2-general-edit",
      images: [{ run_id: "G", job_index: 2 }],
      prompt: "make it night",
    });
  });

  it("grounded dual engine uploads the reference and sends overrides", async () => {
    const { calls, fetchImpl } = mockFetch();
    await submitEngineEdit({
      fetchImpl,
      engine: EDIT_ENGINES["krea2-dual"],
      prompt: "put them together",
      image: upload,
      secondImage: upload,
      ctx: fullCtx,
      clientId: "c",
      title: "t",
      editMode: "insert",
    });
    const action = calls.find((c) => c.url === "/api/jobs/action")!;
    expect(action.body).toMatchObject({
      action: "edit_instruct_dual",
      params: { pack_id: "krea2-edit", editMode: "insert" },
      workflow_control_overrides: { "2.lora_name": "k1.safetensors" },
    });
    expect(
      String((action.body.params as Record<string, unknown>).secondRefImage),
    ).toMatch(/^cj_ref2_/);
  });

  it("validates before any network call", async () => {
    const { fetchImpl } = mockFetch();
    await expect(
      submitEngineEdit({
        fetchImpl,
        engine: EDIT_ENGINES["qwen2511-dual"],
        prompt: "x",
        image: upload,
        secondImage: null,
        ctx: fullCtx,
        clientId: "c",
        title: "t",
      }),
    ).rejects.toThrow(/reference/);
    await expect(
      submitEngineEdit({
        fetchImpl,
        engine: EDIT_ENGINES.qwen2511,
        prompt: " ",
        image: upload,
        ctx: fullCtx,
        clientId: "c",
        title: "t",
      }),
    ).rejects.toThrow(/empty/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("animate posts the i2v action on the step-1 run", async () => {
    const { calls, fetchImpl } = mockFetch();
    await submitAnimate({
      fetchImpl,
      runId: "R1",
      jobIndex: 0,
      motion: "animate_high",
      prompt: " drift ",
      clientId: "c",
    });
    expect(calls[0]).toEqual({
      url: "/api/jobs/action",
      body: {
        run_id: "R1",
        job_index: 0,
        action: "animate_high",
        client_id: "c",
        params: { prompt: "drift" },
      },
    });
  });

  it("video tools without a reference photo skip the face upload", async () => {
    const { calls, fetchImpl } = mockFetch();
    const spec = getActionTool("video_bg_remove")!;
    await submitVideoTool({
      fetchImpl,
      spec,
      settings: defaultSettings(spec),
      video: {
        id: "v",
        previewUrl: "blob:x",
        dataUrl: "data:video/mp4;base64,AAAA",
        label: "clip.mp4",
        duration: 3,
        width: 640,
        height: 360,
      },
      face: null,
      clientId: "c",
    });
    expect(calls.map((c) => c.url)).toEqual([
      "/api/comfy/upload",
      "/api/jobs/seed-run",
      "/api/jobs/action",
    ]);
    expect(calls[2].body).toMatchObject({
      action: "video_bg_remove",
      params: { background: "alpha" },
    });
  });
});

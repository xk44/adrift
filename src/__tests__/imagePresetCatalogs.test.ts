import { describe, expect, it } from "vitest";
import rawApps from "@/lib/tools/appTemplates.json";
import {
  APP_TEMPLATES,
  compileAppPrompt,
  getApp,
  validateAppTemplates,
} from "@/lib/tools/apps";
import {
  EDIT_ENGINES,
  SINGLE_ENGINES,
  compileBatchPrompts,
  getTemplate,
  presetGroups,
} from "@/lib/tools/templates";
import {
  COMMERCIAL_FACE_PRESETS,
  WARDROBE_PRESETS,
  WHAT_IF_PRESETS,
} from "@/lib/tools/lookCatalogs";
import {
  DEFAULT_STYLE_SUBJECT,
  STYLE_CATEGORIES,
  STYLE_PRESETS,
  addStyleToPrompt,
  compileStylePrompt,
  getStylePreset,
  styleLoraFlag,
  stylesIn,
  validateStylePresets,
} from "@/lib/tools/stylePresets";
import { findStyleLora } from "@/lib/krea2/styleLoras";
import { buildHubCards, STYLE_PRESETS_KEY } from "@/lib/tools/hub";

// Public-export rule: no trademarks, titles, celebrities or data.
const BANNED =
  /\b(lego|minecraft|roblox|sims|gta|fortnite|mario|zelda|pokemon|disney|pixar|marvel|dc comics|ghibli|nintendo|playstation|xbox|barbie|nike|adidas|gucci|chanel|prada|kodak|kodachrome|technicolor|polaroid|lomography|instagram|tiktok|sref|niji|higgsfield|soul id)\b/i;

const LOOK_TEMPLATES = [
  ["what_if", WHAT_IF_PRESETS],
  ["commercial_faces", COMMERCIAL_FACE_PRESETS],
  ["ai_stylist", WARDROBE_PRESETS],
] as const;

const NEW_ADS = [
  "levitation_ad",
  "podium_ad",
  "ingredient_burst",
  "marble_luxe",
  "forest_floor",
  "sunburst_ad",
  "flare_ad",
  "in_hand_ad",
  "creator_review",
  "underwater_ad",
  "palm_shadow",
  "seasonal_ad",
];

describe("style presets catalog (Soul-style menu)", () => {
  it("validates, is big enough and covers every category", () => {
    expect(validateStylePresets(STYLE_PRESETS)).toEqual([]);
    expect(STYLE_PRESETS.length).toBeGreaterThanOrEqual(60);
    expect(STYLE_PRESETS.length).toBeLessThanOrEqual(120);
    for (const c of STYLE_CATEGORIES)
      expect(stylesIn(c).length, c).toBeGreaterThanOrEqual(5);
  });

  it("validator catches bad entries", () => {
    const good = STYLE_PRESETS[0];
    const errs = validateStylePresets([
      good,
      { ...good },
      { ...good, id: "Bad-Id", name: "Other", prompt: "short" },
      { ...good, id: "x_lora", name: "X", lora: "not-a-real-style-lora" },
      { ...good, id: "x_flag", name: "Y", prompt: `${good.prompt} --ar 16:9` },
    ]);
    expect(errs.some((e) => e.includes("duplicate id"))).toBe(true);
    expect(errs.some((e) => e.includes("snake_case"))).toBe(true);
    expect(errs.some((e) => e.includes("30-220"))).toBe(true);
    expect(errs.some((e) => e.includes("unknown style LoRA"))).toBe(true);
    expect(errs.some((e) => e.includes("flags"))).toBe(true);
  });

  it("every linked LoRA is in the public style-LoRA catalog", () => {
    const linked = STYLE_PRESETS.filter((p) => p.lora);
    expect(linked.length).toBeGreaterThanOrEqual(50);
    for (const p of linked) expect(findStyleLora(p.lora!), p.id).toBeDefined();
  });

  it("no trademarks, IP or style-code data in names or prompts", () => {
    for (const p of STYLE_PRESETS)
      expect(`${p.name} | ${p.prompt}`, p.id).not.toMatch(BANNED);
  });

  it("compiles subject + fragment, with the LoRA flag only on request", () => {
    const p = getStylePreset("noir")!;
    expect(compileStylePrompt(p, { subject: "a detective, " })).toBe(
      `a detective, ${p.prompt}`,
    );
    expect(compileStylePrompt(p)).toBe(`${DEFAULT_STYLE_SUBJECT}, ${p.prompt}`);
    const withLora = compileStylePrompt(p, {
      subject: "a detective",
      notes: "rain",
      withLora: true,
    });
    expect(withLora).toBe(
      `a detective, ${p.prompt}, rain --lora ${p.lora}.safetensors`,
    );
    const plain = getStylePreset("pixel_art")!;
    expect(plain.lora).toBeUndefined();
    expect(styleLoraFlag(plain)).toBe("");
    expect(compileStylePrompt(plain, { withLora: true })).not.toContain(
      "--lora",
    );
  });

  it("adds a style before existing flags and never duplicates the LoRA", () => {
    const p = getStylePreset("watercolor")!;
    expect(addStyleToPrompt("a fox in snow --ar 16:9", p)).toBe(
      `a fox in snow, ${p.prompt} --ar 16:9`,
    );
    const once = addStyleToPrompt("a fox --ar 1:1", p, true);
    expect(once).toBe(
      `a fox, ${p.prompt} --ar 1:1 --lora ${p.lora}.safetensors`,
    );
    expect(addStyleToPrompt(once, p, true).match(/--lora/g)).toHaveLength(1);
    expect(addStyleToPrompt("", p)).toBe(
      `${DEFAULT_STYLE_SUBJECT}, ${p.prompt}`,
    );
    expect(addStyleToPrompt("--ar 2:3", p)).toBe(
      `${DEFAULT_STYLE_SUBJECT}, ${p.prompt} --ar 2:3`,
    );
  });
});

describe("look template catalogs (What If, Commercial Faces, AI Stylist)", () => {
  it.each(LOOK_TEMPLATES)(
    "%s: registered template on single-photo engines",
    (id, presets) => {
      const t = getTemplate(id)!;
      expect(t).toBeDefined();
      expect(t.presets).toBe(presets);
      for (const e of t.engines) {
        expect(EDIT_ENGINES[e].refs).toBe(1);
        expect(EDIT_ENGINES[e].promptStyle).toBe("instruction");
        expect(SINGLE_ENGINES).toContain(e);
      }
      expect(t.multi && t.multi.max).toBeGreaterThan(1);
    },
  );

  it.each(LOOK_TEMPLATES)(
    "%s: unique ids/labels, grouped, specific prompts",
    (_id, presets) => {
      expect(presets.length).toBeGreaterThanOrEqual(20);
      const ids = presets.map((p) => p.id);
      const labels = presets.map((p) => p.label.toLowerCase());
      expect(new Set(ids).size).toBe(ids.length);
      expect(new Set(labels).size).toBe(labels.length);
      for (const p of presets) {
        expect(p.id, p.id).toMatch(/^[a-z0-9_]+$/);
        expect(p.group, p.id).toBeTruthy();
        expect(p.prompt.length, p.id).toBeGreaterThanOrEqual(80);
        expect(p.prompt.length, p.id).toBeLessThanOrEqual(500);
        expect(p.prompt, p.id).toMatch(/[.!]$/);
        expect(p.prompt, p.id).not.toMatch(/\{\w+\}/);
        expect(`${p.label} | ${p.prompt}`, p.id).not.toMatch(BANNED);
      }
    },
  );

  it("person-preserving prompts keep identity / everything else", () => {
    for (const p of [...WHAT_IF_PRESETS, ...COMMERCIAL_FACE_PRESETS])
      expect(p.prompt, p.id).toMatch(/keep|resemblance/i);
    for (const p of WARDROBE_PRESETS) {
      expect(p.prompt, p.id).toMatch(/exactly the same/);
      expect(p.fragment, p.id).toBeTruthy();
      expect(p.prompt, p.id).toContain(p.fragment!);
    }
  });

  it("groups keep first-seen order and lose nothing", () => {
    const groups = presetGroups(WARDROBE_PRESETS);
    expect(groups.map((g) => g.group)).toEqual([
      "Full looks",
      "Tops",
      "Outerwear",
      "Bottoms",
      "Shoes",
      "Accessories",
    ]);
    expect(groups.flatMap((g) => g.presets)).toHaveLength(
      WARDROBE_PRESETS.length,
    );
    expect(presetGroups(getTemplate("headshot")!.presets)).toEqual([
      { group: null, presets: getTemplate("headshot")!.presets },
    ]);
  });

  it("batch compile honors the cap and appends notes", () => {
    const t = getTemplate("what_if")!;
    const jobs = compileBatchPrompts(
      t,
      WHAT_IF_PRESETS.map((p) => p.id),
      EDIT_ENGINES.krea2,
      "keep the red scarf",
    );
    expect(jobs).toHaveLength(t.multi!.max);
    for (const j of jobs) expect(j.prompt).toMatch(/keep the red scarf\.$/);
    const stylist = compileBatchPrompts(
      getTemplate("ai_stylist")!,
      ["trench", "white_sneakers"],
      EDIT_ENGINES.qwen2511,
    );
    expect(stylist.map((j) => j.label)).toEqual([
      "Trench coat",
      "White sneakers",
    ]);
    expect(stylist[0].prompt).toContain("beige double-breasted trench coat");
  });
});

describe("marketing product ads + hub wiring", () => {
  it("new product ads validate as single-image product edits", () => {
    expect(validateAppTemplates(rawApps)).toEqual([]);
    for (const id of NEW_ADS) {
      const a = getApp(id)!;
      expect(a, id).toBeDefined();
      expect(a.category).toBe("Ads & Products");
      expect(a.inputs?.second, id).toBeUndefined();
      expect(a.prompt, id).toContain(
        "Keep the product's shape, label and colors exactly.",
      );
      expect(`${a.name} ${a.description} ${a.prompt}`, id).not.toMatch(BANNED);
    }
    expect(compileAppPrompt(getApp("seasonal_ad")!)).toContain(
      "cozy winter holidays campaign",
    );
    expect(compileAppPrompt(getApp("seasonal_ad")!, "spring picnic")).toContain(
      "spring picnic campaign",
    );
    expect(
      APP_TEMPLATES.filter((a) => a.category === "Ads & Products").length,
    ).toBeGreaterThanOrEqual(26);
  });

  it("hub lists Style Presets and the three look templates", () => {
    const cards = buildHubCards({
      toolCards: [],
      ctx: {
        catalog: [],
        packIds: new Set(["default"]),
        editLoras: { families: {}, loras: [] },
      },
    });
    const byKey = new Map(cards.map((c) => [c.key, c]));
    const style = byKey.get(STYLE_PRESETS_KEY)!;
    expect(style.available).toBe(true);
    expect(style.subtitle).toContain(String(STYLE_PRESETS.length));
    expect(style.hubCategory).toBe("Image");
    for (const [id] of LOOK_TEMPLATES)
      expect(byKey.has(`template:${id}`), id).toBe(true);
    for (const id of NEW_ADS) expect(byKey.has(`app:${id}`), id).toBe(true);
    const empty = buildHubCards({
      toolCards: [],
      ctx: { catalog: [], packIds: new Set(), editLoras: null },
    }).find((c) => c.key === STYLE_PRESETS_KEY)!;
    expect(empty.available).toBe(false);
    expect(empty.unavailableReason).toMatch(/text-to-image/);
  });
});

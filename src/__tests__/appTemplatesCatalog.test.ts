import { describe, it, expect } from "vitest";
import rawApps from "@/lib/tools/appTemplates.json";
import {
  APP_CATEGORIES,
  APP_DEFAULT_VARIANT,
  APP_TEMPLATES,
  appVariantChoices,
  compileAppPrompt,
  getApp,
  validateAppTemplates,
} from "@/lib/tools/apps";
import { buildHubCards } from "@/lib/tools/hub";

// Higgsfield /apps parity batch (graph-only templates on existing edit engines).
const PARITY_APPS = [
  "billboard_ad",
  "truck_ad",
  "volcano_ad",
  "chameleon",
  "magic_button",
  "kick_ad",
  "splash_shot",
  "behind_scenes",
  "contact_sheet",
  "outfit_vending",
  "idol",
  "rap_star",
  "latex",
  "mukbang",
  "ghoul",
  "melting_doodle",
  "paint_app",
  "claymation",
  "meme",
  "game_dump",
  "tactical_shooter",
  "loading_screen",
  "life_sim",
  "brick_cube",
  "cloud_surf",
  "roller_coaster",
  "sand_worm",
  "snow_globe",
  "frozen",
  "japanese_show",
];

// Contest rule: no trademarks, game/film titles or celebrity names in app
// names, descriptions, prompts or motion text.
const BANNED =
  /\b(lego|minecraft|roblox|sims|gta|grand theft|counter[- ]?strike|fortnite|mario|zelda|pokemon|skibidi|hulk|saiyan|dragon ball|dune|shai[- ]?hulud|ms paint|microsoft|photoshop|nintendo|playstation|xbox|disney|pixar|marvel|eminem|k-?pop|coca|pepsi|nike|adidas)\b/i;

describe("app template catalog", () => {
  it("ships the parity batch and still validates", () => {
    expect(validateAppTemplates(rawApps)).toEqual([]);
    for (const id of PARITY_APPS) expect(getApp(id), id).toBeDefined();
    expect(APP_TEMPLATES.length).toBeGreaterThanOrEqual(58);
  });

  it("names are unique and every category is used", () => {
    const names = APP_TEMPLATES.map((a) => a.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const c of APP_CATEGORIES)
      expect(
        APP_TEMPLATES.some((a) => a.category === c),
        c,
      ).toBe(true);
  });

  it("no trademarked or IP names anywhere in app text", () => {
    for (const a of APP_TEMPLATES) {
      const text = [
        a.name,
        a.description,
        a.prompt,
        a.motion ?? "",
        ...(a.variants ?? []).flatMap((v) => [v.label, v.prompt]),
        a.inputs?.text?.default ?? "",
        a.inputs?.text?.placeholder ?? "",
      ].join(" | ");
      expect(text, a.id).not.toMatch(BANNED);
    }
  });

  it("prompts are specific edit instructions, motions are short", () => {
    for (const id of PARITY_APPS) {
      const a = getApp(id)!;
      expect(a.prompt.length, id).toBeGreaterThanOrEqual(120);
      expect(a.prompt.length, id).toBeLessThanOrEqual(700);
      expect(a.prompt, id).toMatch(/[.!]$/);
      if (a.motion) expect(a.motion.length, id).toBeLessThanOrEqual(160);
    }
  });

  it("single-image parity apps; text apps fill their default", () => {
    for (const id of PARITY_APPS) {
      const a = getApp(id)!;
      expect(a.inputs?.second, id).toBeUndefined();
      const p = compileAppPrompt(a);
      expect(p, id).not.toMatch(/\{\w+\}/);
      if (a.inputs?.text) expect(p, id).toContain(a.inputs.text.default!);
    }
    expect(
      compileAppPrompt(getApp("game_dump")!, "cozy farming sim"),
    ).toContain("from a cozy farming sim video game");
    expect(compileAppPrompt(getApp("billboard_ad")!, "GO FAR")).toContain(
      '"GO FAR"',
    );
  });

  it("every parity app becomes a hub card", () => {
    const ids = new Set(
      buildHubCards({
        toolCards: [],
        ctx: {
          catalog: [],
          packIds: new Set(),
          editLoras: { families: {}, loras: [] },
        },
      }).map((c) => c.key),
    );
    for (const id of PARITY_APPS)
      expect(
        [...ids].some((k) => k.endsWith(`:${id}`)),
        id,
      ).toBe(true);
  });

  it("poster and macro apps ship layout / look variants", () => {
    const poster = getApp("movie_poster")!;
    expect(appVariantChoices(poster).map((c) => c.id)).toEqual([
      APP_DEFAULT_VARIANT,
      "title_block",
      "credits_block",
      "tagline",
    ]);
    const macro = getApp("macro_product")!;
    expect(appVariantChoices(macro).map((c) => c.id)).toEqual([
      APP_DEFAULT_VARIANT,
      "focus_stack",
      "on_surface",
    ]);
    expect(appVariantChoices(getApp("figurine")!)).toEqual([]);

    const base = compileAppPrompt(poster, "NIGHT RUN");
    expect(compileAppPrompt(poster, "NIGHT RUN", APP_DEFAULT_VARIANT)).toBe(
      base,
    );
    expect(compileAppPrompt(poster, "NIGHT RUN", "missing")).toBe(base);
    const credits = compileAppPrompt(poster, "NIGHT RUN", "credits_block");
    expect(credits).toContain('"NIGHT RUN"');
    expect(credits).toMatch(/billing block/);
    expect(compileAppPrompt(poster, "", "tagline")).toContain(
      `"${poster.inputs!.text!.default}"`,
    );
    expect(compileAppPrompt(macro, undefined, "focus_stack")).toMatch(
      /focus-stacked/,
    );
    expect(compileAppPrompt(macro, undefined, "on_surface")).toMatch(
      /resting on/,
    );
    for (const a of APP_TEMPLATES)
      for (const v of a.variants ?? [])
        expect(compileAppPrompt(a, undefined, v.id), v.id).not.toMatch(
          /\{\w+\}/,
        );
  });

  it("validates variants", () => {
    const base = {
      id: "x",
      name: "X",
      category: "Portraits",
      description: "d",
      prompt: "A long enough edit instruction for the photo.",
    };
    const ok = {
      ...base,
      variantLabel: "Layout",
      variants: [
        { id: "alt", label: "Alt", prompt: "Another long enough instruction." },
      ],
    };
    expect(validateAppTemplates({ apps: [ok] })).toEqual([]);
    const errs = (app: object) => validateAppTemplates({ apps: [app] }).join();
    expect(errs({ ...ok, variantLabel: undefined })).toMatch(/variantLabel/);
    expect(errs({ ...base, variantLabel: "Layout" })).toMatch(
      /variantLabel without variants/,
    );
    expect(errs({ ...ok, variants: [] })).toMatch(/non-empty/);
    expect(
      errs({
        ...ok,
        variants: [{ ...ok.variants[0], id: APP_DEFAULT_VARIANT }],
      }),
    ).toMatch(/duplicate id/);
    expect(
      errs({
        ...ok,
        variants: [{ ...ok.variants[0], prompt: "Use {text} for the title." }],
      }),
    ).toMatch(/\{text\} placeholder/);
    expect(
      errs({
        ...ok,
        variants: [{ ...ok.variants[0], prompt: "Use {name} as the title." }],
      }),
    ).toMatch(/unknown placeholder/);
  });
});

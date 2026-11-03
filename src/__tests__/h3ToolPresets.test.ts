/**
 * MiniMax H3 tool presets (orbit looks, transition styles, background-swap
 * settings, the prompt-steered camera additions) and the H3 hub coverage:
 * every H3 card is labelled MiniMax H3, carries the Region-limited class and
 * is found by searching "minimax h3".
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import {
  CAMERA_PRESETS,
  CAMERA_TRAINED_COUNT,
  ORBIT_PRESETS,
  ORBIT_PROMPT,
  TRANSITION_STYLES,
  cameraMovePrompt,
  orbitPrompt,
  transitionStyle,
} from "@/lib/oj/h3Video";
import {
  TRANSITION_PROMPT,
  buildOrbit360Workflow,
  buildTransitionWorkflow,
  transitionPrompt,
} from "@/lib/oj/h3ImageVideo";
import {
  BG_SWAP_SETTINGS,
  bgSwapSettingText,
  buildVideoBgSwapWorkflow,
} from "@/lib/oj/h3MaskedEdit";
import {
  ToolInputError,
  buildActionRequest,
  buildToolCards,
  defaultSettings,
  getActionTool,
  type ActionPicker,
} from "@/lib/tools/toolsPage";
import { buildHubCards, filterHubCards } from "@/lib/tools/hub";
import { isH3Model } from "@/lib/tools/h3License";
import { weightsClass } from "@/lib/tools/openWeights";

const ctx = { catalog: [], packIds: null, editLoras: null };
const HUB = buildHubCards({ toolCards: buildToolCards(ctx), ctx });

const PACK_DIR = path.join(process.cwd(), "public/workflows/packs/minimax");
const load = (name: string): Workflow =>
  Object.fromEntries(
    Object.entries(
      JSON.parse(fs.readFileSync(path.join(PACK_DIR, `${name}.json`), "utf-8")),
    ).filter(([k]) => !k.startsWith("_")),
  ) as Workflow;

const imageRun = {
  run_id: "img",
  prompt: "",
  width: 1024,
  height: 1024,
  jobs: [
    {
      seed: 0,
      index: 0,
      status: "done",
      images: ["/api/comfy/view?filename=mara.png&subfolder=qa&type=input"],
    },
  ],
} as unknown as ImagineRun;
const videoRun = {
  run_id: "vid",
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

const h3Prompt = (wf: Workflow): string =>
  String(
    Object.values(wf).find((n) => n.class_type === "MiniMaxH3ImageToVideo")!
      .inputs.prompt,
  );
const pickerOf = (tool: string, key: string): ActionPicker => {
  const p = getActionTool(tool as never)!.pickers!.find((x) => x.key === key);
  expect(p, `${tool}.${key}`).toBeDefined();
  return p!;
};

describe("preset lists", () => {
  it.each([
    ["orbit looks", ORBIT_PRESETS],
    ["transition styles", TRANSITION_STYLES],
    ["bg swap settings", BG_SWAP_SETTINGS],
  ])("%s: 4-8 entries, unique ids, plain default first", (_, list) => {
    expect(list.length).toBeGreaterThanOrEqual(4);
    expect(list.length).toBeLessThanOrEqual(8);
    expect(new Set(list.map((p) => p.id)).size).toBe(list.length);
    expect(list[0].text).toBe("");
    for (const p of list.slice(1)) {
      expect(p.text.length, p.id).toBeGreaterThan(20);
      expect(p.text, p.id).not.toMatch(/higgsfield|kling|seedance/i);
    }
  });

  it("Tools pickers mirror the preset lists (paramOnly, default first)", () => {
    const cases: [string, string, { id: string }[]][] = [
      ["orbit_360", "orbitLook", ORBIT_PRESETS],
      ["transition", "transitionStyle", TRANSITION_STYLES],
      ["video_bg_swap", "settingPreset", BG_SWAP_SETTINGS],
    ];
    for (const [tool, key, list] of cases) {
      const p = pickerOf(tool, key);
      expect(p.paramOnly).toBe(true);
      expect(p.options.map((o) => o.id)).toEqual(list.map((x) => x.id));
    }
  });

  it("camera adds dolly zoom + earth zoom out as prompt-steered moves", () => {
    const ids = CAMERA_PRESETS.map((p) => p.id);
    for (const id of ["dolly_zoom", "earth_zoom_out"]) {
      expect(ids.indexOf(id)).toBeGreaterThanOrEqual(CAMERA_TRAINED_COUNT);
      expect(cameraMovePrompt(id).length).toBeGreaterThan(20);
    }
    expect(
      pickerOf("camera_move", "cameraMove").options.map((o) => o.id),
    ).toEqual(ids);
  });
});

describe("prompt composition", () => {
  it("orbit: card prompt first and verbatim, look then user text", () => {
    expect(orbitPrompt()).toBe(ORBIT_PROMPT);
    expect(orbitPrompt(undefined, "nope")).toBe(ORBIT_PROMPT);
    const product = ORBIT_PRESETS.find((p) => p.id === "product")!;
    const out = orbitPrompt("keep the logo sharp", "product");
    expect(out.startsWith(ORBIT_PROMPT)).toBe(true);
    expect(out.indexOf(product.text)).toBeGreaterThan(ORBIT_PROMPT.length - 1);
    expect(out.endsWith("keep the logo sharp")).toBe(true);
  });

  it("transition: style leads, user text next, continuity tail last", () => {
    expect(transitionPrompt()).toBe(TRANSITION_PROMPT);
    expect(transitionStyle("bogus").id).toBe("seamless");
    const smoke = transitionStyle("smoke").text;
    const out = transitionPrompt("day turns to night", "smoke");
    expect(out.startsWith(smoke)).toBe(true);
    expect(out.indexOf("day turns to night")).toBeGreaterThan(smoke.length);
    expect(out.endsWith(TRANSITION_PROMPT)).toBe(true);
  });

  it("bg swap: preset text only for known non-custom ids", () => {
    expect(bgSwapSettingText("custom")).toBe("");
    expect(bgSwapSettingText("bogus")).toBe("");
    expect(bgSwapSettingText(undefined)).toBe("");
    expect(bgSwapSettingText("neon_city")).toMatch(/neon/);
  });
});

describe("builders carry the preset into the graph", () => {
  it("orbit_360 look lands on the H3 prompt", () => {
    const wf = buildOrbit360Workflow(load("orbit_360"), imageRun, 0, {
      orbitLook: "product",
    }).workflow;
    expect(h3Prompt(wf)).toBe(orbitPrompt(undefined, "product"));
  });

  it("transition style lands on the H3 prompt", () => {
    const wf = buildTransitionWorkflow(load("transition"), imageRun, 0, {
      secondRefImage: "market.png [input]",
      transitionStyle: "portal",
    }).workflow;
    expect(h3Prompt(wf)).toContain(transitionStyle("portal").text);
  });

  it("bg swap: preset fills an empty setting, typed text wins", () => {
    const text = (params: Record<string, unknown>) =>
      JSON.stringify(
        buildVideoBgSwapWorkflow(load("video_bg_swap"), videoRun, 0, params)
          .workflow,
      );
    expect(text({ settingPreset: "snow_village" })).toContain(
      "snowy mountain village",
    );
    const typed = text({ settingPreset: "snow_village", setting: "a jungle" });
    expect(typed).toContain("a jungle");
    expect(typed).not.toContain("snowy mountain village");
    expect(() =>
      buildVideoBgSwapWorkflow(load("video_bg_swap"), videoRun, 0, {
        settingPreset: "custom",
      }),
    ).toThrow();
  });
});

describe("Tools requests", () => {
  it("orbit + transition send the pick only when it is not the default", () => {
    const orbit = getActionTool("orbit_360")!;
    expect(
      buildActionRequest(orbit, defaultSettings(orbit), null).params.orbitLook,
    ).toBeUndefined();
    expect(
      buildActionRequest(
        orbit,
        { ...defaultSettings(orbit), picks: { orbitLook: "splash" } },
        null,
      ).params.orbitLook,
    ).toBe("splash");
    const tr = getActionTool("transition")!;
    const end = "market.png [input]";
    expect(
      buildActionRequest(tr, defaultSettings(tr), null, end).params
        .transitionStyle,
    ).toBeUndefined();
    expect(
      buildActionRequest(
        tr,
        { ...defaultSettings(tr), picks: { transitionStyle: "flame" } },
        null,
        end,
      ).params.transitionStyle,
    ).toBe("flame");
  });

  it("bg swap: a preset alone satisfies the setting check", () => {
    const bg = getActionTool("video_bg_swap")!;
    expect(() => buildActionRequest(bg, defaultSettings(bg), null)).toThrow(
      ToolInputError,
    );
    const req = buildActionRequest(
      bg,
      { ...defaultSettings(bg), picks: { settingPreset: "misty_forest" } },
      null,
    );
    expect(req.params.settingPreset).toBe("misty_forest");
    expect(req.params.setting).toBeUndefined();
  });
});

describe("H3 hub coverage", () => {
  const H3_KEYS = [
    "action:orbit_360",
    "action:camera_move",
    "action:transition",
    "action:ref_video",
    "action:multiframe_ref",
    "action:h3_charsheet",
    "action:person_remove",
    "action:video_bg_swap",
    "action:video_object_add",
  ];

  it("every H3 tool card says MiniMax H3 and is Region-limited", () => {
    const keys = HUB.map((c) => c.key);
    for (const key of H3_KEYS) {
      expect(keys, key).toContain(key);
      const card = HUB.find((c) => c.key === key)!;
      expect(isH3Model(card.model), key).toBe(true);
      expect(card.model, key).toMatch(/MiniMax H3/);
      expect(weightsClass(card), key).toBe("region");
    }
  });

  it('searching "minimax h3" finds every H3 tool', () => {
    const found = filterHubCards(HUB, "minimax h3").map((c) => c.key);
    for (const key of H3_KEYS) expect(found, key).toContain(key);
  });

  it.each([
    ["3d rotation", "action:orbit_360"],
    ["smoke transition", "action:transition"],
    ["earth zoom out", "action:camera_move"],
    ["video background changer", "action:video_bg_swap"],
  ])("effect alias %s finds %s", (q, key) => {
    expect(filterHubCards(HUB, q).map((c) => c.key)).toContain(key);
  });
});

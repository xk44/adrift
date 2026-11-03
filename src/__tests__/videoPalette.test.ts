/**
 * Video Color Palette: hex parsing / presets (src/lib/tools/videoPalette.ts),
 * the video_palette builder (src/lib/oj/videoPalette.ts), the tools-page
 * request (buildActionRequest) and the pack graph vs the recorded node spec.
 * No ComfyUI; the node itself is covered by
 * comfy_nodes/cj_h3_tools/tests/test_video_palette.py.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import { ACTION_BUILDERS, VIDEO_INPUT_ACTIONS } from "@/lib/oj/actionBuilders";
import {
  VIDEO_PALETTE_NODE,
  VIDEO_PALETTE_PREFIX,
  buildVideoPaletteWorkflow,
} from "@/lib/oj/videoPalette";
import {
  VIDEO_PALETTE_ACTION,
  VIDEO_PALETTE_MAX_COLORS,
  VIDEO_PALETTE_PRESETS,
  VIDEO_PALETTE_SKIN_PROTECT,
  formatHexPalette,
  parseHexPalette,
  previewSwatches,
  strengthFraction,
  videoPalettePreset,
} from "@/lib/tools/videoPalette";
import {
  ACTION_TOOLS,
  ToolInputError,
  buildActionRequest,
  defaultSettings,
  sliderValue,
  sliderVisible,
  textVisible,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import { toolAliases, toolTitle } from "@/lib/tools/toolNames";
import { paletteHexList } from "@/lib/palette";

const ROOT = path.join(process.cwd(), "public/workflows");
const VIDEO_URL =
  "/api/comfy/view?filename=clip.mp4&subfolder=video&type=output";

function base(): Workflow {
  const raw = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "packs/utility/video_palette.json"),
      "utf-8",
    ),
  ) as Record<string, { class_type?: string }>;
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([, n]) => n && typeof n === "object" && n.class_type,
    ),
  ) as Workflow;
}

function run(videos: string[] = [VIDEO_URL]): ImagineRun {
  return {
    run_id: "r",
    status: "done",
    jobs: [
      { seed: 42, index: 0, status: "done", progress: 100, images: [], videos },
    ],
    params: {},
  } as unknown as ImagineRun;
}

const inputs = (wf: Workflow) => wf["1"].inputs as Record<string, unknown>;
const spec = ACTION_TOOLS.find((t) => t.id === "video_palette")!;
const settings = (
  picks: Record<string, string> = {},
  text = "",
): ToolSettings => ({
  ...defaultSettings(spec),
  text,
  picks,
});

describe("parseHexPalette / formatHexPalette", () => {
  it("parses separators, #rgb, weights and the Copy hex format", () => {
    expect(parseHexPalette("#FF0000, 0f0;#00f:2.5\n#123456:0.4")).toEqual([
      { hex: "#ff0000", weight: 1 },
      { hex: "#00ff00", weight: 1 },
      { hex: "#0000ff", weight: 2.5 },
      { hex: "#123456", weight: 0.4 },
    ]);
    const copied = paletteHexList([
      { hex: "#0B3C49", name: "deep teal", weight: 0.613 },
      { hex: "#e07a2f", name: "amber", weight: 0.001 },
    ]);
    expect(copied).toBe("#0b3c49:0.61, #e07a2f:0.01");
    expect(parseHexPalette(copied).map((s) => s.weight)).toEqual([0.61, 0.01]);
  });

  it("rejects bad tokens, zero weight, empty and too many colours", () => {
    expect(() => parseHexPalette("#12345")).toThrow(/not a #rrggbb/);
    expect(() => parseHexPalette("#gg0000")).toThrow(/not a #rrggbb/);
    expect(() => parseHexPalette("#ff0000:0")).toThrow(/above 0/);
    expect(() => parseHexPalette("  , ")).toThrow(/at least one/);
    expect(() =>
      parseHexPalette(
        Array(VIDEO_PALETTE_MAX_COLORS + 1)
          .fill("#000")
          .join(","),
      ),
    ).toThrow(/At most 16/);
  });

  it("formats canonically (weight 1 omitted) and round-trips", () => {
    const s = parseHexPalette("#abc, #112233:2");
    expect(formatHexPalette(s)).toBe("#aabbcc, #112233:2");
    expect(parseHexPalette(formatHexPalette(s))).toEqual(s);
  });
});

describe("presets, preview, strength", () => {
  it("presets are unique ids with valid hex colours", () => {
    const ids = VIDEO_PALETTE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of VIDEO_PALETTE_PRESETS) {
      expect(p.colors.length).toBeGreaterThanOrEqual(3);
      expect(parseHexPalette(p.colors.join(", ")).length).toBe(p.colors.length);
    }
    expect(videoPalettePreset("teal_orange")?.label).toBe("Teal & Orange");
    expect(videoPalettePreset("nope")).toBeUndefined();
  });

  it("previewSwatches never throws", () => {
    expect(previewSwatches("preset", "neon_night", "")).toHaveLength(4);
    expect(previewSwatches("preset", "missing", "")[0].hex).toBe(
      VIDEO_PALETTE_PRESETS[0].colors[0],
    );
    expect(previewSwatches("hex", "", "#fff, #000")).toHaveLength(2);
    expect(previewSwatches("hex", "", "zzz")).toEqual([]);
    expect(previewSwatches("reference", "", "#fff")).toEqual([]);
  });

  it("strengthFraction clamps percent to 0..1", () => {
    expect(strengthFraction(80)).toBe(0.8);
    expect(strengthFraction("35")).toBe(0.35);
    expect(strengthFraction(140)).toBe(1);
    expect(strengthFraction(-3)).toBe(0);
    expect(strengthFraction("x")).toBe(0.8);
  });
});

describe("buildVideoPaletteWorkflow", () => {
  it("wires the clip, canonical palette and knobs", () => {
    const { workflow, slots, seed } = buildVideoPaletteWorkflow(
      base(),
      run(),
      0,
      {
        source: "hex",
        palette: "#ABC, #112233:2",
        strength: 0.456,
        preserveLuminance: true,
        skinProtect: 0.85,
      },
    );
    expect(inputs(workflow)).toMatchObject({
      video: "video/clip.mp4 [output]",
      reference: "",
      palette: "#aabbcc, #112233:2",
      strength: 0.46,
      preserve_luminance: true,
      skin_protect: 0.85,
      filename_prefix: VIDEO_PALETTE_PREFIX,
    });
    expect(slots.imageInputId).toBe("1");
    expect(seed).toBe(42);
  });

  it("reference mode sends the still and no palette", () => {
    const { workflow } = buildVideoPaletteWorkflow(base(), run(), 0, {
      source: "reference",
      secondRefImage: "look.png [input]",
      palette: "#ff0000",
    });
    expect(inputs(workflow)).toMatchObject({
      reference: "look.png [input]",
      palette: "",
      strength: 0.8,
      preserve_luminance: false,
      skin_protect: 0,
    });
  });

  it("clamps strength / skin and rejects bad input", () => {
    const { workflow } = buildVideoPaletteWorkflow(base(), run(), 0, {
      palette: "#000",
      strength: 7,
      skinProtect: -1,
      preserveLuminance: "true",
    });
    expect(inputs(workflow)).toMatchObject({
      strength: 1,
      skin_protect: 0,
      preserve_luminance: false,
    });
    expect(() =>
      buildVideoPaletteWorkflow(base(), run([]), 0, { palette: "#000" }),
    ).toThrow(/no video/);
    expect(() =>
      buildVideoPaletteWorkflow(base(), run(), 0, { palette: "" }),
    ).toThrow(/video_palette: palette: Add at least one/);
    expect(() =>
      buildVideoPaletteWorkflow(base(), run(), 0, { source: "reference" }),
    ).toThrow(/secondRefImage/);
    const broken = base();
    broken["1"].class_type = "SaveVideo";
    expect(() =>
      buildVideoPaletteWorkflow(broken, run(), 0, { palette: "#000" }),
    ).toThrow(/missing node 1/);
  });

  it("does not mutate the base graph", () => {
    const b = base();
    const before = JSON.stringify(b);
    buildVideoPaletteWorkflow(b, run(), 0, { palette: "#123" });
    expect(JSON.stringify(b)).toBe(before);
  });
});

describe("tools page request", () => {
  it("is a video-in action with a strength slider", () => {
    expect(spec).toBeTruthy();
    expect(spec.videoInput).toBeTruthy();
    expect(spec.secondImageOptional).toBe(true);
    expect(spec.modelCheck).toEqual({
      pack: "utility",
      action: "video_palette",
    });
    const strength = spec.sliders!.find((s) => s.key === "strength")!;
    expect(strength.default).toBe(80);
    expect(sliderValue(strength, settings({ strength: "37" }))).toBe(35);
    expect(sliderValue(strength, settings({ strength: "500" }))).toBe(100);
    expect(sliderValue(strength, settings({ strength: "" }))).toBe(80);
    expect(sliderVisible(strength, spec, settings())).toBe(true);
  });

  it("hex text box shows only for the hex source", () => {
    expect(textVisible(spec, settings())).toBe(false);
    expect(textVisible(spec, settings({ source: "hex" }))).toBe(true);
    expect(textVisible(spec, settings({ source: "reference" }))).toBe(false);
  });

  it("defaults to the first preset at 80%", () => {
    const req = buildActionRequest(spec, settings(), null);
    expect(req.action).toBe(VIDEO_PALETTE_ACTION);
    expect(req.params).toEqual({
      source: "preset",
      strength: 0.8,
      preserveLuminance: false,
      skinProtect: 0,
      palette: VIDEO_PALETTE_PRESETS[0].colors.join(", "),
    });
  });

  it("hex / reference / luminance / skin picks", () => {
    const hex = buildActionRequest(
      spec,
      settings(
        { source: "hex", luminance: "keep", skin: "protect", strength: "45" },
        "#abc #112233:2",
      ),
      null,
    );
    expect(hex.params).toEqual({
      source: "hex",
      strength: 0.45,
      preserveLuminance: true,
      skinProtect: VIDEO_PALETTE_SKIN_PROTECT,
      palette: "#aabbcc, #112233:2",
    });
    const ref = buildActionRequest(
      spec,
      settings({ source: "reference" }),
      null,
      "look.png [input]",
    );
    expect(ref.params).toMatchObject({
      source: "reference",
      secondRefImage: "look.png [input]",
    });
    expect(ref.params.palette).toBeUndefined();
    const preset = buildActionRequest(
      spec,
      settings({ preset: "candlelight" }),
      null,
    );
    expect(preset.params.palette).toBe(
      videoPalettePreset("candlelight")!.colors.join(", "),
    );
  });

  it("missing input is a ToolInputError", () => {
    expect(() =>
      buildActionRequest(spec, settings({ source: "reference" }), null),
    ).toThrow(ToolInputError);
    expect(() =>
      buildActionRequest(spec, settings({ source: "hex" }), null),
    ).toThrow(ToolInputError);
    expect(() =>
      buildActionRequest(spec, settings({ source: "hex" }, "#12"), null),
    ).toThrow(/Hex colors/);
  });

  it("request → builder end to end", () => {
    const req = buildActionRequest(
      spec,
      settings({ source: "hex" }, "#0b3c49, #e07a2f"),
      null,
    );
    const { workflow } = ACTION_BUILDERS[req.action](
      base(),
      run(),
      0,
      req.params,
    );
    expect(inputs(workflow).palette).toBe("#0b3c49, #e07a2f");
  });
});

describe("registry, routing, names, pack graph", () => {
  const reg = registry as unknown as {
    actions: Record<string, { template: string; requiresImage?: boolean }>;
    templates: Record<string, { file: string }>;
  };

  it("is registered and routed as a video-input action", () => {
    expect(ACTION_BUILDERS[VIDEO_PALETTE_ACTION]).toBe(
      buildVideoPaletteWorkflow,
    );
    expect(VIDEO_INPUT_ACTIONS.has(VIDEO_PALETTE_ACTION)).toBe(true);
    const a = reg.actions[VIDEO_PALETTE_ACTION];
    expect(reg.templates[a.template].file).toBe(
      "packs/utility/video_palette.json",
    );
    expect(a.requiresImage).toBe(false);
  });

  it("has a canonical name and search aliases", () => {
    expect(toolTitle("action:video_palette")).toBe("Video Color Palette");
    expect(toolAliases("action:video_palette")).toEqual(
      expect.arrayContaining(["color grade", "LUT", "color match"]),
    );
  });

  it("pack graph inputs match the recorded node spec", () => {
    const info = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "fixtures/videoPaletteNodes.objectInfo.json"),
        "utf-8",
      ),
    )[VIDEO_PALETTE_NODE] as {
      input: {
        required: Record<string, unknown>;
        optional?: Record<string, unknown>;
      };
      output_name: string[];
    };
    const names = [
      ...Object.keys(info.input.required),
      ...Object.keys(info.input.optional ?? {}),
    ].sort();
    const wf = base();
    expect(Object.keys(wf)).toEqual(["1"]);
    expect(wf["1"].class_type).toBe(VIDEO_PALETTE_NODE);
    expect(Object.keys(inputs(wf)).sort()).toEqual(names);
    expect(info.output_name).toEqual(["path", "cube_path"]);
  });
});

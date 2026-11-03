/**
 * Golden graphs: every Tools-page action tool, built end to end with fixed
 * inputs (UI defaults -> buildActionRequest -> the route's workflow file ->
 * buildWorkflowForAction), normalised and compared with the JSON fixtures in
 * src/__tests__/golden/. A failing case prints the node-level diff.
 *
 * Regenerate after an intended graph change:
 *   UPDATE_GOLDEN=1 vitest run src/__tests__/goldenGraphs.test.ts
 *
 * With LIVE_OBJECT_INFO=/path/to/object_info.json the fixtures are also
 * linted against that /object_info dump (skipped without it).
 * scripts/golden-render.mjs can queue the fixtures on a real ComfyUI.
 */
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Machine-specific defaults must not leak into the fixtures.
vi.hoisted(() => {
  for (const k of [
    "CJ_DEFAULT_VIDEO_PACK",
    "COMFY_VIDEO_PACKS",
    "CJ_DEFAULT_PACK",
    "NEXT_PUBLIC_CJ_DEFAULT_PACK",
    "CJ_LOW_VRAM",
    "CJ_TILED_VAE_AUTO_PIXELS",
    "COMFY_KREA2_DRAFT_UNET",
    "CJ_QWEN_IMAGE_21",
    "CJ_MOSS_IMAGE",
    "CJ_FLUX3",
    "ADRIFT_DEFAULT_EDIT_LORA",
  ])
    delete process.env[k];
});

import type { ImagineRun, Workflow } from "@/types";
import { buildWorkflowForAction } from "@/lib/oj/actionWorkflow";
import { resolveActionWorkflowPath } from "@/lib/oj/actionWorkflowPath";
import { stripWorkflowMetaKeys } from "@/lib/comfy/workflowMeta";
import { findMaskSlotIds } from "@/lib/comfy/actionMask";
import { selectControlOverridesForGraph } from "@/lib/workflowControlScope";
import { getBuiltinEditLoras, getEditFamilies } from "@/lib/krea2/editLoras";
import {
  ACTION_TOOLS,
  buildActionRequest,
  defaultSettings,
  type ActionToolSpec,
  type EditLoraListResponse,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import {
  diffGraphs,
  goldenSlug,
  normalizeGraph,
  seededRandom,
  type GoldenGraph,
} from "@/lib/tools/goldenGraphs";
import { validatePrompt } from "@/lib/comfy/validatePrompt";

const ROOT = process.cwd();
const GOLDEN_DIR = path.join(ROOT, "src/__tests__/golden");
const WORKFLOWS = path.join(ROOT, "public/workflows");
const UPDATE = process.env.UPDATE_GOLDEN === "1";
const INFO_FILE = process.env.LIVE_OBJECT_INFO;
const INFO: Record<string, unknown> | null =
  INFO_FILE && fs.existsSync(INFO_FILE)
    ? JSON.parse(fs.readFileSync(INFO_FILE, "utf-8"))
    : null;

/** Fixed fake uploads (scripts/golden-render.mjs uploads files with these names). */
const GOLDEN_INPUTS = {
  image: "golden_src.png",
  video: "golden_clip.mp4",
  audio: "golden_audio.wav",
  ref2: "golden_ref2.png",
  mask: "golden_mask.png",
  extra: (i: number) => `golden_ref${i + 3}.png`,
};
const SEED = 1234;
const NOW = new Date("2026-01-01T00:00:00Z");

interface GoldenFixture {
  name: string;
  tool: string;
  action?: string;
  workflow?: string;
  seed?: number;
  /** Building threw (missing input, unsupported default): the message. */
  error?: string;
  graph?: GoldenGraph;
}

interface GoldenCase {
  name: string;
  spec: ActionToolSpec;
  settings?: Partial<ToolSettings>;
}

const view = (name: string) =>
  `/api/comfy/view?filename=${encodeURIComponent(name)}&subfolder=&type=input`;

function sourceRun(spec: ActionToolSpec): ImagineRun {
  const video = Boolean(spec.videoInput);
  const audio = Boolean(spec.audioInput);
  const text = Boolean(spec.noSourceInput);
  return {
    run_id: "golden",
    prompt: "",
    parsedPrompt: "",
    width: 1280,
    height: 720,
    createdAt: NOW.toISOString(),
    status: "done",
    params: video ? { video_seconds: 6, audio_seconds: 4 } : {},
    jobs: text
      ? []
      : [
          {
            seed: 7,
            index: 0,
            status: "done",
            progress: 100,
            images: [view(GOLDEN_INPUTS.image)],
            ...(video ? { videos: [view(GOLDEN_INPUTS.video)] } : {}),
            ...(audio ? { audios: [view(GOLDEN_INPUTS.audio)] } : {}),
          },
        ],
  } as unknown as ImagineRun;
}

const EDIT_LORAS: EditLoraListResponse = {
  families: getEditFamilies(),
  loras: getBuiltinEditLoras().map((l) => ({ ...l, installed: true })),
} as EditLoraListResponse;

/** Input a tool can't run without (its UI makes the user click / drag it). */
const REQUIRED_INPUT: Record<string, Partial<ToolSettings>> = {
  refocus: { focusPoints: [{ x: 0.4, y: 0.5 }] },
  rack_focus: {
    focusPoints: [
      { x: 0.3, y: 0.5, t: 0.5 },
      { x: 0.7, y: 0.5, t: 3 },
    ],
  },
  sa3_inpaint: { picks: { regions: "1-2" } },
};

/** One case per tool with its UI defaults; extra cases go here. */
const CASES: GoldenCase[] = ACTION_TOOLS.filter((t) => !t.special).map(
  (spec) => ({ name: spec.id, spec, settings: REQUIRED_INPUT[spec.id] }),
);

function settingsFor(c: GoldenCase): ToolSettings {
  const { spec } = c;
  return {
    ...defaultSettings(spec),
    ...(spec.text ? { text: "golden test subject" } : {}),
    ...(spec.secondText ? { secondText: "golden second text" } : {}),
    seed: SEED,
    ...c.settings,
  } as ToolSettings;
}

function loadGraph(file: string): Workflow {
  const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<
    string,
    unknown
  >;
  return stripWorkflowMetaKeys(raw) as Workflow;
}

function buildCase(c: GoldenCase): GoldenFixture {
  const { spec } = c;
  const base = { name: c.name, tool: spec.id };
  try {
    const req = buildActionRequest(
      spec,
      settingsFor(c),
      EDIT_LORAS,
      spec.secondImage ? `${GOLDEN_INPUTS.ref2} [input]` : undefined,
      spec.audioInput
        ? { ref: `${GOLDEN_INPUTS.audio} [input]`, seconds: 4 }
        : undefined,
      (spec.extraImages ?? []).map(
        (_, i) => `${GOLDEN_INPUTS.extra(i)} [input]`,
      ),
    );
    const file = resolveActionWorkflowPath(req.action, undefined, req.params);
    if (!file)
      return { ...base, action: req.action, error: "no workflow for action" };
    const baseWorkflow = loadGraph(file);
    const maskSlotIds = findMaskSlotIds(baseWorkflow);
    const built = buildWorkflowForAction(req.action, req.params, {
      baseWorkflow,
      sourceRun: sourceRun(spec),
      maskSlotIds,
      maskRef: maskSlotIds.length ? `${GOLDEN_INPUTS.mask} [input]` : undefined,
      overrides: selectControlOverridesForGraph(req.overrides, file),
    });
    return {
      ...base,
      action: built.action,
      workflow: path.relative(WORKFLOWS, file).split(path.sep).join("/"),
      seed: built.seed,
      graph: normalizeGraph(built.workflow),
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

function fixturePath(name: string): string {
  return path.join(GOLDEN_DIR, `${goldenSlug(name)}.json`);
}

function readFixture(name: string): GoldenFixture | null {
  const p = fixturePath(name);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : null;
}

/** Readable mismatch report: header fields, then the node-level diff. */
function report(want: GoldenFixture, got: GoldenFixture): string[] {
  const lines: string[] = [];
  for (const k of ["action", "workflow", "seed", "error"] as const)
    if (want[k] !== got[k])
      lines.push(
        `${k}: ${JSON.stringify(want[k])} -> ${JSON.stringify(got[k])}`,
      );
  return [...lines, ...diffGraphs(want.graph ?? {}, got.graph ?? {})];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(Math, "random").mockImplementation(seededRandom(SEED));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("golden graphs", () => {
  it("covers a sensible tool set with unique fixture names", () => {
    expect(CASES.length).toBeGreaterThan(50);
    const slugs = CASES.map((c) => goldenSlug(c.name));
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("builds the same graph twice (fixed seed, clock and inputs)", () => {
    const c = CASES.find((x) => x.spec.id === "transition") ?? CASES[0];
    const a = buildCase(c);
    vi.spyOn(Math, "random").mockImplementation(seededRandom(SEED));
    expect(buildCase(c)).toEqual(a);
  });

  it.each(CASES.map((c) => [c.name, c] as const))("%s", (_, c) => {
    const got = buildCase(c);
    if (UPDATE) {
      fs.mkdirSync(GOLDEN_DIR, { recursive: true });
      fs.writeFileSync(
        fixturePath(c.name),
        `${JSON.stringify(got, null, 2)}\n`,
      );
      return;
    }
    const want = readFixture(c.name);
    if (!want)
      throw new Error(
        `No fixture for ${c.name}. Run UPDATE_GOLDEN=1 vitest run src/__tests__/goldenGraphs.test.ts`,
      );
    const diff = report(want, got);
    if (diff.length)
      throw new Error(
        `${c.name} graph changed (${diff.length}):\n  ${diff.join("\n  ")}\n` +
          "Intended? Rerun with UPDATE_GOLDEN=1 and commit the fixture.",
      );
  });

  it("has no fixtures left over from removed cases", () => {
    const want = new Set(CASES.map((c) => `${goldenSlug(c.name)}.json`));
    const extra = fs.existsSync(GOLDEN_DIR)
      ? fs
          .readdirSync(GOLDEN_DIR)
          .filter((f) => f.endsWith(".json") && !want.has(f))
      : [];
    if (UPDATE) {
      for (const f of extra) fs.unlinkSync(path.join(GOLDEN_DIR, f));
      return;
    }
    expect(extra).toEqual([]);
  });
});

describe.skipIf(!INFO)("golden graphs vs live /object_info", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", (_, c) => {
    const fx = readFixture(c.name);
    if (!fx?.graph) return;
    const problems = validatePrompt(fx.graph as unknown as Workflow, INFO!)
      // Model files differ per machine; installs are checked by model-status.
      .filter(
        (p) =>
          !(
            p.kind === "invalid_combo_value" &&
            /(_name|^name|ckpt|model|checkpoint|lora|vae|clip|unet|image|video|audio|file)/i.test(
              p.input ?? "",
            )
          ),
      )
      .map((p) => `${p.nodeId} ${p.classType}: ${p.message}`);
    expect(problems).toEqual([]);
  });
});

describe("goldenGraphs helpers", () => {
  const wf = {
    _meta: { note: "not a node" },
    "10": { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "a" } },
    "2": {
      class_type: "KSampler",
      _meta: { title: "Sampler" },
      inputs: { seed: 1, steps: 8, positive: "run 123e4567-e89b-12d3-a456-426614174000 at 1767225600000" },
    },
  } as unknown as Workflow;

  it("normalizeGraph keeps real nodes in id order and scrubs volatile strings", () => {
    const g = normalizeGraph(wf);
    expect(Object.keys(g)).toEqual(["2", "10"]);
    expect(g["2"]).toEqual({
      class_type: "KSampler",
      title: "Sampler",
      inputs: { positive: "run <uuid> at <time>", seed: 1, steps: 8 },
    });
  });

  it("diffGraphs names the node class and each changed input", () => {
    const before = normalizeGraph(wf);
    const after = normalizeGraph({
      ...wf,
      "2": { ...wf["2"], inputs: { ...wf["2"].inputs, seed: 2, cfg: 1 } },
      "10": undefined,
      "11": { class_type: "PreviewImage", inputs: { images: ["2", 0] } },
    } as unknown as Workflow);
    expect(diffGraphs(before, after)).toEqual([
      "~ 2 KSampler.cfg: (unset) -> 1",
      "~ 2 KSampler.seed: 1 -> 2",
      "- 10 SaveImage",
      "+ 11 PreviewImage",
    ]);
    expect(diffGraphs(before, before)).toEqual([]);
  });

  it("goldenSlug makes file-safe names", () => {
    expect(goldenSlug("Video lipsync: smart select")).toBe("video-lipsync-smart-select");
    expect(goldenSlug("sa3_inpaint")).toBe("sa3-inpaint");
  });
});

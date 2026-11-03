/**
 * Tool runner studio layout: controls column + preview stage + recent
 * strip, preset tile grids and the Generate time hint.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolRunner } from "@/components/tools/ToolRunner";
import { TemplateRunner } from "@/components/tools/TemplateRunner";
import { RunnerCardContext } from "@/components/tools/ToolCover";
import {
  PresetGrid,
  RecentRunsStrip,
  RunnerStage,
  useRecentRunsStore,
} from "@/components/tools/RunnerStudio";
import {
  ACTION_TOOLS,
  buildToolCards,
  type ActionPicker,
  type CatalogTool,
  type EditLoraListResponse,
} from "@/lib/tools/toolsPage";
import { buildHubCards, type HubCard } from "@/lib/tools/hub";
import { getEditTools, toPublicTool } from "@/lib/tools/editTools";
import { TEMPLATES, type EngineContext } from "@/lib/tools/templates";
import {
  isPresetPicker,
  mergeRecentIds,
  newRunIds,
  outputForCategory,
  picksAreFast,
  presetThumb,
  resolveRecentRuns,
  runHintLine,
  runPhase,
  runThumb,
  RECENT_RUNS_CAP,
} from "@/lib/tools/runnerStudio";
import type { ImagineJob, ImagineRun, JobStatus } from "@/types";

const editLoras: EditLoraListResponse = { families: {}, loras: [] };
const catalog = getEditTools().map((t) =>
  toPublicTool(t, { installed: true, packAvailable: true } as never),
) as unknown as CatalogTool[];
const ctx: EngineContext = {
  catalog,
  packIds: new Set(["qwen-image-edit", "krea2-edit", "audio"]),
  editLoras,
};
const toolCards = buildToolCards({
  catalog,
  packIds: ctx.packIds,
  editLoras,
  modelStatus: { tools: {} },
});
const hubCards = buildHubCards({ toolCards, ctx });
const hubCard = (key: string): HubCard => {
  const c = hubCards.find((h) => h.key === key);
  if (!c) throw new Error(`no hub card ${key}`);
  return c;
};
const noop = () => {};

function render(el: ReactElement, card?: HubCard): string {
  return renderToStaticMarkup(
    card ? createElement(RunnerCardContext.Provider, { value: card }, el) : el,
  );
}

function actionRunner(id: string): string {
  const base = toolCards.find((c) => c.key === `action:${id}`)!;
  const card = hubCard(base.key);
  return render(
    createElement(ToolRunner, {
      card: { ...base, title: card.title },
      actionSpec: ACTION_TOOLS.find((s) => s.id === id)!,
      editLoras,
      model: card.model,
      onBack: noop,
    }),
    card,
  );
}

function job(status: JobStatus, extra: Partial<ImagineJob> = {}): ImagineJob {
  return { seed: 1, index: 0, status, progress: 0, images: [], ...extra };
}

function run(
  id: string,
  jobs: ImagineJob[],
  extra: Partial<ImagineRun> = {},
): ImagineRun {
  return {
    run_id: id,
    prompt: "",
    parsedPrompt: "",
    width: 512,
    height: 512,
    jobs,
    createdAt: "2026-01-01T00:00:00Z",
    status: jobs[0]?.status ?? "queued",
    params: {},
    ...extra,
  };
}

describe("runnerStudio helpers", () => {
  it("treats named looks with 4+ options as preset grids", () => {
    const p = (key: string, n: number) =>
      ({
        key,
        title: key,
        options: Array.from({ length: n }, (_, i) => ({
          id: `o${i}`,
          label: `O${i}`,
        })),
      }) as unknown as ActionPicker;
    expect(isPresetPicker(p("look", 4))).toBe(true);
    expect(isPresetPicker(p("preset", 12))).toBe(true);
    expect(isPresetPicker(p("look", 3))).toBe(false);
    expect(isPresetPicker(p("speed", 6))).toBe(false);
  });

  it("gives each preset a stable, distinct thumbnail", () => {
    const a = presetThumb("vace_restyle:look", "anime");
    expect(presetThumb("vace_restyle:look", "anime")).toEqual(a);
    expect(presetThumb("vace_restyle:look", "noir").background).not.toBe(
      a.background,
    );
    expect(a.background).toMatch(/gradient/);
  });

  it("maps hub sections to an output kind and time hint", () => {
    expect(outputForCategory("Video")).toBe("video");
    expect(outputForCategory("VFX")).toBe("video");
    expect(outputForCategory("Audio")).toBe("audio");
    expect(outputForCategory("Image", "Describe")).toBe("text");
    expect(outputForCategory("Image", "Animate & 3D")).toBe("video");
    expect(outputForCategory(null)).toBe("image");
    expect(runHintLine("video")).toBe("Free · runs on your GPU · ~2-4 min");
    expect(runHintLine("video", true)).toBe("Free · runs on your GPU · ~1 min");
    expect(runHintLine("image", true)).toContain("~10 s");
    expect(picksAreFast({ speed: "fast" })).toBe(true);
    expect(picksAreFast({ mode: "quality", look: "fast-food" })).toBe(false);
  });

  it("tracks only this session's new runs, never shared history", () => {
    const seen = new Set(["a"]);
    const runs = [
      run("c", [job("queued")]),
      run("h", [job("done")], { historySource: "server" }),
      run("b", [job("done")]),
      run("a", [job("done")]),
    ];
    expect(newRunIds(seen, runs)).toEqual(["c", "b"]);
    expect(mergeRecentIds(["b", "x"], ["c", "b"])).toEqual(["c", "b", "x"]);
    const many = Array.from({ length: 20 }, (_, i) => `r${i}`);
    expect(mergeRecentIds([], many)).toHaveLength(RECENT_RUNS_CAP);
    expect(
      resolveRecentRuns(["c", "gone", "b"], runs).map((r) => r.run_id),
    ).toEqual(["c", "b"]);
  });

  it("derives strip thumbnails and phases", () => {
    const done = run("d", [job("done", { images: ["/i.png"] })]);
    const vid = run("v", [job("done", { videos: ["/v.mp4"] })]);
    expect(runThumb(done)).toEqual({ kind: "image", url: "/i.png" });
    expect(runThumb(vid)).toEqual({ kind: "video", url: "/v.mp4" });
    expect(runThumb(run("q", [job("running")]))).toBeNull();
    expect(runPhase(run("q", [job("running")]))).toBe("working");
    expect(runPhase(run("e", [job("error")]))).toBe("error");
    expect(runPhase(done)).toBe("done");
  });
});

describe("runner studio layout (static markup)", () => {
  beforeEach(() => useRecentRunsStore.setState({ byCard: {} }));

  it("ToolRunner: controls, Generate + hint, then the stage", () => {
    const html = actionRunner("vace_restyle");
    const controls = html.indexOf('data-testid="runner-controls"');
    const generate = html.indexOf('data-testid="runner-generate"');
    const stage = html.indexOf('data-testid="runner-stage"');
    expect(controls).toBeGreaterThan(-1);
    // DOM order = phone stacking order.
    expect(generate).toBeGreaterThan(controls);
    expect(stage).toBeGreaterThan(generate);
    expect(html).toContain('data-testid="tool-runner"');
    expect(html).toContain("Generate");
    expect(html).toMatch(
      /data-testid="run-hint"[^>]*>[\s\S]*?Free · runs on your GPU · ~/,
    );
    // Empty stage shows the tool's own example art, no strip yet.
    expect(html).toContain("Your result will show here");
    expect(html).not.toContain('data-testid="recent-runs"');
  });

  it("ToolRunner: look presets render as a radio tile grid", () => {
    const html = actionRunner("vace_restyle");
    expect(html).toContain('data-testid="preset-grid-vace_restyle:look"');
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/role="radio"/g)!.length).toBeGreaterThanOrEqual(4);
    const grid = html.slice(
      html.indexOf('data-testid="preset-grid-vace_restyle:look"'),
    );
    const end = grid.indexOf("</div></div></div>");
    expect(grid.slice(0, end).match(/aria-checked="true"/g)).toHaveLength(1);
  });

  it("ToolRunner: long preset lists get a labeled search box", () => {
    const html = actionRunner("wan_motion");
    expect(html).toContain('data-testid="preset-grid-wan_motion:preset"');
    expect(html).toMatch(/<input[^>]*aria-label="Search [^"]+"/);
  });

  it("palette presets use their own swatches as tile art", () => {
    const html = actionRunner("video_palette");
    const grid = html.slice(
      html.indexOf('data-testid="preset-grid-video_palette:preset"'),
    );
    expect(grid).toMatch(/background-color:#[0-9a-f]{3,6}/i);
  });

  it("TemplateRunner multi looks: toggle tiles inside a studio shell", () => {
    const template = TEMPLATES.find((t) => t.multi)!;
    const card = hubCard(`template:${template.id}`);
    const html = render(
      createElement(TemplateRunner, { template, card, ctx, onBack: noop }),
      card,
    );
    expect(html).toContain('data-testid="runner-studio"');
    expect(html).toContain(`data-testid="preset-grid-template:${template.id}"`);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-testid="run-hint"');
  });

  it("PresetGrid filters by nothing and labels every tile", () => {
    const html = render(
      createElement(PresetGrid, {
        label: "Light",
        pickerKey: "t:light",
        options: [
          { id: "a", label: "Golden hour" },
          { id: "b", label: "Neon" },
          { id: "c", label: "Studio" },
          { id: "d", label: "Overcast" },
        ],
        value: "b",
        onChange: noop,
      }),
    );
    for (const l of ["Golden hour", "Neon", "Studio", "Overcast"])
      expect(html).toContain(l);
    expect(html).not.toContain('type="search"');
    expect(html).toMatch(/aria-checked="true"[^>]*title="Neon"/);
  });

  it("stage shows the newest run; strip lists each run with a name", () => {
    const runs = [
      run("new", [job("running", { progress: 40 })]),
      run("old", [job("done", { images: ["/o.png"] })]),
    ];
    const html = render(createElement(RunnerStage, { runs }));
    expect(html).toContain("Working... 40%");
    expect(html).toContain('data-testid="recent-runs"');
    expect(html).toContain('aria-label="Show result 1 (working)"');
    expect(html).toContain('aria-label="Show result 2"');
    expect(html).toContain('src="/o.png"');
    const strip = render(
      createElement(RecentRunsStrip, {
        runs,
        selectedId: "old",
        onSelect: noop,
      }),
    );
    expect(strip.match(/aria-pressed="true"/g)).toHaveLength(1);
  });

  it("stage renders a finished image result for the lightbox", () => {
    const html = render(
      createElement(RunnerStage, {
        runs: [run("d", [job("done", { images: ["/d.png"] })])],
      }),
    );
    expect(html).toContain('data-testid="tool-run-result"');
    expect(html).toContain('alt="Tool result"');
  });

  it("recent store merges per tool key", () => {
    useRecentRunsStore.getState().note("action:x", ["a"]);
    useRecentRunsStore.getState().note("action:x", ["b"]);
    useRecentRunsStore.getState().note("action:y", ["c"]);
    expect(useRecentRunsStore.getState().byCard).toEqual({
      "action:x": ["b", "a"],
      "action:y": ["c"],
    });
  });
});

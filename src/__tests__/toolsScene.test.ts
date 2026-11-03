import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_SCENE,
  applySceneFill,
  optionLongEdge,
  optionSeconds,
  patchedFields,
  sanitizeScene,
  sceneFill,
  sceneSourced,
  sceneSummary,
  type Scene,
} from "@/lib/tools/scene";
import {
  defaultSettings,
  getActionTool,
  type ActionToolId,
  type CatalogTool,
} from "@/lib/tools/toolsPage";
import { STORAGE_KEYS } from "@/lib/storageKeys";
import { SceneButton, ScenePanel } from "@/components/tools/SceneChip";

const scene = (p: Partial<Scene>): Scene => ({ ...DEFAULT_SCENE, ...p });
const spec = (id: string) => getActionTool(id as ActionToolId)!;

const catalog = (outpaint: boolean): CatalogTool =>
  ({
    id: "c",
    loras: [],
    speed: { supported: false },
    extras: { keepFraming: null },
    outpaint: outpaint
      ? { default: "16:9", fill: "", maxSide: 1, presets: [] }
      : null,
  }) as unknown as CatalogTool;

describe("sanitizeScene", () => {
  it("keeps valid fields and drops bad ones", () => {
    expect(
      sanitizeScene({
        apply: false,
        aspect: "7:3",
        longEdge: 1024,
        seed: 12.7,
        seedLocked: "yes",
        duration: -1,
        style: 5,
      }),
    ).toEqual({
      ...DEFAULT_SCENE,
      apply: false,
      longEdge: 1024,
      seed: 12,
    });
    expect(sanitizeScene(null)).toEqual(DEFAULT_SCENE);
  });
});

describe("option measures", () => {
  it("reads long edge from 720p and px labels", () => {
    expect(optionLongEdge({ id: "720p", label: "720p" })).toBe(1280);
    expect(optionLongEdge({ id: "1024", label: "1024 px (slow)" })).toBe(1024);
    expect(optionLongEdge({ id: "auto", label: "Auto" })).toBeNull();
  });
  it("reads seconds from s and min labels", () => {
    expect(optionSeconds({ id: "5s", label: "5 s" })).toBe(5);
    expect(optionSeconds({ id: "60", label: "1 min" })).toBe(60);
    expect(optionSeconds({ id: "long", label: "Long clip" })).toBeNull();
  });
});

describe("sceneFill", () => {
  it("fills nothing while off", () => {
    expect(
      sceneFill(
        spec("multiframe_ref"),
        scene({ apply: false, aspect: "9:16" }),
      ),
    ).toEqual({});
  });

  it("maps aspect, size and length onto a video card's pickers", () => {
    expect(
      sceneFill(
        spec("multiframe_ref"),
        scene({ aspect: "9:16", longEdge: 1024, duration: 7 }),
      ),
    ).toEqual({
      "picks.aspect": "9:16",
      "picks.resolution": "768",
      "picks.duration": "8",
    });
  });

  it("picks the smallest size that reaches the target", () => {
    const fill = (longEdge: number) =>
      sceneFill(spec("wan_camera"), scene({ longEdge }))["picks.resolution"];
    expect(fill(640)).toBe("480p");
    expect(fill(1024)).toBe("720p");
    expect(fill(4096)).toBe("720p");
  });

  it("skips an aspect the card doesn't offer", () => {
    expect(sceneFill(spec("multiframe_ref"), scene({ aspect: "4:5" }))).toEqual(
      {},
    );
  });

  it("leaves audio cards' length and style alone", () => {
    expect(
      sceneFill(spec("music"), scene({ duration: 30, style: "noir" })),
    ).toEqual({});
  });

  it("fills an empty style prompt, not other prompts", () => {
    expect(
      sceneFill(spec("restyle_locked"), scene({ style: " noir " })),
    ).toEqual({ text: "noir" });
    expect(sceneFill(spec("ltx25_animate"), scene({ style: "noir" }))).toEqual(
      {},
    );
  });

  it("shares the seed only while locked, and only where a seed field shows", () => {
    expect(sceneFill(spec("video_retake"), scene({ seed: 7 }))).toEqual({});
    expect(
      sceneFill(spec("video_retake"), scene({ seed: 7, seedLocked: true })),
    ).toEqual({ seed: 7 });
    expect(
      sceneFill(spec("multiframe_ref"), scene({ seed: 7, seedLocked: true })),
    ).toEqual({});
  });

  it("fills a catalog card's seed and outpaint aspect", () => {
    const s = scene({ seed: 3, seedLocked: true, aspect: "9:16" });
    expect(sceneFill(catalog(true), s)).toEqual({
      seed: 3,
      outpaintAspect: "9:16",
    });
    expect(sceneFill(catalog(false), s)).toEqual({ seed: 3 });
  });
});

describe("applySceneFill", () => {
  const base = defaultSettings(spec("multiframe_ref"));
  const none = new Set<string>();

  it("fills untouched fields and marks them from scene", () => {
    const fill = { "picks.aspect": "9:16", seed: 4 };
    const s = applySceneFill(base, base, {}, fill, none);
    expect(s.picks.aspect).toBe("9:16");
    expect(s.seed).toBe(4);
    expect([...sceneSourced(s, fill, none)].sort()).toEqual([
      "picks.aspect",
      "seed",
    ]);
  });

  it("keeps a field edited on the card", () => {
    const prev = { "picks.aspect": "9:16" };
    const edited = { ...base, picks: { aspect: "1:1" } };
    const touched = new Set(["picks.aspect"]);
    const next = { "picks.aspect": "16:9" };
    const s = applySceneFill(edited, base, prev, next, touched);
    expect(s.picks.aspect).toBe("1:1");
    expect(sceneSourced(s, next, touched).size).toBe(0);
  });

  it("keeps a value set elsewhere (Made with prefill) when the scene changes", () => {
    const prefilled = { ...base, picks: { aspect: "1:1" } };
    const s = applySceneFill(
      prefilled,
      base,
      { "picks.aspect": "9:16" },
      { "picks.aspect": "16:9" },
      none,
    );
    expect(s.picks.aspect).toBe("1:1");
  });

  it("follows scene changes and resets to the default when cleared", () => {
    const a = applySceneFill(base, base, {}, { "picks.aspect": "9:16" }, none);
    const b = applySceneFill(
      a,
      base,
      { "picks.aspect": "9:16" },
      { "picks.aspect": "1:1" },
      none,
    );
    expect(b.picks.aspect).toBe("1:1");
    const c = applySceneFill(b, base, { "picks.aspect": "1:1" }, {}, none);
    expect("aspect" in c.picks).toBe(false);
    const t = applySceneFill(base, base, {}, { text: "noir" }, none);
    expect(applySceneFill(t, base, { text: "noir" }, {}, none).text).toBe("");
  });

  it("returns the same object when nothing changes", () => {
    expect(applySceneFill(base, base, {}, {}, none)).toBe(base);
  });

  it("names the fields a patch writes", () => {
    expect(patchedFields({ seed: 1, text: "x" })).toEqual(["seed", "text"]);
  });
});

describe("Scene chip", () => {
  it("summarizes the scene, or says off", () => {
    expect(
      sceneSummary(
        scene({ aspect: "16:9", longEdge: 1024, duration: 5, style: "x" }),
      ),
    ).toBe("16:9 · 1024 px · 5 s · style");
    const html = (s: Scene) =>
      renderToStaticMarkup(
        createElement(SceneButton, {
          scene: s,
          open: false,
          panelId: "p",
          onClick: () => {},
        }),
      );
    expect(html(scene({ aspect: "9:16" }))).toContain("9:16");
    expect(html(scene({ apply: false, aspect: "9:16" }))).toContain("off");
  });

  it("renders the apply toggle and fields", () => {
    const html = renderToStaticMarkup(
      createElement(ScenePanel, {
        id: "p",
        scene: scene({ aspect: "1:1" }),
        onChange: () => {},
        onClear: () => {},
      }),
    );
    expect(html).toContain("Apply scene to tools");
    expect(html).toContain("Size (long edge)");
    expect(html).toContain("Video length");
    expect(html).toContain('aria-checked="true"');
  });
});

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

describe("sceneStore", () => {
  const KEY = STORAGE_KEYS.toolsScene;
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("localStorage", memoryStorage());
  });

  it("persists per browser under its own key", async () => {
    expect(KEY).toBe("adrift.tools-scene");
    const { useSceneStore } = await import("@/store/sceneStore");
    useSceneStore.getState().update({ aspect: "9:16", seed: 9 });
    expect(JSON.parse(localStorage.getItem(KEY)!).state.scene).toMatchObject({
      aspect: "9:16",
      seed: 9,
      apply: true,
    });
  });

  it("rehydrates sanitized and clear keeps the toggle", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: { scene: { apply: false, aspect: "bad", longEdge: 1280 } },
        version: 1,
      }),
    );
    const { useSceneStore } = await import("@/store/sceneStore");
    expect(useSceneStore.getState().scene).toEqual({
      ...DEFAULT_SCENE,
      apply: false,
      longEdge: 1280,
    });
    useSceneStore.getState().clear();
    expect(useSceneStore.getState().scene).toEqual({
      ...DEFAULT_SCENE,
      apply: false,
    });
  });
});

describe("ToolRunner with a scene", () => {
  // The SSR snapshot of a zustand store is its initial state, so the store
  // is mocked to hand the runner a set scene.
  async function renderRunner(id: string, s: Scene): Promise<string> {
    vi.resetModules();
    vi.doMock("@/store/sceneStore", () => ({
      useSceneStore: (sel: (st: { scene: Scene }) => unknown) =>
        sel({ scene: s }),
    }));
    const { ToolRunner } = await import("@/components/tools/ToolRunner");
    const { buildToolCards } = await import("@/lib/tools/toolsPage");
    const card = buildToolCards({
      catalog: [],
      packIds: new Set(),
      editLoras: { families: {}, loras: [] },
      modelStatus: { tools: {} },
    } as never).find((c) => c.key === `action:${id}`)!;
    const html = renderToStaticMarkup(
      createElement(ToolRunner, {
        card,
        actionSpec: spec(id),
        onBack: () => {},
      } as never),
    );
    vi.doUnmock("@/store/sceneStore");
    return html;
  }

  it("fills the card's pickers and marks them from scene", async () => {
    const html = await renderRunner(
      "multiframe_ref",
      scene({ aspect: "9:16", duration: 8 }),
    );
    expect(html.match(/data-testid="from-scene"/g)?.length).toBe(2);
    expect(html).toMatch(/aria-checked="true"[^>]*>(?:<[^>]+>)*9:16/);
    expect(html).toMatch(/aria-checked="true"[^>]*>(?:<[^>]+>)*8 s/);
  });

  it("marks nothing while the scene is off", async () => {
    const html = await renderRunner(
      "multiframe_ref",
      scene({ apply: false, aspect: "9:16" }),
    );
    expect(html).not.toContain('data-testid="from-scene"');
    expect(html).toMatch(/aria-checked="true"[^>]*>(?:<[^>]+>)*16:9/);
  });
});

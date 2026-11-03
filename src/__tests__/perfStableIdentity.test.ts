/**
 * Re-render reduction (critique #34), measured as prop-identity churn: a
 * React.memo row/editor re-renders exactly when its props change identity, so
 * "objects with a new identity after one edit" == "rows re-rendered".
 */
import { describe, expect, it } from "vitest";
import oi from "./fixtures/objectInfo.inputOptions.json";
import type { ObjectInfoIndex } from "@/lib/oj/inputSpec";
import {
  applyInputSpecs,
  buildControlSchema,
  syncDynamicComboControls,
} from "@/lib/oj/workflowControlSchema";
import {
  computeEffectiveControls,
  getEditableControls,
} from "@/store/workflowControlStore";
import {
  sameItems,
  shallowEqualDeep1,
  stabilizeByKey,
} from "@/lib/ui/stableIdentity";
import {
  stabilizeEffectiveControls,
  type EffectiveControl,
} from "@/components/workflowControls/stableControls";
import { stabilizeRunGroups } from "@/lib/galleryRunGroups";

const INDEX = oi as unknown as ObjectInfoIndex;

const T2I = {
  "3": {
    class_type: "KSampler",
    inputs: {
      seed: 1,
      steps: 20,
      cfg: 7,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1,
      model: ["4", 0],
      positive: ["6", 0],
      negative: ["7", 0],
      latent_image: ["5", 0],
    },
  },
  "4": {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "a.safetensors" },
  },
  "5": {
    class_type: "EmptyLatentImage",
    inputs: { width: 1024, height: 1024, batch_size: 1 },
  },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "a", clip: ["4", 1] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "b", clip: ["4", 1] } },
  "8": { class_type: "CLIPSetLastLayer", inputs: { stop_at_clip_layer: -2, clip: ["4", 1] } },
};

/** The WorkflowControlPanel pipeline: spec enrich → editable → effective. */
function panelControls(overrides: Record<string, unknown>): EffectiveControl[] {
  const base = buildControlSchema(T2I as never).controls;
  const spec = syncDynamicComboControls(
    applyInputSpecs(base, INDEX, overrides),
    INDEX,
    overrides,
  );
  return computeEffectiveControls(getEditableControls(spec), overrides);
}

const changed = <T>(a: readonly T[], b: readonly T[]) =>
  b.filter((item, i) => item !== a[i]).length;

describe("shallowEqualDeep1 / sameItems / stabilizeByKey", () => {
  it("compares one nested level of plain objects and arrays", () => {
    expect(shallowEqualDeep1({ a: 1, r: { x: 1 } }, { a: 1, r: { x: 1 } })).toBe(true);
    expect(shallowEqualDeep1({ a: 1, o: ["a"] }, { a: 1, o: ["a"] })).toBe(true);
    expect(shallowEqualDeep1({ a: 1, r: { x: 1 } }, { a: 1, r: { x: 2 } })).toBe(false);
    expect(shallowEqualDeep1({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(shallowEqualDeep1({ r: { d: { x: 1 } } }, { r: { d: { x: 1 } } })).toBe(false);
    expect(shallowEqualDeep1(new Date(0), new Date(0))).toBe(false);
  });

  it("sameItems is element-identity equality", () => {
    const o = {};
    expect(sameItems([o], [o])).toBe(true);
    expect(sameItems([o], [{}])).toBe(false);
    expect(sameItems([o], [o, o])).toBe(false);
  });

  it("stabilizeByKey reuses equal items and drops stale keys from the cache", () => {
    const first = stabilizeByKey(
      [{ k: "a", v: 1 }, { k: "b", v: 1 }],
      new Map(),
      (x) => x.k,
      (x, y) => x.v === y.v,
    );
    const second = stabilizeByKey(
      [{ k: "a", v: 1 }, { k: "c", v: 1 }],
      first.cache,
      (x) => x.k,
      (x, y) => x.v === y.v,
    );
    expect(second.items[0]).toBe(first.items[0]);
    expect(second.items[1]).not.toBe(first.items[1]);
    expect([...second.cache.keys()]).toEqual(["a", "c"]);
  });
});

describe("WorkflowControlPanel: one edit re-renders one editor", () => {
  it("before: every control object is rebuilt by a single override edit", () => {
    const a = panelControls({});
    const b = panelControls({ "3.steps": 30 });
    expect(a.length).toBeGreaterThan(8);
    expect(changed(a, b)).toBe(a.length);
  });

  it("after: only the edited control changes identity", () => {
    const a = panelControls({});
    const s1 = stabilizeEffectiveControls(a, new Map());
    const s2 = stabilizeEffectiveControls(panelControls({ "3.steps": 30 }), s1.cache);
    expect(changed(s1.items, s2.items)).toBe(1);
    const edited = s2.items.find((c) => c.key === "3.steps")!;
    expect(edited.effectiveValue).toBe(30);
    expect(edited.isOverridden).toBe(true);
    // Values are never stale: every item deep-equals a fresh computation.
    expect(s2.items).toEqual(panelControls({ "3.steps": 30 }));
  });

  it("resetting an override restores the original object values", () => {
    const s1 = stabilizeEffectiveControls(panelControls({ "3.cfg": 4 }), new Map());
    const s2 = stabilizeEffectiveControls(panelControls({}), s1.cache);
    expect(changed(s1.items, s2.items)).toBe(1);
    expect(s2.items.find((c) => c.key === "3.cfg")!.isOverridden).toBe(false);
  });
});

describe("Gallery run groups keyed by run", () => {
  type Img = { id: string; liked?: boolean };
  type Group = { runId: string; images: Img[] };
  const runs = (n: number): Group[] =>
    Array.from({ length: n }, (_, i) => ({
      runId: `r${i}`,
      images: [0, 1, 2, 3].map((j) => ({ id: `r${i}-${j}` })),
    }));
  // groupImagesByRun builds fresh group objects + arrays on every pass.
  const regroup = (gs: Group[]): Group[] =>
    gs.map((g) => ({ runId: g.runId, images: [...g.images] }));

  it("liking one image re-renders one row instead of all 50", () => {
    const base = runs(50);
    const s1 = stabilizeRunGroups("2026-10-27", regroup(base), new Map());
    const liked = base.map((g, i) =>
      i === 7
        ? { ...g, images: g.images.map((im, j) => (j === 2 ? { ...im, liked: true } : im)) }
        : g,
    );
    const before = regroup(liked);
    expect(changed(s1.items, before)).toBe(50);
    const s2 = stabilizeRunGroups("2026-10-27", regroup(liked), s1.cache);
    expect(changed(s1.items, s2.items)).toBe(1);
    expect(s2.items[7].images[2].liked).toBe(true);
  });

  it("a new run at the top leaves existing rows untouched", () => {
    const base = runs(10);
    const s1 = stabilizeRunGroups("d", regroup(base), new Map());
    const withNew = [{ runId: "new", images: [{ id: "n" }] }, ...base];
    const s2 = stabilizeRunGroups("d", regroup(withNew), s1.cache);
    expect(s2.items.slice(1)).toEqual(s1.items);
    s2.items.slice(1).forEach((g, i) => expect(g).toBe(s1.items[i]));
  });

  it("the same run on two days is cached separately", () => {
    const g = { runId: "r", images: [{ id: "x" }] };
    const today = stabilizeRunGroups("d1", [g], new Map());
    const other = stabilizeRunGroups("d2", [{ runId: "r", images: [{ id: "y" }] }], today.cache);
    expect(other.items[0].images[0].id).toBe("y");
  });
});

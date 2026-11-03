import { describe, expect, it } from "vitest";
import {
  graphIdFromWorkflowPath,
  isScopedOverrides,
  mergeScopedOverrides,
  selectControlOverridesForGraph,
} from "@/lib/workflowControlScope";

describe("graphIdFromWorkflowPath", () => {
  it("normalizes relative, absolute, saved and video-variant paths", () => {
    expect(graphIdFromWorkflowPath("packs/krea2/t2i.json")).toBe(
      "packs/krea2/t2i.json",
    );
    expect(
      graphIdFromWorkflowPath("/app/public/workflows/packs/krea2/t2i.json"),
    ).toBe("packs/krea2/t2i.json");
    expect(
      graphIdFromWorkflowPath("C:\\app\\public\\workflows\\packs\\x\\i2v.json"),
    ).toBe("packs/x/i2v.json");
    expect(graphIdFromWorkflowPath("./t2i.json")).toBe("t2i.json");
    expect(graphIdFromWorkflowPath("saved:my.json")).toBe("saved:my.json");
    expect(graphIdFromWorkflowPath("packs/ltx25/i2v.video.json")).toBe(
      "packs/ltx25/i2v.json",
    );
    expect(graphIdFromWorkflowPath("")).toBeNull();
    expect(graphIdFromWorkflowPath(undefined)).toBeNull();
  });
});

describe("scoped control overrides", () => {
  const t2i = "packs/ltx25/t2v.json";
  const i2v = "packs/ltx25/i2v.json";

  it("a t2i override never reaches i2v (same node id)", () => {
    const store = mergeScopedOverrides({}, t2i, { "3.steps": 40 });
    expect(isScopedOverrides(store)).toBe(true);
    expect(selectControlOverridesForGraph(store, i2v)).toEqual({});
    expect(
      selectControlOverridesForGraph(
        store,
        "/srv/app/public/workflows/packs/ltx25/i2v.json",
      ),
    ).toEqual({});
    expect(
      selectControlOverridesForGraph(
        store,
        "/srv/app/public/workflows/packs/ltx25/t2v.json",
      ),
    ).toEqual({ "3.steps": 40 });
  });

  it("keeps tweaks for several graphs and drops a graph when emptied", () => {
    let store = mergeScopedOverrides({}, t2i, { "3.steps": 40 });
    store = mergeScopedOverrides(store, i2v, { "5.cfg": 2 });
    expect(selectControlOverridesForGraph(store, t2i)).toEqual({
      "3.steps": 40,
    });
    expect(selectControlOverridesForGraph(store, i2v)).toEqual({ "5.cfg": 2 });
    store = mergeScopedOverrides(store, t2i, {});
    expect(store.__byGraph).not.toHaveProperty(t2i);
    expect(selectControlOverridesForGraph(store, i2v)).toEqual({ "5.cfg": 2 });
  });

  it("discards a legacy flat map when merging", () => {
    const store = mergeScopedOverrides({ "3.steps": 99 }, t2i, { "4.cfg": 1 });
    expect(store).toEqual({ __byGraph: { [t2i]: { "4.cfg": 1 } } });
  });

  it("applies the video variant of the same graph", () => {
    const store = mergeScopedOverrides({}, i2v, { "5.cfg": 2 });
    expect(
      selectControlOverridesForGraph(store, "packs/ltx25/i2v.video.json"),
    ).toEqual({ "5.cfg": 2 });
  });

  it("passes explicit flat per-request maps through unchanged", () => {
    const flat = { "2.lora_name": "x.safetensors", "23.upscale_by": 2 };
    expect(selectControlOverridesForGraph(flat, i2v)).toEqual(flat);
    expect(selectControlOverridesForGraph(flat, null)).toEqual(flat);
  });

  it("an envelope with no graph (overlay / direct routes) applies nothing", () => {
    const store = mergeScopedOverrides({}, t2i, { "3.steps": 40 });
    expect(selectControlOverridesForGraph(store, null)).toEqual({});
  });

  it("ignores non-objects", () => {
    expect(selectControlOverridesForGraph(null, t2i)).toEqual({});
    expect(selectControlOverridesForGraph([1, 2], t2i)).toEqual({});
    expect(selectControlOverridesForGraph("x", t2i)).toEqual({});
  });
});

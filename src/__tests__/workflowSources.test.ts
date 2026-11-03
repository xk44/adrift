import { afterEach, describe, expect, it } from "vitest";
import {
  filterSourcesForSlot,
  findSourceByPath,
  kindFitsSlot,
  listWorkflowSources,
  packKeyToKind,
  packWorkflowSources,
  registerWorkflowSourceProvider,
  type WorkflowSourceEntry,
} from "@/lib/workflowSources";
import { getAllPacks, type WorkflowPack } from "@/lib/oj/packs";
import { WORKFLOW_ASSIGNMENT_SLOTS } from "@/lib/workflowAssignments";

const fakePack = {
  id: "fake",
  name: "Fake",
  workflows: {
    t2i: "packs/fake/t2i.json",
    i2i: "packs/fake/i2i.json",
    vary_subtle: "packs/fake/i2i.json",
    vary_strong: "packs/fake/i2i.json",
    i2v: "packs/fake/i2v.json",
    edit_instruct: "packs/fake/edit.json",
  },
} as unknown as WorkflowPack;

describe("packWorkflowSources", () => {
  it("lists pack graphs with their kind, deduped by file+kind", () => {
    const entries = packWorkflowSources([fakePack]);
    expect(entries.map((e) => [e.workflowPath, e.kind])).toEqual([
      ["packs/fake/t2i.json", "t2i"],
      ["packs/fake/i2i.json", "i2i"],
      ["packs/fake/i2v.json", "i2v"],
    ]);
    expect(entries.every((e) => e.source === "pack" && e.packId === "fake")).toBe(true);
  });

  it("skips specialised graphs that fit no slot", () => {
    expect(packKeyToKind("edit_instruct")).toBeUndefined();
    expect(packKeyToKind("zoom_2x")).toBe("outpaint");
    expect(packKeyToKind("make_3d_trellis")).toBe("i23d");
  });

  it("every real pack graph path is relative to public/workflows", () => {
    for (const e of packWorkflowSources(getAllPacks())) {
      expect(e.workflowPath.startsWith("/")).toBe(false);
      expect(e.workflowPath.startsWith("saved:")).toBe(false);
    }
  });
});

describe("listWorkflowSources", () => {
  let off: (() => void) | undefined;
  afterEach(() => off?.());

  it("merges saved, extra/user and pack entries", () => {
    const user: WorkflowSourceEntry = {
      id: "user:abc",
      source: "user",
      label: "Imported",
      kind: "i2i",
      workflowPath: "user:abc",
    };
    const list = listWorkflowSources({
      saved: [
        { name: "Mine", file: "mine.json", kind: "t2i" },
        { name: "Odd", file: "odd.json", kind: "unknown" },
        {
          name: "Broken",
          file: "broken.json",
          kind: "i2v",
          runtime: { checked: true, missingCount: 2 },
        },
      ],
      packs: [fakePack],
      extra: [user],
    });
    expect(list[0]).toMatchObject({
      source: "saved",
      workflowPath: "saved:mine.json",
      kind: "t2i",
    });
    expect(findSourceByPath(list, "saved:odd.json")?.kind).toBe("unknown");
    expect(findSourceByPath(list, "saved:broken.json")?.missingCount).toBe(2);
    expect(findSourceByPath(list, "user:abc")?.source).toBe("user");
    expect(findSourceByPath(list, "packs/fake/i2v.json")?.source).toBe("pack");
  });

  it("includes registered providers and survives a throwing one", () => {
    off = registerWorkflowSourceProvider(() => [
      {
        id: "user:p",
        source: "user",
        label: "From provider",
        kind: "upscale",
        workflowPath: "user:p",
      },
    ]);
    const off2 = registerWorkflowSourceProvider(() => {
      throw new Error("boom");
    });
    const list = listWorkflowSources({ packs: [] });
    off2();
    expect(list.map((e) => e.id)).toEqual(["user:p"]);
  });
});

describe("filterSourcesForSlot", () => {
  const list = listWorkflowSources({
    saved: [
      { name: "T2I", file: "a.json", kind: "t2i" },
      { name: "Unknown", file: "b.json" },
    ],
    packs: [fakePack],
  });

  it("an i2v slot never offers a text-to-image graph", () => {
    const { matching, unknown } = filterSourcesForSlot(list, "i2v");
    expect(matching.map((e) => e.workflowPath)).toEqual(["packs/fake/i2v.json"]);
    expect(unknown.map((e) => e.workflowPath)).toEqual(["saved:b.json"]);
  });

  it("every real slot kind has at least one built-in pack option", () => {
    const all = listWorkflowSources();
    const missing = WORKFLOW_ASSIGNMENT_SLOTS.filter(
      (slot) =>
        slot.recommendedKind &&
        slot.recommendedKind !== "t2a" &&
        filterSourcesForSlot(all, slot.recommendedKind).matching.length === 0,
    ).map((s) => s.id);
    expect(missing).toEqual([]);
  });

  it("kindFitsSlot gates the quick Selected/Default buttons", () => {
    expect(kindFitsSlot("t2i", "t2i")).toBe(true);
    expect(kindFitsSlot("t2i", "i2v")).toBe(false);
    expect(kindFitsSlot(undefined, "i2v")).toBe(false);
    expect(kindFitsSlot("t2i", undefined)).toBe(true);
  });
});

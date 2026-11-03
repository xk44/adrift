import { describe, expect, it } from "vitest";
import {
  filterParamChips,
  isDisplayableParam,
  isInternalParamKey,
  isNoopParamValue,
  partitionDisplayParams,
} from "@/lib/ui/displayParams";
import { buildGalleryParamChips } from "@/lib/galleryParams";
import { formatParamsForDisplay } from "@/lib/oj/engine";

const LEAKY_PARAMS = {
  ar: "1:1",
  stylize: 250,
  chaos: 10,
  sref: "12345",
  raw: true,
  action_source_run_id: "run-001",
  action_workflow_path:
    "/Users/someone/adrift/public/workflows/vary_subtle.json",
  packId: "minimax",
  mossSpeed: "off",
  editMode: "instruct",
  srefParams: { items: [{ code: "1" }] },
  mossLayout: [{ x: 0, y: 0, w: 1, h: 1, prompt: "cat" }],
  wildcards: { colour: "red" },
  auto_detail_summary: "probe ok",
  _internal: 1,
  source_run_id: "abc",
  workflowPath: "/tmp/x.json",
};

describe("isInternalParamKey", () => {
  it.each([
    "action_source_run_id",
    "action_workflow_path",
    "_debug",
    "packId",
    "pack_id",
    "editMode",
    "srefParams",
    "mossLayout",
    "wildcards",
    "workflow",
    "workflowPath",
    "lora_path",
    "source_run_id",
    "sourceRunId",
  ])("hides %s", (key) => {
    expect(isInternalParamKey(key)).toBe(true);
  });

  it.each([
    "ar",
    "stylize",
    "chaos",
    "sref",
    "seed",
    "v",
    "raw",
    "lora",
    "mossSpeed",
    "weird",
  ])("keeps %s", (key) => {
    expect(isInternalParamKey(key)).toBe(false);
  });
});

describe("isNoopParamValue", () => {
  it.each([
    undefined,
    null,
    false,
    "",
    "  ",
    "off",
    "OFF",
    "none",
    [],
    {},
    [{ a: 1 }],
    NaN,
  ])("treats %p as no-op", (value) => {
    expect(isNoopParamValue(value)).toBe(true);
  });

  it.each([true, 0, 250, "1:1", "fast", ["a", "b"]])("keeps %p", (value) => {
    expect(isNoopParamValue(value)).toBe(false);
  });
});

describe("partitionDisplayParams", () => {
  it("keeps the full map: everything lands in visible or hidden", () => {
    const { visible, hidden } = partitionDisplayParams(LEAKY_PARAMS);
    expect(visible.map(([k]) => k)).toEqual([
      "ar",
      "stylize",
      "chaos",
      "sref",
      "raw",
    ]);
    expect(visible.length + hidden.length).toBe(
      Object.keys(LEAKY_PARAMS).length,
    );
  });
});

describe("chip builders use the shared filter", () => {
  it("buildGalleryParamChips drops internal keys and absolute paths", () => {
    const chips = buildGalleryParamChips(LEAKY_PARAMS, 7);
    expect(chips).toEqual([
      "ar 1:1",
      "stylize 250",
      "chaos 10",
      "sref 12345",
      "raw",
      "--seed 7",
    ]);
    expect(chips.join(" ")).not.toMatch(
      /\/Users|run-001|minimax|instruct|object/,
    );
  });

  it("formatParamsForDisplay drops internal keys", () => {
    const chips = formatParamsForDisplay(LEAKY_PARAMS);
    expect(chips).toEqual([
      "1:1",
      "chaos 10",
      "stylize 250",
      "sref 12345",
      "raw",
    ]);
  });

  it("shows a non-default MOSS speed under its typed flag name", () => {
    expect(buildGalleryParamChips({ mossSpeed: "fast" })).toEqual([
      "speed fast",
    ]);
    expect(formatParamsForDisplay({ mossSpeed: "turbo" })).toEqual([
      "speed turbo",
    ]);
  });
});

describe("filterParamChips (persisted chip strings)", () => {
  it("strips leaked chips stored by older gallery entries", () => {
    expect(
      filterParamChips([
        "ar 16:9",
        "action_source_run_id run-001",
        "action_workflow_path /Users/someone/public/workflows/vary_subtle.json",
        "packId minimax",
        "mossSpeed off",
        "editMode instruct",
        "srefParams [object Object]",
        "raw",
        "16:9",
        "--seed 42",
      ]),
    ).toEqual(["ar 16:9", "raw", "16:9", "--seed 42"]);
  });

  it("relabels aliased keys, preserving dashes", () => {
    expect(filterParamChips(["mossSpeed fast", "--mossSpeed turbo"])).toEqual([
      "speed fast",
      "--speed turbo",
    ]);
  });

  it("isDisplayableParam combines key and value rules", () => {
    expect(isDisplayableParam("stylize", 100)).toBe(true);
    expect(isDisplayableParam("stylize", null)).toBe(false);
    expect(isDisplayableParam("packId", "wan")).toBe(false);
  });
});

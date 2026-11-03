import { describe, expect, it } from "vitest";
import {
  drawRect,
  effectiveAspect,
  isMossT2iWorkflowPath,
  layoutBoxesBody,
  moveRect,
  parseAspectRatio,
  resizeRect,
  MOSS_BOX_MIN,
} from "@/lib/mossLayoutUi";
import type { MossLayoutBox } from "@/lib/oj/mossLayout";

const box: MossLayoutBox = { x: 0.1, y: 0.1, w: 0.2, h: 0.2, kind: "object", caption: "a" };

describe("drawRect", () => {
  it("handles any drag direction", () => {
    expect(drawRect({ x: 0.5, y: 0.6 }, { x: 0.2, y: 0.3 })).toEqual({
      x: 0.2, y: 0.3, w: 0.3, h: 0.3,
    });
  });
  it("clamps to canvas and enforces min size", () => {
    const r = drawRect({ x: -1, y: 0.5 }, { x: 2, y: 0.5 });
    expect(r.x).toBe(0);
    expect(r.w).toBe(1);
    expect(r.h).toBe(MOSS_BOX_MIN);
    const edge = drawRect({ x: 1, y: 1 }, { x: 1, y: 1 });
    expect(edge.x + edge.w).toBeLessThanOrEqual(1);
    expect(edge.y + edge.h).toBeLessThanOrEqual(1);
  });
});

describe("moveRect", () => {
  it("clamps inside canvas keeping size", () => {
    expect(moveRect(box, 5, 5)).toEqual({ x: 0.8, y: 0.8, w: 0.2, h: 0.2 });
    expect(moveRect(box, -5, -5)).toEqual({ x: 0, y: 0, w: 0.2, h: 0.2 });
  });
});

describe("resizeRect", () => {
  it("keeps origin, clamps to edge and min", () => {
    expect(resizeRect(box, { x: 3, y: 3 })).toEqual({ x: 0.1, y: 0.1, w: 0.9, h: 0.9 });
    expect(resizeRect(box, { x: 0, y: 0 })).toEqual({
      x: 0.1, y: 0.1, w: MOSS_BOX_MIN, h: MOSS_BOX_MIN,
    });
  });
});

describe("aspect", () => {
  it("parses ratios", () => {
    expect(parseAspectRatio("16:9")).toBeCloseTo(16 / 9);
    expect(parseAspectRatio("bad")).toBeNull();
    expect(parseAspectRatio("0:1")).toBeNull();
  });
  it("prompt --ar wins over settings", () => {
    expect(effectiveAspect("cat --ar 3:2 --s 5", "1:1")).toBe("3:2");
    expect(effectiveAspect("cat", "4:5")).toBe("4:5");
    expect(effectiveAspect("cat --ar nope", "4:5")).toBe("4:5");
  });
});

describe("layoutBoxesBody", () => {
  const moss = "packs/moss-image/t2i.json";
  it("includes boxes for the MOSS t2i graph", () => {
    expect(isMossT2iWorkflowPath(moss)).toBe(true);
    expect(layoutBoxesBody([box], moss)).toEqual({ layout_boxes: [box] });
  });
  it("omits when empty, other workflow, i2i, undefined, or krea2 route", () => {
    expect(layoutBoxesBody([], moss)).toEqual({});
    expect(layoutBoxesBody([box], "t2i.json")).toEqual({});
    expect(layoutBoxesBody([box], "packs/moss-image/i2i.json")).toEqual({});
    expect(layoutBoxesBody([box], undefined)).toEqual({});
    expect(layoutBoxesBody([box], moss, true)).toEqual({});
  });
  it("skips half-filled boxes instead of sending them (server would 400)", () => {
    const blank = { ...box, kind: "object" as const, caption: "  " };
    const noText = { ...box, kind: "text" as const, caption: "", text: "" };
    const text = { ...box, kind: "text" as const, caption: "", text: "OPEN" };
    expect(layoutBoxesBody([blank, noText], moss)).toEqual({});
    expect(layoutBoxesBody([blank, box, text], moss)).toEqual({ layout_boxes: [box, text] });
  });
});

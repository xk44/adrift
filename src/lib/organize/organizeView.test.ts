import { describe, expect, it } from "vitest";
import {
  dayGroupLabel,
  isStillImage,
  nextSelection,
  thumbKind,
} from "./organizeView";

const view = (f: string) =>
  `/api/comfy/image?filename=${f}&subfolder=&type=output`;

describe("thumbKind", () => {
  it("classifies explicit media fields first", () => {
    expect(thumbKind({ url: view("a.png"), videoUrl: view("a.mp4") })).toBe(
      "video",
    );
    expect(thumbKind({ audioUrl: view("a.wav") })).toBe("audio");
  });
  it("never treats a video/audio url as an image", () => {
    expect(thumbKind({ url: view("clip_00003_.mp4") })).toBe("video");
    expect(thumbKind({ url: view("voice.wav") })).toBe("audio");
    expect(thumbKind({ url: "/x/model.glb" })).toBe("mesh");
  });
  it("uses the still preview for meshes when present", () => {
    expect(thumbKind({ url: view("p.png"), meshUrl: "/m.glb" })).toBe("image");
    expect(thumbKind({ meshUrl: "/m.glb" })).toBe("mesh");
    expect(thumbKind({})).toBe("none");
  });
});

describe("isStillImage", () => {
  it("keeps only visible still images", () => {
    expect(isStillImage({ url: view("a.png") })).toBe(true);
    expect(isStillImage({ url: view("a.png"), hidden: true })).toBe(false);
    expect(isStillImage({ url: view("a.mp4") })).toBe(false);
    expect(isStillImage({ url: view("a.png"), videoUrl: "v.mp4" })).toBe(false);
    expect(isStillImage({ url: "" })).toBe(false);
  });
});

describe("dayGroupLabel", () => {
  const now = new Date(2026, 9, 24, 15, 0, 0);
  it("labels recent days relatively", () => {
    expect(dayGroupLabel(new Date(2026, 9, 24, 1).toISOString(), now)).toBe(
      "Today",
    );
    expect(dayGroupLabel(new Date(2026, 9, 23, 23).toISOString(), now)).toBe(
      "Yesterday",
    );
    expect(dayGroupLabel(new Date(2026, 9, 21, 12).toISOString(), now)).toBe(
      "Wednesday",
    );
  });
  it("falls back to a date, with year only when different", () => {
    expect(dayGroupLabel(new Date(2026, 9, 1).toISOString(), now)).toBe(
      "October 1",
    );
    expect(dayGroupLabel(new Date(2025, 9, 1).toISOString(), now)).toBe(
      "October 1, 2025",
    );
    expect(dayGroupLabel(undefined, now)).toBe("Unknown");
    expect(dayGroupLabel("nope", now)).toBe("Unknown");
  });
});

describe("nextSelection", () => {
  const ids = ["a", "b", "c", "d"];
  it("single click selects one, clicking it again clears", () => {
    expect([...nextSelection(new Set(), "b", ids)]).toEqual(["b"]);
    expect([...nextSelection(new Set(["a", "c"]), "b", ids)]).toEqual(["b"]);
    expect(nextSelection(new Set(["b"]), "b", ids).size).toBe(0);
  });
  it("additive toggles", () => {
    expect([
      ...nextSelection(new Set(["a"]), "c", ids, { additive: true }),
    ]).toEqual(["a", "c"]);
    expect([
      ...nextSelection(new Set(["a", "c"]), "a", ids, { additive: true }),
    ]).toEqual(["c"]);
  });
  it("range extends from the last selected", () => {
    expect(
      [...nextSelection(new Set(["b"]), "d", ids, { range: true })].sort(),
    ).toEqual(["b", "c", "d"]);
    expect(
      [...nextSelection(new Set(["d"]), "a", ids, { range: true })].sort(),
    ).toEqual(["a", "b", "c", "d"]);
    expect([...nextSelection(new Set(), "c", ids, { range: true })]).toEqual([
      "c",
    ]);
  });
});

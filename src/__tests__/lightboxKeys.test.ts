import { describe, expect, it } from "vitest";
import {
  keyOwner,
  lightboxKeyIntent,
  type LightboxKeyContext,
} from "@/lib/ui/lightboxKeys";

const base: LightboxKeyContext = {
  owner: null,
  compareActive: false,
  zoomed: false,
  canCompare: true,
  canQuickEdit: true,
  canZoom: true,
};

describe("keyOwner", () => {
  it("treats typing fields as text", () => {
    expect(keyOwner({ tagName: "TEXTAREA" })).toBe("text");
    expect(keyOwner({ tagName: "INPUT", type: "search" })).toBe("text");
    expect(keyOwner({ tagName: "INPUT" })).toBe("text");
    expect(keyOwner({ tagName: "DIV", isContentEditable: true })).toBe("text");
  });
  it("treats arrow-key widgets as controls", () => {
    expect(keyOwner({ tagName: "VIDEO" })).toBe("control");
    expect(keyOwner({ tagName: "AUDIO" })).toBe("control");
    expect(keyOwner({ tagName: "SELECT" })).toBe("control");
    expect(keyOwner({ tagName: "INPUT", type: "range" })).toBe("control");
    expect(keyOwner({ tagName: "DIV", role: "slider" })).toBe("control");
  });
  it("leaves buttons and plain elements to the lightbox", () => {
    expect(keyOwner({ tagName: "BUTTON" })).toBeNull();
    expect(keyOwner({ tagName: "INPUT", type: "checkbox" })).toBeNull();
    expect(keyOwner({ tagName: "DIV" })).toBeNull();
    expect(keyOwner(null)).toBeNull();
  });
});

describe("lightboxKeyIntent", () => {
  it("ignores every key while typing", () => {
    const ctx = { ...base, owner: "text" as const };
    expect(lightboxKeyIntent({ key: "Escape" }, ctx)).toBeNull();
    expect(lightboxKeyIntent({ key: "ArrowLeft" }, ctx)).toBeNull();
    expect(lightboxKeyIntent({ key: "c" }, ctx)).toBeNull();
  });
  it("peels Escape one layer at a time", () => {
    expect(
      lightboxKeyIntent({ key: "Escape" }, { ...base, zoomed: true, compareActive: true }),
    ).toBe("exit-zoom");
    expect(lightboxKeyIntent({ key: "Escape" }, { ...base, compareActive: true })).toBe(
      "exit-compare",
    );
    expect(lightboxKeyIntent({ key: "Escape" }, base)).toBe("close");
    // A focused video still lets Escape close the lightbox.
    expect(lightboxKeyIntent({ key: "Escape" }, { ...base, owner: "control" })).toBe(
      "close",
    );
  });
  it("navigates with arrows only when nothing else owns them", () => {
    expect(lightboxKeyIntent({ key: "ArrowLeft" }, base)).toBe("prev");
    expect(lightboxKeyIntent({ key: "ArrowRight" }, base)).toBe("next");
    expect(lightboxKeyIntent({ key: "ArrowRight" }, { ...base, owner: "control" })).toBeNull();
    expect(lightboxKeyIntent({ key: "ArrowRight" }, { ...base, compareActive: true })).toBeNull();
    expect(lightboxKeyIntent({ key: "ArrowRight" }, { ...base, zoomed: true })).toBeNull();
    expect(lightboxKeyIntent({ key: "ArrowRight", metaKey: true }, base)).toBeNull();
  });
  it("gates letter shortcuts by capability and modifiers", () => {
    expect(lightboxKeyIntent({ key: "c" }, base)).toBe("compare");
    expect(lightboxKeyIntent({ key: "C" }, base)).toBe("compare");
    expect(lightboxKeyIntent({ key: "c" }, { ...base, canCompare: false })).toBeNull();
    expect(lightboxKeyIntent({ key: "c", metaKey: true }, base)).toBeNull();
    expect(lightboxKeyIntent({ key: "e" }, base)).toBe("quick-edit");
    expect(lightboxKeyIntent({ key: "e" }, { ...base, canQuickEdit: false })).toBeNull();
    expect(lightboxKeyIntent({ key: "t" }, base)).toBe("tools");
    expect(lightboxKeyIntent({ key: "z" }, base)).toBe("zoom");
    expect(lightboxKeyIntent({ key: "z" }, { ...base, canZoom: false })).toBeNull();
    expect(lightboxKeyIntent({ key: "x" }, base)).toBeNull();
  });
});

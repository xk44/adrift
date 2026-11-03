import { describe, expect, it } from "vitest";
import { buildGalleryParamChips } from "@/lib/galleryParams";

describe("buildGalleryParamChips", () => {
  it("adds the actual per-image seed as a clickable --seed chip", () => {
    expect(buildGalleryParamChips({ ar: "16:9", seed: 42 }, 1234)).toEqual([
      "ar 16:9",
      "--seed 1234",
    ]);
  });

  it("does not duplicate the base prompt seed from run params", () => {
    const chips = buildGalleryParamChips({ seed: 42, stylize: 300 }, 43);
    expect(chips).toEqual(["stylize 300", "--seed 43"]);
    expect(chips.filter((chip) => /seed/i.test(chip))).toHaveLength(1);
  });

  it("keeps hidden negative-prompt params out of visible chips", () => {
    expect(
      buildGalleryParamChips({ negativePrompt: "bad", no: "hands", raw: true }, 9),
    ).toEqual(["raw", "--seed 9"]);
  });
});

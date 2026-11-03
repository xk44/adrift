import { describe, expect, it } from "vitest";
import {
  buildParamChips,
  canonicalParamKey,
  formatSeedLabel,
  humanizeParamChip,
  shortFlagFor,
  stripChipFlagsFromPrompt,
} from "@/lib/paramChips";

describe("paramChips", () => {
  it("canonicalizes internal keys, long flags and short flags", () => {
    expect(canonicalParamKey("aspectRatio")).toBe("ar");
    expect(canonicalParamKey("--aspect")).toBe("ar");
    expect(canonicalParamKey("stylize")).toBe("stylize");
    expect(canonicalParamKey("--s")).toBe("stylize");
    expect(canonicalParamKey("--seed")).toBe("seed");
    expect(canonicalParamKey("--stop")).toBe("stop");
    expect(canonicalParamKey("customThing")).toBe("customThing");
  });

  it("picks the shortest typeable flag", () => {
    expect(shortFlagFor("stylize")).toBe("--s");
    expect(shortFlagFor("chaos")).toBe("--c");
    expect(shortFlagFor("quality")).toBe("--q");
    expect(shortFlagFor("mossSpeed")).toBe("--speed");
    expect(shortFlagFor("unknownKey")).toBe("--unknownKey");
  });

  it("humanizes persisted chips into short labels", () => {
    expect(humanizeParamChip("aspectRatio 1:1")).toEqual({
      key: "ar",
      label: "ar 1:1",
      flag: "--ar",
      value: "1:1",
    });
    expect(humanizeParamChip("stylize 250")?.label).toBe("s 250");
    expect(humanizeParamChip("--chaos 20")?.label).toBe("c 20");
    expect(humanizeParamChip("16:9")?.label).toBe("ar 16:9");
    expect(humanizeParamChip("raw")).toEqual({
      key: "raw",
      label: "raw",
      flag: "--raw",
      value: "",
    });
    expect(humanizeParamChip("   ")).toBeNull();
  });

  it("formats a run's seeds as one label", () => {
    expect(formatSeedLabel([])).toBeNull();
    expect(formatSeedLabel([42])).toBe("seed 42");
    expect(formatSeedLabel([42, 42])).toBe("seed 42");
    expect(formatSeedLabel([1000, 1001, 1002, 1003])).toBe("seed 1000…1003");
    expect(formatSeedLabel([7, 99, 3])).toBe("seed 7 +2");
    expect(formatSeedLabel([Number.NaN])).toBeNull();
  });

  it("builds deduped chips with a single trailing seed chip", () => {
    const chips = buildParamChips(
      [
        "aspectRatio 1:1",
        "stylize 250",
        "--seed 1000",
        "--seed 1001",
        "packId x",
        "s 250",
      ],
      [1000, 1001, 1002, 1003],
    );
    expect(chips.map((c) => c.label)).toEqual([
      "ar 1:1",
      "s 250",
      "seed 1000…1003",
    ]);
    const seed = chips[chips.length - 1];
    expect(seed.flag).toBe("--seed");
    expect(seed.value).toBe("1000");
  });

  it("keeps distinct loras", () => {
    const chips = buildParamChips(["lora a.safetensors", "lora b.safetensors"]);
    expect(chips.map((c) => c.label)).toEqual([
      "lora a.safetensors",
      "lora b.safetensors",
    ]);
  });

  it("strips flags already shown as chips from the displayed prompt", () => {
    expect(
      stripChipFlagsFromPrompt(
        "cinematic portrait, golden hour --ar 1:1 --s 250 --seed 1000",
        ["ar", "stylize"],
      ),
    ).toBe("cinematic portrait, golden hour");
    // Flags without a chip stay visible.
    expect(stripChipFlagsFromPrompt("a cat --no dogs --ar 16:9", ["ar"])).toBe(
      "a cat --no dogs",
    );
    expect(stripChipFlagsFromPrompt("plain prompt", ["ar"])).toBe(
      "plain prompt",
    );
    // Never blank the text.
    expect(stripChipFlagsFromPrompt("--ar 1:1", ["ar"])).toBe("--ar 1:1");
  });
});

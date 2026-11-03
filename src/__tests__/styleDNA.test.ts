import { describe, expect, it } from "vitest";

import {
  buildStyleDNA,
  hasStyleDNA,
  styleDNAChips,
  styleDNAPromptFlags,
} from "@/lib/styleDNA";
import type { GalleryImage } from "@/types";

function img(overrides: Partial<GalleryImage> = {}): GalleryImage {
  return {
    id: "id",
    url: "http://x/a.png",
    prompt: "a cat",
    fullPrompt: "a cat --sref 123456 --stylize 250",
    params: [],
    paramsMap: {},
    seed: 42,
    createdAt: "2026-01-01T00:00:00Z",
    runId: "run1",
    jobIndex: 0,
    width: 512,
    height: 512,
    ...overrides,
  };
}

describe("styleDNAChips", () => {
  it("collects model, style params, and loras in order", () => {
    const chips = styleDNAChips(
      img({
        model: "flux-dev",
        paramsMap: { sref: "123456", stylize: 250, chaos: 12 },
        loras: [{ name: "filmgrain", strength: 0.6 }],
      }),
    );
    expect(chips.map((c) => c.label)).toEqual([
      "Model",
      "Style ref",
      "Stylize",
      "Chaos",
      "LoRA",
    ]);
    expect(chips[1].flag).toBe("--sref 123456");
    expect(chips[4].value).toBe("filmgrain@0.6");
  });

  it("emits boolean flag params (raw/niji) with no value", () => {
    const chips = styleDNAChips(img({ paramsMap: { raw: true, niji: true } }));
    const raw = chips.find((c) => c.label === "Raw");
    expect(raw?.flag).toBe("--raw");
    expect(raw?.value).toBe("on");
    expect(chips.find((c) => c.label === "Niji")?.flag).toBe("--niji");
  });

  it("ignores a false boolean flag", () => {
    expect(styleDNAChips(img({ paramsMap: { raw: false } }))).toEqual([]);
  });

  it("captures sref weight and engine (sw/sv)", () => {
    const chips = styleDNAChips(img({ paramsMap: { sw: 0.5, sv: "sv2" } }));
    expect(chips.map((c) => c.flag)).toEqual(["--sw 0.5", "--sv sv2"]);
  });

  it("ignores subject-only images with no style metadata", () => {
    expect(styleDNAChips(img({ paramsMap: {} }))).toEqual([]);
    expect(hasStyleDNA(img({ paramsMap: {} }))).toBe(false);
  });

  it("joins multi-value sref arrays", () => {
    const chips = styleDNAChips(img({ paramsMap: { sref: ["111", "222"] } }));
    expect(chips[0].flag).toBe("--sref 111 222");
  });
});

describe("buildStyleDNA", () => {
  it("renders a compact one-line fingerprint", () => {
    const dna = buildStyleDNA(
      img({ model: "flux-dev", paramsMap: { sref: "123456", stylize: 250 } }),
    );
    expect(dna).toBe("DNA · flux-dev · --sref 123456 · --stylize 250");
  });
  it("degrades when there's no style metadata", () => {
    expect(buildStyleDNA(img({ paramsMap: {} }))).toContain(
      "no style metadata",
    );
  });
});

describe("styleDNAPromptFlags", () => {
  it("emits only the flag-form params (not model/lora)", () => {
    const flags = styleDNAPromptFlags(
      img({
        model: "flux-dev",
        paramsMap: { sref: "123456", stylize: 250 },
        loras: [{ name: "x", strength: 1 }],
      }),
    );
    expect(flags).toBe("--sref 123456 --stylize 250");
  });
});

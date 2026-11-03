/**
 * CharacterChips while an Anima reference image is set: the LoRA chips stay
 * visible but read as "off" (the anima_ref action leaves them out), and the
 * small X buttons carry a 44 px hit area. Stores are mocked because zustand
 * renders its initial state on the server.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  lora: {
    selected: [] as unknown[],
    remove: () => {},
    setStrength: () => {},
    removeTrigger: () => {},
    setApplyAnyway: () => {},
  },
  anima: {
    reference: null as unknown,
    second: null as unknown,
    clear: () => {},
    clearReference: () => {},
    clearSecond: () => {},
  },
}));

vi.mock("@/store/characterLoraStore", () => ({
  useCharacterLoraStore: (sel: (s: typeof state.lora) => unknown) =>
    sel(state.lora),
}));
vi.mock("@/store/animaRefStore", () => ({
  useAnimaRefStore: (sel: (s: typeof state.anima) => unknown) =>
    sel(state.anima),
}));
vi.mock("@/lib/characters/activeFamily", () => ({
  useCharacterFamily: () => null,
}));

import { CharacterChips } from "@/components/characters/CharacterChips";

const HERO = {
  filename: "hero_v1.safetensors",
  label: "Hero",
  strength: 0.8,
  triggers: ["hero"],
  baseFamily: null,
};
const REF = {
  id: "r1",
  source: "upload",
  previewUrl: "data:image/png;base64,AA==",
  label: "ref.png",
  width: 1,
  height: 1,
};

describe("CharacterChips with an Anima reference", () => {
  beforeEach(() => {
    state.lora.selected = [HERO];
    state.anima.reference = null;
    state.anima.second = null;
  });

  it("without a reference the LoRA chip is live", () => {
    const html = renderToStaticMarkup(<CharacterChips />);
    expect(html).toContain("data-character-chip");
    expect(html).not.toContain("data-overridden");
    expect(html).not.toMatch(/>off</);
  });

  it("with a reference every LoRA chip is dimmed and labelled off", () => {
    state.anima.reference = REF;
    const html = renderToStaticMarkup(<CharacterChips />);
    expect(html).toContain("data-anima-ref-chip");
    expect(html).toContain('data-overridden=""');
    expect(html).toContain("opacity-60");
    expect(html).toMatch(/>off</);
  });

  it("two references: a left and a right chip, each removable", () => {
    state.anima.reference = REF;
    state.anima.second = { ...REF, id: "r2", label: "b.png" };
    const html = renderToStaticMarkup(<CharacterChips />);
    expect(html).toContain('data-anima-ref-chip="left"');
    expect(html).toContain('data-anima-ref-chip="right"');
    expect(html).toContain('aria-label="Remove left character reference"');
    expect(html).toContain('aria-label="Remove right character reference"');
  });

  it("small remove buttons have a 44 px hit area", () => {
    state.anima.reference = REF;
    const html = renderToStaticMarkup(<CharacterChips />);
    for (const label of [
      "Remove character reference",
      "Remove character Hero",
      "Don&#x27;t add trigger word hero",
    ]) {
      const re = new RegExp(`class="[^"]*before:size-11[^"]*"[^>]*aria-label="${label}"|aria-label="${label}"[^>]*class="[^"]*before:size-11`);
      expect(html, label).toMatch(re);
    }
  });
});

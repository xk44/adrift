import { describe, expect, it, beforeEach } from "vitest";
import registry from "@/lib/oj/registry.json";
import {
  buildSuggestions,
  getAutocompleteContext,
} from "@/lib/promptAutocomplete";
import { useStyleStore } from "@/store/styleStore";

describe("LoRA deploy registration autocomplete", () => {
  beforeEach(() => {
    useStyleStore.setState({ loraShortcodes: [], recentLoraShortcodes: [] });
  });

  it("registers a deployed LoRA shortcode in the style store", () => {
    useStyleStore.getState().saveLoRAShortcode({
      shortcode: "ink-board-v1.safetensors",
      filename: "/models/loras/ink-board-v1.safetensors",
      displayName: "Ink Board v1",
      triggers: ["inkboard_style"],
      defaultStrength: 1.0,
    });

    expect(useStyleStore.getState().loraShortcodes).toEqual([
      expect.objectContaining({
        shortcode: "ink-board-v1.safetensors",
        filename: "/models/loras/ink-board-v1.safetensors",
        displayName: "Ink Board v1",
        triggers: ["inkboard_style"],
        defaultStrength: 1.0,
        useCount: 0,
        isFavorite: false,
      }),
    ]);
  });

  it("buildSuggestions returns trigger suggestions for registered LoRAs", () => {
    useStyleStore.getState().saveLoRAShortcode({
      shortcode: "ink-board-v1.safetensors",
      filename: "/models/loras/ink-board-v1.safetensors",
      displayName: "Ink Board v1",
      triggers: ["inkboard_style"],
      defaultStrength: 1.0,
    });

    const prompt = "portrait ink";
    const context = getAutocompleteContext(prompt, prompt.length);

    expect(context).toEqual(
      expect.objectContaining({ type: "trigger", query: "ink" }),
    );
    expect(
      buildSuggestions({
        context: context!,
        registry,
        downloads: [],
        loraShortcodes: useStyleStore.getState().loraShortcodes,
      }),
    ).toEqual([
      expect.objectContaining({
        type: "trigger",
        label: "inkboard_style",
        insertText: "inkboard_style ",
        loraName: "Ink Board v1",
      }),
    ]);
  });

  it("buildSuggestions returns deployed LoRA names after --lora", () => {
    useStyleStore.getState().saveLoRAShortcode({
      shortcode: "ink-board-v1.safetensors",
      filename: "/models/loras/ink-board-v1.safetensors",
      displayName: "Ink Board v1",
      triggers: ["inkboard_style"],
      defaultStrength: 1.0,
    });

    const prompt = "--lora ink";
    const context = getAutocompleteContext(prompt, prompt.length);

    expect(context).toEqual(
      expect.objectContaining({ type: "lora", query: "ink" }),
    );
    expect(
      buildSuggestions({
        context: context!,
        registry,
        downloads: [],
        loraShortcodes: useStyleStore.getState().loraShortcodes,
      }),
    ).toEqual([
      expect.objectContaining({
        type: "lora",
        label: "ink-board-v1.safetensors",
        insertText: "ink-board-v1.safetensors ",
      }),
    ]);
  });
});

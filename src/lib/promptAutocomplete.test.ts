import { describe, expect, it } from "vitest";
import registry from "@/lib/oj/registry.json";
import {
  getAutocompleteContext,
  getParamSuggestions,
  getTriggerWordSuggestions,
} from "@/lib/promptAutocomplete";
import type { DownloadedModel } from "@/store/downloadStore";

function download(overrides: Partial<DownloadedModel>): DownloadedModel {
  return {
    civitaiModelId: 1,
    civitaiVersionId: 10,
    modelName: "Ink Style",
    versionName: "v1",
    type: "LORA",
    filename: "ink.safetensors",
    localPath: "/models/loras/ink.safetensors",
    trainedWords: [],
    downloadedAt: "2026-07-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("prompt autocomplete", () => {
  it("detects prompt parameter context after --", () => {
    expect(getAutocompleteContext("portrait --s", 12)).toEqual({
      type: "param",
      query: "--s",
      from: 9,
      to: 12,
    });
  });

  it("matches parameter suggestions from the registry", () => {
    const suggestions = getParamSuggestions(registry, "--ar");

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "param",
          label: "--ar",
          description: registry.params.ar.description,
          valueHint: "ratio",
        }),
      ]),
    );
  });

  it("matches registry aliases without a duplicate hardcoded list", () => {
    const suggestions = getParamSuggestions(registry, "--q");

    expect(suggestions.map((suggestion) => suggestion.label)).toContain("--q");
    expect(suggestions.map((suggestion) => suggestion.label)).toContain(
      "--quality",
    );
  });

  it("lists each parameter once, by its shortest flag, for a bare --", () => {
    const labels = getParamSuggestions(registry, "--").map((s) => s.label);
    expect(labels).toContain("--ar");
    expect(labels).not.toContain("--aspect");
    expect(labels).toContain("--s");
    expect(labels).not.toContain("--stylize");
    expect(new Set(labels).size).toBe(labels.length);
    // Typing past the dashes still offers the matching aliases.
    expect(
      getParamSuggestions(registry, "--asp").map((s) => s.label),
    ).toContain("--aspect");
  });

  it("detects plain-word trigger context", () => {
    expect(getAutocompleteContext("portrait ink", 12)).toEqual({
      type: "trigger",
      query: "ink",
      from: 9,
      to: 12,
    });
  });

  it("prefix-matches trigger words for downloaded LoRAs", () => {
    const suggestions = getTriggerWordSuggestions(
      [
        download({ trainedWords: ["inkwash", "line art"] }),
        download({
          civitaiVersionId: 11,
          modelName: "Checkpoint",
          type: "Checkpoint",
          trainedWords: ["ignored"],
        }),
      ],
      "ink",
    );

    expect(suggestions).toEqual([
      expect.objectContaining({
        type: "trigger",
        label: "inkwash",
        insertText: "inkwash ",
        loraName: "Ink Style",
      }),
    ]);
  });
});

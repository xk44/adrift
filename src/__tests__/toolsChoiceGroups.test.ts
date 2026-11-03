import { describe, expect, it } from "vitest";
import {
  CHOICE_SEARCH_MIN,
  chipLabel,
  choiceGroups,
  filterChoiceGroups,
  parenGroup,
} from "@/lib/tools/choiceGroups";
import { ACTION_TOOLS } from "@/lib/tools/toolsPage";

const voices = [
  { id: "emma", label: "Emma (English, woman)" },
  { id: "liam", label: "Liam (English, man)" },
  { id: "ana", label: "Ana (Spanish, woman)" },
  { id: "luis", label: "Luis (Spanish, man)" },
  { id: "yuki", label: "Yuki (Japanese, woman)" },
  { id: "ken", label: "Ken (Japanese, man)" },
  { id: "lea", label: "Léa (French, woman)" },
  { id: "hugo", label: "Hugo (French, man)" },
  { id: "x", label: "Narrator" },
];

describe("parenGroup", () => {
  it("takes the first parenthetical item", () => {
    expect(parenGroup("Emma (English, woman)")).toBe("English");
    expect(parenGroup("Heart (US English, woman)")).toBe("US English");
    expect(parenGroup("Solo (Neutral)")).toBe("Neutral");
    expect(parenGroup("Plain")).toBeNull();
  });
});

describe("choiceGroups", () => {
  it("keeps explicit group runs", () => {
    const g = choiceGroups([
      { id: "a", label: "A", group: "Push" },
      { id: "b", label: "B", group: "Push" },
      { id: "c", label: "C", group: "Orbit" },
    ]);
    expect(g.map((x) => [x.group, x.options.length])).toEqual([
      ["Push", 2],
      ["Orbit", 1],
    ]);
  });

  it("groups voice lists by language, untagged into Other", () => {
    const g = choiceGroups(voices);
    expect(g.map((x) => x.group)).toEqual([
      "English",
      "Spanish",
      "Japanese",
      "French",
      "Other",
    ]);
    expect(g.flatMap((x) => x.options)).toHaveLength(voices.length);
  });

  it("falls back to one unnamed group for short or untagged lists", () => {
    expect(choiceGroups(voices.slice(0, 4))).toEqual([
      { group: "", options: voices.slice(0, 4) },
    ]);
    const plain = Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      label: `P${i}`,
    }));
    expect(choiceGroups(plain)).toHaveLength(1);
    const oneLang = Array.from({ length: 9 }, (_, i) => ({
      id: `e${i}`,
      label: `E${i} (English, woman)`,
    }));
    expect(choiceGroups(oneLang)[0].group).toBe("");
  });

  it("groups every real dropdown catalog without losing options", () => {
    let checked = 0;
    for (const spec of ACTION_TOOLS) {
      for (const p of spec.pickers ?? []) {
        if (!p.dropdown) continue;
        const flat = choiceGroups(p.options).flatMap((g) => g.options);
        expect(flat.map((o) => o.id).sort()).toEqual(
          p.options.map((o) => o.id).sort(),
        );
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("filterChoiceGroups", () => {
  const groups = choiceGroups(voices);

  it("returns all groups for an empty query", () => {
    expect(filterChoiceGroups(groups, "  ")).toBe(groups);
  });

  it("ANDs words across label and group, dropping empty groups", () => {
    const r = filterChoiceGroups(groups, "spanish woman");
    expect(r).toEqual([{ group: "Spanish", options: [voices[2]] }]);
    expect(filterChoiceGroups(groups, "japanese")).toHaveLength(1);
    expect(filterChoiceGroups(groups, "zzz")).toEqual([]);
  });

  it("matches ids with separators as words", () => {
    const g = [
      { group: "", options: [{ id: "dolly_zoom-in", label: "Vertigo" }] },
    ];
    expect(filterChoiceGroups(g, "dolly zoom")).toHaveLength(1);
  });
});

describe("chipLabel", () => {
  it("drops the part the heading already says", () => {
    expect(chipLabel("Emma (English, woman)", "English")).toBe("Emma · woman");
    expect(chipLabel("Solo (Neutral)", "Neutral")).toBe("Solo");
  });

  it("leaves labels alone otherwise", () => {
    expect(chipLabel("Emma (English, woman)", "")).toBe(
      "Emma (English, woman)",
    );
    expect(chipLabel("Emma (English, woman)", "Spanish")).toBe(
      "Emma (English, woman)",
    );
    expect(chipLabel("Slow push", "Push")).toBe("Slow push");
  });

  it("search threshold is sane", () => {
    expect(CHOICE_SEARCH_MIN).toBeGreaterThan(8);
  });
});

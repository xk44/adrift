import { describe, expect, it } from "vitest";
import {
  MAX_CHARACTERS,
  activeFamilyGroup,
  applyCharactersToPrompt,
  appliedSelections,
  buildCharacterEntries,
  characterLoraFlags,
  classifyCharacterLora,
  clampStrength,
  filterCharacterEntries,
  hasAnimaRefAdapter,
  hasAnimaRefAdapterV2,
  isFamilyMismatch,
  promptHasOwnLora,
  sanitizeSelections,
  selectionFromEntry,
  toggleSelection,
  type CharacterSelection,
} from "@/lib/characters/characterLoras";
import { parseImagineInput } from "@/lib/oj/parser";
import { familyFromInputs } from "@/lib/characters/activeFamily";

const sel = (
  filename: string,
  extra: Partial<CharacterSelection> = {},
): CharacterSelection => ({
  filename,
  label: filename,
  strength: 0.9,
  triggers: [],
  baseFamily: null,
  ...extra,
});

describe("classifyCharacterLora", () => {
  it("character tags win, from any source", () => {
    expect(classifyCharacterLora({ filename: "x.safetensors", tags: ["Character"] })).toBe("tag");
    expect(classifyCharacterLora({ filename: "x.safetensors", tags: ["celebrity"] })).toBe("tag");
  });

  it("trainer character boards count as trained", () => {
    expect(
      classifyCharacterLora({ filename: "my_run.safetensors", tags: ["character"], trained: true }),
    ).toBe("trained");
    // A trainer style board is not a character.
    expect(
      classifyCharacterLora({ filename: "my_char.safetensors", tags: ["style"], trained: true }),
    ).toBeNull();
  });

  it("a non-character tag list is trusted over the name", () => {
    expect(
      classifyCharacterLora({ filename: "anime_character.safetensors", tags: ["style"] }),
    ).toBeNull();
  });

  it("file name is a last resort and skips tool LoRAs", () => {
    expect(classifyCharacterLora({ filename: "hero_character_v2.safetensors" })).toBe("name");
    expect(classifyCharacterLora({ filename: "my-oc-lora.safetensors" })).toBe("name");
    expect(classifyCharacterLora({ filename: "h3_character_swap.safetensors" })).toBeNull();
    expect(classifyCharacterLora({ filename: "character-sheet.safetensors" })).toBeNull();
    expect(classifyCharacterLora({ filename: "Anything2RealCharacters.safetensors" })).toBeNull();
    expect(classifyCharacterLora({ filename: "edit_tools/character_x.safetensors" })).toBeNull();
    expect(classifyCharacterLora({ filename: "detail_tweaker.safetensors" })).toBeNull();
    // "chart" is not "char"
    expect(classifyCharacterLora({ filename: "chartstyle.safetensors" })).toBeNull();
  });
});

describe("buildCharacterEntries + filter", () => {
  const server = [
    { filename: "chars/alice_character.safetensors" },
    { filename: "my_oc_run.safetensors" },
    {
      filename: "civ/bob.safetensors",
      modelName: "Bob (game)",
      tags: ["character"],
      baseModel: "SDXL 1.0",
      triggers: ["bobtrigger"],
      hasPreview: true,
    },
    { filename: "film_grain.safetensors" },
  ];

  const entries = buildCharacterEntries(
    server,
    [
      {
        shortcode: "my_oc_run",
        filename: "my_oc_run",
        displayName: "My OC",
        tags: ["character"],
        triggers: ["ohwx"],
        defaultStrength: 1,
      },
    ],
    [
      {
        filename: "alice_character.safetensors",
        modelName: "Alice",
        type: "LORA",
        trainedWords: ["alicetrig"],
      },
    ],
  );

  it("merges trainer shortcodes and downloads by base file name", () => {
    const oc = entries.find((e) => e.filename === "my_oc_run.safetensors")!;
    expect(oc.label).toBe("My OC");
    expect(oc.triggers).toEqual(["ohwx"]);
    expect(oc.characterReason).toBe("trained");
    expect(oc.strength).toBe(1);

    const alice = entries.find((e) => e.filename.endsWith("alice_character.safetensors"))!;
    expect(alice.label).toBe("Alice");
    expect(alice.triggers).toEqual(["alicetrig"]);
    expect(alice.characterReason).toBe("name");

    const bob = entries.find((e) => e.filename === "civ/bob.safetensors")!;
    expect(bob.baseFamily).toBe("sdxl");
    expect(bob.hasPreview).toBe(true);
  });

  it("characters only by default; All LoRAs shows the rest; search works", () => {
    expect(filterCharacterEntries(entries, {}).map((e) => e.label)).toEqual([
      "Alice",
      "Bob (game)",
      "My OC",
    ]);
    const all = filterCharacterEntries(entries, { showAll: true });
    expect(all).toHaveLength(4);
    expect(all[3].filename).toBe("film_grain.safetensors"); // non-characters last
    expect(filterCharacterEntries(entries, { query: "BOBTRIG" })).toHaveLength(1);
  });
});

describe("selection", () => {
  it("caps at two and toggles off", () => {
    let list: CharacterSelection[] = [];
    list = toggleSelection(list, sel("a"));
    list = toggleSelection(list, sel("b"));
    list = toggleSelection(list, sel("c"));
    expect(list.map((s) => s.filename)).toEqual(["a", "b"]);
    expect(MAX_CHARACTERS).toBe(2);
    list = toggleSelection(list, sel("a"));
    expect(list.map((s) => s.filename)).toEqual(["b"]);
  });

  it("default strength sits in 0.8-1.0 and is clamped", () => {
    const s = selectionFromEntry({
      filename: "x",
      label: "x",
      tags: [],
      baseModel: null,
      baseFamily: null,
      triggers: [],
      strength: null,
      hasPreview: false,
      characterReason: "name",
    });
    expect(s.strength).toBeGreaterThanOrEqual(0.8);
    expect(s.strength).toBeLessThanOrEqual(1);
    expect(clampStrength(9)).toBe(1.5);
    expect(clampStrength(-1)).toBe(0.1);
    expect(clampStrength(Number.NaN)).toBe(0.9);
  });

  it("sanitizes stored rows", () => {
    expect(sanitizeSelections("junk")).toEqual([]);
    const out = sanitizeSelections([
      { filename: "a.safetensors", strength: 7, triggers: ["t", 3, ""] },
      { filename: "a.safetensors" },
      { nope: true },
      { filename: "b.safetensors", applyAnyway: true, baseFamily: "sdxl" },
      { filename: "c.safetensors" },
    ]);
    expect(out.map((s) => s.filename)).toEqual(["a.safetensors", "b.safetensors"]);
    expect(out[0].strength).toBe(1.5);
    expect(out[0].triggers).toEqual(["t"]);
    expect(out[0].label).toBe("a");
    expect(out[1].applyAnyway).toBe(true);
  });
});

describe("model family", () => {
  it("maps engine versions, checkpoints and workflows to groups", () => {
    expect(activeFamilyGroup({ modelVersion: "krea-2-comfyui" })).toBe("krea2");
    expect(activeFamilyGroup({ modelVersion: "zimage-turbo" })).toBe("zimage");
    expect(activeFamilyGroup({ modelVersion: "custom", modelFamily: "sdxl" })).toBe("sdxl");
    expect(activeFamilyGroup({ modelVersion: "custom", modelFamily: "unknown" })).toBeNull();
    expect(activeFamilyGroup({ modelVersion: "custom", workflowName: "Flux dev txt2img" })).toBe("flux");
  });

  it("engine versions ignore the default checkpoint", () => {
    expect(
      familyFromInputs({ modelVersion: "custom", defaultModel: "sd_xl_base_1.0.safetensors" }),
    ).toBe("sdxl");
    expect(
      familyFromInputs({ modelVersion: "ideogram4", defaultModel: "sd_xl_base_1.0.safetensors" }),
    ).toBe("ideogram4");
  });

  it("warns only when both sides are known and differ", () => {
    expect(isFamilyMismatch({ baseFamily: "sdxl" }, "krea2")).toBe(true);
    expect(isFamilyMismatch({ baseFamily: "sdxl" }, "sdxl")).toBe(false);
    expect(isFamilyMismatch({ baseFamily: null }, "krea2")).toBe(false);
    expect(isFamilyMismatch({ baseFamily: "sdxl" }, null)).toBe(false);
  });

  it("holds back a mismatched character unless Use anyway is on", () => {
    const list = [sel("x.safetensors", { baseFamily: "sdxl" })];
    expect(appliedSelections(list, "krea2")).toEqual([]);
    expect(applyCharactersToPrompt("a cat", list, "krea2")).toBe("a cat");
    const anyway = [sel("x.safetensors", { baseFamily: "sdxl", applyAnyway: true })];
    expect(applyCharactersToPrompt("a cat", anyway, "krea2")).toBe(
      "a cat --lora x.safetensors::0.9",
    );
  });
});

describe("prompt wiring", () => {
  it("one --lora flag per character, parsed by the engine as separate LoRAs", () => {
    const prompt = applyCharactersToPrompt(
      "a knight in a forest --sref 123",
      [
        sel("chars/alice.safetensors", { strength: 0.85, triggers: ["alicetrig"] }),
        sel("bob.safetensors", { strength: 1, triggers: ["bobtrig", "knight"] }),
      ],
      null,
    );
    expect(prompt).toBe(
      "alicetrig, bobtrig, a knight in a forest --sref 123 --lora chars/alice.safetensors::0.85 --lora bob.safetensors::1",
    );
    const parsed = parseImagineInput(prompt);
    expect(parsed.params.lora).toEqual([
      "chars/alice.safetensors::0.85",
      "bob.safetensors::1",
    ]);
  });

  it("leaves a LoRA the user already typed alone", () => {
    expect(
      applyCharactersToPrompt(
        "a cat --lora bob.safetensors::0.5",
        [sel("bob.safetensors", { triggers: ["bobtrig"] })],
        null,
      ),
    ).toBe("a cat --lora bob.safetensors::0.5");
  });

  it("skips file names with spaces (the flag can't carry them)", () => {
    expect(characterLoraFlags([sel("bad name.safetensors"), sel("ok.safetensors")])).toBe(
      "--lora ok.safetensors::0.9",
    );
  });

  it("character flags don't count as the user's own --lora", () => {
    const files = ["a.safetensors"];
    expect(promptHasOwnLora("x --lora a.safetensors::0.9", files)).toBe(false);
    expect(promptHasOwnLora("x --lora a.safetensors::0.9 --lora style.safetensors", files)).toBe(true);
    expect(promptHasOwnLora("x", files)).toBe(false);
  });
});

describe("Anima reference adapter detection", () => {
  it("looks for the loader node in /object_info", () => {
    expect(hasAnimaRefAdapter({ AnimaRefAdapterLoader: { input: {} } })).toBe(true);
    expect(hasAnimaRefAdapter({})).toBe(false);
    expect(hasAnimaRefAdapter(null)).toBe(false);
    expect(hasAnimaRefAdapter(["AnimaRefAdapterLoader"])).toBe(false);
  });

  it("v2: the one-node AnimaRefAdapter counts as installed and as v2", () => {
    expect(hasAnimaRefAdapter({ AnimaRefAdapter: { input: {} } })).toBe(true);
    expect(hasAnimaRefAdapterV2({ AnimaRefAdapter: { input: {} } })).toBe(true);
    expect(hasAnimaRefAdapterV2({ AnimaRefAdapterLoader: { input: {} } })).toBe(false);
    expect(hasAnimaRefAdapterV2(null)).toBe(false);
  });
});

describe("file names with spaces", () => {
  it("are left out whole: no flag and no trigger words", () => {
    expect(
      applyCharactersToPrompt(
        "a cat",
        [sel("my char.safetensors", { triggers: ["mytrig"] })],
        null,
      ),
    ).toBe("a cat");
  });
});

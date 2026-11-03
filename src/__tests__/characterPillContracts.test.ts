/**
 * Source contracts for the Character pill wiring (the hosts are hooks /
 * big client components without a DOM test harness).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const src = (p: string) => readFileSync(path.resolve(__dirname, "..", p), "utf8");

describe("Character pill wiring", () => {
  const bar = src("components/PromptBar.tsx");

  it("sits between Styles and Images and opens the picker", () => {
    const styles = bar.indexOf('label="Styles"');
    const character = bar.indexOf('label="Character"');
    const images = bar.indexOf('label="Images"');
    expect(styles).toBeGreaterThan(-1);
    expect(character).toBeGreaterThan(styles);
    expect(images).toBeGreaterThan(character);
    expect(bar).toContain("<CharacterPicker");
    expect(bar).toContain("<CharacterChips />");
  });

  it("applies characters at submit, after the style refs", () => {
    const submit = bar.slice(bar.indexOf("const handleSubmit"), bar.indexOf("const handleKeyDown"));
    expect(submit).toMatch(/applyCharactersToPrompt\(\s*srefStr/);
    expect(submit).toContain("useCharacterLoraStore.getState().selected");
    expect(submit).toContain("currentCharacterFamily()");
  });

  it("image inputs stay separate from characters", () => {
    expect(src("components/PromptAttachmentSections.tsx")).not.toMatch(/characterLora/i);
  });

  it("Settings LoRAs survive a character pick, one --lora flag each", () => {
    const hook = src("hooks/useImagine.ts");
    expect(hook).toContain("!promptHasOwnLora(");
    expect(hook).toContain("useCharacterLoraStore.getState().selected");
    expect(hook).not.toMatch(/resolvedLoras\.length > 0 && !basePrompt\.includes\("--lora"\)/);
    expect(hook).toContain(".map((l) => `--lora ${l}`)");
  });

  it("trainer deploys tag character / style boards", () => {
    const panel = src("components/training/LoraRunPanel.tsx");
    expect(panel).toMatch(/board\.kind === "character" \|\| board\.kind === "style"/);
    expect(panel).toContain("[board.kind]");
  });
});

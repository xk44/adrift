import { describe, expect, it } from "vitest";
import {
  BASE_MODEL_FAMILIES,
  BASE_MODEL_GROUPS,
  CIVITAI_BASE_MODELS,
  CIVITAI_MODEL_SORTS,
  CIVITAI_MODEL_TYPES,
  CIVITAI_PERIODS,
  baseModelFamily,
  isCivitaiBaseModel,
  isCivitaiModelType,
  searchBaseModelGroups,
} from "@/lib/civitaiFilters";

describe("civitai enum module", () => {
  it("matches the live enum counts", () => {
    expect(CIVITAI_MODEL_SORTS).toHaveLength(8);
    expect([...CIVITAI_PERIODS].sort()).toEqual(
      ["AllTime", "Day", "Month", "Week", "Year"],
    );
    expect(CIVITAI_MODEL_TYPES).toHaveLength(23);
    expect(CIVITAI_BASE_MODELS).toHaveLength(117);
  });

  it("uses Civitai's exact type spelling (Controlnet, not ControlNet)", () => {
    expect(isCivitaiModelType("Controlnet")).toBe(true);
    expect(isCivitaiModelType("ControlNet")).toBe(false);
  });

  it("has no base model names containing commas (repeated params are safe)", () => {
    for (const b of CIVITAI_BASE_MODELS) expect(b).not.toContain(",");
  });
});

describe("base-model families", () => {
  it("places every base model in exactly one family group", () => {
    const grouped = BASE_MODEL_GROUPS.flatMap((g) => g.models);
    expect(grouped).toHaveLength(CIVITAI_BASE_MODELS.length);
    expect(new Set(grouped).size).toBe(CIVITAI_BASE_MODELS.length);
    expect(BASE_MODEL_GROUPS.map((g) => g.family)).toEqual(
      BASE_MODEL_FAMILIES.filter((f) =>
        BASE_MODEL_GROUPS.some((g) => g.family === f),
      ),
    );
  });

  it("keeps the picker from being one big wall", () => {
    for (const g of BASE_MODEL_GROUPS) {
      expect(g.models.length).toBeGreaterThan(0);
    }
    const other = BASE_MODEL_GROUPS.find((g) => g.family === "Other");
    expect(other!.models.length).toBeLessThan(CIVITAI_BASE_MODELS.length / 2);
  });

  it.each([
    ["Flux.1 D", "Flux"],
    ["Flux.1 Krea", "Flux"],
    ["SDXL 1.0", "SDXL"],
    ["SD 1.5", "SD1.x"],
    ["SD 3.5 Large", "SD2 / SD3"],
    ["Wan Video 2.2 I2V-A14B", "Wan"],
    ["LTXV 2.3", "LTX"],
    ["Qwen 2.1", "Qwen"],
    ["Krea 2", "Krea"],
    ["Illustrious", "Pony / Illustrious / Noob"],
    ["NoobAI", "Pony / Illustrious / Noob"],
    ["Hunyuan Video", "Video"],
    ["Flux 3 Video", "Video"],
    ["Flux.3", "Flux"],
    ["ACE Audio", "Audio"],
    ["Hunyuan3D", "3D"],
    ["Some Future Model", "Other"],
  ])("%s → %s", (name, family) => {
    expect(baseModelFamily(name)).toBe(family);
  });

  it("searches case-insensitively and drops empty families", () => {
    const groups = searchBaseModelGroups("wan video 2.2");
    expect(groups.map((g) => g.family)).toEqual(["Wan"]);
    expect(groups[0].models.every((m) => /2\.2/.test(m))).toBe(true);
    expect(searchBaseModelGroups("")).toEqual(BASE_MODEL_GROUPS);
    expect(searchBaseModelGroups("zzzz-nope")).toEqual([]);
  });

  it("matches a family name too", () => {
    const groups = searchBaseModelGroups("pony");
    expect(groups.some((g) => g.models.includes("Pony V7"))).toBe(true);
    expect(isCivitaiBaseModel("Pony V7")).toBe(true);
  });
});

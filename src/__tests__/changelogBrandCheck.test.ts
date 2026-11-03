import { describe, it, expect } from "vitest";
import { CHANGELOG } from "@/lib/changelog";

/**
 * User-facing changelog copy names no third-party products or services.
 * Model credits (SDXL, Flux, SD1.5, ...) and the ComfyUI backend are fine;
 * comparisons to other apps and named service integrations are not.
 */
const BRANDS = [
  /mid\s*journey/i,
  /\bmj\b/i,
  /higgsfield/i,
  /civitai/i,
  /runway/i,
  /leonardo/i,
  /\bpika\b/i,
  /openai|chatgpt|dall-?e/i,
  /adobe|photoshop|firefly|lightroom/i,
  /\bcanva\b/i,
  /\bfal(\.ai)?\b/i,
  /replicate/i,
  /discord/i,
];

function strings(): string[] {
  return CHANGELOG.flatMap((e) => [
    e.title,
    ...e.highlights,
    ...(e.fixes ?? []),
  ]);
}

describe("changelog brand check", () => {
  it("has no third-party brand names outside model credits", () => {
    const hits = strings().filter((s) => BRANDS.some((re) => re.test(s)));
    expect(hits).toEqual([]);
  });

  it("keeps model credits", () => {
    expect(strings().join("\n")).toMatch(/SDXL, Flux, and SD1\.5/);
  });
});

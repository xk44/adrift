import { describe, expect, it } from "vitest";
import { buildKreaMoodboardEntry } from "../../scripts/import-krea-moodboards.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("buildKreaMoodboardEntry", () => {
  it("builds bounded moodboard entries with deterministic ids and encoded image URLs", () => {
    const board = {
      uuid: "local-krea-board-uuid",
      name: "N".repeat(120),
      taste_profile: "taste ".repeat(140),
      keywords: ["neon noir", "glass", "macro", "grain", "cinematic", "ink", "extra"],
    };
    const files = [
      "z image.png",
      "01.png",
      "02.webp",
      "03.jpg",
      "04.jpeg",
      "05.PNG",
      "06.png",
      "07.png",
      "08.png",
      "09.png",
      "10.png",
      "11.png",
      "12.png",
      "13.png",
      "14.png",
      "15.png",
      "16.png",
      "17.png",
      "18.png",
      "19.png",
      "20.png",
      "bad.svg",
    ];

    const entry = buildKreaMoodboardEntry(
      board,
      "01_Test_Board_images",
      files,
      1700000000000,
    );

    expect(entry.id).toMatch(UUID_RE);
    expect(entry.id).toBe(
      buildKreaMoodboardEntry(board, "01_Test_Board_images", [], 1).id,
    );
    expect(entry.name).toHaveLength(100);
    expect(entry.description.length).toBeLessThanOrEqual(500);
    expect(entry.description).toContain("neon noir");
    expect(entry.images).toHaveLength(20);
    expect(entry.images.every((image) => image.weight === 1)).toBe(true);
    expect(entry.images[0].url).toBe(
      "/api/moodboards/krea?board=01_Test_Board_images&file=01.png",
    );
    expect(entry.images.some((image) => image.url.includes("bad.svg"))).toBe(false);
    expect(entry.images.some((image) => image.url.includes("z%20image.png"))).toBe(false);
  });
});

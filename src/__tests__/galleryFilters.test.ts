import { describe, expect, it } from "vitest";
import {
  createGalleryImageFilter,
  filterGalleryImages,
  matchesGalleryPromptQuery,
} from "@/lib/galleryFilters";

const images = [
  { id: "1", prompt: "A neon city at night", liked: true },
  { id: "2", prompt: "Quiet forest cabin", hidden: true },
  { id: "3", prompt: "Forest trail in fog", liked: false },
  { id: "4", prompt: "Portrait study", liked: true, hidden: true },
];

describe("galleryFilters", () => {
  it("matches prompt query case-insensitively and trims whitespace", () => {
    expect(
      matchesGalleryPromptQuery({ prompt: "A Neon City at Night" }, " neon "),
    ).toBe(true);
    expect(
      matchesGalleryPromptQuery({ prompt: "A Neon City at Night" }, "forest"),
    ).toBe(false);
  });

  it("filters images by prompt substring", () => {
    expect(filterGalleryImages(images, { query: "forest" }).map((img) => img.id))
      .toEqual(["2", "3"]);
  });

  it("excludes hidden images when requested", () => {
    expect(
      filterGalleryImages(images, { query: "forest", excludeHidden: true }).map(
        (img) => img.id,
      ),
    ).toEqual(["3"]);
  });

  it("filters to liked images only", () => {
    expect(filterGalleryImages(images, { likedOnly: true }).map((img) => img.id))
      .toEqual(["1", "4"]);
  });

  it("combines query, liked-only, and hidden exclusion in one predicate", () => {
    const predicate = createGalleryImageFilter({
      query: "portrait",
      likedOnly: true,
      excludeHidden: true,
    });

    expect(images.filter(predicate)).toEqual([]);
  });
});

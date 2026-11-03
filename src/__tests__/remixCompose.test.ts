import { describe, expect, it } from "vitest";
import {
  buildRemixComposition,
  REMIX_WEIGHT_STRONG,
  REMIX_WEIGHT_SUBTLE,
  stripSeedFromPrompt,
} from "@/lib/remixCompose";
import type { GalleryImage, ImageAttachment } from "@/types";

const baseImage = (
  overrides: Partial<GalleryImage> = {},
): Pick<GalleryImage, "url" | "prompt" | "fullPrompt" | "sourceImages"> => ({
  url: "https://example.test/output.png",
  prompt: "a glass city",
  fullPrompt: "a glass city --ar 16:9 --seed 12345 --stylize 250",
  sourceImages: [],
  ...overrides,
});

const ids = () => {
  let index = 0;
  return () => `id-${++index}`;
};

describe("remix composition", () => {
  it("strips seed values from prompts", () => {
    expect(stripSeedFromPrompt("alpha --seed 42 beta")).toBe("alpha beta");
    expect(stripSeedFromPrompt("--seed 42 alpha")).toBe("alpha");
  });

  it("attaches the original image as a subtle image prompt", () => {
    const composition = buildRemixComposition(baseImage(), "subtle", {
      createId: ids(),
    });

    expect(composition.prompt).toBe("a glass city --ar 16:9 --stylize 250");
    expect(composition.attachments[0]).toMatchObject({
      id: "id-1",
      url: "https://example.test/output.png",
      mode: "image_prompt",
      weight: REMIX_WEIGHT_SUBTLE,
    });
  });

  it("uses a lower original image weight for strong remix", () => {
    const composition = buildRemixComposition(baseImage(), "strong", {
      createId: ids(),
    });

    expect(composition.attachments[0].weight).toBe(REMIX_WEIGHT_STRONG);
    expect(REMIX_WEIGHT_SUBTLE).toBeGreaterThan(REMIX_WEIGHT_STRONG);
  });

  it("restores source images with their original modes and weights", () => {
    const sourceImages: ImageAttachment[] = [
      {
        id: "old-style",
        url: "https://example.test/style.png",
        mode: "style_ref",
        weight: 1.4,
        filename: "style.png",
      },
      {
        id: "old-start",
        url: "https://example.test/start.png",
        mode: "starting_frame",
        weight: 0.8,
      },
    ];

    const composition = buildRemixComposition(
      baseImage({ sourceImages }),
      "subtle",
      { createId: ids() },
    );

    expect(composition.attachments).toHaveLength(3);
    expect(composition.attachments[1]).toMatchObject({
      id: "id-2",
      url: "https://example.test/style.png",
      mode: "style_ref",
      weight: 1.4,
      filename: "style.png",
    });
    expect(composition.attachments[2]).toMatchObject({
      id: "id-3",
      url: "https://example.test/start.png",
      mode: "starting_frame",
      weight: 0.8,
    });
  });

  it("does not duplicate the original output image from sourceImages", () => {
    const composition = buildRemixComposition(
      baseImage({
        sourceImages: [
          {
            id: "old-output",
            url: "https://example.test/output.png",
            mode: "image_prompt",
            weight: 1,
          },
        ],
      }),
      "subtle",
      { createId: ids() },
    );

    expect(composition.attachments).toHaveLength(1);
    expect(composition.attachments[0].url).toBe(
      "https://example.test/output.png",
    );
  });
});

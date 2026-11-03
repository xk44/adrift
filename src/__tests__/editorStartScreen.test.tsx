import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GalleryImage } from "@/types";
import {
  collectEditorUploads,
  firstImageFile,
  normalizeImageLinkInput,
  selectEditorGenerations,
} from "@/components/editor/editorStartScreen";

const storeMock = vi.hoisted(() => ({
  editor: { setSourceImage: vi.fn() },
  generation: { gallery: [] as unknown[] },
}));

vi.mock("@/store/editorStore", () => ({
  useEditorStore: Object.assign(
    (selector: (state: typeof storeMock.editor) => unknown) =>
      selector(storeMock.editor),
    { subscribe: () => () => {} },
  ),
}));

vi.mock("@/store", () => ({
  useGenerationStore: (
    selector: (state: typeof storeMock.generation) => unknown,
  ) => selector(storeMock.generation),
}));

function img(overrides: Partial<GalleryImage> & { id: string }): GalleryImage {
  return {
    url: `/api/view?filename=${overrides.id}.png`,
    prompt: "",
    fullPrompt: "",
    params: [],
    paramsMap: {},
    seed: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    runId: `run-${overrides.id}`,
    jobIndex: 0,
    width: 1024,
    height: 1024,
    ...overrides,
  };
}

describe("normalizeImageLinkInput", () => {
  it("accepts http(s) URLs and trims whitespace", () => {
    expect(normalizeImageLinkInput("  https://example.com/a.png ")).toBe(
      "https://example.com/a.png",
    );
    expect(normalizeImageLinkInput("http://localhost:8188/view?x=1")).toBe(
      "http://localhost:8188/view?x=1",
    );
  });

  it("upgrades bare hosts to https", () => {
    expect(normalizeImageLinkInput("example.com/cat.jpg")).toBe(
      "https://example.com/cat.jpg",
    );
    expect(normalizeImageLinkInput("//cdn.example.com/x.webp")).toBe(
      "https://cdn.example.com/x.webp",
    );
  });

  it("keeps same-origin paths and image data URIs", () => {
    expect(normalizeImageLinkInput("/api/view?filename=a.png")).toBe(
      "/api/view?filename=a.png",
    );
    expect(normalizeImageLinkInput("data:image/png;base64,AAAA")).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  it("rejects empty, non-web, and host-less input", () => {
    expect(normalizeImageLinkInput("")).toBeNull();
    expect(normalizeImageLinkInput("   ")).toBeNull();
    expect(normalizeImageLinkInput("javascript:alert(1)")).toBeNull();
    expect(normalizeImageLinkInput("file:///etc/passwd")).toBeNull();
    expect(normalizeImageLinkInput("data:text/html,hi")).toBeNull();
    expect(normalizeImageLinkInput("not a link")).toBeNull();
    expect(normalizeImageLinkInput("hello")).toBeNull();
  });
});

describe("selectEditorGenerations", () => {
  const gallery = [
    img({ id: "old", prompt: "a red fox", createdAt: "2026-10-01T00:00:00Z" }),
    img({
      id: "new",
      prompt: "neon city at night",
      createdAt: "2026-10-03T00:00:00Z",
      liked: true,
    }),
    img({
      id: "mid",
      prompt: "red neon sign",
      createdAt: "2026-10-02T00:00:00Z",
    }),
    img({ id: "hidden", prompt: "red", hidden: true }),
    img({ id: "video", prompt: "red", videoUrl: "/v.mp4" }),
    img({
      id: "ext",
      prompt: "red",
      external: { source: "civitai", id: 1 },
    }),
  ];

  it("returns still, visible, local images newest first", () => {
    expect(
      selectEditorGenerations(gallery, { filter: "all", query: "" }).map(
        (g) => g.id,
      ),
    ).toEqual(["new", "mid", "old"]);
  });

  it("filters to liked images", () => {
    expect(
      selectEditorGenerations(gallery, { filter: "liked", query: "" }).map(
        (g) => g.id,
      ),
    ).toEqual(["new"]);
  });

  it("matches every search term case-insensitively", () => {
    expect(
      selectEditorGenerations(gallery, { filter: "all", query: "RED" }).map(
        (g) => g.id,
      ),
    ).toEqual(["mid", "old"]);
    expect(
      selectEditorGenerations(gallery, {
        filter: "all",
        query: "red neon",
      }).map((g) => g.id),
    ).toEqual(["mid"]);
  });

  it("searches the full prompt too", () => {
    const withParams = [
      img({ id: "p", prompt: "fox", fullPrompt: "fox --ar 16:9" }),
    ];
    expect(
      selectEditorGenerations(withParams, { filter: "all", query: "16:9" }),
    ).toHaveLength(1);
  });
});

describe("collectEditorUploads", () => {
  it("dedupes reference images by URL, newest first, skipping blob URLs", () => {
    const gallery = [
      img({
        id: "a",
        createdAt: "2026-10-01T00:00:00Z",
        sourceImages: [
          { id: "s1", url: "/uploads/one.png", mode: "image_prompt", weight: 1 },
          { id: "s2", url: "blob:http://x/dead", mode: "image_prompt", weight: 1 },
        ],
      }),
      img({
        id: "b",
        createdAt: "2026-10-05T00:00:00Z",
        sourceImages: [
          {
            id: "s3",
            url: "/uploads/two.png",
            filename: "two.png",
            mode: "style_ref",
            weight: 1,
          },
          { id: "s4", url: "/uploads/one.png", mode: "image_prompt", weight: 1 },
        ],
      }),
      img({ id: "c" }),
    ];

    expect(collectEditorUploads(gallery)).toEqual([
      { id: "s3", url: "/uploads/two.png", label: "two.png" },
      { id: "s4", url: "/uploads/one.png", label: "Uploaded image" },
    ]);
  });
});

describe("firstImageFile", () => {
  it("picks the first image file and ignores others", () => {
    const text = new File(["x"], "a.txt", { type: "text/plain" });
    const png = new File(["x"], "b.png", { type: "image/png" });
    expect(firstImageFile([text, png])).toBe(png);
    expect(firstImageFile([text])).toBeNull();
    expect(firstImageFile(null)).toBeNull();
  });
});

describe("EditorEmptyState start screen", () => {
  it("renders the drop zone, link card, and generation picker", async () => {
    storeMock.generation.gallery = [
      img({ id: "g1", prompt: "lighthouse in fog", liked: true }),
      img({
        id: "g2",
        prompt: "desert road",
        sourceImages: [
          { id: "u1", url: "/uploads/ref.png", mode: "image_prompt", weight: 1 },
        ],
      }),
    ];
    const { EditorEmptyState } =
      await import("@/components/editor/EditorEmptyState");
    const html = renderToStaticMarkup(<EditorEmptyState />);

    expect(html).toContain("What do you want to change?");
    expect(html).toContain("Drop an image or video here");
    expect(html).toContain("Upload image");
    expect(html).toContain("Paste an image link");
    expect(html).toContain("Add image");
    expect(html).toContain("Your uploads");
    expect(html).toContain("/uploads/ref.png");
    expect(html).toContain("Recent generations");
    expect(html).toContain("Search your prompts");
    expect(html).toContain("Edit image: lighthouse in fog");
    expect(html).toContain("Edit image: desert road");
  });

  it("hides the uploads section and shows an empty hint with no history", async () => {
    storeMock.generation.gallery = [];
    const { EditorEmptyState } =
      await import("@/components/editor/EditorEmptyState");
    const html = renderToStaticMarkup(<EditorEmptyState />);

    expect(html).not.toContain("Your uploads");
    expect(html).toContain("Nothing generated yet");
  });
});

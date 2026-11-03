import { describe, expect, it } from "vitest";
import type { GalleryImage } from "@/types";
import {
  catalogStyleImageUrl,
  compactParamChips,
  promptForReuse,
  promptSrefCodes,
  rankImagesByPrompt,
  recentPromptCards,
  savedStyleCollage,
  sessionNameFromPrompt,
  stripPromptFlags,
  togglePromptSref,
  type StyleSession,
} from "@/components/style/styleCreatorLogic";

function img(partial: Partial<GalleryImage> & { id: string }): GalleryImage {
  return {
    url: `/img/${partial.id}.png`,
    prompt: "",
    fullPrompt: "",
    params: [],
    paramsMap: {},
    seed: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    runId: "run",
    jobIndex: 0,
    width: 512,
    height: 512,
    ...partial,
  };
}

describe("stripPromptFlags", () => {
  it("drops trailing flags", () => {
    expect(stripPromptFlags("rainy dock at dusk --ar 16:9 --s 250")).toBe(
      "rainy dock at dusk",
    );
  });
  it("keeps em-dash style text and handles flag-only prompts", () => {
    expect(stripPromptFlags("a well-lit room")).toBe("a well-lit room");
    expect(stripPromptFlags("--sref 123")).toBe("");
  });
});

describe("promptForReuse", () => {
  it("drops --seed anywhere, keeps other flags", () => {
    expect(promptForReuse("fern --ar 1:1 --seed 1040")).toBe("fern --ar 1:1");
    expect(promptForReuse("fern --SEED 5 --s 250")).toBe("fern --s 250");
    expect(promptForReuse("plain prompt")).toBe("plain prompt");
  });
});

describe("sessionNameFromPrompt", () => {
  it("falls back when prompt has no text", () => {
    expect(sessionNameFromPrompt("--sref 1", "Style 3")).toBe("Style 3");
    expect(sessionNameFromPrompt("   ", "Style 3")).toBe("Style 3");
  });
  it("truncates on a word boundary", () => {
    const name = sessionNameFromPrompt(
      "an abandoned greenhouse overgrown with glowing ferns at night",
      "x",
      30,
    );
    expect(name.endsWith("…")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).toBe("an abandoned greenhouse…");
  });
});

describe("sref prompt helpers", () => {
  it("reads sref codes", () => {
    expect(promptSrefCodes("cat --sref 12 34 --ar 1:1")).toEqual(["12", "34"]);
    expect(promptSrefCodes("cat --ar 1:1")).toEqual([]);
  });
  it("adds, replaces and toggles off a code", () => {
    expect(togglePromptSref("", "42")).toBe("--sref 42");
    expect(togglePromptSref("cat --ar 1:1", "42")).toBe(
      "cat --ar 1:1 --sref 42",
    );
    expect(togglePromptSref("cat --sref 7 --ar 1:1", "42")).toBe(
      "cat --ar 1:1 --sref 42",
    );
    expect(togglePromptSref("cat --sref 42", "42")).toBe("cat");
  });
  it("builds catalog image urls", () => {
    expect(catalogStyleImageUrl("123", "still_life")).toBe(
      "/api/style-catalog?code=123&subject=still_life",
    );
  });
});

describe("compactParamChips", () => {
  it("humanizes keys, orders by importance and hides noise", () => {
    expect(
      compactParamChips({
        seed: 99,
        chaos: 20,
        stylize: 1000,
        ar: "1:1",
        raw: true,
        model: "flux.safetensors",
        packId: "internal",
      }),
    ).toEqual(["ar 1:1", "s 1000", "c 20", "raw"]);
  });
  it("maps legacy aspectRatio to ar and caps the count", () => {
    expect(compactParamChips({ aspectRatio: "16:9" })).toEqual(["ar 16:9"]);
    expect(
      compactParamChips({ ar: "1:1", stylize: 1, chaos: 2, weird: 3, q: 1 }, 2),
    ).toEqual(["ar 1:1", "s 1"]);
  });
  it("returns [] for missing params", () => {
    expect(compactParamChips(undefined)).toEqual([]);
  });
});

describe("recentPromptCards", () => {
  it("dedupes prompts, newest first, skipping hidden/external", () => {
    const gallery = [
      img({
        id: "old",
        prompt: "harbor at dawn",
        fullPrompt: "harbor at dawn --ar 3:2",
        paramsMap: { ar: "3:2" },
        createdAt: "2026-10-01T00:00:00.000Z",
      }),
      img({
        id: "new",
        prompt: "Harbor at dawn",
        fullPrompt: "Harbor at dawn --seed 77 --s 50",
        createdAt: "2026-10-03T00:00:00.000Z",
      }),
      img({
        id: "hidden",
        prompt: "secret",
        hidden: true,
        createdAt: "2026-10-04T00:00:00.000Z",
      }),
      img({
        id: "ext",
        prompt: "external",
        external: { source: "civitai", id: 1 },
        createdAt: "2026-10-05T00:00:00.000Z",
      }),
      img({
        id: "mid",
        prompt: "desert train",
        createdAt: "2026-10-02T00:00:00.000Z",
      }),
      img({ id: "blank", prompt: "", createdAt: "2026-10-06T00:00:00.000Z" }),
    ];
    const cards = recentPromptCards(gallery);
    expect(cards.map((c) => c.id)).toEqual(["new", "mid"]);
    expect(cards[0].fullPrompt).toBe("Harbor at dawn --s 50");
    expect(cards[0].text).toBe("Harbor at dawn");
  });
  it("respects the limit", () => {
    const gallery = Array.from({ length: 10 }, (_, i) =>
      img({ id: `i${i}`, prompt: `prompt ${i}` }),
    );
    expect(recentPromptCards(gallery, 6)).toHaveLength(6);
  });
});

describe("savedStyleCollage", () => {
  const sessions: StyleSession[] = [
    {
      id: "s1",
      name: "S",
      createdAt: "",
      updatedAt: "",
      selectedImageIds: ["a", "b", "c", "d", "e"],
      status: "done",
      styleCode: "abc",
    },
  ];
  const byId = new Map(
    ["a", "b", "c", "d", "e"].map((id) => [id, img({ id })] as const),
  );

  it("uses the producing session's references (max 4)", () => {
    expect(savedStyleCollage("abc", "/img/a.png", sessions, byId)).toEqual([
      "/img/a.png",
      "/img/b.png",
      "/img/c.png",
      "/img/d.png",
    ]);
  });
  it("falls back to the thumbnail, then nothing", () => {
    expect(savedStyleCollage("zzz", "/t.png", sessions, byId)).toEqual([
      "/t.png",
    ]);
    expect(savedStyleCollage("zzz", undefined, sessions, byId)).toEqual([]);
  });
});

describe("rankImagesByPrompt", () => {
  const images = [
    { id: "1", prompt: "a red car in the city" },
    { id: "2", prompt: "neon city street in rain --ar 16:9" },
    { id: "3", prompt: "mountain lake" },
  ];
  it("keeps order without a prompt", () => {
    expect(rankImagesByPrompt(images, undefined).map((i) => i.id)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });
  it("puts word-overlap matches first, stably", () => {
    expect(
      rankImagesByPrompt(images, "rainy neon city --s 100").map((i) => i.id),
    ).toEqual(["2", "1", "3"]);
  });
});

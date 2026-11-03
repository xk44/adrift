import { beforeEach, describe, expect, it } from "vitest";
import { usePromptPreviewStore } from "@/store/promptPreviewStore";
import { exploreCardAuthor } from "@/components/ExploreCardOverlay";

describe("promptPreviewStore", () => {
  beforeEach(() => {
    usePromptPreviewStore.setState({ preview: null, owner: null });
  });

  it("sets and clears by owner", () => {
    const { setPreview, clearPreview } = usePromptPreviewStore.getState();
    setPreview("a", "first");
    expect(usePromptPreviewStore.getState().preview).toBe("first");
    clearPreview("a");
    expect(usePromptPreviewStore.getState().preview).toBeNull();
  });

  it("ignores a stale clear from a previous owner", () => {
    const { setPreview, clearPreview } = usePromptPreviewStore.getState();
    setPreview("a", "first");
    setPreview("b", "second");
    clearPreview("a");
    expect(usePromptPreviewStore.getState()).toMatchObject({
      owner: "b",
      preview: "second",
    });
  });
});

describe("exploreCardAuthor", () => {
  it("prefers the handle, falls back to source", () => {
    expect(exploreCardAuthor("artist")).toBe("artist");
    expect(exploreCardAuthor("  ")).toBe("Civitai");
    expect(exploreCardAuthor(undefined)).toBe("Civitai");
    expect(exploreCardAuthor(null, "Styles")).toBe("Styles");
  });
});

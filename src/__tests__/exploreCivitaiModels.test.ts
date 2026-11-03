import { describe, expect, it, beforeEach } from "vitest";
import { useExploreStore } from "@/store/exploreStore";
import {
  DEFAULT_MODEL_FILTERS,
  buildCivitaiModelQuery,
} from "@/lib/modelFilters";

beforeEach(() => {
  useExploreStore.setState({
    primaryTab: "hot",
    secondaryTab: "images",
    topPeriod: "week",
    searchQuery: "",
    viewMode: "grid",
    modelFilters: DEFAULT_MODEL_FILTERS,
    refreshNonce: 0,
  });
});

describe("Explore Civitai model tabs", () => {
  it("allows models and loras as secondary tabs", () => {
    useExploreStore.getState().setSecondaryTab("models");
    expect(useExploreStore.getState().secondaryTab).toBe("models");

    useExploreStore.getState().setSecondaryTab("loras");
    expect(useExploreStore.getState().secondaryTab).toBe("loras");
  });

  it("stores the shared model filters", () => {
    const next = {
      ...DEFAULT_MODEL_FILTERS,
      source: "civitai-red" as const,
      nsfw: false,
    };
    useExploreStore.getState().setModelFilters(next);
    expect(useExploreStore.getState().modelFilters).toEqual(next);
  });

  it("builds LoRA searches with independent source and nsfw params", () => {
    const params = buildCivitaiModelQuery(
      { ...DEFAULT_MODEL_FILTERS, source: "civitai-red", nsfw: false },
      { query: "anime", scope: "loras" },
    );

    expect(params.get("q")).toBe("anime");
    expect(params.getAll("types")).toEqual(["LORA", "LoCon", "DoRA"]);
    expect(params.get("source")).toBe("red");
    expect(params.get("nsfw")).toBe("false");
    expect(params.get("sort")).toBe("Highest Rated");
    // Cursor pagination: Civitai rejects `page` together with a query.
    expect(params.has("page")).toBe(false);
  });
});

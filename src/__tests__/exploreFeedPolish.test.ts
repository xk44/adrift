/**
 * Explore polish: plain-language feed errors (with the Settings link only
 * for Civitai auth refusals), NSFW reset when leaving Civitai Red, and the
 * Likes tab falling back to Hot on tabs that have no likes list.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { describeFeedError } from "@/lib/explore/civitaiErrors";
import {
  DEFAULT_MODEL_FILTERS,
  withModelSource,
  type ModelFilters,
} from "@/lib/modelFilters";
import { supportsLikes, useExploreStore } from "@/store/exploreStore";

describe("describeFeedError", () => {
  it("Civitai 401/403 asks for an API key in Settings", () => {
    for (const raw of [
      "Civitai API error 401: Unauthorized",
      "Civitai API error 403: Forbidden",
      "This resource requires authentication",
    ]) {
      const info = describeFeedError(raw, "civitai");
      expect(info.needsKey).toBe(true);
      expect(info.message).toContain("Civitai API key in Settings");
    }
  });

  it("never offers the Civitai key link for Hugging Face", () => {
    const info = describeFeedError("Hugging Face request failed (401)", "hf");
    expect(info.needsKey).toBe(false);
  });

  it("rate limits, outages and bad replies get short, actionable copy", () => {
    expect(describeFeedError("Civitai API error 429: slow down").message).toBe(
      "Civitai is limiting requests right now. Wait a minute, then try again.",
    );
    expect(
      describeFeedError("Hugging Face request failed (503)", "hf").message,
    ).toBe("Couldn't reach Hugging Face. Check your connection, then try again.");
    expect(describeFeedError("TypeError: Failed to fetch").message).toContain(
      "Couldn't reach Civitai",
    );
    expect(
      describeFeedError("Unexpected token '<', \"<html>\" is not valid JSON")
        .message,
    ).toContain("sent back something unexpected");
  });

  it("passes other messages through, with a fallback for empty ones", () => {
    expect(describeFeedError("Model not found").message).toBe(
      "Model not found",
    );
    expect(describeFeedError("").message).toBe("Couldn't load from Civitai.");
    expect(describeFeedError(null, "hf").message).toBe(
      "Couldn't load from Hugging Face.",
    );
  });
});

describe("withModelSource", () => {
  it("leaving Civitai Red turns mature results back off", () => {
    const red = { ...DEFAULT_MODEL_FILTERS, source: "civitai-red" as const };
    const mature = { ...red, nsfw: true };
    expect(withModelSource(mature, "civitai").nsfw).toBe(false);
    expect(withModelSource(mature, "hf").nsfw).toBe(false);
    // Round trip: back on Red, the toggle stays off until picked again.
    expect(
      withModelSource(withModelSource(mature, "civitai"), "civitai-red").nsfw,
    ).toBe(false);
  });

  it("keeps the rest of the filters and is a no-op for the same source", () => {
    const f: ModelFilters = {
      ...DEFAULT_MODEL_FILTERS,
      source: "civitai-red" as const,
      nsfw: true,
      baseModels: ["SDXL 1.0"],
    };
    expect(withModelSource(f, "civitai-red")).toBe(f);
    expect(withModelSource(f, "civitai").baseModels).toEqual(["SDXL 1.0"]);
    expect(withModelSource(f, "civitai").source).toBe("civitai");
  });
});

describe("Explore likes tab", () => {
  beforeEach(() => {
    useExploreStore.setState({ primaryTab: "hot", secondaryTab: "images" });
  });

  it("only images and styles have a likes list", () => {
    expect(supportsLikes("images")).toBe(true);
    expect(supportsLikes("styles")).toBe(true);
    expect(supportsLikes("videos")).toBe(false);
    expect(supportsLikes("models")).toBe(false);
    expect(supportsLikes("loras")).toBe(false);
  });

  it("switching to a tab without likes falls back to Hot", () => {
    const s = useExploreStore.getState();
    s.setPrimaryTab("likes");
    s.setSecondaryTab("videos");
    expect(useExploreStore.getState().primaryTab).toBe("hot");
    expect(useExploreStore.getState().secondaryTab).toBe("videos");
  });

  it("styles keeps Likes (liked srefs)", () => {
    const s = useExploreStore.getState();
    s.setPrimaryTab("likes");
    s.setSecondaryTab("styles");
    expect(useExploreStore.getState().primaryTab).toBe("likes");
  });

  it("other sorts are left alone", () => {
    const s = useExploreStore.getState();
    s.setPrimaryTab("new");
    s.setSecondaryTab("models");
    expect(useExploreStore.getState().primaryTab).toBe("new");
  });
});

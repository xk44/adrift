import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  searchCivitaiImages: vi.fn(),
  getCivitaiConfig: vi.fn(),
}));

vi.mock("@/lib/civitai", () => ({
  searchCivitaiImages: mocks.searchCivitaiImages,
  sourceFromNsfw: (nsfw?: boolean) => (nsfw ? "red" : "com"),
}));

vi.mock("@/lib/civitaiConfig", () => ({
  getCivitaiConfig: mocks.getCivitaiConfig,
}));

import { GET } from "@/app/api/civitai/images/route";
import { buildExploreImageQuery } from "@/lib/explore/imageFeed";

function req(query = ""): NextRequest {
  return new NextRequest(`http://localhost:3000/api/civitai/images${query}`);
}

describe("GET /api/civitai/images", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCivitaiConfig.mockResolvedValue({ showNsfw: false });
    mocks.searchCivitaiImages.mockResolvedValue({ items: [], nextCursor: undefined });
  });

  it("forwards a valid Civitai period for Explore Top filters", async () => {
    const res = await GET(req("?sort=Most%20Collected&period=Week&limit=24"));

    expect(res.status).toBe(200);
    expect(mocks.searchCivitaiImages).toHaveBeenCalledWith(
      expect.objectContaining({
        sort: "Most Collected",
        period: "Week",
        limit: 24,
        nsfw: false,
      }),
    );
  });

  it("drops invalid period values instead of forwarding arbitrary query input", async () => {
    const res = await GET(req("?period=Forever&nsfw=true"));

    expect(res.status).toBe(200);
    const options = mocks.searchCivitaiImages.mock.calls[0][0];
    expect(options.period).toBeUndefined();
    expect(options.nsfw).toBe(true);
  });

  it("the Explore client query stays SFW even when the account NSFW toggle is on", async () => {
    mocks.getCivitaiConfig.mockResolvedValue({ showNsfw: true, source: "red" });
    const q = buildExploreImageQuery({ sort: "Most Reactions" });
    const res = await GET(req(`?${q.toString()}`));

    expect(res.status).toBe(200);
    const options = mocks.searchCivitaiImages.mock.calls[0][0];
    expect(options.nsfw).toBe(false);
    expect(options.source).toBe("com");
  });

  it("without explicit params the route is SFW on the normal site, whatever the account config says", async () => {
    mocks.getCivitaiConfig.mockResolvedValue({ showNsfw: true, source: "red" });
    await GET(req("?sort=Newest"));
    const options = mocks.searchCivitaiImages.mock.calls[0][0];
    expect(options.nsfw).toBe(false);
    expect(options.source).toBe("com");
  });

  it("explicit nsfw=true still opts in", async () => {
    await GET(req("?nsfw=true"));
    const options = mocks.searchCivitaiImages.mock.calls[0][0];
    expect(options.nsfw).toBe(true);
    expect(options.source).toBe("red");
  });
});

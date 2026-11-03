import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  searchCivitaiModels: vi.fn(),
  getCivitaiConfig: vi.fn(),
  getCivitaiApiKey: vi.fn(),
}));

vi.mock("@/lib/civitai", () => ({
  searchCivitaiModels: mocks.searchCivitaiModels,
  sourceFromNsfw: (nsfw?: boolean) => (nsfw ? "red" : "com"),
}));

vi.mock("@/lib/civitaiConfig", () => ({
  getCivitaiConfig: mocks.getCivitaiConfig,
  getCivitaiApiKey: mocks.getCivitaiApiKey,
}));

import { GET } from "@/app/api/civitai/models/route";

function req(query = ""): NextRequest {
  return new NextRequest(`http://localhost:3000/api/civitai/models${query}`);
}

describe("GET /api/civitai/models filter validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCivitaiConfig.mockResolvedValue({ showNsfw: false });
    mocks.getCivitaiApiKey.mockResolvedValue(null);
    mocks.searchCivitaiModels.mockResolvedValue({
      items: [],
      metadata: {},
      nextCursor: "1|2|3",
    });
  });

  it("forwards the full filter set and returns nextCursor", async () => {
    const res = await GET(
      req(
        "?q=cat&sort=Most%20Liked&period=Month&types=Checkpoint&types=LORA&baseModels=Flux.1%20D&baseModels=SDXL%201.0&checkpointType=Merge&username=some_user&cursor=1%7C2%7C3&source=red&nsfw=true&limit=24",
      ),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).nextCursor).toBe("1|2|3");
    expect(mocks.searchCivitaiModels).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "cat",
        sort: "Most Liked",
        period: "Month",
        types: ["Checkpoint", "LORA"],
        baseModels: ["Flux.1 D", "SDXL 1.0"],
        checkpointType: "Merge",
        username: "some_user",
        cursor: "1|2|3",
        source: "red",
        nsfw: true,
        limit: 24,
      }),
    );
  });

  it("tolerates legacy comma lists and dedupes", async () => {
    await GET(req("?types=LORA,LoCon&types=LORA"));
    expect(mocks.searchCivitaiModels.mock.calls[0][0].types).toEqual([
      "LORA",
      "LoCon",
    ]);
  });

  it.each([
    "?types=ControlNet",
    "?baseModels=NotAModel",
    "?sort=Random",
    "?period=Forever",
    "?checkpointType=Other",
    "?username=a%20b",
    "?cursor=a%26b",
    "?source=evil",
  ])("rejects %s with 400", async (qs) => {
    const res = await GET(req(qs));
    expect(res.status).toBe(400);
    expect(mocks.searchCivitaiModels).not.toHaveBeenCalled();
  });
});

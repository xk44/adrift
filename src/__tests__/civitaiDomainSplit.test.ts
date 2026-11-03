/**
 * Civitai SFW/NSFW domain routing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getCivitaiApiKey: vi.fn().mockResolvedValue(""),
  getCivitaiConfig: vi.fn().mockResolvedValue({ showNsfw: false }),
}));

vi.mock("@/lib/env", () => ({
  env: {
    ADMIN_API_KEY: "",
    CIVITAI_API_KEY: "",
  },
}));

vi.mock("@/lib/civitaiConfig", () => ({
  getCivitaiApiKey: mocks.getCivitaiApiKey,
  getCivitaiConfig: mocks.getCivitaiConfig,
}));

function mockCivitaiResponse(
  body: unknown = {
    items: [],
    metadata: { totalItems: 0, currentPage: 1, pageSize: 20, totalPages: 0 },
  },
) {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCivitaiConfig.mockResolvedValue({ showNsfw: false });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockCivitaiResponse()));
});

describe("Civitai API domain split", () => {
  it("maps explicit sources to Civitai API base URLs", async () => {
    const { getCivitaiApiBaseUrl } = await import("@/lib/civitai");

    expect(getCivitaiApiBaseUrl("com")).toBe("https://civitai.com/api/v1");
    expect(getCivitaiApiBaseUrl("red")).toBe("https://civitai.red/api/v1");
  });

  it("maps legacy nsfw values to sources", async () => {
    const { sourceFromNsfw } = await import("@/lib/civitai");

    expect(sourceFromNsfw(false)).toBe("com");
    expect(sourceFromNsfw(undefined)).toBe("com");
    expect(sourceFromNsfw(true)).toBe("red");
  });

  it("uses civitai.com for SFW model searches", async () => {
    const { searchCivitaiModels } = await import("@/lib/civitai");

    await searchCivitaiModels({ nsfw: false, limit: 1 });

    expect(vi.mocked(fetch).mock.calls[0][0]).toMatch(
      /^https:\/\/civitai\.com\/api\/v1\/models\?/,
    );
  });

  it("uses civitai.red for NSFW model searches", async () => {
    const { searchCivitaiModels } = await import("@/lib/civitai");

    await searchCivitaiModels({ nsfw: true, limit: 1 });

    const url = String(vi.mocked(fetch).mock.calls[0][0]);
    expect(url).toMatch(/^https:\/\/civitai\.red\/api\/v1\/models\?/);
    expect(url).toContain("nsfw=true");
  });

  it("can query civitai.red while keeping the SFW content filter", async () => {
    const { searchCivitaiModels } = await import("@/lib/civitai");

    await searchCivitaiModels({ source: "red", nsfw: false, limit: 2 });

    const url = String(vi.mocked(fetch).mock.calls[0][0]);
    expect(url).toMatch(/^https:\/\/civitai\.red\/api\/v1\/models\?/);
    expect(url).toContain("nsfw=false");
  });

  it("can query civitai.com while requesting NSFW content params", async () => {
    const { searchCivitaiModels } = await import("@/lib/civitai");

    await searchCivitaiModels({ source: "com", nsfw: true, limit: 2 });

    const url = String(vi.mocked(fetch).mock.calls[0][0]);
    expect(url).toMatch(/^https:\/\/civitai\.com\/api\/v1\/models\?/);
    expect(url).toContain("nsfw=true");
  });

  it("uses civitai.red for NSFW model detail lookups", async () => {
    const { fetchCivitaiModel } = await import("@/lib/civitai");

    await fetchCivitaiModel(123, true);

    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      "https://civitai.red/api/v1/models/123",
    );
  });

  it("uses civitai.red for NSFW model-version download resolution", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockCivitaiResponse({
        downloadUrl: "https://civitai.red/api/download/models/123",
      }),
    );
    const { getCivitaiDownloadUrl } = await import("@/lib/civitai");

    await getCivitaiDownloadUrl(456, true);

    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      "https://civitai.red/api/v1/model-versions/456",
    );
  });

  it("uses civitai.red for NSFW hash lookups", async () => {
    const { fetchCivitaiModelVersionByHash } = await import("@/lib/civitai");

    await fetchCivitaiModelVersionByHash("abc123", true);

    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      "https://civitai.red/api/v1/model-versions/by-hash/abc123",
    );
  });

  it("uses civitai.red for NSFW image searches", async () => {
    const { searchCivitaiImages } = await import("@/lib/civitai");

    await searchCivitaiImages({ nsfw: true, limit: 1 });

    const url = String(vi.mocked(fetch).mock.calls[0][0]);
    expect(url).toMatch(/^https:\/\/civitai\.red\/api\/v1\/images\?/);
    expect(url).toContain("nsfw=true");
  });

  it("uses civitai.red for NSFW image detail lookups", async () => {
    const { fetchCivitaiImageById } = await import("@/lib/civitai");

    await fetchCivitaiImageById(789, true);

    const url = String(vi.mocked(fetch).mock.calls[0][0]);
    expect(url).toMatch(/^https:\/\/civitai\.red\/api\/v1\/images\?/);
    expect(url).toContain("imageId=789");
  });

  it("routes source=red and nsfw=false independently for image searches", async () => {
    const { clearCivitaiCache } = await import("@/lib/civitai");
    clearCivitaiCache();
    const { GET } = await import("@/app/api/civitai/images/route");

    const res = await GET(
      new NextRequest(
        "http://localhost/api/civitai/images?source=red&nsfw=false&limit=1",
      ),
    );

    expect(res.status).toBe(200);
    const url = String(vi.mocked(fetch).mock.calls[0][0]);
    expect(url).toMatch(/^https:\/\/civitai\.red\/api\/v1\/images\?/);
    expect(url).toContain("nsfw=false");
  });

  it("routes source=com and nsfw=true independently for image searches", async () => {
    const { clearCivitaiCache } = await import("@/lib/civitai");
    clearCivitaiCache();
    const { GET } = await import("@/app/api/civitai/images/route");

    const res = await GET(
      new NextRequest(
        "http://localhost/api/civitai/images?source=com&nsfw=true&limit=1",
      ),
    );

    expect(res.status).toBe(200);
    const url = String(vi.mocked(fetch).mock.calls[0][0]);
    expect(url).toMatch(/^https:\/\/civitai\.com\/api\/v1\/images\?/);
    expect(url).toContain("nsfw=true");
  });
});

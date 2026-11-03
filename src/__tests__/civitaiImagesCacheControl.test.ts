/**
 * Cache-Control: private for admin-authed civitai images route (Fix #6)
 *
 * Run with: npx vitest run src/__tests__/civitaiImagesCacheControl.test.ts
 */

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

function req(query = ""): NextRequest {
  return new NextRequest(`http://localhost:3000/api/civitai/images${query}`);
}

describe("Fix #6 — Cache-Control is private for admin-authed civitai images", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCivitaiConfig.mockResolvedValue({ showNsfw: false });
    mocks.searchCivitaiImages.mockResolvedValue({
      items: [],
      nextCursor: undefined,
    });
  });

  it("response has Cache-Control: private, max-age=60 (not public)", async () => {
    const res = await GET(req("?sort=Most%20Collected&limit=24"));
    expect(res.status).toBe(200);
    const cc = res.headers.get("Cache-Control");
    expect(cc).toContain("private");
    expect(cc).not.toContain("public");
    expect(cc).toContain("max-age=60");
  });

  it("source file no longer contains public cache directive for this route", () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const src: string = readFileSync(
      join(process.cwd(), "src/app/api/civitai/images/route.ts"),
      "utf8",
    );
    // Must not have the old public directive
    expect(src).not.toContain('"Cache-Control": "public, max-age=60"');
    // Must have the fixed private directive
    expect(src).toContain('"Cache-Control": "private, max-age=60"');
  });
});

/**
 * Civitai auth/settings mutation auth guard.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockGetCivitaiConfig = vi.fn();
const mockGetCivitaiApiKey = vi.fn();
const mockSetCivitaiConfig = vi.fn();

vi.mock("@/lib/env", () => ({
  env: {
    ADMIN_API_KEY: "test-admin-key",
    CIVITAI_API_KEY: "",
  },
}));

vi.mock("@/lib/civitaiConfig", () => ({
  getCivitaiConfig: mockGetCivitaiConfig,
  getCivitaiApiKey: mockGetCivitaiApiKey,
  setCivitaiConfig: mockSetCivitaiConfig,
}));

function makeRequest(
  method: string,
  body?: Record<string, unknown>,
  token?: string,
): NextRequest {
  return new NextRequest("http://localhost/api/civitai/auth", {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCivitaiConfig.mockResolvedValue({ apiKey: "stored", showNsfw: false });
  mockGetCivitaiApiKey.mockResolvedValue("stored");
  mockSetCivitaiConfig.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
});

describe("/api/civitai/auth mutation auth", () => {
  it("rejects GET status without admin token", async () => {
    const { GET } = await import("@/app/api/civitai/auth/route");

    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(401);
  });

  it("allows GET status with admin token and does not expose the key", async () => {
    const { GET } = await import("@/app/api/civitai/auth/route");

    const res = await GET(makeRequest("GET", undefined, "test-admin-key"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({
      ok: true,
      hasKey: true,
      source: "config",
      showNsfw: false,
    });
    expect(JSON.stringify(data)).not.toContain("stored");
  });

  it("rejects unauthenticated PUT, PATCH, and DELETE mutations", async () => {
    const { PUT, PATCH, DELETE } = await import("@/app/api/civitai/auth/route");

    const put = await PUT(makeRequest("PUT", { apiKey: "new-key" }));
    const patch = await PATCH(makeRequest("PATCH", { showNsfw: true }));
    const del = await DELETE(makeRequest("DELETE"));

    expect(put.status).toBe(401);
    expect(patch.status).toBe(401);
    expect(del.status).toBe(401);
    expect(mockSetCivitaiConfig).not.toHaveBeenCalled();
  });

  it("allows authenticated PATCH showNsfw changes", async () => {
    const { PATCH } = await import("@/app/api/civitai/auth/route");

    const res = await PATCH(
      makeRequest("PATCH", { showNsfw: true }, "test-admin-key"),
    );

    expect(res.status).toBe(200);
    expect(mockSetCivitaiConfig).toHaveBeenCalledWith({
      apiKey: "stored",
      showNsfw: true,
    });
  });
});

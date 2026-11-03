/**
 * Server-version capability gating (/features + /system_stats), checked
 * against the recorded ComfyUI 0.42.0 fixtures and a synthetic old server.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { COMFY_HTTP_URL: "http://comfy.test" } }));
vi.mock("@/lib/auth", () => ({ requireAdmin: () => ({ ok: true }) }));
vi.mock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));

import {
  clearComfyCapabilitiesCache,
  deriveCapabilities,
  getComfyCapabilities,
  INTERRUPT_PROMPT_ID_MIN_VERSION,
  parseVersion,
  versionAtLeast,
} from "@/lib/comfy/capabilities";

const FIXTURES = join(__dirname, "fixtures/comfy-contract");
const load = (n: string) => JSON.parse(readFileSync(join(FIXTURES, n), "utf8"));
const systemStats = load("system_stats.json");
const features = load("features.json");

describe("version compare", () => {
  it("parses ComfyUI version strings", () => {
    expect(parseVersion("0.42.0")).toEqual([0, 42, 0]);
    expect(parseVersion("v0.3.57-rc1")).toEqual([0, 3, 57]);
    expect(parseVersion("0.4")).toEqual([0, 4, 0]);
    expect(parseVersion("dev")).toBeNull();
  });
  it("compares numerically, not lexically", () => {
    expect(versionAtLeast("0.42.0", "0.3.57")).toBe(true);
    expect(versionAtLeast("0.3.57", "0.3.57")).toBe(true);
    expect(versionAtLeast("0.3.56", "0.3.57")).toBe(false);
    expect(versionAtLeast("0.3.100", "0.3.57")).toBe(true);
    expect(versionAtLeast(undefined, "0.3.57")).toBe(false);
  });
});

describe("deriveCapabilities", () => {
  it("enables targeted interrupt + preview metadata on the recorded 0.42.0", () => {
    const caps = deriveCapabilities(systemStats, features);
    expect(caps).toMatchObject({
      reachable: true,
      comfyuiVersion: "0.42.0",
      interruptPromptId: true,
      previewMetadata: true,
    });
  });
  it("falls back on an old server without /features", () => {
    const caps = deriveCapabilities({ system: { comfyui_version: "0.3.40" } }, null);
    expect(caps).toMatchObject({
      reachable: true,
      interruptPromptId: false,
      previewMetadata: false,
      features: {},
    });
    expect(INTERRUPT_PROMPT_ID_MIN_VERSION).toBe("0.3.57");
  });
  it("unreachable → nothing enabled", () => {
    expect(deriveCapabilities(null, null)).toMatchObject({
      reachable: false,
      comfyuiVersion: null,
      interruptPromptId: false,
    });
  });
});

describe("deriveCapabilities noFp8", () => {
  it("MPS device -> noFp8; CUDA / unknown -> false", () => {
    expect(
      deriveCapabilities({ devices: [{ name: "mps", type: "mps" }] }, null)
        .noFp8,
    ).toBe(true);
    expect(
      deriveCapabilities(
        { devices: [{ name: "cuda:0 NVIDIA GeForce RTX 4090", type: "cuda" }] },
        null,
      ).noFp8,
    ).toBe(false);
    expect(deriveCapabilities(null, null).noFp8).toBe(false);
  });
});

describe("getComfyCapabilities", () => {
  beforeEach(() => clearComfyCapabilitiesCache());

  function stub(stats: unknown, feats: unknown) {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/system_stats"))
        return stats ? new Response(JSON.stringify(stats)) : new Response("", { status: 503 });
      if (u.endsWith("/features"))
        return feats ? new Response(JSON.stringify(feats)) : new Response("", { status: 404 });
      throw new Error(u);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("GETs /system_stats + /features once per TTL; fresh refetches", async () => {
    const fetchMock = stub(systemStats, features);
    const a = await getComfyCapabilities();
    await getComfyCapabilities();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls as unknown as [string, RequestInit?][]) {
      expect(init?.method ?? "GET").toBe("GET");
    }
    expect(a.interruptPromptId).toBe(true);
    await getComfyCapabilities(undefined, { fresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not cache an outage", async () => {
    const fetchMock = stub(null, null);
    expect((await getComfyCapabilities()).reachable).toBe(false);
    await getComfyCapabilities();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("is served by GET /api/comfy/capabilities", async () => {
    stub(systemStats, features);
    const { GET } = await import("@/app/api/comfy/capabilities/route");
    const res = await GET(new NextRequest("http://localhost/api/comfy/capabilities"));
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.capabilities).toMatchObject({
      comfyuiVersion: "0.42.0",
      interruptPromptId: true,
      previewMetadata: true,
    });
  });
});

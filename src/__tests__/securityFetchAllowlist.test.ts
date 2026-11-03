/**
 * Security guardrails for server-side fetch inputs.
 */

import { describe, expect, it } from "vitest";
import {
  hostMatchesAllowlist,
  isAllowedCivitaiImageUrl,
  isAllowedHttpsFetchUrl,
  isAllowedInpaintImageSource,
  resolveAllowedInpaintImageFetchUrl,
} from "@/lib/validate";

describe("hostMatchesAllowlist", () => {
  it("matches exact hosts and wildcard subdomains without suffix tricks", () => {
    expect(hostMatchesAllowlist("civitai.com", ["civitai.com", "*.civitai.com"])).toBe(true);
    expect(hostMatchesAllowlist("image.civitai.com", ["civitai.com", "*.civitai.com"])).toBe(true);
    expect(hostMatchesAllowlist("cdn.image.civitai.com", ["civitai.com", "*.civitai.com"])).toBe(true);
    expect(hostMatchesAllowlist("evilcivitai.com", ["civitai.com", "*.civitai.com"])).toBe(false);
    expect(hostMatchesAllowlist("civitai.com.evil.test", ["civitai.com", "*.civitai.com"])).toBe(false);
  });
});

describe("isAllowedHttpsFetchUrl", () => {
  const allowlist = ["example.com", "*.example.com"];

  it("allows only https URLs on allowlisted hosts", () => {
    expect(isAllowedHttpsFetchUrl("https://example.com/a.png", allowlist)).toBe(true);
    expect(isAllowedHttpsFetchUrl("https://cdn.example.com/a.png", allowlist)).toBe(true);
    expect(isAllowedHttpsFetchUrl("http://example.com/a.png", allowlist)).toBe(false);
    expect(isAllowedHttpsFetchUrl("https://evil.com/a.png", allowlist)).toBe(false);
    expect(isAllowedHttpsFetchUrl("not-a-url", allowlist)).toBe(false);
  });
});

describe("isAllowedCivitaiImageUrl", () => {
  it("rejects arbitrary server-side fetch URLs", () => {
    expect(isAllowedCivitaiImageUrl("https://image.civitai.com/x/y.png")).toBe(true);
    expect(isAllowedCivitaiImageUrl("https://civitai.com/api/download/models/1")).toBe(true);
    expect(isAllowedCivitaiImageUrl("https://image.civitai.red/x/y.png")).toBe(true);
    expect(isAllowedCivitaiImageUrl("https://civitai.red/images/123")).toBe(true);
    expect(isAllowedCivitaiImageUrl("https://civitai.red.evil.test/image.png")).toBe(false);
    expect(isAllowedCivitaiImageUrl("https://example.com/image.png")).toBe(false);
    expect(isAllowedCivitaiImageUrl("http://image.civitai.com/image.png")).toBe(false);
  });
});

describe("isAllowedInpaintImageSource", () => {
  const comfy = "http://127.0.0.1:8188";

  it("allows data URLs and the configured ComfyUI host", () => {
    expect(isAllowedInpaintImageSource("data:image/png;base64,AAAA", comfy)).toBe(true);
    expect(isAllowedInpaintImageSource("http://127.0.0.1:8188/view?filename=a.png", comfy)).toBe(true);
  });

  it("resolves app-local ComfyUI proxy paths only when an app origin is provided", () => {
    expect(resolveAllowedInpaintImageFetchUrl(
      "/api/comfy/image?filename=a.png",
      comfy,
      "http://127.0.0.1:3000",
    )).toBe("http://127.0.0.1:3000/api/comfy/image?filename=a.png");
    expect(resolveAllowedInpaintImageFetchUrl("/account", comfy, "http://127.0.0.1:3000")).toBeNull();
    expect(resolveAllowedInpaintImageFetchUrl("/api/comfy/image?filename=a.png", comfy)).toBeNull();
  });

  it("rejects arbitrary external or malformed URLs", () => {
    expect(isAllowedInpaintImageSource("https://example.com/a.png", comfy)).toBe(false);
    expect(isAllowedInpaintImageSource("http://127.0.0.1:8189/view?filename=a.png", comfy)).toBe(false);
    expect(isAllowedInpaintImageSource("not-a-url", comfy)).toBe(false);
  });
});

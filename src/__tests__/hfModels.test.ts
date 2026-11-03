import { describe, expect, it } from "vitest";
import {
  hfBaseModel,
  hfDisplayTags,
  hfModelsUpstreamUrl,
  mapHfModel,
  mapHfModels,
  parseHfModelsRequest,
  parseHfNextCursor,
} from "@/lib/hfModels";
import { isAllowedHuggingFaceApiUrl } from "@/lib/validate";

const parse = (qs: string) => parseHfModelsRequest(new URLSearchParams(qs));

describe("parseHfModelsRequest", () => {
  it("applies defaults: trending, desc, limit 24, full=true", () => {
    const r = parse("");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.upstream.get("sort")).toBe("trendingScore");
    expect(r.upstream.get("direction")).toBe("-1");
    expect(r.upstream.get("limit")).toBe("24");
    expect(r.upstream.get("full")).toBe("true");
    expect(r.upstream.has("search")).toBe(false);
  });

  it("passes whitelisted params through", () => {
    const r = parse(
      "search=flux&sort=downloads&pipeline_tag=text-to-image&filter=lora&filter=diffusers&author=black-forest-labs&limit=50&cursor=eyJhIjoxfQ==",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.upstream.get("search")).toBe("flux");
    expect(r.upstream.get("sort")).toBe("downloads");
    expect(r.upstream.get("pipeline_tag")).toBe("text-to-image");
    expect(r.upstream.getAll("filter")).toEqual(["lora", "diffusers"]);
    expect(r.upstream.get("author")).toBe("black-forest-labs");
    expect(r.upstream.get("limit")).toBe("50");
    expect(r.upstream.get("cursor")).toBe("eyJhIjoxfQ==");
  });

  it("ignores unknown keys and never forwards direction/full/token from the client", () => {
    const r = parse("direction=1&full=true&token=abc&expand=siblings");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.upstream.get("direction")).toBe("-1");
    expect(r.upstream.get("full")).toBe("true");
    expect(r.upstream.has("token")).toBe(false);
    expect(r.upstream.has("expand")).toBe(false);
  });

  it("strips control characters from search", () => {
    const r = parse("search=a%00b%0Ac");
    expect(r.ok && r.upstream.get("search")).toBe("abc");
  });

  it.each([
    ["sort=random", "sort"],
    ["pipeline_tag=rm-rf", "pipeline_tag"],
    ["filter=license:mit", "filter"],
    [
      "filter=lora&filter=diffusers&filter=gguf&filter=mlx&filter=onnx",
      "too many",
    ],
    ["author=../etc", "author"],
    ["author=a%20b", "author"],
    ["limit=0", "limit"],
    ["limit=101", "limit"],
    ["limit=2.5", "limit"],
    ["cursor=abc%26x%3D1", "cursor"],
    [`search=${"x".repeat(129)}`, "search"],
  ])("rejects %s", (qs, needle) => {
    const r = parse(qs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(needle);
  });

  it("builds an upstream URL that passes the HF allowlist", () => {
    const r = parse("search=x");
    if (!r.ok) throw new Error("parse failed");
    const url = hfModelsUpstreamUrl(r.upstream);
    expect(url.startsWith("https://huggingface.co/api/models?")).toBe(true);
    expect(isAllowedHuggingFaceApiUrl(url)).toBe(true);
  });
});

describe("isAllowedHuggingFaceApiUrl", () => {
  it.each([
    ["https://huggingface.co/api/models", true],
    ["http://huggingface.co/api/models", false],
    ["https://huggingface.co.evil.com/api/models", false],
    ["https://evil.com/api/models", false],
    ["https://cdn-lfs.huggingface.co/api/models", false],
    ["https://huggingface.co/black-forest-labs/FLUX.1-dev", false],
    ["https://user:pw@huggingface.co/api/models", false],
    ["https://huggingface.co:8443/api/models", false],
    ["not a url", false],
  ])("%s → %s", (url, ok) => {
    expect(isAllowedHuggingFaceApiUrl(url)).toBe(ok);
  });
});

describe("parseHfNextCursor", () => {
  it("extracts the cursor from a rel=next Link header", () => {
    expect(
      parseHfNextCursor(
        '<https://huggingface.co/api/models?sort=downloads&cursor=eyJ4IjoxfQ%3D%3D>; rel="next"',
      ),
    ).toBe("eyJ4IjoxfQ==");
  });

  it("ignores missing, foreign-host, or malformed links", () => {
    expect(parseHfNextCursor(null)).toBeNull();
    expect(parseHfNextCursor("")).toBeNull();
    expect(
      parseHfNextCursor('<https://evil.com/api/models?cursor=abc>; rel="next"'),
    ).toBeNull();
    expect(
      parseHfNextCursor(
        '<https://huggingface.co/api/models?cursor=abc>; rel="prev"',
      ),
    ).toBeNull();
    expect(
      parseHfNextCursor('<https://huggingface.co/api/models>; rel="next"'),
    ).toBeNull();
  });
});

describe("mapHfModel", () => {
  const raw = {
    _id: "x",
    id: "black-forest-labs/FLUX.1-dev",
    author: "black-forest-labs",
    gated: "auto",
    lastModified: "2026-01-01T00:00:00.000Z",
    likes: 12000,
    downloads: 345678,
    tags: [
      "diffusers",
      "text-to-image",
      "license:other",
      "region:us",
      "base_model:adapter:foo/bar",
      "base_model:black-forest-labs/FLUX.1-schnell",
      "flux",
      "not-for-all-audiences",
    ],
    pipeline_tag: "text-to-image",
    library_name: "diffusers",
    createdAt: "2024-08-01T00:00:00.000Z",
  };

  it("maps to the card shape with a huggingface.co link", () => {
    const m = mapHfModel(raw)!;
    expect(m).toMatchObject({
      id: "black-forest-labs/FLUX.1-dev",
      name: "FLUX.1-dev",
      author: "black-forest-labs",
      downloads: 345678,
      likes: 12000,
      pipelineTag: "text-to-image",
      library: "diffusers",
      gated: true,
      adult: true,
      url: "https://huggingface.co/black-forest-labs/FLUX.1-dev",
    });
    expect(hfDisplayTags(m)).toEqual(["flux"]);
    expect(hfBaseModel(m)).toBe("black-forest-labs/FLUX.1-schnell");
  });

  it("rejects malformed ids and tolerates missing fields", () => {
    expect(mapHfModel({ id: "../../etc/passwd" })).toBeNull();
    expect(mapHfModel({ id: "javascript:alert(1)" })).toBeNull();
    expect(mapHfModel(null)).toBeNull();
    const bare = mapHfModel({ id: "gpt2" })!;
    expect(bare).toMatchObject({
      name: "gpt2",
      author: null,
      downloads: 0,
      likes: 0,
      tags: [],
      gated: false,
      url: "https://huggingface.co/gpt2",
    });
  });

  it("mapHfModels filters bad rows and non-arrays", () => {
    expect(mapHfModels([{ id: "a/b" }, { id: "" }, 5])).toHaveLength(1);
    expect(mapHfModels({ error: "x" })).toEqual([]);
  });
});

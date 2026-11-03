import { describe, it, expect } from "vitest";
import {
  clusterNodeLabel,
  normalizeAssetSearch,
  normalizeStyleSearch,
  normalizeUmapPoints,
  umapRunModelLabel,
  vaultErrorMessage,
} from "@/lib/sref/vaultShapes";

// Shapes captured from a live StyleVault API (stylevault api, 2026-10-17).
describe("StyleVault response normalizers", () => {
  it("unwraps umap points from {points} (the map was always empty before)", () => {
    const real = {
      run_id: 1,
      count: 2,
      points: [
        {
          asset_id: 1,
          x: 8.4,
          y: 8.5,
          source_path: "/a.png",
          sha256: "x",
          cluster_id: null,
        },
        {
          asset_id: 2,
          x: 1,
          y: 2,
          source_path: "/b.png",
          sha256: "y",
          cluster_id: 4,
        },
      ],
    };
    expect(normalizeUmapPoints(real)).toEqual([
      { asset_id: 1, x: 8.4, y: 8.5, cluster_id: null },
      { asset_id: 2, x: 1, y: 2, cluster_id: 4 },
    ]);
    expect(normalizeUmapPoints([{ style_id: 7, x: 0, y: 0 }])).toEqual([
      { asset_id: 7, x: 0, y: 0, cluster_id: null },
    ]);
    expect(
      normalizeUmapPoints({ points: [{ asset_id: 3, x: "nope", y: 1 }] }),
    ).toEqual([]);
    expect(normalizeUmapPoints(null)).toEqual([]);
  });

  it("maps style search {results} keyed by style_node_id", () => {
    const real = {
      results: [
        {
          style_node_id: 1,
          style_name: "Amber Haze",
          cluster_id: 4,
          codes: ["4886489159"],
          score: null,
        },
      ],
    };
    expect(normalizeStyleSearch(real)).toEqual([
      {
        id: 1,
        style_name: "Amber Haze",
        source_cluster_id: 4,
        codes: ["4886489159"],
      },
    ]);
    // Legacy bare array of SVStyle still works.
    expect(
      normalizeStyleSearch([
        { id: 2, style_name: "B", source_cluster_id: null },
      ]),
    ).toEqual([
      { id: 2, style_name: "B", source_cluster_id: null, codes: undefined },
    ]);
    expect(
      normalizeStyleSearch({ results: [{ style_name: "no id" }] }),
    ).toEqual([]);
  });

  it("reads asset search results + total_count", () => {
    const real = {
      query: "cat",
      count: 1,
      total_count: 12,
      results: [
        { asset_id: 5, score: -1.2, source_path: "/c.png", sha256: "z" },
      ],
    };
    expect(normalizeAssetSearch(real)).toEqual({
      items: [{ asset_id: 5, score: -1.2, source_path: "/c.png", sha256: "z" }],
      total: 12,
    });
    expect(
      normalizeAssetSearch([{ asset_id: 1, source_path: "/a" }]).total,
    ).toBeNull();
  });

  it("labels clusters and runs from real fields", () => {
    expect(clusterNodeLabel({ id: 1, name: "run1/d1/c4" })).toBe("run1/d1/c4");
    expect(clusterNodeLabel({ id: 1, label: "legacy" })).toBe("legacy");
    expect(clusterNodeLabel({ id: 9 })).toBe("Cluster 9");
    expect(
      umapRunModelLabel({
        models: [{ name: "color-histogram" }, { name: "clip" }],
      }),
    ).toBe("color-histogram + clip");
    expect(umapRunModelLabel({ embedding_model: "old" })).toBe("old");
    expect(umapRunModelLabel({ models: [] })).toBeNull();
  });

  it("surfaces FastAPI detail as well as proxy error", () => {
    expect(
      vaultErrorMessage({ detail: "Style B has no source_cluster_id." }, 422),
    ).toBe("Style B has no source_cluster_id.");
    expect(vaultErrorMessage({ error: "StyleVault unreachable" }, 502)).toBe(
      "StyleVault unreachable",
    );
    expect(
      vaultErrorMessage({ detail: [{ msg: "field required" }] }, 422),
    ).toBe("HTTP 422");
  });
});

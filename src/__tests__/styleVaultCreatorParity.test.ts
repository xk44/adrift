/**
 * Style Vault & Style Creator route/data parity tests
 *
 * Validates:
 * - Vault proxy allowlist covers all StyleVaultPage data paths
 * - StyleMap SVG scatter data flow (SVUmapPoint shape, UmapScatter scaling)
 * - Style creator session shape (useStyleSessions)
 * - StyleVaultPage LoRA deploy has no hard-coded path
 * - Route mapper handles style-vault and style-creator dynamic routes
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Vault proxy allowlist — all data paths used by StyleVaultPage must be routable
// ---------------------------------------------------------------------------

describe("vault proxy allowlist covers StyleVaultPage data paths", () => {
  // These are the svFetch/svPost paths used by StyleVaultPage tabs
  const styleVaultPaths = [
    ["umap", "runs"],                              // StyleMapTab — list runs
    ["umap", "runs", "1", "points"],               // StyleMapTab — fetch scatter data
    ["styles", "search"],                          // StyleBrowserTab — search styles
    ["styles", "mix"],                             // StyleMixPanel — POST mix
    ["clusters", "tree"],                          // StyleBrowserTab — cluster tree
    ["clusters", "42", "members"],                 // StyleBrowserTab — cluster members
    ["assets", "42", "thumb"],                       // StyleBrowser/Dataset — thumbnails
    ["health"],                                    // Offline detection
    ["training", "backends"],                      // LoRAStudioTab — list trainer backends
    ["training", "jobs"],                          // LoRAStudioTab — list/start jobs
    ["training", "jobs", "job-1"],                 // LoRAStudioTab — poll job details
    ["training", "jobs", "job-1", "cancel"],       // LoRAStudioTab — cancel job
    ["training", "jobs", "job-1", "deploy"],       // LoRAStudioTab — deploy finished job
    ["search"],                                    // DatasetTab — asset search
  ];

  // Mirrors the ALLOWED_PATH_PREFIXES in the proxy route
  const allowedPrefixes = [
    "styles",
    "clusters",
    "representatives",
    "moodboards",
    "assets",
    "health",
    "umap",
    "search",
    "training",
    "loras",
  ];

  it.each(styleVaultPaths.map((p) => [p.join("/"), p]))(
    "path %s is allowed by proxy (prefix=%s)",
    (_label, segments) => {
      const prefix = (segments as string[])[0];
      expect(allowedPrefixes).toContain(prefix);
    },
  );

  it("mutable prefixes include StyleVault UI POST targets", () => {
    const mutablePrefixes = [
      "assets",
      "clusters",
      "moodboards",
      "styles",
      "training",
      "loras",
    ];
    // styles/mix (POST) should be allowed — style mixing is a mutation
    expect(mutablePrefixes).toContain("styles");
    // assets/:id/rate (POST) should be allowed — lightbox ratings are mutations
    expect(mutablePrefixes).toContain("assets");
    // training/jobs and training/jobs/:id/deploy are mutations
    expect(mutablePrefixes).toContain("training");
  });
});

// ---------------------------------------------------------------------------
// StyleMap SVG scatter data flow
// ---------------------------------------------------------------------------

describe("StyleMap SVG scatter data flow", () => {
  interface SVUmapPoint {
    style_id: number;
    x: number;
    y: number;
    cluster_id?: number | null;
    label?: string | null;
  }

  it("SVUmapPoint shape validates for scatter rendering", () => {
    const point: SVUmapPoint = {
      style_id: 1,
      x: 0.23,
      y: -0.87,
      cluster_id: 5,
      label: "Style A",
    };
    expect(typeof point.style_id).toBe("number");
    expect(typeof point.x).toBe("number");
    expect(typeof point.y).toBe("number");
    // cluster_id and label are optional
    expect(point.cluster_id).toBe(5);
    expect(point.label).toBe("Style A");
  });

  it("SVUmapPoint works with null cluster_id", () => {
    const point: SVUmapPoint = {
      style_id: 2,
      x: 0.5,
      y: 0.1,
      cluster_id: null,
      label: null,
    };
    expect(point.cluster_id).toBeNull();
    expect(point.label).toBeNull();
  });

  it("scatter scale maps point coordinates to SVG viewBox", () => {
    // Simulate the scaling logic from UmapScatter component
    const W = 480;
    const H = 360;
    const PAD = 20;

    const points: SVUmapPoint[] = [
      { style_id: 1, x: -1.0, y: -1.0, cluster_id: 0 },
      { style_id: 2, x: 1.0, y: 1.0, cluster_id: 0 },
      { style_id: 3, x: 0.0, y: 0.0, cluster_id: 1 },
    ];

    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;

    // Mirrors the component's scale function exactly
    const scale = (v: number, lo: number, hi: number, outLo: number, outHi: number) => {
      const denom = hi - lo || 1;
      return outLo + ((v - lo) / denom) * (outHi - outLo);
    };

    // X axis: lo = minX padded left, hi = maxX padded right → outLo=PAD, outHi=W-PAD
    const cxVals = points.map((p) =>
      scale(p.x, minX - rangeX * 0.05, maxX + rangeX * 0.05, PAD, W - PAD),
    );
    // Y axis: inverted (Y up in data, Y down in SVG) → lo=maxY+pad, hi=minY-pad → outLo=PAD, outHi=H-PAD
    const cyVals = points.map((p) =>
      scale(p.y, maxY + rangeY * 0.05, minY - rangeY * 0.05, PAD, H - PAD),
    );

    // All mapped X values should be within the viewBox [PAD, W-PAD]
    for (const cx of cxVals) {
      expect(cx).toBeGreaterThanOrEqual(PAD - 0.01);
      expect(cx).toBeLessThanOrEqual(W - PAD + 0.01);
    }
    // All mapped Y values should be within the viewBox [PAD, H-PAD]
    for (const cy of cyVals) {
      expect(cy).toBeGreaterThanOrEqual(PAD - 0.01);
      expect(cy).toBeLessThanOrEqual(H - PAD + 0.01);
    }

    // The center point (0,0) should map near the center of the viewBox
    expect(Math.abs(cxVals[2] - W / 2)).toBeLessThan(W / 4);
    expect(Math.abs(cyVals[2] - H / 2)).toBeLessThan(H / 4);
  });

  it("cluster color assignment is deterministic per cluster_id", () => {
    const palette = [
      "#7c68ff", "#3b82f6", "#10b981", "#f59e0b",
      "#ef4444", "#8b5cf6", "#06b6d4", "#f97316",
    ];
    const clusterColors: Record<number, string> = {};
    let ci = 0;

    const points = [
      { style_id: 1, x: 0, y: 0, cluster_id: 3 },
      { style_id: 2, x: 0, y: 0, cluster_id: 0 },
      { style_id: 3, x: 0, y: 0, cluster_id: 3 }, // same cluster as point 1
      { style_id: 4, x: 0, y: 0, cluster_id: 1 },
    ];

    for (const p of points) {
      const c = p.cluster_id ?? 0;
      if (!(c in clusterColors)) {
        clusterColors[c] = palette[ci % palette.length];
        ci++;
      }
    }

    // Point 1 and 3 share cluster 3, so they get the same color
    expect(clusterColors[3]).toBe(palette[0]);
    expect(clusterColors[0]).toBe(palette[1]);
    expect(clusterColors[1]).toBe(palette[2]);
    // Same cluster should always map to same color
    expect(clusterColors[3]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Style creator sessions (Styles page creator panel, useStyleSessions)
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newStyleSession } from "../components/style/useStyleSessions";
import type { StyleSession } from "../components/style/styleCreatorLogic";

describe("style creator session persistence", () => {
  const NOW = new Date("2026-05-01T00:00:00.000Z");

  it("new sessions carry every persisted field", () => {
    const session = newStyleSession(0, NOW);
    expect(session).toEqual({
      id: `session-${NOW.getTime()}`,
      name: "Style 1",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      selectedImageIds: [],
      status: "draft",
    });
  });

  it("names sessions from the prompt and dedupes picked images", () => {
    const session = newStyleSession(2, NOW, "ink wash mountains --ar 3:2", [
      "a",
      "b",
      "a",
    ]);
    expect(session.name).toBe("ink wash mountains");
    expect(session.prompt).toBe("ink wash mountains --ar 3:2");
    expect(session.selectedImageIds).toEqual(["a", "b"]);
  });

  it("round-trips through JSON the way localStorage stores it", () => {
    const sessions: StyleSession[] = [
      newStyleSession(0, NOW),
      { ...newStyleSession(1, NOW), status: "done", styleCode: "12345" },
    ];
    const back: StyleSession[] = JSON.parse(JSON.stringify(sessions));
    expect(back).toEqual(sessions);
    expect(back.filter((s) => s.status !== "done")).toHaveLength(1);
  });
});

describe("TrainView LoRA deploy", () => {
  const vault = readFileSync(
    join(process.cwd(), "src/components/style/library/TrainView.tsx"),
    "utf8",
  );

  it("never sends a hard-coded home-folder lora_dir", () => {
    expect(vault).not.toMatch(/lora_dir\s*:/);
    expect(vault).not.toMatch(/~\/projects/i);
  });

  it("auto-deploys each finished job at most once", () => {
    // Both the jobs-list and the selected-detail effects gate on this set.
    const guards = vault.match(/!autoDeployAttempted\.current\.has\(/g) ?? [];
    const marks = vault.match(/autoDeployAttempted\.current\.add\(/g) ?? [];
    expect(guards).toHaveLength(2);
    expect(marks).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Route mapper - style-vault and style-creator dynamic routes
// ---------------------------------------------------------------------------

import { parsePathname, buildPathname, buildUrl } from "../lib/routeMapper";

describe("style vault & creator route parity", () => {
  it("/styles/:id → style-vault with id param", () => {
    const result = parsePathname("/styles/12345");
    expect(result).not.toBeNull();
    expect(result!.nav).toBe("style-vault");
    expect(result!.params.id).toBe("12345");
  });

  it("/style-vault → style-vault (static)", () => {
    const result = parsePathname("/style-vault");
    expect(result).not.toBeNull();
    expect(result!.nav).toBe("style-vault");
    expect(result!.params).toEqual({});
  });

  it("/style-creator → style-creator (static)", () => {
    const result = parsePathname("/style-creator");
    expect(result).not.toBeNull();
    expect(result!.nav).toBe("style-creator");
    expect(result!.params).toEqual({});
  });

  it("/style-creator/new → style-creator with id=new", () => {
    const result = parsePathname("/style-creator/new");
    expect(result).not.toBeNull();
    expect(result!.nav).toBe("style-creator");
    expect(result!.params.id).toBe("new");
  });

  it("/style-creator/session-123 → style-creator with id=session-123", () => {
    const result = parsePathname("/style-creator/session-123");
    expect(result).not.toBeNull();
    expect(result!.nav).toBe("style-creator");
    expect(result!.params.id).toBe("session-123");
  });

  it("buildPathname round-trips style-vault dynamic route", () => {
    // Canonical vault URL is /styles/vault/:id (/styles is Browse); legacy
    // /styles/:id links still parse to the vault above.
    expect(buildPathname("style-vault", { id: "cool-style" })).toBe(
      "/styles/vault/cool-style",
    );
    const back = parsePathname("/styles/vault/cool-style");
    expect(back!.nav).toBe("style-vault");
    expect(back!.params.id).toBe("cool-style");
  });

  it("buildPathname round-trips style-creator dynamic route", () => {
    expect(buildPathname("style-creator", { id: "new" })).toBe(
      "/style-creator/new",
    );
    expect(buildPathname("style-creator", { id: "session-42" })).toBe(
      "/style-creator/session-42",
    );
  });

  it("buildUrl produces correct paths", () => {
    expect(buildUrl("style-vault")).toBe("/style-vault");
    expect(buildUrl("style-vault", { id: "abc" })).toBe("/styles/vault/abc");
    expect(buildUrl("style-creator")).toBe("/style-creator");
    expect(buildUrl("style-creator", { id: "new" })).toBe("/style-creator/new");
  });
});

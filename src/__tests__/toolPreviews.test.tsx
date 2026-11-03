import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_PREVIEW_BYTES,
  buildToolPreviewsManifest,
  listPreviewFiles,
  renderManifest,
  toolPreviewSlug as scriptSlug,
} from "../../scripts/gen-tool-previews-manifest.mjs";
import {
  TOOL_PREVIEWS,
  resolveToolPreview,
  shouldPlayPreview,
  toolPreviewSlug,
  type ToolPreviewsManifest,
} from "@/lib/tools/toolPreviews";
import { ToolPreviewMedia } from "@/components/tools/ToolPreviewMedia";
import { ToolCover } from "@/components/tools/ToolCover";
import { buildHubCards } from "@/lib/tools/hub";
import { buildToolCards, getActionTool } from "@/lib/tools/toolsPage";
import plan from "../../scripts/gpu-smoke/previews-plan.json";

const ROOT = path.resolve(__dirname, "../..");

describe("gen-tool-previews-manifest", () => {
  it("groups stills and videos by card slug, webm before mp4", () => {
    const { manifest, warnings } = buildToolPreviewsManifest([
      "app--figurine.mp4",
      "action--relight.webp",
      "app--figurine.webm",
      "app--figurine.webp",
      "special--storyboard.mp4",
    ]);
    expect(warnings).toEqual([
      "special--storyboard: video without special--storyboard.webp; the card shows the gradient until it plays",
    ]);
    expect(manifest).toEqual({
      previews: {
        "action--relight": { still: "action--relight.webp" },
        "app--figurine": {
          still: "app--figurine.webp",
          video: ["app--figurine.webm", "app--figurine.mp4"],
        },
        "special--storyboard": { video: ["special--storyboard.mp4"] },
      },
    });
  });

  it("is order-independent and deterministic", () => {
    const a = ["b.webp", "a.mp4", "a.webp", "c.webm"];
    const one = renderManifest(buildToolPreviewsManifest(a).manifest);
    const two = renderManifest(
      buildToolPreviewsManifest([...a].reverse()).manifest,
    );
    expect(one).toBe(two);
    expect(one.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(one).previews)).toEqual(["a", "b", "c"]);
  });

  it("skips README, dotfiles and unsupported formats, with warnings", () => {
    const { manifest, warnings } = buildToolPreviewsManifest([
      "README.md",
      ".DS_Store",
      "action--upscale.png",
      "action--upscale.gif",
      "bad name.webp",
      "action:raw.webp",
    ]);
    expect(manifest.previews).toEqual({});
    expect(warnings).toHaveLength(4);
    expect(warnings.join("\n")).toMatch(/action--upscale\.png: unsupported/);
    expect(warnings.join("\n")).toMatch(/bad name\.webp: file name/);
    expect(warnings.join("\n")).toMatch(/action:raw\.webp: file name/);
  });

  it("matches extensions case-insensitively and flags heavy files", () => {
    const { manifest, warnings } = buildToolPreviewsManifest(
      ["action--animate.MP4", "action--animate.WEBP"],
      { "action--animate.MP4": MAX_PREVIEW_BYTES + 1 },
    );
    expect(manifest.previews["action--animate"]).toEqual({
      still: "action--animate.WEBP",
      video: ["action--animate.MP4"],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/action--animate\.MP4: .* MB/);
  });

  it("lists only files, and a missing folder as empty", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tool-previews-"));
    expect(listPreviewFiles(path.join(dir, "nope"))).toEqual({
      names: [],
      sizes: {},
    });
    writeFileSync(path.join(dir, "action--relight.webp"), "x");
    const { names, sizes } = listPreviewFiles(dir);
    expect(names).toEqual(["action--relight.webp"]);
    expect(sizes["action--relight.webp"]).toBe(1);
  });

  it("committed manifest is in sync with public/tool-previews", () => {
    const { names, sizes } = listPreviewFiles(
      path.join(ROOT, "public/tool-previews"),
    );
    const want = renderManifest(
      buildToolPreviewsManifest(names, sizes).manifest,
    );
    const have = readFileSync(
      path.join(ROOT, "src/lib/tools/toolPreviews.json"),
      "utf8",
    );
    expect(have, "run node scripts/gen-tool-previews-manifest.mjs").toBe(want);
  });

  it("script and app agree on the key -> file slug", () => {
    for (const key of [
      "action:relight",
      "app:figurine",
      "special:click_to_ad",
      "catalog:some/odd id",
      "template:headshot",
    ]) {
      expect(scriptSlug(key)).toBe(toolPreviewSlug(key));
    }
    expect(toolPreviewSlug("action:relight")).toBe("action--relight");
  });
});

const M: ToolPreviewsManifest = {
  previews: {
    "action--relight": { still: "action--relight.webp" },
    "app--figurine": {
      still: "app--figurine.webp",
      video: ["app--figurine.webm", "app--figurine.mp4"],
    },
    "special--storyboard": { video: ["special--storyboard.mp4"] },
  },
};

describe("resolveToolPreview fallback", () => {
  it("no entry keeps the gradient cover", () => {
    expect(resolveToolPreview("action:upscale", { manifest: M })).toEqual({
      kind: "none",
    });
    expect(
      resolveToolPreview("action:upscale", {
        manifest: { previews: {} },
        size: "lg",
      }),
    ).toEqual({ kind: "none" });
  });

  it("still-only entry shows the still at every size", () => {
    for (const size of ["sm", "md", "lg"] as const) {
      expect(
        resolveToolPreview("action:relight", { manifest: M, size }),
      ).toEqual({ kind: "still", src: "/tool-previews/action--relight.webp" });
    }
  });

  it("video entry plays the video with the still as poster", () => {
    expect(
      resolveToolPreview("app:figurine", { manifest: M, size: "lg" }),
    ).toEqual({
      kind: "video",
      sources: [
        { src: "/tool-previews/app--figurine.webm", type: "video/webm" },
        { src: "/tool-previews/app--figurine.mp4", type: "video/mp4" },
      ],
      poster: "/tool-previews/app--figurine.webp",
    });
  });

  it("reduced motion and tiny tiles prefer the still", () => {
    const still = { kind: "still", src: "/tool-previews/app--figurine.webp" };
    expect(
      resolveToolPreview("app:figurine", { manifest: M, reducedMotion: true }),
    ).toEqual(still);
    expect(
      resolveToolPreview("app:figurine", { manifest: M, size: "sm" }),
    ).toEqual(still);
  });

  it("video-only entry: none on tiny tiles, paused video under reduced motion", () => {
    expect(
      resolveToolPreview("special:storyboard", { manifest: M, size: "sm" }),
    ).toEqual({ kind: "none" });
    const r = resolveToolPreview("special:storyboard", {
      manifest: M,
      reducedMotion: true,
    });
    expect(r.kind).toBe("video");
    expect(
      shouldPlayPreview({
        reducedMotion: true,
        canHover: true,
        hovered: true,
        inView: true,
      }),
    ).toBe(false);
  });

  it("drops video files with an unknown extension", () => {
    const m: ToolPreviewsManifest = {
      previews: { "action--animate": { video: ["action--animate.mov"] } },
    };
    expect(resolveToolPreview("action:animate", { manifest: m })).toEqual({
      kind: "none",
    });
  });

  it("shipped manifest has the expected shape", () => {
    expect(typeof TOOL_PREVIEWS.previews).toBe("object");
  });
});

describe("shouldPlayPreview", () => {
  const base = {
    reducedMotion: false,
    canHover: true,
    hovered: false,
    inView: false,
  };
  it("hover devices play only while hovered or focused", () => {
    expect(shouldPlayPreview(base)).toBe(false);
    expect(shouldPlayPreview({ ...base, inView: true })).toBe(false);
    expect(shouldPlayPreview({ ...base, hovered: true })).toBe(true);
  });
  it("touch devices play while in view", () => {
    const touch = { ...base, canHover: false };
    expect(shouldPlayPreview(touch)).toBe(false);
    expect(shouldPlayPreview({ ...touch, inView: true })).toBe(true);
  });
  it("reduced motion never plays", () => {
    expect(
      shouldPlayPreview({ ...base, reducedMotion: true, hovered: true }),
    ).toBe(false);
    expect(
      shouldPlayPreview({
        ...base,
        reducedMotion: true,
        canHover: false,
        inView: true,
      }),
    ).toBe(false);
  });
});

describe("ToolPreviewMedia render", () => {
  it("renders nothing without a manifest entry", () => {
    expect(
      renderToStaticMarkup(
        <ToolPreviewMedia cardKey="action:upscale" manifest={M} />,
      ),
    ).toBe("");
  });

  it("first render is the still (motion preference not yet known)", () => {
    const html = renderToStaticMarkup(
      <ToolPreviewMedia cardKey="app:figurine" manifest={M} size="lg" />,
    );
    expect(html).toContain('src="/tool-previews/app--figurine.webp"');
    expect(html).toContain('alt=""');
    expect(html).not.toContain("<video");
  });

  it("video-only entry renders a muted looping inline video that does not autoplay", () => {
    const html = renderToStaticMarkup(
      <ToolPreviewMedia cardKey="special:storyboard" manifest={M} />,
    );
    expect(html).toContain("<video");
    expect(html).toMatch(/\bloop\b/);
    expect(html).toMatch(/playsInline|playsinline/);
    expect(html).not.toMatch(/autoplay/i);
    expect(html).toContain(
      '<source src="/tool-previews/special--storyboard.mp4" type="video/mp4"/>',
    );
  });

  it("ToolCover keeps the gradient cover and icon with no preview", () => {
    const html = renderToStaticMarkup(
      <ToolCover
        card={{
          key: "action:__no_preview__",
          hubCategory: "Edit",
          icon: "Wand",
        }}
      />,
    );
    expect(html).toContain("background:");
    expect(html).toContain("<svg");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<video");
  });
});

type PlanEntry = {
  rank: number;
  toolKey: string;
  file: string;
  kind: "still" | "video";
  input: Record<string, string>;
  params?: Record<string, unknown>;
  runs?: { params: Record<string, unknown> }[];
  post: string;
};

describe("tool previews render plan", () => {
  const entries = plan.previews as unknown as PlanEntry[];
  const ctx = { catalog: null, packIds: null, editLoras: null };
  const cards = buildHubCards({
    toolCards: buildToolCards({ ...ctx, modelStatus: { tools: {} } }),
    ctx,
  });
  const keys = new Set(cards.map((c) => c.key));

  it("lists 24 distinct, ranked, real tool cards", () => {
    expect(entries).toHaveLength(24);
    expect(entries.map((e) => e.rank)).toEqual(
      Array.from({ length: 24 }, (_, i) => i + 1),
    );
    expect(new Set(entries.map((e) => e.toolKey)).size).toBe(24);
    for (const e of entries) {
      expect(keys.has(e.toolKey), e.toolKey).toBe(true);
      expect(e.file).toBe(toolPreviewSlug(e.toolKey));
      expect(["still", "video"]).toContain(e.kind);
      expect(e.post.length).toBeGreaterThan(0);
    }
  });

  it("every input points at a planned asset", () => {
    const groups = plan as unknown as Record<string, Record<string, unknown>>;
    for (const e of entries) {
      for (const ref of Object.values(e.input)) {
        const [group, id] = ref.split(".");
        expect(
          groups[group!]?.[id!],
          `${e.toolKey} input ${ref}`,
        ).toBeTruthy();
      }
    }
    for (const who of ["mara", "pip", "lumen"]) {
      const c = (plan.cast as Record<string, { prompt: string }>)[who];
      expect(c?.prompt, who).toMatch(/\S/);
    }
  });

  it("action params are real picker keys and option ids", () => {
    for (const e of entries) {
      if (!e.toolKey.startsWith("action:")) continue;
      const spec = getActionTool(e.toolKey.slice("action:".length));
      expect(spec, e.toolKey).toBeTruthy();
      const runs = e.runs?.map((r) => r.params) ?? (e.params ? [e.params] : []);
      for (const params of runs) {
        for (const [k, v] of Object.entries(params)) {
          const picker = spec!.pickers?.find((p) => p.key === k);
          expect(picker, `${e.toolKey} picker ${k}`).toBeTruthy();
          expect(
            picker!.options.map((o) => o.id),
            `${e.toolKey} ${k}=${String(v)}`,
          ).toContain(v);
        }
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8");

describe("Create/Explore image grid width parity", () => {
  it("uses reference-like 320px dense image-grid columns", () => {
    const css = source("src/app/globals.css");
    expect(css).toMatch(
      /\.image-grid\s*\{[\s\S]*?gap-0\.5[\s\S]*?minmax\(320px/,
    );
    expect(css).not.toContain("minmax(280px");
  });

  it("uses tight 2x2 generation preview gaps and radius", () => {
    const css = source("src/app/globals.css");
    expect(css).toMatch(
      /\.image-grid-2x2\s*\{[\s\S]*?gap-px[\s\S]*?rounded-sm/,
    );
  });

  it("Create gallery uses reference run-row layout with natural aspect ratios", () => {
    const gallery = source("src/components/Gallery.tsx");
    // Reference site create feed (measured from reference): one row per run —
    // portrait 4-across / landscape 2-up, 4px tile radius, 230px meta column
    expect(gallery).toContain("repeat(${gridCols}, 1fr)");
    expect(gallery).toContain("firstAr >= 1.3 ? 2 : 4");
    expect(gallery).toContain("rounded-[4px] overflow-hidden");
    expect(gallery).toContain("const ar = width && height ? width / height : 1;");
    // Stored size first, corrected to the loaded image's real aspect.
    expect(gallery).toMatch(
      /tileStyle\(\s*variant,\s*naturalSize\?\.width \?\? img\.width,\s*naturalSize\?\.height \?\? img\.height,?\s*\)/,
    );
    expect(gallery).toContain("lg:w-[230px]");
    expect(gallery).not.toContain("columns-2 md:columns-3");
    expect(gallery).not.toMatch(/overflow-x-auto[\s\S]*w-48 h-48/);
  });

  it("Explore content uses dense padding and existing reference masonry columns", () => {
    const explore = source("src/components/ExplorePage.tsx");
    // Content shares the centered ~1600px column with the prompt bar (reference site);
    // left-aligns when the settings panel is open
    expect(explore).toContain(
      'px-4 md:px-6 pt-1 pb-3 md:py-3 w-full max-w-[1648px] ${settingsOpen ? "mr-auto" : "mx-auto"}',
    );
    expect(explore).toContain(
      "columns-2 md:columns-3 lg:columns-4 xl:columns-5 gap-0.5",
    );
    expect(explore).toContain("break-inside-avoid mb-0.5");
  });

  it("Gallery downloads preserve media-specific extensions", () => {
    // Whitespace-normalized so the assertion checks the extension logic, not
    // exact source indentation (which the formatter is free to reflow).
    // The extension logic lives in gallerySelection.downloadTarget.
    const sel = source("src/lib/gallerySelection.ts").replace(/\s+/g, " ");
    expect(sel).toContain('img.videoUrl ? ".mp4"');
    // Audio keeps the served container (mp3 from SaveAudioMP3, else .wav).
    expect(sel).toContain("img.audioUrl ? audioExt(img.audioUrl)");
    // 3D files keep their real type (.glb / .ply splat / .bvh motion).
    expect(sel).toContain("img.meshUrl ? meshExt(img.meshUrl)");
    const gallery = source("src/components/Gallery.tsx");
    expect(gallery).toContain("downloadTarget(img)");
    expect(gallery).toContain("link.download = target.filename");
  });
});

describe("Civitai model browser source contracts", () => {
  it("puts the Civitai browser under Setup > Models > Download with the hide-downloaded toggle", () => {
    const setup = source("src/components/SetupPage.tsx");
    const setupUrl = source("src/lib/setupUrl.ts");
    const browser = source("src/components/CivitaiModelBrowser.tsx");
    const results = source("src/components/models/ModelFeedResults.tsx");
    const filters = source("src/lib/modelFilters.ts");
    expect(setupUrl).toContain('"models.download": "Download"');
    expect(setup).toMatch(/case "models\.download":\s*return <CivitaiModelBrowser \/>/);
    expect(browser).toContain("Hide fully downloaded models");
    // Shared with Explore → Models: one filter bar + feed, not a fork.
    expect(browser).toContain("<ModelFilterBar");
    expect(browser).toContain("useModelFeed(");
    expect(filters).toContain('p.set("source", civitaiApiSource(filters.source))');
    expect(filters).toContain('filters.source === "civitai-red" && filters.nsfw ? "true" : "false"');
    expect(results).toContain("filterDownloadedCivitaiModels");
  });
});

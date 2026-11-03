/**
 * App-side image quality guards: uploads keep their original bytes up to the
 * mask cap, any resample is high quality and keeps PNG lossless, and tool
 * hand-offs pass the original full-resolution file (never a thumbnail).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  LOSSY_RESAMPLE_QUALITY,
  TOOL_UPLOAD_MAX_SIDE,
  dataUrlMime,
  uploadResizePlan,
} from "@/lib/tools/uploadPrep";
import { MASK_MAX_SIDE } from "@/lib/tools/toolsPage";
import { resampleSteps, resampleToCanvas } from "@/lib/canvasResample";
import {
  PROFILE_REF_KEEP_CHARS,
  PROFILE_REF_MAX_SIDE,
  profileRefShrink,
} from "@/lib/tools/characterProfiles";
import {
  galleryToolImage,
  handoffFromGalleryItem,
} from "@/lib/tools/toolHandoff";
import { editorHandoff } from "@/lib/editorTools";
import type { GalleryImage } from "@/types";

const SRC = join(process.cwd(), "src");

describe("uploadResizePlan", () => {
  it("keeps the original bytes up to the cap", () => {
    expect(uploadResizePlan(1024, 1024, "image/png")).toBeNull();
    expect(uploadResizePlan(4096, 2304, "image/jpeg")).toBeNull();
    expect(uploadResizePlan(512, 768, "image/webp")).toBeNull();
  });

  it("never upscales and keeps unknown sizes untouched", () => {
    expect(uploadResizePlan(64, 64, "image/png")).toBeNull();
    expect(uploadResizePlan(0, 0, "image/png")).toBeNull();
  });

  it("matches the mask export cap so masks line up 1:1", () => {
    expect(TOOL_UPLOAD_MAX_SIDE).toBe(MASK_MAX_SIDE);
  });

  it("resamples a PNG over the cap to a lossless PNG at the cap", () => {
    expect(uploadResizePlan(8000, 6000, "image/png")).toEqual({
      width: 4096,
      height: 3072,
      mime: "image/png",
    });
  });

  it("keeps a lossy source's format at near-lossless quality", () => {
    expect(uploadResizePlan(6000, 8000, "image/jpeg")).toEqual({
      width: 3072,
      height: 4096,
      mime: "image/jpeg",
      quality: LOSSY_RESAMPLE_QUALITY,
    });
    expect(uploadResizePlan(5000, 5000, "image/webp")?.mime).toBe("image/webp");
    expect(LOSSY_RESAMPLE_QUALITY).toBeGreaterThanOrEqual(0.92);
  });

  it("encodes other types as PNG (alpha kept)", () => {
    expect(uploadResizePlan(5000, 100, "image/gif")?.mime).toBe("image/png");
    expect(uploadResizePlan(5000, 100, "")?.mime).toBe("image/png");
  });

  it("null maxSide opts out (client tools that export at full size)", () => {
    expect(uploadResizePlan(9000, 9000, "image/png", null)).toBeNull();
  });

  it("reads the data URL type", () => {
    expect(dataUrlMime("data:image/jpeg;base64,AAA")).toBe("image/jpeg");
    expect(dataUrlMime("data:IMAGE/PNG;base64,AAA")).toBe("image/png");
    expect(dataUrlMime("/api/comfy/image?x")).toBe("");
  });
});

describe("resampleSteps", () => {
  it("halves step by step down to the target", () => {
    const steps = resampleSteps(8000, 6000, 768, 576);
    expect(steps.at(-1)).toEqual({ width: 768, height: 576 });
    let prev = 8000;
    for (const s of steps) {
      expect(prev / s.width).toBeLessThanOrEqual(2.01);
      prev = s.width;
    }
  });

  it("is one step for small reductions and upscales", () => {
    expect(resampleSteps(5000, 5000, 4096, 4096)).toEqual([
      { width: 4096, height: 4096 },
    ]);
    expect(resampleSteps(512, 512, 1024, 1024)).toEqual([
      { width: 1024, height: 1024 },
    ]);
  });
});

describe("resampleToCanvas", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("draws every step with high-quality smoothing", () => {
    const ctxs: Record<string, unknown>[] = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const ctx: Record<string, unknown> = {
          imageSmoothingEnabled: false,
          imageSmoothingQuality: "low",
          draws: [] as unknown[],
          fillRect: () => {},
          drawImage(...args: unknown[]) {
            (ctx.draws as unknown[]).push(args.slice(1));
          },
        };
        ctxs.push(ctx);
        return { width: 0, height: 0, getContext: () => ctx };
      },
    });
    const src = { width: 4000, height: 3000 } as unknown as HTMLImageElement;
    const out = resampleToCanvas(src, 4000, 3000, 768, 576);
    expect(out.width).toBe(768);
    expect(out.height).toBe(576);
    expect(ctxs.length).toBeGreaterThan(1);
    for (const ctx of ctxs) {
      expect(ctx.imageSmoothingEnabled).toBe(true);
      expect(ctx.imageSmoothingQuality).toBe("high");
    }
  });
});

describe("profileRefShrink", () => {
  it("stores a small upload as-is (no lossy re-encode)", () => {
    expect(profileRefShrink(512, 640, 200_000)).toBeNull();
  });

  it("shrinks oversize uploads to the storage cap", () => {
    expect(profileRefShrink(3000, 4000, 2_000_000)).toEqual({
      width: Math.round(3000 * (PROFILE_REF_MAX_SIDE / 4000)),
      height: PROFILE_REF_MAX_SIDE,
    });
  });

  it("re-encodes an in-size but heavy file without resizing it", () => {
    expect(profileRefShrink(700, 700, PROFILE_REF_KEEP_CHARS + 1)).toEqual({
      width: 700,
      height: 700,
    });
  });
});

describe("tool hand-offs pass the original full-res file", () => {
  const item = (patch: Partial<GalleryImage> = {}): GalleryImage =>
    ({
      id: "mara-1",
      url: "/api/comfy/image?filename=mara_00001_.png&subfolder=&type=output",
      prompt: "mara portrait",
      runId: "run-1",
      jobIndex: 0,
      width: 1664,
      height: 2432,
      ...patch,
    }) as GalleryImage;

  it("lightbox hand-off carries the output URL and its native size", () => {
    const h = handoffFromGalleryItem(item(), "action:upscale", 1);
    expect(h?.url).toBe(item().url);
    expect([h?.width, h?.height]).toEqual([1664, 2432]);
    // A local image goes by run/job: the server loads the saved file itself.
    const img = h ? galleryToolImage(h) : null;
    expect(img).toMatchObject({ runId: "run-1", jobIndex: 0 });
    expect(img?.dataUrl).toBeUndefined();
  });

  it("an external image hands over its full URL, not the thumbnail", () => {
    const h = handoffFromGalleryItem(
      item({
        runId: "",
        url: "https://example.test/full.png",
        external: {
          source: "civitai",
          id: 1,
          thumbnailUrl: "https://example.test/width=450/full.png",
        },
      }),
      "action:upscale",
      1,
    );
    expect(h?.url).toBe("https://example.test/full.png");
  });

  it("editor hand-off passes the canvas source URL and run", () => {
    const h = editorHandoff(
      { key: "action:upscale", mask: null },
      {
        url: "/api/comfy/image?filename=pip_00001_.png&type=output",
        id: "pip-1",
        width: 2048,
        height: 2048,
        run: { runId: "run-9", jobIndex: 1 },
      },
      null,
      1,
    );
    expect(h).toMatchObject({
      url: "/api/comfy/image?filename=pip_00001_.png&type=output",
      width: 2048,
      height: 2048,
      runId: "run-9",
      jobIndex: 1,
    });
  });
});

describe("static guards", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return files(p);
      return /\.(ts|tsx)$/.test(p) && !/\.test\./.test(p) ? [p] : [];
    });

  it("outputs are served unoptimized (no Next/Image downscale)", () => {
    const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
    expect(config).toMatch(/unoptimized:\s*true/);
    const offenders = files(SRC).filter(
      (p) =>
        !p.includes("__tests__") &&
        /from\s+"next\/image"/.test(readFileSync(p, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("no pixelated scaling on displayed images", () => {
    const offenders = files(SRC).filter((p) =>
      /pixelated|crisp-edges|optimize(?:Speed|-contrast)/.test(
        readFileSync(p, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("only the profile store re-encodes images as JPEG", () => {
    const offenders = files(SRC)
      .filter((p) => !p.includes("__tests__"))
      .filter((p) =>
        /to(?:DataURL|Blob)\([^)]*image\/jpeg/.test(readFileSync(p, "utf8")),
      )
      .map((p) => p.slice(SRC.length + 1));
    expect(offenders).toEqual(["components/tools/CharacterProfiles.tsx"]);
  });

  it("the tool upload input resamples through the high-quality path", () => {
    const input = readFileSync(
      join(SRC, "components/tools/ToolImageInput.tsx"),
      "utf8",
    );
    expect(input).toMatch(/prepareUploadDataUrl/);
    expect(input).not.toMatch(/drawImage/);
    // Color Grade exports at the photo's own size: no upload cap.
    const grade = readFileSync(
      join(SRC, "components/tools/ColorGrade.tsx"),
      "utf8",
    );
    expect(grade).toMatch(/maxSide=\{null\}/);
  });
});

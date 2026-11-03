import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HANDOFF_TTL_MS,
  galleryToolImage,
  handoffFromGalleryItem,
  takeHandoff,
} from "@/lib/tools/toolHandoff";
import { useToolHandoffStore } from "@/store/toolHandoffStore";
import type { GalleryImage } from "@/types";

const item = (patch: Partial<GalleryImage> = {}): GalleryImage =>
  ({
    id: "img-1",
    url: "/api/comfy/view?filename=a.png",
    prompt: "a lighthouse at dusk",
    runId: "run-1",
    jobIndex: 2,
    width: 832,
    height: 1216,
    ...patch,
  }) as GalleryImage;

const NOW = 1_000_000;

describe("handoffFromGalleryItem", () => {
  it("hands a local image over by run/job", () => {
    const h = handoffFromGalleryItem(item(), "action:upscale", NOW);
    expect(h).toEqual({
      toolKey: "action:upscale",
      media: "image",
      itemId: "img-1",
      url: "/api/comfy/view?filename=a.png",
      label: "a lighthouse at dusk",
      width: 832,
      height: 1216,
      runId: "run-1",
      jobIndex: 2,
      at: NOW,
    });
  });

  it("uses the clip URL for videos and omits run info for external items", () => {
    const v = handoffFromGalleryItem(
      item({ videoUrl: "/clip.mp4", runId: undefined }),
      "action:x",
      NOW,
    );
    expect(v?.media).toBe("video");
    expect(v?.url).toBe("/clip.mp4");
    expect(v && "runId" in v).toBe(false);
  });

  it("hands audio items over by their audio URL", () => {
    const a = handoffFromGalleryItem(
      item({ audioUrl: "/a.mp3", url: "" }),
      "action:sa3_a2a",
      NOW,
    );
    expect(a?.media).toBe("audio");
    expect(a?.url).toBe("/a.mp3");
  });

  it("treats a clip with an audio track as video", () => {
    const v = handoffFromGalleryItem(
      item({ videoUrl: "/v.mp4", audioUrl: "/a.mp3" }),
      "action:upscale_video",
      NOW,
    );
    expect(v?.media).toBe("video");
    expect(v?.url).toBe("/v.mp4");
  });

  it("returns null for 3D and missing URLs", () => {
    expect(handoffFromGalleryItem(item({ meshUrl: "/m.glb" }), "k", NOW)).toBe(
      null,
    );
    expect(handoffFromGalleryItem(item({ url: "" }), "k", NOW)).toBe(null);
  });

  it("falls back to a generic label without a prompt", () => {
    expect(handoffFromGalleryItem(item({ prompt: "" }), "k", NOW)?.label).toBe(
      "Image",
    );
  });
});

describe("takeHandoff", () => {
  const h = handoffFromGalleryItem(item(), "action:upscale", NOW)!;

  it("returns a fresh match and clears it", () => {
    expect(takeHandoff(h, "action:upscale", NOW + 1000)).toEqual({
      handoff: h,
      remaining: null,
    });
  });

  it("leaves another tool's hand-off pending", () => {
    expect(takeHandoff(h, "app:other", NOW + 1000)).toEqual({
      handoff: null,
      remaining: h,
    });
  });

  it("drops stale or future-dated hand-offs", () => {
    expect(takeHandoff(h, "action:upscale", NOW + HANDOFF_TTL_MS + 1)).toEqual({
      handoff: null,
      remaining: null,
    });
    expect(takeHandoff(h, "action:upscale", NOW - 1)).toEqual({
      handoff: null,
      remaining: null,
    });
    expect(takeHandoff(null, "action:upscale", NOW)).toEqual({
      handoff: null,
      remaining: null,
    });
  });
});

describe("galleryToolImage", () => {
  it("builds a gallery ToolImage for local images only", () => {
    const h = handoffFromGalleryItem(item(), "k", NOW)!;
    expect(galleryToolImage(h)).toEqual({
      id: "img-1",
      source: "gallery",
      previewUrl: "/api/comfy/view?filename=a.png",
      label: "a lighthouse at dusk",
      width: 832,
      height: 1216,
      runId: "run-1",
      jobIndex: 2,
    });
    const ext = handoffFromGalleryItem(item({ runId: undefined }), "k", NOW)!;
    expect(galleryToolImage(ext)).toBe(null);
    const clip = handoffFromGalleryItem(
      item({ videoUrl: "/c.mp4" }),
      "k",
      NOW,
    )!;
    expect(galleryToolImage(clip)).toBe(null);
  });
});

describe("useToolHandoffStore", () => {
  beforeEach(() => useToolHandoffStore.setState({ pending: null }));

  it("offers once and is consumed by the matching tool only", () => {
    const h = handoffFromGalleryItem(item(), "template:krea2", NOW)!;
    useToolHandoffStore.getState().offer(h);
    expect(useToolHandoffStore.getState().take("app:x", NOW)).toBe(null);
    expect(useToolHandoffStore.getState().pending).toBe(h);
    expect(useToolHandoffStore.getState().take("template:krea2", NOW)).toBe(h);
    expect(useToolHandoffStore.getState().pending).toBe(null);
    expect(useToolHandoffStore.getState().take("template:krea2", NOW)).toBe(
      null,
    );
  });
});

describe("runner wiring", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("ToolRunner, TemplateRunner and AppRunner preload the hand-off", () => {
    expect(src("src/components/tools/ToolRunner.tsx")).toContain(
      "useToolHandoff(card.key, {",
    );
    for (const f of ["TemplateRunner", "AppRunner"]) {
      const runner = src(`src/components/tools/${f}.tsx`);
      expect(runner).toContain("useToolHandoff(card.key, {");
      expect(runner).toContain("onImage: setImage,");
      expect(runner).toContain("onError: setError,");
    }
    // Opened from the editor: results go back there.
    for (const f of ["ToolRunner", "TemplateRunner", "AppRunner"]) {
      const runner = src(`src/components/tools/${f}.tsx`);
      expect(runner, f).toContain("onHandoff: editorOrigin.onHandoff");
      expect(runner, f).toContain("editorOrigin.track(");
    }
  });

  it("the hook takes only hand-offs the runner can use", () => {
    const hook = src("src/components/tools/useToolHandoff.ts");
    expect(hook).toContain('pending.media === "image" && !onImage');
    expect(hook).toContain('pending.media === "video" && !onVideo');
    expect(hook).toContain("MAX_VIDEO_UPLOAD_BYTES");
  });

  it("extra images (a bridge's end frame) fill the slots after the first", () => {
    const hook = src("src/components/tools/useToolHandoff.ts");
    expect(hook).toContain("(h.moreImages ?? []).map((m, i) =>");
    expect(hook).toContain("onMoreImage?.(i + 1, img)");
    const runner = src("src/components/tools/ToolRunner.tsx");
    expect(runner).toMatch(/onMoreImage:\s+refCount > 1 && !videoLabel/);
    expect(runner).toContain("if (slot < refCount) setImage(slot, img);");
  });
});

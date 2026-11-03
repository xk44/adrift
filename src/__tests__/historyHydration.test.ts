import { describe, expect, it } from "vitest";
import { mergeRecentHistory } from "@/lib/historyHydration";
import type { GalleryImage, ImagineRun } from "@/types";

const recentResponse = {
  ok: true,
  nextOffset: null,
  runs: [{
    run_id: "4e0604cf-38fb-4c24-9638-7ed67baa9d7f",
    prompt: "history probe amber lantern",
    parsedPrompt: "history probe amber lantern",
    width: 1024,
    height: 1024,
    createdAt: "2026-07-10T18:34:43.000Z",
    params: { negativePrompt: "ugly, blurry, low quality, distorted" },
    jobs: [{ index: 0, seed: 161973971, status: "done", progress: 0, images: ["/api/comfy/image?filename=CJ_Krea2_00042_.png&subfolder=&type=output"], prompt_id: "ccb9a029-0c93-458a-b4ef-b181af2d22a3" }],
  }],
};

function localImage(runId: string): GalleryImage {
  return { id: `local-${runId}`, url: "local.png", prompt: "local", fullPrompt: "local", params: [], paramsMap: {}, seed: 1, createdAt: "2026-07-01T00:00:00.000Z", runId, jobIndex: 0, width: 512, height: 512 };
}

function activeRun(): ImagineRun {
  return { run_id: "4e0604cf-38fb-4c24-9638-7ed67baa9d7f", prompt: "live prompt", parsedPrompt: "live prompt", width: 512, height: 512, createdAt: "2026-07-10T12:01:00.000Z", params: {}, status: "running", jobs: [{ index: 0, seed: 7, status: "running", progress: 0.5, images: [] }] };
}

describe("shared history hydration", () => {
  it("hydrates a recorded /api/jobs/recent response into shared runs and proxy gallery images", () => {
    const merged = mergeRecentHistory(recentResponse.runs, [], []);
    expect(merged.runs[0]).toMatchObject({ run_id: "4e0604cf-38fb-4c24-9638-7ed67baa9d7f", status: "done", historySource: "server" });
    expect(merged.gallery[0]).toMatchObject({ runId: "4e0604cf-38fb-4c24-9638-7ed67baa9d7f", url: expect.stringContaining("/api/comfy/image"), historySource: "server" });
  });

  it("keeps a locally active run ahead of its server copy", () => {
    const merged = mergeRecentHistory(recentResponse.runs, [activeRun()], []);
    expect(merged.runs).toHaveLength(1);
    expect(merged.runs[0]).toMatchObject({ prompt: "live prompt", status: "running" });
    expect(merged.gallery).toEqual([]);
  });

  it("retains missing persisted gallery history as local-only", () => {
    const merged = mergeRecentHistory(recentResponse.runs, [], [localImage("legacy-run")]);
    expect(merged.gallery.find((image) => image.runId === "legacy-run")).toMatchObject({ historySource: "local" });
  });

  it("preserves local gallery organization for a server-matched image", () => {
    const existing = { ...localImage("4e0604cf-38fb-4c24-9638-7ed67baa9d7f"), liked: true, hidden: true, folderIds: ["favorites"] };
    const merged = mergeRecentHistory(recentResponse.runs, [], [existing]);
    expect(merged.gallery[0]).toMatchObject({ id: existing.id, liked: true, hidden: true, folderIds: ["favorites"], historySource: "server" });
  });
});

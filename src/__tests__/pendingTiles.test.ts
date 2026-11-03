import { describe, expect, it } from "vitest";
import {
  naturalSizeOverride,
  pendingTileAspect,
  previewBlur,
} from "@/lib/pendingTileAspect";
import { runReadyForGallery } from "@/lib/galleryMedia";
import { isFailedLocalRun, selectGeneratingRowRuns } from "@/store";
import type { ImagineJob, ImagineRun, JobStatus } from "@/types";

function job(status: JobStatus, images: string[] = []): ImagineJob {
  return { seed: 1, index: 0, status, progress: 0, images } as ImagineJob;
}
function run(
  status: JobStatus,
  jobs: ImagineJob[],
  extra: Partial<ImagineRun> = {},
): ImagineRun {
  return {
    run_id: `r-${Math.random()}`,
    prompt: "a cat",
    parsedPrompt: "a cat",
    width: 0,
    height: 0,
    jobs,
    createdAt: new Date().toISOString(),
    status,
    params: {},
    ...extra,
  };
}

describe("pendingTileAspect", () => {
  it("prefers the job's real size over --ar", () => {
    expect(
      pendingTileAspect({ width: 1344, height: 768, params: { aspect: "1:1" } }),
    ).toEqual({ ar: 1344 / 768, aspectRatio: "1344 / 768" });
  });
  it("falls back to --ar then square", () => {
    expect(pendingTileAspect({ width: 0, height: 0, params: { aspect: "2:3" } })
      .aspectRatio).toBe("2 / 3");
    expect(pendingTileAspect({ params: { aspect: "bogus" } })).toEqual({
      ar: 1,
      aspectRatio: "1 / 1",
    });
  });
});

describe("previewBlur", () => {
  it("sharpens as progress rises", () => {
    expect(previewBlur(0)).toBe("blur(12px)");
    expect(previewBlur(50)).toBe("blur(6px)");
    expect(previewBlur(100)).toBe("none");
    expect(previewBlur(NaN)).toBe("blur(12px)");
  });
});

describe("naturalSizeOverride", () => {
  it("keeps the stored size when the aspect matches", () => {
    expect(naturalSizeOverride(2048, 2048, 1024, 1024)).toBeNull();
    expect(naturalSizeOverride(1024, 1016, 1024, 1024)).toBeNull();
  });
  it("uses the real size when stored is missing or wrong", () => {
    expect(naturalSizeOverride(768, 1344, 0, 0)).toEqual({
      width: 768,
      height: 1344,
    });
    expect(naturalSizeOverride(1536, 1024, 1024, 1024)).toEqual({
      width: 1536,
      height: 1024,
    });
    expect(naturalSizeOverride(0, 0, 1024, 1024)).toBeNull();
  });
});

describe("runReadyForGallery", () => {
  it("adds the finished images of partly failed or cancelled runs", () => {
    expect(runReadyForGallery(run("error", [job("done", ["a"]), job("error")]))).toBe(true);
    expect(runReadyForGallery(run("done", [job("done", ["a"]), job("cancelled")]))).toBe(true);
  });
  it("waits for outputs and active jobs", () => {
    expect(runReadyForGallery(run("done", [job("done")]))).toBe(false);
    expect(runReadyForGallery(run("running", [job("done", ["a"]), job("running")]))).toBe(false);
    expect(runReadyForGallery(run("error", [job("error")]))).toBe(false);
  });
});

describe("selectGeneratingRowRuns", () => {
  it("keeps this session's failures visible, not server history ones", () => {
    const active = run("queued", [job("queued")]);
    const failed = run("error", [job("error")]);
    const serverFailed = run("error", [job("error")], { historySource: "server" });
    const done = run("done", [job("done", ["a"])]);
    expect(isFailedLocalRun(failed)).toBe(true);
    expect(isFailedLocalRun(serverFailed)).toBe(false);
    const rows = selectGeneratingRowRuns({
      runs: [active, failed, serverFailed, done],
    } as never);
    expect(rows).toEqual([active, failed]);
  });
});

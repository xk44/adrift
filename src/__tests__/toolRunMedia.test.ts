import { describe, expect, it } from "vitest";
import { toolRunMedia } from "@/lib/tools/runMedia";
import type { ImagineJob, ImagineRun } from "@/types";

const job = (index: number, over: Partial<ImagineJob> = {}): ImagineJob => ({
  index,
  seed: 1,
  status: "done",
  progress: 100,
  images: [],
  ...over,
});
const run = (jobs: ImagineJob[]) => ({ run_id: "r", jobs }) as unknown as ImagineRun;

describe("toolRunMedia", () => {
  it("lists images across jobs in order", () => {
    const { items, more } = toolRunMedia(run([job(0, { images: ["a", "b"] }), job(1, { images: ["c"] })]));
    expect(items.map((i) => i.url)).toEqual(["a", "b", "c"]);
    expect(items[2]).toMatchObject({ jobIndex: 1, imageIndex: 0, kind: "image" });
    expect(more).toBe(0);
  });
  it("shows a video job's video, not its preview frames", () => {
    const { items } = toolRunMedia(run([job(0, { images: ["poster"], videos: ["clip.mp4"] })]));
    expect(items).toEqual([{ kind: "video", url: "clip.mp4", jobIndex: 0, imageIndex: 0 }]);
  });
  it("skips unfinished jobs and caps with a remainder count", () => {
    const imgs = Array.from({ length: 14 }, (_, i) => `i${i}`);
    const r = run([job(0, { images: imgs }), job(1, { status: "running", images: ["x"] })]);
    const { items, more } = toolRunMedia(r, 9);
    expect(items).toHaveLength(9);
    expect(more).toBe(5);
    expect(items.some((i) => i.url === "x")).toBe(false);
  });
});

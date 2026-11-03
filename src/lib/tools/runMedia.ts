import type { ImagineRun } from "@/types";

export interface RunMediaItem {
  kind: "image" | "video";
  url: string;
  jobIndex: number;
  /** Position among the job's images (for opening the lightbox on it). */
  imageIndex: number;
}

/**
 * Visual outputs of a finished tool run, in job order, for the inline result
 * on the Tools page. A job that produced a video shows the video only (its
 * images are preview frames); otherwise its images.
 */
export function toolRunMedia(run: ImagineRun, cap = 12): { items: RunMediaItem[]; more: number } {
  const all: RunMediaItem[] = [];
  for (const job of run.jobs) {
    if (job.status !== "done") continue;
    if (job.videos?.length) {
      job.videos.forEach((url, i) => all.push({ kind: "video", url, jobIndex: job.index, imageIndex: i }));
    } else {
      job.images.forEach((url, i) => all.push({ kind: "image", url, jobIndex: job.index, imageIndex: i }));
    }
  }
  return { items: all.slice(0, cap), more: Math.max(0, all.length - cap) };
}

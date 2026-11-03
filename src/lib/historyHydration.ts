import { buildGalleryParamChips } from "@/lib/galleryParams";
import type { GalleryImage, ImagineJob, ImagineRun, JobStatus } from "@/types";

export interface RecentHistoryRun {
  run_id: string;
  prompt: string;
  parsedPrompt: string;
  width: number;
  height: number;
  createdAt: string;
  params: Record<string, unknown>;
  jobs: Array<{
    index: number;
    seed: number;
    status: string;
    progress: number;
    images: string[];
    prompt_id?: string;
    error?: string;
  }>;
}

const JOB_STATUSES = new Set<JobStatus>([
  "queued", "running", "done", "error", "cancelled",
]);

function normalizeStatus(status: string): JobStatus {
  return JOB_STATUSES.has(status as JobStatus)
    ? (status as JobStatus)
    : "queued";
}

function runStatus(jobs: ImagineJob[]): JobStatus {
  if (jobs.some((job) => job.status === "running")) return "running";
  if (jobs.some((job) => job.status === "queued")) return "queued";
  if (jobs.length > 0 && jobs.every((job) => job.status === "done")) return "done";
  if (jobs.some((job) => job.status === "error")) return "error";
  if (jobs.length > 0 && jobs.every((job) => job.status === "cancelled")) return "cancelled";
  return "queued";
}

export function recentRunToImagineRun(run: RecentHistoryRun): ImagineRun {
  const jobs: ImagineJob[] = run.jobs.map((job) => ({
    index: job.index,
    seed: job.seed,
    status: normalizeStatus(job.status),
    progress: job.progress,
    images: job.images,
    ...(job.prompt_id ? { prompt_id: job.prompt_id } : {}),
    ...(job.error ? { error: job.error } : {}),
  }));
  return { ...run, jobs, status: runStatus(jobs), historySource: "server" };
}

function isLocalActiveRun(run: ImagineRun): boolean {
  return !run.historySource && (run.status === "queued" || run.status === "running");
}

function serverGalleryImages(run: ImagineRun, existing: GalleryImage[]): GalleryImage[] {
  const oldImagesByJob = new Map<number, GalleryImage[]>();
  for (const image of existing) {
    if (image.runId !== run.run_id) continue;
    oldImagesByJob.set(image.jobIndex, [...(oldImagesByJob.get(image.jobIndex) ?? []), image]);
  }

  return run.jobs.flatMap((job) =>
    job.images.map((url, imageIndex) => {
      const old = oldImagesByJob.get(job.index)?.[imageIndex];
      return {
        id: old?.id ?? `server:${run.run_id}:${job.index}:${imageIndex}`,
        url,
        prompt: run.prompt,
        fullPrompt: `${run.parsedPrompt || run.prompt} --seed ${job.seed}`,
        params: buildGalleryParamChips(run.params, job.seed),
        paramsMap: run.params,
        seed: job.seed,
        createdAt: run.createdAt,
        runId: run.run_id,
        jobIndex: job.index,
        width: run.width,
        height: run.height,
        folderIds: old?.folderIds,
        liked: old?.liked,
        hidden: old?.hidden,
        historySource: "server" as const,
      };
    }),
  );
}

/** Gallery images of one server run, outside the feed's paged history. */
export function runGalleryImages(run: RecentHistoryRun): GalleryImage[] {
  return serverGalleryImages(recentRunToImagineRun(run), []);
}

/**
 * Server history is authoritative, except active local runs retain their live
 * WebSocket state. Persisted gallery entries not yet represented by the server
 * remain as local-only offline history.
 */
export function mergeRecentHistory(
  serverRuns: RecentHistoryRun[],
  existingRuns: ImagineRun[],
  existingGallery: GalleryImage[],
): { runs: ImagineRun[]; gallery: GalleryImage[] } {
  const incoming = serverRuns.map(recentRunToImagineRun);
  const incomingIds = new Set(incoming.map((run) => run.run_id));
  const priorServerRuns = existingRuns.filter((run) => run.historySource === "server" && !incomingIds.has(run.run_id));
  const localActiveRuns = existingRuns.filter(isLocalActiveRun);
  const activeIds = new Set(localActiveRuns.map((run) => run.run_id));
  const runs = [
    ...localActiveRuns,
    ...incoming.filter((run) => !activeIds.has(run.run_id)),
    ...priorServerRuns.filter((run) => !activeIds.has(run.run_id)),
  ];

  const serverRunIds = new Set([...priorServerRuns, ...incoming].map((run) => run.run_id));
  const localOnlyImages = existingGallery
    .filter((image) => !serverRunIds.has(image.runId))
    .map((image) => ({ ...image, historySource: "local" as const }));
  const incomingImages = incoming
    .filter((run) => !activeIds.has(run.run_id))
    .flatMap((run) => serverGalleryImages(run, existingGallery));
  const priorServerImages = existingGallery.filter(
    (image) => image.historySource === "server" && !incomingIds.has(image.runId),
  );
  return { runs, gallery: [...incomingImages, ...priorServerImages, ...localOnlyImages] };
}

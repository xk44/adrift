/** Row grouping for GET /api/jobs/recent (route files may only export handlers). */
import type { RecentRunRow } from "@/lib/db";
import { isAudioFile, isMeshFile } from "@/lib/mesh/usdz";

export type RecentJob = {
  index: number;
  seed: number;
  status: string;
  progress: number;
  /** Images and videos (clients split videos by extension). */
  images: string[];
  /** 3D outputs: the .glb plus its .usdz export when one exists. */
  meshes?: string[];
  audios?: string[];
  prompt_id?: string;
  error?: string;
};

export type RecentRun = {
  run_id: string;
  prompt: string;
  parsedPrompt: string;
  width: number;
  height: number;
  createdAt: string;
  params: Record<string, unknown>;
  jobs: RecentJob[];
};

export function proxyUrl(
  filename: string,
  subfolder: string,
  type: string,
): string {
  return `/api/comfy/image?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
}

function paramsFrom(row: RecentRunRow): Record<string, unknown> {
  if (!row.params) return {};
  try {
    const value: unknown = JSON.parse(row.params);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Which response bucket an output row goes in. The stored media type wins;
 * the extension is the fallback for rows written before meshes/audio were
 * persisted (they defaulted to "image").
 */
export function outputBucket(
  filename: string,
  media: string | null | undefined,
): "images" | "meshes" | "audios" {
  if (media === "mesh" || isMeshFile(filename)) return "meshes";
  if (media === "audio" || isAudioFile(filename)) return "audios";
  return "images";
}

export function groupRuns(rows: RecentRunRow[]): RecentRun[] {
  const runs = new Map<string, RecentRun>();
  const jobs = new Map<string, RecentJob>();
  for (const row of rows) {
    let run = runs.get(row.run_id);
    if (!run) {
      run = {
        run_id: row.run_id,
        prompt: row.prompt,
        parsedPrompt: row.parsed_prompt ?? row.prompt,
        width: row.width ?? 0,
        height: row.height ?? 0,
        createdAt: new Date(row.created_at * 1000).toISOString(),
        params: paramsFrom(row),
        jobs: [],
      };
      runs.set(row.run_id, run);
    }
    if (!row.job_id) continue;
    let job = jobs.get(row.job_id);
    if (!job) {
      job = {
        index: Number(row.job_id.split(":").at(-1) ?? run.jobs.length),
        seed: row.seed ?? 0,
        // Client enum has no "pending" — normalize legacy rows to "queued".
        status:
          row.job_status === "pending" || !row.job_status
            ? "queued"
            : row.job_status,
        progress: row.progress ?? 0,
        images: [],
        ...(row.prompt_id_comfy ? { prompt_id: row.prompt_id_comfy } : {}),
        ...(row.job_error ? { error: row.job_error } : {}),
      };
      jobs.set(row.job_id, job);
      run.jobs.push(job);
    }
    if (row.output_filename) {
      const url = proxyUrl(
        row.output_filename,
        row.output_subfolder ?? "",
        row.output_type ?? "output",
      );
      const bucket = outputBucket(row.output_filename, row.output_media);
      if (bucket === "images") job.images.push(url);
      else (job[bucket] ??= []).push(url);
    }
  }
  return [...runs.values()];
}

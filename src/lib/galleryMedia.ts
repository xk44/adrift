import type { ImagineJob, ImagineRun } from "@/types";

/** Download extension for an audio view URL (?filename=x.mp3 or a path); default ".wav". */
export function audioExt(url: string | undefined): string {
  if (!url) return ".wav";
  let name = url;
  try {
    const u = new URL(url, "http://local");
    name = u.searchParams.get("filename") ?? u.pathname;
  } catch {
    /* keep raw */
  }
  const m = /\.(mp3|wav|flac|ogg|opus|m4a|aac)$/i.exec(name);
  return m ? `.${m[1].toLowerCase()}` : ".wav";
}

/** File name of a media view URL (?filename=x.ply or the last path segment). */
function mediaFilename(url: string): string {
  try {
    const u = new URL(url, "http://local");
    return u.searchParams.get("filename") ?? u.pathname;
  } catch {
    return url;
  }
}

/**
 * Download extension for a 3D file URL: meshes (.glb/.obj/...), Gaussian
 * splats (.ply/.spz/.ksplat/.splat) and BVH motion; default ".glb".
 */
export function meshExt(url: string | undefined): string {
  if (!url) return ".glb";
  const m = /\.(glb|gltf|obj|fbx|stl|usdz|ply|spz|ksplat|splat|bvh)$/i.exec(
    mediaFilename(url),
  );
  return m ? `.${m[1].toLowerCase()}` : ".glb";
}

/**
 * First file of a job the 3D viewer can show. Only self-contained .glb: a .gltf
 * references sidecar buffers the view route cannot resolve, and splats, .bvh
 * and the rest are not meshes it can load. Unlike meshExt, an unknown name is
 * not assumed to be a GLB.
 */
export function previewableMesh(
  urls: readonly (string | undefined)[] | undefined,
): string | undefined {
  return (urls ?? []).find((u) => u && /\.glb$/i.test(mediaFilename(u)));
}

/** One download button per 3D file of a job: "Download PLY", "Download GLB". */
export function meshDownloads(
  urls: readonly (string | undefined)[] | undefined,
): Array<{ href: string; label: string }> {
  const list = (urls ?? []).filter((u): u is string => Boolean(u));
  const unique = [...new Set(list)];
  const labels = unique.map((u) => meshExt(u).slice(1).toUpperCase());
  return unique.map((href, i) => {
    const dupes = labels.filter((l) => l === labels[i]).length;
    const nth = labels.slice(0, i + 1).filter((l) => l === labels[i]).length;
    return {
      href,
      label: `Download ${labels[i]}${dupes > 1 ? ` ${nth}` : ""}`,
    };
  });
}

/**
 * Gallery tiles a finished job contributes: one per image, or one tile for an
 * audio-only (music / sfx) or mesh-only job (url "" → the tile shows its
 * media icon). 0 = nothing to show yet.
 */
export function galleryTileCount(job: ImagineJob): number {
  if (job.status !== "done") return 0;
  if (job.images.length > 0) return job.images.length;
  return job.audios?.length || job.meshes?.length ? 1 : 0;
}

/**
 * A run is ready for the gallery once nothing in it is still queued/running
 * and every finished job has its outputs loaded. Partly failed or cancelled
 * runs still contribute the images that did finish.
 */
export function runReadyForGallery(run: ImagineRun): boolean {
  if (run.status !== "done" && run.status !== "error" && run.status !== "cancelled")
    return false;
  if (run.jobs.some((j) => j.status === "queued" || j.status === "running"))
    return false;
  const done = run.jobs.filter((j) => j.status === "done");
  return done.length > 0 && done.every((j) => galleryTileCount(j) > 0);
}

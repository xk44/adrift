/**
 * Download names for gallery media: `Adrift_<tool>_<seed>_v<N>.<ext>`, with
 * the tool read from the run's params and N = job index + 1. Client-safe.
 */

import type { GalleryImage } from "@/types";
import {
  DOWNLOAD_PREFIX,
  downloadName,
  extFromUrl,
  nameToken,
  toolFromParams,
} from "@/lib/output/saveNodes";

export type DownloadNameSource = Pick<GalleryImage, "seed" | "id"> &
  Partial<Pick<GalleryImage, "paramsMap" | "jobIndex">>;

function seedOf(img: DownloadNameSource): string | number {
  return Number.isFinite(img.seed) ? img.seed : img.id;
}

function versionOf(img: DownloadNameSource): number {
  return typeof img.jobIndex === "number" && img.jobIndex >= 0 ? img.jobIndex + 1 : 1;
}

/** File name for one media file; ext comes from the real URL when it has one. */
export function mediaDownloadName(
  img: DownloadNameSource,
  url: string | undefined,
  fallbackExt: string,
): string {
  return downloadName({
    tool: toolFromParams(img.paramsMap),
    seed: seedOf(img),
    version: versionOf(img),
    ext: extFromUrl(url, fallbackExt.replace(/^\./, "")),
  });
}

/** Same stem plus a suffix, for sidecars ("…_v1_metadata.json"). */
export function sidecarDownloadName(img: DownloadNameSource, suffix: string): string {
  const stem = `${DOWNLOAD_PREFIX}${toolFromParams(img.paramsMap)}_${nameToken(seedOf(img), "0")}_v${versionOf(img)}`;
  return `${stem}_${suffix}`;
}

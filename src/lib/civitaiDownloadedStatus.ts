import type { CivitaiModel } from "@/lib/civitai";
import { planCivitaiFile } from "@/lib/civitaiFolders";
import type { DownloadedModel } from "@/store/downloadStore";

function basename(value: string): string {
  return value.split(/[\\/]/).pop()?.toLowerCase() ?? value.toLowerCase();
}

export function getCivitaiVersionIds(model: CivitaiModel): number[] {
  return (model.modelVersions ?? [])
    .map((version) => version.id)
    .filter((id): id is number => typeof id === "number");
}

/** True when this exact file of this version is in the download list. */
export function isCivitaiFileDownloaded(
  modelId: number,
  versionId: number,
  filename: string,
  downloads: DownloadedModel[],
): boolean {
  const wanted = basename(filename);
  return downloads.some(
    (download) =>
      download.civitaiModelId === modelId &&
      download.civitaiVersionId === versionId &&
      basename(download.filename) === wanted,
  );
}

/**
 * A version counts as downloaded when every file Adrift can download from
 * it is present. Files that can't be downloaded here (config, training
 * data, zips) don't count, or the badge could never turn on. Without a
 * model type every file counts.
 */
export function isCivitaiVersionFullyDownloaded(
  modelId: number,
  version: NonNullable<CivitaiModel["modelVersions"]>[number],
  downloads: DownloadedModel[],
  modelType?: string,
): boolean {
  const versionDownloads = downloads.filter(
    (download) =>
      download.civitaiModelId === modelId &&
      download.civitaiVersionId === version.id,
  );

  if (versionDownloads.length === 0) return false;

  const allFiles = version.files ?? [];
  const files = modelType
    ? allFiles.filter((file) => planCivitaiFile(modelType, file).ok)
    : allFiles;
  if (files.length === 0) return true;

  const downloadedFilenames = new Set(
    versionDownloads.map((download) => basename(download.filename)),
  );

  return files.every((file) => downloadedFilenames.has(basename(file.name)));
}

export function isCivitaiModelFullyDownloaded(
  model: CivitaiModel,
  downloads: DownloadedModel[],
): boolean {
  const versions = model.modelVersions ?? [];
  if (versions.length === 0) return false;

  return versions.every((version) =>
    isCivitaiVersionFullyDownloaded(model.id, version, downloads, model.type),
  );
}

export function filterDownloadedCivitaiModels(
  models: CivitaiModel[],
  downloads: DownloadedModel[],
  hideDownloaded: boolean,
): CivitaiModel[] {
  if (!hideDownloaded) return models;
  return models.filter(
    (model) => !isCivitaiModelFullyDownloaded(model, downloads),
  );
}

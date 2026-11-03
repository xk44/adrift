import { describe, expect, it } from "vitest";
import type { CivitaiModel } from "@/lib/civitai";
import type { DownloadedModel } from "@/store/downloadStore";
import {
  filterDownloadedCivitaiModels,
  isCivitaiFileDownloaded,
  isCivitaiModelFullyDownloaded,
  isCivitaiVersionFullyDownloaded,
} from "@/lib/civitaiDownloadedStatus";

function download(modelId: number, versionId: number, filename: string): DownloadedModel {
  return {
    civitaiModelId: modelId,
    civitaiVersionId: versionId,
    modelName: `model-${modelId}`,
    versionName: `v-${versionId}`,
    type: "LORA",
    filename,
    localPath: `/models/loras/${filename}`,
    trainedWords: [],
    downloadedAt: "2026-05-05T00:00:00.000Z",
  };
}

function model(id: number): CivitaiModel {
  return {
    id,
    name: `model-${id}`,
    type: "LORA",
    modelVersions: [
      {
        id: id * 10 + 1,
        name: "SafeTensor",
        modelId: id,
        downloadUrl: "https://example.test/a",
        files: [{ name: "main.safetensors", sizeKB: 10, downloadUrl: "https://example.test/a" }],
        images: [],
      },
      {
        id: id * 10 + 2,
        name: "Pruned",
        modelId: id,
        downloadUrl: "https://example.test/b",
        files: [
          { name: "pruned.safetensors", sizeKB: 9, downloadUrl: "https://example.test/b" },
          { name: "metadata.json", sizeKB: 1, downloadUrl: "https://example.test/c" },
        ],
        images: [],
      },
    ],
  };
}

describe("Civitai downloaded status", () => {
  it("does not treat unknown/empty version metadata as fully downloaded", () => {
    expect(isCivitaiModelFullyDownloaded({ id: 1, name: "empty", type: "LORA", modelVersions: [] }, [])).toBe(false);
  });

  it("without a type, requires every version and every file variant", () => {
    const m = model(7);
    const partial = [
      download(7, 71, "main.safetensors"),
      download(7, 72, "pruned.safetensors"),
    ];
    expect(isCivitaiVersionFullyDownloaded(7, m.modelVersions![1], partial)).toBe(false);

    const complete = [...partial, download(7, 72, "metadata.json")];
    expect(isCivitaiVersionFullyDownloaded(7, m.modelVersions![1], complete)).toBe(true);
  });

  it("ignores files Adrift can't download (config, zips) once the type is known", () => {
    const m = model(7);
    const downloads = [
      download(7, 71, "main.safetensors"),
      download(7, 72, "pruned.safetensors"),
    ];
    expect(isCivitaiVersionFullyDownloaded(7, m.modelVersions![1], downloads, "LORA")).toBe(true);
    expect(isCivitaiModelFullyDownloaded(m, downloads)).toBe(true);
    expect(isCivitaiModelFullyDownloaded(m, downloads.slice(0, 1))).toBe(false);
  });

  it("reports per-file status", () => {
    const downloads = [download(7, 72, "/x/pruned.safetensors")];
    expect(isCivitaiFileDownloaded(7, 72, "pruned.safetensors", downloads)).toBe(true);
    expect(isCivitaiFileDownloaded(7, 72, "main.safetensors", downloads)).toBe(false);
    expect(isCivitaiFileDownloaded(7, 71, "pruned.safetensors", downloads)).toBe(false);
  });

  it("filters only fully downloaded models when the hide toggle is enabled", () => {
    const complete = model(1);
    const partial = model(2);
    const downloads = [
      download(1, 11, "main.safetensors"),
      download(1, 12, "pruned.safetensors"),
      download(2, 21, "main.safetensors"),
    ];

    expect(filterDownloadedCivitaiModels([complete, partial], downloads, false).map((m) => m.id)).toEqual([1, 2]);
    expect(filterDownloadedCivitaiModels([complete, partial], downloads, true).map((m) => m.id)).toEqual([2]);
  });
});

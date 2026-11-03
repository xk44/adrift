/**
 * Download Tracking Store
 * Tracks which Civitai model versions have been downloaded locally.
 */

import { STORAGE_KEYS, legacyAwareJSONStorage } from "@/lib/storageKeys";
import { createWithEqualityFn } from "zustand/traditional";
import { persist } from "zustand/middleware";
import { getStyleLoraTriggers } from "@/lib/krea2/styleLoras";

export interface DownloadedModel {
  civitaiModelId: number;
  civitaiVersionId: number;
  modelName: string;
  versionName: string;
  type: string; // "Checkpoint" | "LORA" | "ControlNet" | etc.
  filename: string;
  localPath: string;
  sha256?: string;
  trainedWords: string[];
  downloadedAt: string;
}

interface DownloadState {
  downloads: DownloadedModel[];
  // Plain object instead of Map for JSON serialization compatibility
  activeDownloads: Record<number, { progress: number; filename: string }>;
  hideDownloaded: boolean;
}

interface DownloadActions {
  addDownload: (download: DownloadedModel) => void;
  removeDownload: (civitaiVersionId: number) => void;
  isDownloaded: (civitaiVersionId: number) => boolean;
  isModelFullyDownloaded: (
    civitaiModelId: number,
    versionIds: number[],
  ) => boolean;
  getDownloadedVersionIdsForModel: (civitaiModelId: number) => Set<number>;
  setHideDownloaded: (hide: boolean) => void;
  setActiveDownload: (
    versionId: number,
    progress: number,
    filename: string,
  ) => void;
  clearActiveDownload: (versionId: number) => void;
  getTriggersForLora: (filename: string) => string[];
  seedFromExisting: (models: DownloadedModel[]) => void;
}

export const useDownloadStore = createWithEqualityFn<DownloadState & DownloadActions>()(
  persist(
    (set, get) => ({
      downloads: [],
      activeDownloads: {},
      hideDownloaded: false,

      addDownload: (download) =>
        set((state) => {
          // Don't duplicate the same file of a version (a version can
          // have several downloadable files, e.g. fp16 + fp32 or a VAE).
          const exists = state.downloads.some(
            (d) =>
              d.civitaiVersionId === download.civitaiVersionId &&
              d.filename === download.filename,
          );
          if (exists) return {};
          return { downloads: [...state.downloads, download] };
        }),

      removeDownload: (civitaiVersionId) =>
        set((state) => ({
          downloads: state.downloads.filter(
            (d) => d.civitaiVersionId !== civitaiVersionId,
          ),
        })),

      isDownloaded: (civitaiVersionId) =>
        get().downloads.some((d) => d.civitaiVersionId === civitaiVersionId),

      isModelFullyDownloaded: (civitaiModelId, versionIds) => {
        if (versionIds.length === 0) return false;
        const downloads = get().downloads;
        return versionIds.every((vId) =>
          downloads.some(
            (d) =>
              d.civitaiModelId === civitaiModelId && d.civitaiVersionId === vId,
          ),
        );
      },

      getDownloadedVersionIdsForModel: (civitaiModelId) => {
        const ids = new Set<number>();
        for (const download of get().downloads) {
          if (download.civitaiModelId === civitaiModelId) {
            ids.add(download.civitaiVersionId);
          }
        }
        return ids;
      },

      setHideDownloaded: (hide) => set({ hideDownloaded: hide }),

      setActiveDownload: (versionId, progress, filename) =>
        set((state) => ({
          activeDownloads: {
            ...state.activeDownloads,
            [versionId]: { progress, filename },
          },
        })),

      clearActiveDownload: (versionId) =>
        set((state) => {
          const next = { ...state.activeDownloads };
          delete next[versionId];
          return { activeDownloads: next };
        }),

      getTriggersForLora: (filename) => {
        const base =
          filename.split(/[\\/]/).pop()?.toLowerCase() ??
          filename.toLowerCase();
        const match = get().downloads.find(
          (d) =>
            (d.filename.split(/[\\/]/).pop()?.toLowerCase() ??
              d.filename.toLowerCase()) === base,
        );
        // Civitai-downloaded LoRAs carry their own trainedWords; fall back to
        // the fal Krea 2 style-LoRA catalog so applied style LoRAs auto-append
        // their trigger phrase even when not tracked as a Civitai download.
        if (match?.trainedWords?.length) return match.trainedWords;
        return getStyleLoraTriggers(filename);
      },

      seedFromExisting: (models) =>
        set((state) => {
          const existingIds = new Set(
            state.downloads.map((d) => d.civitaiVersionId),
          );
          const newOnes = models.filter(
            (m) => !existingIds.has(m.civitaiVersionId),
          );
          if (newOnes.length === 0) return {};
          return { downloads: [...state.downloads, ...newOnes] };
        }),
    }),
    {
      name: STORAGE_KEYS.downloads,
      storage: legacyAwareJSONStorage(),
      // Exclude activeDownloads from persistence
      partialize: (state) => ({
        downloads: state.downloads,
        hideDownloaded: state.hideDownloaded,
      }),
    },
  ),
);

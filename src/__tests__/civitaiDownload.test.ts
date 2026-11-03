/**
 * Civitai DownloadStore Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
// Route tests live in civitaiDownloadRoute.test.ts (real temp dir, no fs mocks).

// ---------------------------------------------------------------------------
// DownloadStore tests (pure Zustand store logic)
// ---------------------------------------------------------------------------

import { useDownloadStore } from "@/store/downloadStore";
import type { DownloadedModel } from "@/store/downloadStore";

function makeModel(overrides: Partial<DownloadedModel> = {}): DownloadedModel {
  return {
    civitaiModelId: 100,
    civitaiVersionId: 1,
    modelName: "TestModel",
    versionName: "v1.0",
    type: "LORA",
    filename: "testmodel.safetensors",
    localPath: "/models/loras/testmodel.safetensors",
    trainedWords: ["trigger_word", "style_keyword"],
    downloadedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("useDownloadStore", () => {
  beforeEach(() => {
    useDownloadStore.setState({
      downloads: [],
      activeDownloads: {},
      hideDownloaded: false,
    });
  });

  describe("addDownload", () => {
    it("keeps separate files of one version but not the same file twice", () => {
      const add = useDownloadStore.getState().addDownload;
      add(makeModel({ civitaiVersionId: 1, filename: "a.safetensors" }));
      add(makeModel({ civitaiVersionId: 1, filename: "vae.safetensors" }));
      add(makeModel({ civitaiVersionId: 1, filename: "a.safetensors" }));
      expect(useDownloadStore.getState().downloads.map((d) => d.filename)).toEqual([
        "a.safetensors",
        "vae.safetensors",
      ]);
    });
  });

  describe("seedFromExisting", () => {
    it("adds new models from existing list", () => {
      const models = [
        makeModel({ civitaiVersionId: 1 }),
        makeModel({ civitaiVersionId: 2 }),
      ];
      useDownloadStore.getState().seedFromExisting(models);

      expect(useDownloadStore.getState().downloads).toHaveLength(2);
    });

    it("deduplicates by versionId — existing entries not re-added", () => {
      const m1 = makeModel({ civitaiVersionId: 1 });
      useDownloadStore.getState().addDownload(m1);

      const incoming = [
        makeModel({ civitaiVersionId: 1, modelName: "ShouldNotReplace" }),
        makeModel({ civitaiVersionId: 2 }),
      ];
      useDownloadStore.getState().seedFromExisting(incoming);

      const downloads = useDownloadStore.getState().downloads;
      expect(downloads).toHaveLength(2);
      expect(downloads.find((d) => d.civitaiVersionId === 1)?.modelName).toBe(
        "TestModel",
      );
    });

    it("no-ops when all incoming models already exist", () => {
      const m1 = makeModel({ civitaiVersionId: 1 });
      useDownloadStore.getState().addDownload(m1);

      useDownloadStore
        .getState()
        .seedFromExisting([makeModel({ civitaiVersionId: 1 })]);

      expect(useDownloadStore.getState().downloads).toHaveLength(1);
    });

    it("handles empty incoming list", () => {
      useDownloadStore
        .getState()
        .addDownload(makeModel({ civitaiVersionId: 1 }));
      useDownloadStore.getState().seedFromExisting([]);

      expect(useDownloadStore.getState().downloads).toHaveLength(1);
    });
  });

  describe("getTriggersForLora", () => {
    it("returns trigger words for exact filename match", () => {
      useDownloadStore.getState().addDownload(
        makeModel({
          filename: "mymodel.safetensors",
          trainedWords: ["word1", "word2"],
        }),
      );

      const triggers = useDownloadStore
        .getState()
        .getTriggersForLora("mymodel.safetensors");
      expect(triggers).toEqual(["word1", "word2"]);
    });

    it("matches case-insensitively on basename", () => {
      useDownloadStore.getState().addDownload(
        makeModel({
          filename: "MyModel.safetensors",
          trainedWords: ["trigger"],
        }),
      );

      const triggers = useDownloadStore
        .getState()
        .getTriggersForLora("mymodel.safetensors");
      expect(triggers).toEqual(["trigger"]);
    });

    it("matches when stored with full path", () => {
      useDownloadStore.getState().addDownload(
        makeModel({
          filename: "/models/loras/MyModel.safetensors",
          trainedWords: ["abc"],
        }),
      );

      const triggers = useDownloadStore
        .getState()
        .getTriggersForLora("mymodel.safetensors");
      expect(triggers).toEqual(["abc"]);
    });

    it("matches when query includes path prefix", () => {
      useDownloadStore
        .getState()
        .addDownload(
          makeModel({ filename: "mymodel.safetensors", trainedWords: ["xyz"] }),
        );

      const triggers = useDownloadStore
        .getState()
        .getTriggersForLora("/some/path/mymodel.safetensors");
      expect(triggers).toEqual(["xyz"]);
    });

    it("returns empty array when no match", () => {
      useDownloadStore
        .getState()
        .addDownload(makeModel({ filename: "other.safetensors" }));

      const triggers = useDownloadStore
        .getState()
        .getTriggersForLora("notfound.safetensors");
      expect(triggers).toEqual([]);
    });

    it("returns empty array for model with no trained words", () => {
      useDownloadStore
        .getState()
        .addDownload(
          makeModel({ filename: "blank.safetensors", trainedWords: [] }),
        );

      const triggers = useDownloadStore
        .getState()
        .getTriggersForLora("blank.safetensors");
      expect(triggers).toEqual([]);
    });
  });

  describe("isModelFullyDownloaded", () => {
    it("returns true when all versionIds are present for model", () => {
      useDownloadStore
        .getState()
        .addDownload(makeModel({ civitaiModelId: 100, civitaiVersionId: 1 }));
      useDownloadStore
        .getState()
        .addDownload(makeModel({ civitaiModelId: 100, civitaiVersionId: 2 }));

      const result = useDownloadStore
        .getState()
        .isModelFullyDownloaded(100, [1, 2]);
      expect(result).toBe(true);
    });

    it("returns false when some versions are missing", () => {
      useDownloadStore
        .getState()
        .addDownload(makeModel({ civitaiModelId: 100, civitaiVersionId: 1 }));

      const result = useDownloadStore
        .getState()
        .isModelFullyDownloaded(100, [1, 2]);
      expect(result).toBe(false);
    });

    it("returns false when no versions downloaded", () => {
      const result = useDownloadStore
        .getState()
        .isModelFullyDownloaded(100, [1, 2]);
      expect(result).toBe(false);
    });

    it("returns false for empty versionIds list", () => {
      const result = useDownloadStore
        .getState()
        .isModelFullyDownloaded(100, []);
      expect(result).toBe(false);
    });

    it("checks modelId as well as versionId", () => {
      useDownloadStore
        .getState()
        .addDownload(makeModel({ civitaiModelId: 999, civitaiVersionId: 1 }));

      const result = useDownloadStore
        .getState()
        .isModelFullyDownloaded(100, [1]);
      expect(result).toBe(false);
    });
  });
});

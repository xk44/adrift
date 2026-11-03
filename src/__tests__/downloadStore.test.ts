/**
 * Download Store Tests
 * ====================
 * Unit tests for useDownloadStore (Zustand).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useDownloadStore } from "@/store/downloadStore";
import type { DownloadedModel } from "@/store/downloadStore";

function makeModel(
  versionId: number,
  overrides?: Partial<DownloadedModel>,
): DownloadedModel {
  return {
    civitaiModelId: 100,
    civitaiVersionId: versionId,
    modelName: "TestModel",
    versionName: `v${versionId}`,
    type: "Checkpoint",
    filename: `model_v${versionId}.safetensors`,
    localPath: `/models/checkpoints/model_v${versionId}.safetensors`,
    trainedWords: [],
    downloadedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  useDownloadStore.setState({
    downloads: [],
    activeDownloads: {},
    hideDownloaded: false,
  });
});

// ── addDownload ─────────────────────────────────────────────────────

describe("addDownload", () => {
  it("adds a model to downloads", () => {
    useDownloadStore.getState().addDownload(makeModel(1));
    expect(useDownloadStore.getState().downloads).toHaveLength(1);
  });

  it("deduplicates by versionId", () => {
    const m = makeModel(1);
    useDownloadStore.getState().addDownload(m);
    useDownloadStore.getState().addDownload(m);
    expect(useDownloadStore.getState().downloads).toHaveLength(1);
  });

  it("allows different versionIds", () => {
    useDownloadStore.getState().addDownload(makeModel(1));
    useDownloadStore.getState().addDownload(makeModel(2));
    expect(useDownloadStore.getState().downloads).toHaveLength(2);
  });
});

// ── removeDownload ──────────────────────────────────────────────────

describe("removeDownload", () => {
  it("removes by versionId", () => {
    useDownloadStore.getState().addDownload(makeModel(1));
    useDownloadStore.getState().addDownload(makeModel(2));
    useDownloadStore.getState().removeDownload(1);
    expect(useDownloadStore.getState().downloads).toHaveLength(1);
    expect(useDownloadStore.getState().downloads[0].civitaiVersionId).toBe(2);
  });

  it("no-op for non-existent versionId", () => {
    useDownloadStore.getState().addDownload(makeModel(1));
    useDownloadStore.getState().removeDownload(999);
    expect(useDownloadStore.getState().downloads).toHaveLength(1);
  });
});

// ── isDownloaded ────────────────────────────────────────────────────

describe("isDownloaded", () => {
  it("returns true for downloaded version", () => {
    useDownloadStore.getState().addDownload(makeModel(5));
    expect(useDownloadStore.getState().isDownloaded(5)).toBe(true);
  });

  it("returns false for unknown version", () => {
    expect(useDownloadStore.getState().isDownloaded(999)).toBe(false);
  });
});

// ── isModelFullyDownloaded ──────────────────────────────────────────

describe("isModelFullyDownloaded", () => {
  it("returns true when all versions downloaded", () => {
    useDownloadStore
      .getState()
      .addDownload(makeModel(1, { civitaiModelId: 10 }));
    useDownloadStore
      .getState()
      .addDownload(makeModel(2, { civitaiModelId: 10 }));
    expect(useDownloadStore.getState().isModelFullyDownloaded(10, [1, 2])).toBe(
      true,
    );
  });

  it("returns false when some versions missing", () => {
    useDownloadStore
      .getState()
      .addDownload(makeModel(1, { civitaiModelId: 10 }));
    expect(useDownloadStore.getState().isModelFullyDownloaded(10, [1, 2])).toBe(
      false,
    );
  });

  it("returns false for empty versionIds array", () => {
    expect(useDownloadStore.getState().isModelFullyDownloaded(10, [])).toBe(
      false,
    );
  });

  it("checks modelId match (not just versionId)", () => {
    useDownloadStore
      .getState()
      .addDownload(makeModel(1, { civitaiModelId: 99 }));
    expect(useDownloadStore.getState().isModelFullyDownloaded(10, [1])).toBe(
      false,
    );
  });
});

// ── getDownloadedVersionIdsForModel ─────────────────────────────────

describe("getDownloadedVersionIdsForModel", () => {
  it("returns set of version IDs for a model", () => {
    useDownloadStore
      .getState()
      .addDownload(makeModel(1, { civitaiModelId: 10 }));
    useDownloadStore
      .getState()
      .addDownload(makeModel(2, { civitaiModelId: 10 }));
    useDownloadStore
      .getState()
      .addDownload(makeModel(3, { civitaiModelId: 20 }));
    const ids = useDownloadStore.getState().getDownloadedVersionIdsForModel(10);
    expect(ids).toEqual(new Set([1, 2]));
  });

  it("returns empty set for unknown model", () => {
    const ids = useDownloadStore
      .getState()
      .getDownloadedVersionIdsForModel(999);
    expect(ids.size).toBe(0);
  });
});

// ── activeDownloads ─────────────────────────────────────────────────

describe("activeDownloads", () => {
  it("sets active download progress", () => {
    useDownloadStore.getState().setActiveDownload(1, 50, "file.safetensors");
    expect(useDownloadStore.getState().activeDownloads[1]).toEqual({
      progress: 50,
      filename: "file.safetensors",
    });
  });

  it("clears active download", () => {
    useDownloadStore.getState().setActiveDownload(1, 50, "file.safetensors");
    useDownloadStore.getState().clearActiveDownload(1);
    expect(useDownloadStore.getState().activeDownloads[1]).toBeUndefined();
  });

  it("tracks multiple concurrent downloads", () => {
    useDownloadStore.getState().setActiveDownload(1, 30, "a.st");
    useDownloadStore.getState().setActiveDownload(2, 60, "b.st");
    const active = useDownloadStore.getState().activeDownloads;
    expect(Object.keys(active)).toHaveLength(2);
  });
});

// ── getTriggersForLora ──────────────────────────────────────────────

describe("getTriggersForLora", () => {
  it("returns trained words for matching filename", () => {
    useDownloadStore.getState().addDownload(
      makeModel(1, {
        type: "LORA",
        filename: "anime_style_v2.safetensors",
        trainedWords: ["anime", "stylized"],
      }),
    );
    const triggers = useDownloadStore
      .getState()
      .getTriggersForLora("anime_style_v2.safetensors");
    expect(triggers).toEqual(["anime", "stylized"]);
  });

  it("matches case-insensitively", () => {
    useDownloadStore.getState().addDownload(
      makeModel(1, {
        filename: "MyLora.safetensors",
        trainedWords: ["trigger1"],
      }),
    );
    expect(
      useDownloadStore.getState().getTriggersForLora("mylora.safetensors"),
    ).toEqual(["trigger1"]);
  });

  it("matches basename from full path", () => {
    useDownloadStore.getState().addDownload(
      makeModel(1, {
        filename: "/models/loras/test.safetensors",
        trainedWords: ["word"],
      }),
    );
    expect(
      useDownloadStore.getState().getTriggersForLora("test.safetensors"),
    ).toEqual(["word"]);
  });

  it("returns empty array for no match", () => {
    expect(
      useDownloadStore.getState().getTriggersForLora("nonexistent.safetensors"),
    ).toEqual([]);
  });
});

// ── seedFromExisting ────────────────────────────────────────────────

describe("seedFromExisting", () => {
  it("seeds with new models", () => {
    useDownloadStore.getState().seedFromExisting([makeModel(1), makeModel(2)]);
    expect(useDownloadStore.getState().downloads).toHaveLength(2);
  });

  it("skips already-existing versionIds", () => {
    useDownloadStore.getState().addDownload(makeModel(1));
    useDownloadStore.getState().seedFromExisting([makeModel(1), makeModel(2)]);
    expect(useDownloadStore.getState().downloads).toHaveLength(2);
  });

  it("no-op when all already exist", () => {
    useDownloadStore.getState().addDownload(makeModel(1));
    useDownloadStore.getState().seedFromExisting([makeModel(1)]);
    expect(useDownloadStore.getState().downloads).toHaveLength(1);
  });

  it("handles empty seed array", () => {
    useDownloadStore.getState().seedFromExisting([]);
    expect(useDownloadStore.getState().downloads).toHaveLength(0);
  });
});

// ── hideDownloaded ──────────────────────────────────────────────────

describe("setHideDownloaded", () => {
  it("toggles hideDownloaded flag", () => {
    useDownloadStore.getState().setHideDownloaded(true);
    expect(useDownloadStore.getState().hideDownloaded).toBe(true);
    useDownloadStore.getState().setHideDownloaded(false);
    expect(useDownloadStore.getState().hideDownloaded).toBe(false);
  });
});

// PromptBar selects s.downloads; progress ticks must not hand it a new array.
describe("progress ticks keep the downloads reference", () => {
  it("setActiveDownload / clearActiveDownload leave downloads untouched", () => {
    useDownloadStore.getState().addDownload(makeModel(1, { type: "LORA" }));
    const before = useDownloadStore.getState().downloads;
    for (let p = 0; p <= 100; p += 25)
      useDownloadStore.getState().setActiveDownload(2, p, "x.safetensors");
    useDownloadStore.getState().clearActiveDownload(2);
    expect(useDownloadStore.getState().downloads).toBe(before);
  });
});

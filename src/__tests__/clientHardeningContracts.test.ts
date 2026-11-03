import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = process.cwd();
function source(path: string): string {
  return readFileSync(join(projectRoot, path), "utf8");
}

describe("client request hardening contracts", () => {
  it("guards model and moodboard store fetches with request sequencing", () => {
    const modelStore = source("src/store/modelStore.ts");
    const styleStore = source("src/store/styleStore.ts");

    expect(modelStore).toContain("fetchAvailableSequence.begin()");
    expect(modelStore).toContain("signal: request.signal");
    expect(modelStore).toContain("if (!request.isCurrent()) return");
    expect(styleStore).toContain("fetchMoodboardsSequence.begin()");
    expect(styleStore).toContain("signal: request.signal");
    expect(styleStore).toContain("if (!request.isCurrent()) return");
  });

  it("guards overlapping imagine and Civitai browser requests", () => {
    const useImagine = source("src/hooks/useImagine.ts");
    const civitai = source("src/components/models/useModelFeed.ts");

    expect(useImagine).toContain("requestSequenceRef.current.begin()");
    expect(useImagine).toContain("signal: request.signal");
    expect(useImagine).toContain("Superseded request");
    expect(civitai).toContain("requestSequenceRef.current.begin()");
    expect(civitai).toContain("signal: request.signal");
    expect(civitai).toContain("return () => sequence.cancel()");
  });
});

describe("client leak and empty-state guards", () => {
  it("revokes only the previous editor empty-state blob URL", () => {
    const editorEmptyState = source(
      "src/components/editor/EditorEmptyState.tsx",
    );

    expect(editorEmptyState).toContain("lastBlobUrlRef");
    expect(editorEmptyState).toContain("URL.createObjectURL(file)");
    expect(editorEmptyState).toContain("URL.revokeObjectURL(previousUrl)");
    expect(editorEmptyState).not.toContain("useEffect");
  });

  it("persists dropped SREF image files through the moodboard upload route", () => {
    const styleReferencePanel = source(
      "src/components/style/StyleReferencePanel.tsx",
    );

    expect(styleReferencePanel).toContain('fetch("/api/moodboards/upload"');
    expect(styleReferencePanel).toContain('formData.append("file", file)');
    expect(styleReferencePanel).toContain(
      'addSREFItem({ value: url, type: "url", weight: 1.0 })',
    );
    expect(styleReferencePanel).not.toContain("URL.createObjectURL(file)");
  });

  it("revokes ImageSelector blob URLs on removal, clear, and unmount", () => {
    const imageSelector = source("src/components/ImageSelector.tsx");

    expect(imageSelector).toContain("URL.revokeObjectURL(attachment.url)");
    expect(imageSelector).toContain("handleRemoveAttachment");
    expect(imageSelector).toContain("handleClearAttachments");
    expect(imageSelector).toContain("latestAttachmentsRef.current.forEach");
  });

  it("validates layer reorder indexes and avoids empty progress division", () => {
    const editorStore = source("src/store/editorStore.ts");
    const gallery = source("src/components/Gallery.tsx");

    expect(editorStore).toContain("fromIndex >= state.layers.length");
    expect(editorStore).toContain("toIndex >= state.layers.length");
    expect(editorStore).toContain("if (!removed) return state");
    expect(gallery).toContain("run.jobs.length > 0");
    expect(gallery).toContain(": 0");
  });
});

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EnhanceOptions } from "@/components/editor/EnhanceOptions";

const storeMock = vi.hoisted(() => ({
  editor: {
    sourceImage: "/image.png",
    sourceImageId: "gallery-image-1",
    isProcessing: false,
    setProcessing: vi.fn(),
  },
  generation: {
    clientId: "client-1",
    gallery: [
      {
        id: "gallery-image-1",
        runId: "run-1",
        jobIndex: 0,
      },
    ],
    addRun: vi.fn(),
    setError: vi.fn(),
  },
}));

vi.mock("@/store/editorStore", () => ({
  useEditorStore: (selector: (state: typeof storeMock.editor) => unknown) =>
    selector(storeMock.editor),
}));

vi.mock("@/store", () => ({
  useGenerationStore: (
    selector: (state: typeof storeMock.generation) => unknown,
  ) => selector(storeMock.generation),
}));

vi.mock("@/components/Toast", () => ({
  showToast: vi.fn(),
}));

type TestEnhanceMode =
  | "detail"
  | "upscale_detail"
  | "adetailer"
  | "adetailer_auto";

function renderEnhanceOptions(initialMode?: TestEnhanceMode) {
  return renderToStaticMarkup(<EnhanceOptions initialMode={initialMode} />);
}

describe("EnhanceOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all mode options", () => {
    const html = renderEnhanceOptions();

    expect(html).toContain('value="detail"');
    expect(html).toContain(">Detail</option>");
    expect(html).toContain('value="upscale_detail"');
    expect(html).toContain(">Upscale + Detail</option>");
    expect(html).toContain('value="adetailer"');
    expect(html).toContain(">ADetailer</option>");
    expect(html).toContain('value="adetailer_auto"');
    expect(html).toContain(">Auto Refine</option>");
  });

  it("renders manual controls only for ADetailer mode", () => {
    for (const mode of ["detail", "upscale_detail", "adetailer_auto"] as const) {
      const html = renderEnhanceOptions(mode);
      expect(html).not.toContain("Face denoise");
      expect(html).not.toContain("Hand denoise");
      expect(html).not.toContain("BBox threshold");
      expect(html).not.toContain("Crop factor");
      expect(html).not.toContain("Feather");
    }

    const adetailerHtml = renderEnhanceOptions("adetailer");
    expect(adetailerHtml).toContain("Face denoise");
    expect(adetailerHtml).toContain("Hand denoise");
    expect(adetailerHtml).toContain("BBox threshold");
    expect(adetailerHtml).toContain("Crop factor");
    expect(adetailerHtml).toContain("Feather");
  });
});

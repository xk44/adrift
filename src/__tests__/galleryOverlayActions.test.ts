import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = process.cwd();
const source = (path: string) => readFileSync(join(projectRoot, path), "utf8");

describe("gallery per-image hover overlay actions", () => {
  it("routes the per-image Use button through the Create image-prompt attachment flow", () => {
    const gallery = source("src/components/Gallery.tsx");

    expect(gallery).toContain("useImageAsAttachment");
    expect(gallery).toContain('new CustomEvent("use-start-frame"');
    expect(gallery).toContain('mode: "image_prompt"');
    expect(gallery).toContain('title="Use image"');
    // Row-level "Use" loads the prompt text + settings into the prompt bar.
    expect(gallery).toContain(
      'title="Load this prompt and its settings into the prompt bar"',
    );
  });

  it("preserves existing per-image hover actions while adding Use Image", () => {
    const gallery = source("src/components/Gallery.tsx");

    expect(gallery).toContain('handleAction("vary_subtle", img)');
    expect(gallery).toContain('handleAction("upscale_subtle", img)');
    expect(gallery).toContain('handleRemix(img, "subtle")');
    expect(gallery).toContain('title="Copy prompt"');
    expect(gallery).toContain('title="Download"');
    expect(gallery).toContain('title="Open in Lightbox"');
  });

  it("binds generation actions to the active tile instead of images[0]", () => {
    const gallery = source("src/components/Gallery.tsx");

    expect(gallery).toContain(
      "async (action: string, source: GalleryImage) =>",
    );
    expect(gallery).not.toContain("const source = images[0]");
    expect(gallery).toContain(
      "const activeImage = images[activeImageIndex] ?? images[0]",
    );
    // Row More menu runs each generation action on the active tile.
    for (const action of [
      "vary_subtle",
      "vary_strong",
      "upscale_subtle",
      "upscale_creative",
    ]) {
      expect(gallery).toContain(`{ action: "${action}",`);
    }
    expect(gallery).toContain("void handleAction(action, activeImage)");
    expect(gallery).toMatch(
      /onMouseEnter=\{\(\) => \{\s*setActiveImageIndex\(i\);/,
    );
    expect(gallery).toContain("onFocus={() => setActiveImageIndex(i)}");
    expect(gallery).toContain("setActiveImageIndex(i);");
  });

  it("shows the per-image action bar after a touch tile selection", () => {
    const gallery = source("src/components/Gallery.tsx");

    expect(gallery).toContain("const [touchActionIndex, setTouchActionIndex]");
    expect(gallery).toContain("setTouchActionIndex(i);");
    expect(gallery).toContain("touchActionIndex === i");
    expect(gallery).toContain("onTouchStart={(e) => e.stopPropagation()}");
  });

  it("keeps row-level prompt Use separate from per-image Use Image", () => {
    const gallery = source("src/components/Gallery.tsx");

    expect(gallery).toContain("const handleUse = useCallback(() =>");
    expect(gallery).toContain("setPromptValue(fullPrompt)");
    expect(gallery).toContain("handleUse");
  });

  it("queues row-level Rerun through imagine instead of filling the prompt bar", () => {
    const gallery = source("src/components/Gallery.tsx");

    expect(gallery).toContain("const handleRerun = useCallback(async () =>");
    expect(gallery).toContain('fetch("/api/jobs/imagine"');
    expect(gallery).toContain("client_id: clientId");
    expect(gallery).toContain("batch_size: 1");
    expect(gallery).toContain('resolveActionWorkflow("promptbar.imagine")');
    expect(gallery).toContain("workflow_control_overrides");
    expect(gallery).toContain("for (const run of data.runs ?? []) addRun(run)");
    expect(gallery).not.toContain("setPromptValue(promptWithoutSeed)");
  });
});

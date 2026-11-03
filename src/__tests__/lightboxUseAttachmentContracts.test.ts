import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = process.cwd();
const source = (path: string) => readFileSync(join(projectRoot, path), "utf8");

describe("lightbox use attachment contracts", () => {
  it("groups every generation action into the Creator actions submenus", () => {
    const lightbox = source("src/components/Lightbox.tsx");
    const actions = source("src/components/LightboxActions.tsx");
    const catalog = source("src/lib/ui/creatorActions.ts");

    // Catalog lives in creatorActions.ts; LightboxActions renders it and
    // Lightbox dispatches each run.
    expect(lightbox).toContain("<LightboxActions");
    expect(actions).toContain('aria-label="Creator actions"');
    for (const label of [
      "Vary",
      "Edit",
      "Upscale & enhance",
      "Animate",
      "3D & layers",
      "Use & recipe",
    ]) {
      expect(catalog).toContain(`label: "${label}"`);
    }
    for (const run of [
      'action("vary_subtle")',
      'action("vary_strong")',
      'action("upscale_subtle")',
      'action("upscale_creative")',
      'action("adetailer")',
      'action("animate_low")',
      'action("animate_high")',
      'action("animate_low", { loop: 0 })',
      'action("animate_high", { loop: 0 })',
      '{ kind: "rerun" }',
      '{ kind: "rerun_tweak" }',
      '{ kind: "edit" }',
      '{ kind: "use", mode: "image_prompt" }',
      '{ kind: "use", mode: "style_ref" }',
      '{ kind: "use_prompt" }',
      '{ kind: "reproduce" }',
    ]) {
      expect(catalog).toContain(run);
    }
    expect(catalog).toContain('name: "Rerun with parameters"');
    expect(lightbox).toContain("onRun={runInlineTool}");
    expect(lightbox).toContain("onOpenTool={openInTools}");
    expect(lightbox).toContain("void handleAction(run.action, run.params)");
    expect(lightbox).toContain("void handleRerun();");
    expect(lightbox).toContain("setShowRerunSheet((v) => !v)");
    expect(lightbox).toContain("handleRemix(run.variant)");
    expect(lightbox).toContain("handleUseWithSeed();");
    // Remix / Zoom / Pan stay in the Tools panel, not the creator groups.
    for (const row of ["Remix", "Zoom", "Pan"]) {
      expect(catalog).not.toContain(`label: "${row}"`);
    }
    // Generation actions are gated off for external (Civitai) images
    expect(lightbox).toContain("external={isExternal}");
    expect(actions).toContain("creatorActionLayout(prefs, ctx)");
  });

  it("folds refiners, reframing, remix and 3D into All tools; Insights after", () => {
    const lightbox = source("src/components/Lightbox.tsx");
    const actions = source("src/components/LightboxActions.tsx");
    const tools = source("src/lib/ui/lightboxTools.ts");

    const creation = lightbox.indexOf("<LightboxActions");
    const toolsPanel = lightbox.indexOf("<LightboxToolsPanel", creation);
    const insights = lightbox.indexOf('ActionSection title="Insights"');
    expect(creation).toBeGreaterThan(-1);
    expect(toolsPanel).toBeGreaterThan(creation);
    expect(insights).toBeGreaterThan(toolsPanel);
    expect(actions).toContain('aria-label="All tools"');
    expect(actions).toContain("props.renderToolsPanel(hiddenTools)");
    expect(lightbox).not.toContain('ActionSection title="More"');
    // Every action the old rows fired is an inline Tools entry now.
    for (const action of [
      "pan_up",
      "pan_down",
      "pan_left",
      "pan_right",
      "zoom_out_1_5x",
      "zoom_out_2x",
      "detail",
      "upscale_detail",
      "adetailer",
      "adetailer_auto",
      "realism_lite",
      "realism_pro",
    ]) {
      expect(tools).toContain(`"${action}"`);
    }
    expect(lightbox.slice(insights)).toContain(
      "<StyleInsights image={currentImage} />",
    );
    // One button component → one size everywhere (40px on phones)
    for (const src of [lightbox, actions]) {
      expect(src).not.toContain("PillButton");
      expect(src).not.toContain("ActionGroup");
    }
    expect(actions).toContain("flex h-10 w-full min-w-0 items-center");
    expect(actions).toContain("md:h-8");
  });

  it("composes Remix into the prompt bar instead of opening the old modal", () => {
    const lightbox = source("src/components/Lightbox.tsx");

    expect(lightbox).toContain("buildRemixComposition(currentImage, variant)");
    expect(lightbox).toContain("addImageAttachment(attachment)");
    expect(lightbox).toContain("closeLightbox()");
    expect(lightbox).not.toContain("showRemix");
    expect(lightbox).not.toContain("remixPrompt");
    expect(lightbox).not.toContain('aria-label="Remix prompt"');
    expect(lightbox).not.toContain('handleAction("remix_subtle"');
    expect(lightbox).not.toContain('handleAction("remix_strong"');
  });

  it("wires Lightbox Edit through the editor store openEditor entry point", () => {
    const lightbox = source("src/components/Lightbox.tsx");

    expect(lightbox).toContain("useEditorStore");
    expect(lightbox).toContain("const openEditor = useEditorStore");
    expect(lightbox).toContain("openEditor(currentImage.url, currentImage.id)");
    expect(lightbox).toMatch(/case "edit":\s*handleEdit\(\);/);
  });

  it("wires Lightbox Rerun to the imagine job endpoint with current prompt params", () => {
    const lightbox = source("src/components/Lightbox.tsx");

    expect(lightbox).toContain("const getRerunPrompt");
    expect(lightbox).toContain("--seed\\s+\\d+");
    expect(lightbox).toContain('fetch("/api/jobs/imagine"');
    expect(lightbox).toContain("prompt,");
    expect(lightbox).toContain("client_id: clientId");
    expect(lightbox).toContain("batch_size: 1");
    expect(lightbox).toContain('resolveActionWorkflow("promptbar.imagine")');
    expect(lightbox).toContain("workflow_control_overrides");
    expect(lightbox).toContain(
      "for (const run of data.runs ?? []) addRun(run)",
    );
    expect(lightbox).toMatch(/case "rerun":\s*void handleRerun\(\);/);
  });

  it("supports mobile lightbox swipe navigation and close gestures", () => {
    const lightbox = source("src/components/Lightbox.tsx");

    expect(lightbox).toContain("TOUCH_SWIPE_THRESHOLD_PX = 48");
    expect(lightbox).toContain("TOUCH_CLOSE_THRESHOLD_PX = 64");
    expect(lightbox).toContain("touchStartRef");
    expect(lightbox).toContain("onTouchStart={handleTouchStart}");
    expect(lightbox).toContain("onTouchEnd={handleTouchEnd}");
    expect(lightbox).toContain("dy > TOUCH_CLOSE_THRESHOLD_PX");
    expect(lightbox).toContain("closeLightbox()");
    expect(lightbox).toContain("if (dx < 0)");
    expect(lightbox).toContain("handleNext()");
    expect(lightbox).toContain("handlePrev()");
  });

  it("keeps the Use row (Image / Style / Prompt) mapped to distinct attachment modes", () => {
    const lightbox = source("src/components/Lightbox.tsx");
    const actions = source("src/components/LightboxActions.tsx");

    const catalog = source("src/lib/ui/creatorActions.ts");
    expect(catalog).toContain('{ kind: "use", mode: "image_prompt" }');
    expect(catalog).toContain('{ kind: "use", mode: "style_ref" }');
    expect(catalog).toContain('{ kind: "use_prompt" }');
    expect(lightbox).toMatch(
      /case "use":\s*useImageAsAttachment\(run\.mode\);/,
    );
    expect(lightbox).toMatch(/case "use_prompt":\s*handlePromptClick\(\);/);
    expect(lightbox).toContain("setPromptValue(getFullPrompt())");
  });

  it("renders the source/similar strip when source images exist", () => {
    const lightbox = source("src/components/Lightbox.tsx");
    const types = source("src/types/index.ts");
    const imagine = source("src/hooks/useImagine.ts");

    expect(types).toContain("sourceImages?: ImageAttachment[]");
    expect(imagine).toContain("sourceImages: run.sourceImages");
    expect(lightbox).toContain("currentImage.sourceImages &&");
    expect(lightbox).toContain("currentImage.sourceImages.length > 0");
    expect(lightbox).toContain("Source / Similar");
    expect(lightbox).toContain("currentImage.sourceImages.map");
    expect(lightbox).toContain('src.mode === "style_ref"');
    expect(lightbox).toContain('? "Style"');
    expect(lightbox).toContain('src.mode === "image_prompt"');
    expect(lightbox).toContain('"IP"');
    expect(lightbox).toContain('src.mode === "starting_frame"');
    expect(lightbox).toContain('"SF"');
    expect(lightbox).toContain(
      "Source images: {currentImage.sourceImages.length}",
    );
  });

  it("preserves Start Frame as an animation starting-frame attachment", () => {
    const lightbox = source("src/components/Lightbox.tsx");

    expect(lightbox).toContain('useImageAsAttachment("starting_frame")');
    // The Start frame button lives in the Tools panel's Reuse entry.
    expect(source("src/lib/ui/lightboxTools.ts")).toContain(
      'label: "Start frame"',
    );
  });

  it("page-level handoff accepts image/style/start-frame modes and focuses Create", () => {
    const page = source("src/app/page.tsx");

    expect(page).toContain(
      'mode?: "starting_frame" | "image_prompt" | "style_ref"',
    );
    expect(page).toContain('const mode = detail.mode ?? "starting_frame"');
    expect(page).toContain("mode,");
    expect(page).toContain('setActiveNav("create")');
    // Formatter may split this across lines; check the key parts individually
    expect(page).toContain(
      'querySelector<HTMLTextAreaElement>("#desktop_input_bar")',
    );
    expect(page).toContain("?.focus()");
    expect(page).toContain("document");
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = process.cwd();
function source(path: string): string {
  return readFileSync(join(projectRoot, path), "utf8");
}

describe("batch size and seed chip contracts", () => {
  it("defaults batch size to 1 and sends the user setting instead of a hard-coded four", () => {
    const store = source("src/store/index.ts");
    const hook = source("src/hooks/useImagine.ts");
    const route = source("src/app/api/jobs/imagine/route.ts");

    expect(store).toContain("batchSize: 1");
    expect(hook).toContain("batch_size: settings.batchSize ?? 1");
    expect(hook).not.toContain("batch_size: 4");
    expect(route).toContain("validateBatchSize(rawBatchSize ?? 1)");
  });

  it("exposes a settings-panel batch selector with safe GPU copy", () => {
    const panel = source("src/components/SettingsPanel.tsx");
    expect(panel).toContain("Batch Size");
    expect(panel).toMatch(
      /value:\s*1[\s\S]*value:\s*2[\s\S]*value:\s*4[\s\S]*value:\s*8/,
    );
    expect(panel).toContain("Default 1 protects smaller GPUs");
  });

  it("shows functional seed chips in Create and Organize surfaces", () => {
    const gallery = source("src/components/Gallery.tsx");
    const organize = source("src/components/OrganizePage.tsx");

    // Create collapses a run's seeds into ONE chip (seed 1000…1003) whose
    // click inserts the hovered image's seed via the shared param handler.
    expect(gallery).toContain("images.map((img) => img.seed)");
    expect(gallery).toContain("String(activeImage?.seed ?? chip.value)");
    expect(gallery).toContain("handleParamClick(insert)");
    expect(gallery).not.toContain("--seed {img.seed}");
    expect(organize).toContain("handleUseParam(img, param, e)");
    expect(organize).toContain(
      "replacePromptParamText(img.fullPrompt || img.prompt, param)",
    );
    expect(organize).toContain('setActiveNav("create")');
  });
});

describe("useImagine history polling contract", () => {
  it("does not start fallback history polling while the websocket is connected", () => {
    const hook = source("src/hooks/useImagine.ts");
    const loopIdx = hook.indexOf("for (const run of runs)");
    const guardIdx = hook.indexOf(
      "if (!wsConnected && job.prompt_id)",
      loopIdx,
    );
    const pollIdx = hook.indexOf(
      "void pollHistoryForPrompt(job.prompt_id)",
      loopIdx,
    );

    expect(hook).toContain("const wsConnected = useGenerationStore");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(pollIdx).toBeGreaterThan(guardIdx);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ModelOverrideList,
  initialOverridePicks,
  matchLabel,
  overridesFromPicks,
  quantLabel,
} from "@/components/tools/userTools/ModelOverridePicker";
import {
  Checks,
  flagBlockedPacks,
} from "@/components/tools/userTools/ImportWorkflowDialog";
import { blocklistSlugs, matchBlockedPackId } from "@/lib/comfy/nodeBlocklist";
import { saveUserToolApi } from "@/lib/userTools/client";
import type { MissingModelReport, UserToolAnalysis } from "@/lib/userTools/types";
import { BRAND_LEAK } from "./brandLeak";

const flux: MissingModelReport = {
  nodeId: "1",
  classType: "UnetLoaderGGUF",
  input: "unet_name",
  file: "flux1-dev-Q8_0.gguf",
  searchUrl: "https://civitai.com/search/models?query=flux1-dev-Q8_0",
  candidates: [
    { value: "flux1-dev-Q6_K.gguf", match: "same_model", score: 0.9, quant: "gguf_q6_k", verdict: "unknown" },
    { value: "flux1-schnell-Q8_0.gguf", match: "same_family", score: 0.5, quant: "gguf_q8_0", verdict: "unknown" },
    { value: "flux1-dev-fp8.safetensors", match: "same_model", score: 0.9, quant: "fp8_e4m3fn", verdict: "unsupported", reason: "fp8 isn't supported on Apple GPUs" },
    { value: "sdxl.safetensors", match: "other", score: 0 },
  ],
  suggested: "flux1-dev-Q6_K.gguf",
  optionCount: 4,
};
const lora: MissingModelReport = {
  nodeId: "3",
  classType: "LoraLoader",
  input: "lora_name",
  file: "ink.safetensors",
  searchUrl: "https://civitai.com/search/models?query=ink",
  candidates: [],
  suggested: null,
};

const render = (picks: Record<string, string>) =>
  renderToStaticMarkup(
    createElement(ModelOverrideList, { missing: [flux, lora], picks, onPick: () => {} }),
  );

describe("ModelOverridePicker", () => {
  it("pre-selects confident suggestions and builds the save list", () => {
    const picks = initialOverridePicks([flux, lora]);
    expect(picks).toEqual({ "1.unet_name": "flux1-dev-Q6_K.gguf" });
    expect(overridesFromPicks([flux, lora], { ...picks, "3.lora_name": "" })).toEqual([
      { nodeId: "1", input: "unet_name", value: "flux1-dev-Q6_K.gguf" },
    ]);
  });

  it("renders grouped options, chips, keep-as-is and Civitai links", () => {
    const html = render({ "1.unet_name": "flux1-dev-Q6_K.gguf" });
    expect(html).toContain("Keep as is (missing)");
    expect(html).toContain('label="Best match"');
    expect(html).toContain('label="Same family"');
    expect(html).toContain('label="Other installed files"');
    expect(html).toContain("flux1-dev-Q6_K.gguf (suggested)");
    expect(html).toContain("(won&#x27;t run here)");
    expect(html).toContain("Same model · GGUF Q6_K");
    expect(html).toContain("1 of 2 swapped");
    // Unresolved LoRA with nothing installed: warning + search link.
    expect(html).toContain("Nothing installed for this slot yet.");
    expect(html).toContain("Still missing.");
    expect(html).toContain("https://civitai.com/search/models?query=ink");
    expect(html).not.toMatch(BRAND_LEAK);
  });

  it("shows the verdict chip and a look warning for a weaker match", () => {
    const html = render({ "1.unet_name": "flux1-dev-fp8.safetensors" });
    expect(html).toContain("Won&#x27;t run here");
    const fam = render({ "1.unet_name": "flux1-schnell-Q8_0.gguf" });
    expect(fam).toContain("A different model can change the look.");
  });

  it("formats quant and match labels", () => {
    expect(quantLabel("gguf_q4_k_m")).toBe("GGUF Q4_K_M");
    expect(quantLabel("fp8_scaled")).toBe("fp8");
    expect(quantLabel("bf16")).toBe("bf16");
    expect(quantLabel(undefined)).toBeNull();
    expect(matchLabel({ value: "a", match: "same_file", score: 1 })).toBe("Same file");
  });

  it("Checks turns green when every missing model has a stand-in", () => {
    const analysis = {
      checked: true,
      missingNodes: [],
      missingModels: [flux],
    } as unknown as UserToolAnalysis;
    const ok = renderToStaticMarkup(
      createElement(Checks, { analysis, picks: { "1.unet_name": "flux1-dev-Q6_K.gguf" } }),
    );
    expect(ok).toContain("Every missing model has a stand-in");
    const warn = renderToStaticMarkup(createElement(Checks, { analysis, picks: {} }));
    expect(warn).toContain("Some pieces are missing");
  });

  it("flags suggested node packs that are on the blocklist (F9)", () => {
    // Pull a real entry from the bundled list rather than hard-coding a slug.
    const blockedUrl = `https://github.com/${blocklistSlugs()[0]}`;
    const safeUrl = "https://github.com/example/comfyui-safe-pack";
    const flagged = flagBlockedPacks([
      { id: blockedUrl, label: "Flagged Pack" },
      { id: safeUrl, label: "Safe Pack" },
    ]);
    expect(flagged[0].blocked).toEqual(matchBlockedPackId(blockedUrl)!.rules);
    expect(flagged[1].blocked).toBeNull();
    const analysis = {
      checked: true,
      missingNodes: [
        {
          classType: "SomeMissingNode",
          packs: [
            { id: blockedUrl, label: "Flagged Pack" },
            { id: safeUrl, label: "Safe Pack" },
          ],
        },
      ],
      missingModels: [],
    } as unknown as UserToolAnalysis;
    const html = renderToStaticMarkup(createElement(Checks, { analysis }));
    expect(html).toContain('data-testid="blocked-pack"');
    expect(html).toContain("Manager will refuse to install it");
    expect(html).toContain("Safe Pack");
  });

  it("saveUserToolApi sends modelOverrides only when there are picks", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, tool: { id: "t" } }),
    }));
    const analysis = {
      workflowType: "t2i",
      output: "image",
      workflow: {},
      source: { type: "file" },
    } as unknown as UserToolAnalysis;
    const base = { name: "n", icon: "Wrench", category: "Image", analysis, params: [] };
    await saveUserToolApi(fetchImpl as never, {
      ...base,
      modelOverrides: [{ nodeId: "1", input: "unet_name", value: "a.gguf" }],
    });
    await saveUserToolApi(fetchImpl as never, { ...base, modelOverrides: [] });
    const calls = fetchImpl.mock.calls as unknown as Array<[string, { body: string }]>;
    const bodies = calls.map((c) => JSON.parse(c[1].body));
    expect(bodies[0].modelOverrides).toEqual([
      { nodeId: "1", input: "unet_name", value: "a.gguf" },
    ]);
    expect("modelOverrides" in bodies[1]).toBe(false);
  });
});

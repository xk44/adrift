/**
 * Explore compat UI (static render, no DOM library): per-card chip, best-quant
 * badge, GPU-aware file pre-selection, the "Fits my GPU" toggle and filter.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CivitaiModel, CivitaiModelVersion } from "@/lib/civitai";
import { mapHfModel } from "@/lib/hfModels";
import {
  profileFromSystemStats,
  type BackendProfile,
} from "@/lib/models/compat";
import { DEFAULT_MODEL_FILTERS } from "@/lib/modelFilters";
import { useFitsFilterStore } from "@/store/fitsFilterStore";
import { ModelCard } from "@/components/civitai/ModelCard";
import { HfModelCard } from "@/components/models/HfModelCard";
import { FitsMyGpuToggle } from "@/components/models/FitsMyGpuToggle";
import { ModelFeedResults } from "@/components/models/ModelFeedResults";
import type { ModelFeed } from "@/components/models/useModelFeed";

const hook = vi.hoisted(() => ({
  value: { profile: null as unknown, status: "loading" as string },
}));
vi.mock("@/components/models/useBackendProfile", () => ({
  useBackendProfile: () => hook.value,
}));
// Static render reads zustand's server snapshot; read live state instead.
vi.mock("@/store/fitsFilterStore", async (orig) => {
  const mod = await orig<typeof import("@/store/fitsFilterStore")>();
  const live = ((sel: (s: unknown) => unknown) =>
    sel(
      mod.useFitsFilterStore.getState(),
    )) as unknown as typeof mod.useFitsFilterStore;
  Object.assign(live, mod.useFitsFilterStore);
  return { useFitsFilterStore: live };
});

const GiB = 1024 ** 3;
const P3060: BackendProfile = profileFromSystemStats({
  system: { os: "linux", ram_total: 64 * GiB },
  devices: [
    {
      name: "cuda:0 NVIDIA GeForce RTX 3060 : cudaMallocAsync",
      type: "cuda",
      vram_total: 12 * GiB,
    },
  ],
})!;

type File = CivitaiModelVersion["files"][number];
const f = (name: string, gib: number, primary = false): File => ({
  name,
  sizeKB: gib * 1024 * 1024,
  downloadUrl: "https://civitai.com/api/download/models/1",
  type: "Model",
  primary,
  metadata: { format: "GGUF", fp: "fp16" },
});
const ggufModel = (id: number, files: File[]): CivitaiModel => ({
  id,
  name: `Model ${id}`,
  type: "Checkpoint",
  modelVersions: [
    {
      id: id * 10,
      name: "v1",
      modelId: id,
      downloadUrl: "",
      baseModel: "Flux.1 D",
      files,
      images: [],
    },
  ],
});
const QUANTS = ggufModel(1, [
  f("flux1-dev-Q4_K_S.gguf", 6.8),
  f("flux1-dev-Q8_0.gguf", 12.7, true),
  f("flux1-dev-F16.gguf", 23.8),
]);
const HUGE = ggufModel(2, [f("flux1-dev-F16.gguf", 23.8, true)]);

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(el);

afterEach(() => {
  hook.value = { profile: null, status: "loading" };
  useFitsFilterStore.getState().setFitsOnly(false);
});

describe("Civitai ModelCard compat", () => {
  it("chip, best-quant badge, per-file verdicts and GPU pre-selection", () => {
    const html = render(
      createElement(ModelCard, {
        model: QUANTS,
        source: "com" as const,
        nsfw: false,
        downloads: [],
        variant: "explore",
        profile: P3060,
      }),
    );
    expect(html).toContain('data-testid="compat-chip"');
    expect(html).toContain(">Fits<");
    expect(html).toContain("Best: Q4_K_S");
    // The picker pre-selects the best file for this GPU, not Civitai's primary Q8.
    expect(html).toMatch(
      /<option value="flux1-dev-Q4_K_S.gguf" selected="">[^<]*best for your GPU/,
    );
    expect(html).toMatch(/flux1-dev-F16.gguf[^<]*· too big/);
    expect(html).toContain('data-testid="file-compat-reason"');
  });

  it("without a profile: no chip, no badge, primary file selected", () => {
    const html = render(
      createElement(ModelCard, {
        model: QUANTS,
        source: "com" as const,
        nsfw: false,
        downloads: [],
        variant: "explore",
      }),
    );
    expect(html).not.toContain("compat-chip");
    expect(html).not.toContain("best-quant");
    expect(html).toMatch(/<option value="flux1-dev-Q8_0.gguf" selected="">/);
  });

  it("browser variant shows 'Too big for 12 GB' on the collapsed card", () => {
    const html = render(
      createElement(ModelCard, {
        model: HUGE,
        source: "com" as const,
        nsfw: false,
        downloads: [],
        variant: "browser",
        profile: P3060,
      }),
    );
    expect(html).toContain("Too big for 12 GB");
  });
});

describe("HfModelCard compat", () => {
  it("names-only GGUF repo: quant count badge + 'Size unknown' chip", () => {
    const m = mapHfModel({
      id: "city96/FLUX.1-dev-gguf",
      pipeline_tag: "text-to-image",
      siblings: [
        { rfilename: "flux1-dev-Q4_K_S.gguf" },
        { rfilename: "flux1-dev-Q8_0.gguf" },
      ],
    })!;
    const html = render(
      createElement(HfModelCard, { model: m, profile: P3060 }),
    );
    expect(html).toContain("2 quants");
    expect(html).toContain("Size unknown");
  });
});

describe("Fits my GPU toggle", () => {
  it("disabled with a tooltip while the GPU is unknown", () => {
    hook.value = { profile: null, status: "offline" };
    const html = render(createElement(FitsMyGpuToggle));
    expect(html).toContain("disabled=\"\"");
    expect(html).toContain("Connect to ComfyUI");
    expect(html).toContain('aria-pressed="false"');
  });

  it("enabled and pressed when on with a known GPU", () => {
    hook.value = { profile: P3060, status: "ready" };
    useFitsFilterStore.getState().setFitsOnly(true);
    const html = render(createElement(FitsMyGpuToggle));
    expect(html).not.toContain("disabled=\"\"");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("RTX 3060 (12 GB)");
  });
});

describe("ModelFeedResults filter", () => {
  const feed: ModelFeed = {
    civitai: [QUANTS, HUGE],
    hf: [],
    loading: false,
    error: null,
    hasMore: false,
    count: 2,
    loadMore: () => {},
    reload: () => {},
  };
  const props = {
    feed,
    filters: DEFAULT_MODEL_FILTERS,
    downloads: [],
    hideDownloaded: false,
    variant: "browser" as const,
  };

  it("off by default: every card shows", () => {
    hook.value = { profile: P3060, status: "ready" };
    const html = render(createElement(ModelFeedResults, props));
    expect(html).toContain("Model 1");
    expect(html).toContain("Model 2");
  });

  it("on: hides cards whose best file is too big", () => {
    hook.value = { profile: P3060, status: "ready" };
    useFitsFilterStore.getState().setFitsOnly(true);
    const html = render(createElement(ModelFeedResults, props));
    expect(html).toContain("Model 1");
    expect(html).not.toContain("Model 2");
  });

  it("on but GPU unknown: filter is not applied", () => {
    hook.value = { profile: null, status: "offline" };
    useFitsFilterStore.getState().setFitsOnly(true);
    const html = render(createElement(ModelFeedResults, props));
    expect(html).toContain("Model 2");
  });

  it("everything hidden: says why and how to undo it", () => {
    hook.value = { profile: P3060, status: "ready" };
    useFitsFilterStore.getState().setFitsOnly(true);
    const html = render(
      createElement(ModelFeedResults, {
        ...props,
        feed: { ...feed, civitai: [HUGE], count: 1 },
      }),
    );
    expect(html).toContain("fit your GPU");
    expect(html).toContain("Fits my GPU");
  });

  it("everything hidden with more pages: manual Load more, not auto-paging", () => {
    hook.value = { profile: P3060, status: "ready" };
    useFitsFilterStore.getState().setFitsOnly(true);
    const html = render(
      createElement(ModelFeedResults, {
        ...props,
        feed: { ...feed, civitai: [HUGE], count: 1, hasMore: true },
      }),
    );
    expect(html).toContain("Load more");
  });

  it("HF with Fits my GPU on: says it can't check unsized repos", () => {
    hook.value = { profile: P3060, status: "ready" };
    useFitsFilterStore.getState().setFitsOnly(true);
    const hfModel = mapHfModel({
      id: "city96/FLUX.1-dev-gguf",
      pipeline_tag: "text-to-image",
      siblings: [{ rfilename: "flux1-dev-Q4_K_S.gguf" }],
    })!;
    const html = render(
      createElement(ModelFeedResults, {
        ...props,
        filters: { ...DEFAULT_MODEL_FILTERS, source: "hf" as const },
        feed: { ...feed, civitai: [], hf: [hfModel], count: 1 },
      }),
    );
    expect(html).toContain("fits-unsized-hint");
    expect(html).toContain("1 repo");
  });

  it("first-page Civitai auth error: plain copy, Settings link, Retry", () => {
    hook.value = { profile: P3060, status: "ready" };
    const html = render(
      createElement(ModelFeedResults, {
        ...props,
        feed: {
          ...feed,
          civitai: [],
          count: 0,
          error: "Civitai API error 401: Unauthorized",
        },
      }),
    );
    expect(html).toContain('data-testid="feed-error"');
    expect(html).toContain("Add a Civitai API key in Settings");
    expect(html).toContain('data-testid="feed-error-settings"');
    expect(html).toContain("Retry");
    expect(html).not.toContain("API error 401");
  });

  it("Hugging Face errors never point at the Civitai key", () => {
    hook.value = { profile: P3060, status: "ready" };
    const html = render(
      createElement(ModelFeedResults, {
        ...props,
        filters: { ...DEFAULT_MODEL_FILTERS, source: "hf" as const },
        feed: {
          ...feed,
          civitai: [],
          count: 0,
          error: "Hugging Face request failed (503)",
        },
      }),
    );
    expect(html).toContain("Couldn&#x27;t reach Hugging Face");
    expect(html).not.toContain("feed-error-settings");
  });

  it("load-more error keeps the grid and shows the compact retry", () => {
    hook.value = { profile: P3060, status: "ready" };
    const html = render(
      createElement(ModelFeedResults, {
        ...props,
        feed: { ...feed, error: "Civitai API error 500: boom" },
      }),
    );
    expect(html).toContain("Model 1");
    expect(html).toContain("load more");
  });

  it("empty feed: says whether filters are narrowing it", () => {
    hook.value = { profile: P3060, status: "ready" };
    const empty = { ...feed, civitai: [], count: 0 };
    const plain = render(
      createElement(ModelFeedResults, { ...props, feed: empty }),
    );
    expect(plain).toContain('data-testid="model-feed-empty"');
    expect(plain).toContain("No models found. Try a broader search.");
    const narrowed = render(
      createElement(ModelFeedResults, {
        ...props,
        feed: empty,
        filters: { ...DEFAULT_MODEL_FILTERS, baseModels: ["SDXL 1.0"] },
      }),
    );
    expect(narrowed).toContain("Remove a filter");
  });
});

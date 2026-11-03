import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_FILTERS, modelFiltersFromUrl, modelFiltersToUrl } from "@/lib/modelFilters";
import { updateUrlQuery } from "@/lib/urlQuery";
import {
  WORKFLOWS_CIVITAI_DEFAULTS,
  parseWorkflowsTab,
  workflowsCivitaiFiltersToUrl,
  workflowsCivitaiFromUrl,
  workflowsCivitaiQueryToUrl,
  workflowsTabToUrl,
} from "@/lib/workflowsUrl";

const sp = (qs: string) => new URLSearchParams(qs);

/** Apply an updates record the way updateUrlQuery does, for round trips. */
function apply(qs: string, updates: Record<string, string | null>): URLSearchParams {
  const p = sp(qs);
  for (const [k, v] of Object.entries(updates)) {
    if (v === null) p.delete(k);
    else p.set(k, v);
  }
  return p;
}

describe("Workflows tab URL", () => {
  it("parses known tabs and falls back to aliases", () => {
    expect(parseWorkflowsTab("civitai")).toBe("civitai");
    expect(parseWorkflowsTab("import")).toBe("import");
    expect(parseWorkflowsTab(null)).toBe("aliases");
    expect(parseWorkflowsTab("nope")).toBe("aliases");
  });

  it("omits the default tab", () => {
    expect(workflowsTabToUrl("aliases")).toEqual({ tab: null });
    expect(workflowsTabToUrl("civitai")).toEqual({ tab: "civitai" });
  });
});

describe("Workflows → Civitai URL state", () => {
  it("an empty URL is the tab's own defaults (Most Downloaded)", () => {
    expect(workflowsCivitaiFromUrl(sp(""))).toEqual({
      filters: WORKFLOWS_CIVITAI_DEFAULTS,
      query: "",
    });
    expect(WORKFLOWS_CIVITAI_DEFAULTS.sort).toBe("Most Downloaded");
  });

  it("defaults write nothing", () => {
    expect(
      Object.values(workflowsCivitaiFiltersToUrl(WORKFLOWS_CIVITAI_DEFAULTS)).every(
        (v) => v === null,
      ),
    ).toBe(true);
    expect(workflowsCivitaiQueryToUrl("  ")).toEqual({ q: null });
  });

  it("round-trips non-default filters and the search", () => {
    const filters = {
      ...WORKFLOWS_CIVITAI_DEFAULTS,
      source: "civitai-red" as const,
      sort: "Highest Rated" as const,
      period: "Month" as const,
      types: ["LORA" as const],
      creator: "someone",
      nsfw: false,
    };
    const url = apply("tab=civitai", {
      ...workflowsCivitaiFiltersToUrl(filters),
      ...workflowsCivitaiQueryToUrl("anime"),
    });
    expect(url.get("msort")).toBe("Highest Rated");
    expect(url.get("tab")).toBe("civitai");
    expect(workflowsCivitaiFromUrl(url)).toEqual({ filters, query: "anime" });
  });

  it("an explicit Explore-default sort survives (not swallowed by Explore's defaults)", () => {
    const filters = { ...WORKFLOWS_CIVITAI_DEFAULTS, sort: "Highest Rated" as const };
    expect(workflowsCivitaiFiltersToUrl(filters).msort).toBe("Highest Rated");
    expect(modelFiltersToUrl(filters).msort).toBeNull();
  });

  it("modelFiltersFromUrl defaults to Explore's filters when none are given", () => {
    expect(modelFiltersFromUrl(sp(""))).toEqual(DEFAULT_MODEL_FILTERS);
    expect(modelFiltersFromUrl(sp("src=civitai"), { ...DEFAULT_MODEL_FILTERS, source: "hf" }).source).toBe("civitai");
    expect(modelFiltersFromUrl(sp(""), { ...DEFAULT_MODEL_FILTERS, source: "hf" }).source).toBe("hf");
  });
});

describe("updateUrlQuery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubWindow(pathname: string, search: string) {
    const history = { pushState: vi.fn(), replaceState: vi.fn() };
    vi.stubGlobal("window", { location: { pathname, search }, history });
    return history;
  }

  it("merges updates, deleting nulls; pushes or replaces", () => {
    const h = stubWindow("/workflows", "?tab=civitai&msort=Newest");
    updateUrlQuery({ msort: null, q: "cat" }, "push");
    expect(h.pushState).toHaveBeenCalledWith(null, "", "?tab=civitai&q=cat");
    updateUrlQuery({ q: "dog" });
    expect(h.replaceState).toHaveBeenCalledWith(null, "", "?tab=civitai&msort=Newest&q=dog");
  });

  it("is a no-op when nothing changes and drops an emptied query", () => {
    const h = stubWindow("/workflows", "?tab=civitai");
    updateUrlQuery({ tab: "civitai" }, "push");
    expect(h.pushState).not.toHaveBeenCalled();
    updateUrlQuery({ tab: null }, "push");
    expect(h.pushState).toHaveBeenCalledWith(null, "", "/workflows");
  });
});

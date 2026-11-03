import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_FILTERS,
  activeFilterChips,
  buildCivitaiModelQuery,
  buildHfModelQuery,
  clearModelFilters,
  filterControlsFor,
  modelFiltersFromUrl,
  modelFiltersToUrl,
  removeFilterChip,
  showsCheckpointType,
  toggleIn,
  type ModelFilters,
} from "@/lib/modelFilters";

const F = (patch: Partial<ModelFilters> = {}): ModelFilters => ({
  ...DEFAULT_MODEL_FILTERS,
  ...patch,
});

function urlParams(f: ModelFilters): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(modelFiltersToUrl(f))) {
    if (v !== null) sp.set(k, v);
  }
  return sp;
}

describe("buildCivitaiModelQuery", () => {
  it("maps every Civitai filter, repeating multi-value keys", () => {
    const p = buildCivitaiModelQuery(
      F({
        sort: "Most Downloaded",
        period: "Week",
        types: ["Checkpoint", "LORA"],
        baseModels: ["Flux.1 D", "SDXL 1.0"],
        checkpointType: "Merge",
        creator: "@some_user",
      }),
      { query: "  portrait  ", scope: "models", cursor: "12|34|56", limit: 30 },
    );
    expect(p.get("q")).toBe("portrait");
    expect(p.get("limit")).toBe("30");
    expect(p.get("cursor")).toBe("12|34|56");
    expect(p.get("sort")).toBe("Most Downloaded");
    expect(p.get("period")).toBe("Week");
    expect(p.getAll("types")).toEqual(["Checkpoint", "LORA"]);
    expect(p.getAll("baseModels")).toEqual(["Flux.1 D", "SDXL 1.0"]);
    expect(p.get("checkpointType")).toBe("Merge");
    expect(p.get("username")).toBe("some_user");
    expect(p.get("source")).toBe("com");
    expect(p.get("nsfw")).toBe("false");
    expect(p.has("page")).toBe(false);
  });

  it("omits empty optional params", () => {
    const p = buildCivitaiModelQuery(F(), { query: "", scope: "models" });
    expect(p.has("q")).toBe(false);
    expect(p.has("types")).toBe(false);
    expect(p.has("baseModels")).toBe(false);
    expect(p.has("username")).toBe(false);
    expect(p.has("cursor")).toBe(false);
    expect(p.get("limit")).toBe("24");
  });

  it("only sends checkpointType when Checkpoint is in the types", () => {
    const p = buildCivitaiModelQuery(
      F({ types: ["LORA"], checkpointType: "Trained" }),
      { query: "", scope: "models" },
    );
    expect(p.has("checkpointType")).toBe(false);
  });

  it("civitai.com is always SFW; Civitai Red honors the NSFW toggle", () => {
    const com = buildCivitaiModelQuery(F({ source: "civitai", nsfw: true }), {
      query: "",
      scope: "models",
    });
    expect(com.get("source")).toBe("com");
    expect(com.get("nsfw")).toBe("false");

    const red = buildCivitaiModelQuery(F({ source: "civitai-red", nsfw: true }), {
      query: "",
      scope: "models",
    });
    expect(red.get("source")).toBe("red");
    expect(red.get("nsfw")).toBe("true");

    const redSfw = buildCivitaiModelQuery(
      F({ source: "civitai-red", nsfw: false }),
      { query: "", scope: "models" },
    );
    expect(redSfw.get("nsfw")).toBe("false");
  });

  it("scopes the LoRAs tab to the LoRA family", () => {
    const all = buildCivitaiModelQuery(F(), { query: "", scope: "loras" });
    expect(all.getAll("types")).toEqual(["LORA", "LoCon", "DoRA"]);

    const picked = buildCivitaiModelQuery(
      F({ types: ["Checkpoint", "DoRA"], checkpointType: "Merge" }),
      { query: "", scope: "loras" },
    );
    expect(picked.getAll("types")).toEqual(["DoRA"]);
    expect(picked.has("checkpointType")).toBe(false);
  });

  it("drops creators that fail the username whitelist", () => {
    const p = buildCivitaiModelQuery(F({ creator: "bad name&x=1" }), {
      query: "",
      scope: "models",
    });
    expect(p.has("username")).toBe(false);
  });
});

describe("buildHfModelQuery", () => {
  it("maps HF sort/task/library/author/search", () => {
    const p = buildHfModelQuery(
      F({
        source: "hf",
        hfSort: "downloads",
        hfTask: "text-to-image",
        hfLibrary: "diffusers",
        creator: "black-forest-labs",
        // Civitai-only filters must not leak into HF queries
        baseModels: ["Flux.1 D"],
        period: "Week",
        types: ["Checkpoint"],
      }),
      { query: "flux", scope: "models", cursor: "abc=", limit: 12 },
    );
    expect(p.get("search")).toBe("flux");
    expect(p.get("sort")).toBe("downloads");
    expect(p.get("pipeline_tag")).toBe("text-to-image");
    expect(p.getAll("filter")).toEqual(["diffusers"]);
    expect(p.get("author")).toBe("black-forest-labs");
    expect(p.get("limit")).toBe("12");
    expect(p.get("cursor")).toBe("abc=");
    for (const k of ["baseModels", "period", "types", "nsfw", "source"]) {
      expect(p.has(k)).toBe(false);
    }
  });

  it("adds filter=lora on the LoRAs tab", () => {
    const p = buildHfModelQuery(F({ source: "hf", hfLibrary: "diffusers" }), {
      query: "",
      scope: "loras",
    });
    expect(p.getAll("filter")).toEqual(["lora", "diffusers"]);
    expect(p.get("sort")).toBe("trendingScore");
    expect(p.has("search")).toBe(false);
  });
});

describe("filter visibility per source", () => {
  it("hides Civitai-only controls for Hugging Face and vice versa", () => {
    const hf = filterControlsFor("hf");
    expect(hf.period || hf.baseModel || hf.type || hf.nsfw).toBe(false);
    expect(hf.task && hf.library).toBe(true);

    const civ = filterControlsFor("civitai");
    expect(civ.period && civ.baseModel && civ.type).toBe(true);
    expect(civ.task || civ.library || civ.nsfw).toBe(false);
    expect(filterControlsFor("civitai-red").nsfw).toBe(true);
  });

  it("shows checkpointType only when Checkpoint is effective", () => {
    expect(showsCheckpointType(F(), "models")).toBe(false);
    expect(showsCheckpointType(F({ types: ["Checkpoint"] }), "models")).toBe(
      true,
    );
    expect(showsCheckpointType(F({ types: ["Checkpoint"] }), "loras")).toBe(
      false,
    );
    expect(
      showsCheckpointType(F({ source: "hf", types: ["Checkpoint"] }), "models"),
    ).toBe(false);
  });
});

describe("URL persistence", () => {
  it("writes nothing for defaults", () => {
    expect(urlParams(F()).toString()).toBe("");
  });

  it("round-trips a full Civitai Red filter set", () => {
    const f = F({
      source: "civitai-red",
      sort: "Newest",
      period: "Month",
      types: ["Checkpoint", "VAE"],
      baseModels: ["Flux.1 D", "Wan Video 2.2 I2V-A14B"],
      checkpointType: "Trained",
      creator: "someone",
      nsfw: true,
    });
    const sp = urlParams(f);
    expect(sp.get("src")).toBe("red");
    expect(sp.get("nsfw")).toBe("1");
    expect(sp.get("mtype")).toBe("Checkpoint,VAE");
    expect(modelFiltersFromUrl(new URLSearchParams(sp.toString()))).toEqual(f);
  });

  it("round-trips Hugging Face filters", () => {
    const f = F({
      source: "hf",
      hfSort: "likes",
      hfTask: "image-to-video",
      hfLibrary: "gguf",
    });
    const sp = urlParams(f);
    expect(sp.get("src")).toBe("hf");
    expect(modelFiltersFromUrl(sp)).toEqual(f);
  });

  it("drops invalid / injected URL values", () => {
    const f = modelFiltersFromUrl(
      new URLSearchParams(
        "src=evil&msort=DROP&mperiod=Forever&mtype=LORA,Bogus&base=Flux.1 D,Nope&ckpt=x&creator=a b&hsort=x&task=x&lib=x&nsfw=maybe",
      ),
    );
    expect(f).toEqual(F({ types: ["LORA"], baseModels: ["Flux.1 D"] }));
  });
});

describe("active filter chips", () => {
  it("lists narrowing filters for the active source only", () => {
    const f = F({
      period: "Week",
      types: ["Checkpoint"],
      baseModels: ["SDXL 1.0"],
      checkpointType: "Merge",
      creator: "abc",
      hfTask: "text-to-image", // HF-only: hidden on Civitai
    });
    expect(activeFilterChips(f, "models").map((c) => c.id)).toEqual([
      "period",
      "type:Checkpoint",
      "base:SDXL 1.0",
      "ckpt",
      "creator",
    ]);
    expect(
      activeFilterChips({ ...f, source: "hf" }, "models").map((c) => c.id),
    ).toEqual(["task", "creator"]);
    expect(
      activeFilterChips(F({ source: "civitai-red", nsfw: false }), "models"),
    ).toEqual([]);
    expect(
      activeFilterChips(F({ source: "civitai-red", nsfw: true }), "models"),
    ).toEqual([{ id: "mature", label: "Mature included" }]);
  });

  it("removes one chip at a time and clears checkpointType with Checkpoint", () => {
    const f = F({ types: ["Checkpoint", "LORA"], checkpointType: "Merge" });
    const next = removeFilterChip(f, "type:Checkpoint");
    expect(next.types).toEqual(["LORA"]);
    expect(next.checkpointType).toBeNull();
    expect(removeFilterChip(F({ period: "Day" }), "period").period).toBe(
      "AllTime",
    );
    expect(
      removeFilterChip(F({ baseModels: ["Pony", "SD 1.5"] }), "base:Pony")
        .baseModels,
    ).toEqual(["SD 1.5"]);
  });

  it("Clear all keeps source and sort", () => {
    const f = F({
      source: "civitai-red",
      sort: "Newest",
      hfSort: "likes",
      period: "Day",
      types: ["VAE"],
      creator: "x",
      nsfw: true,
    });
    expect(clearModelFilters(f)).toEqual(
      F({ source: "civitai-red", sort: "Newest", hfSort: "likes" }),
    );
  });

  it("toggleIn adds and removes", () => {
    expect(toggleIn(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleIn(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("HF task default", () => {
  it("opens HF on text-to-image and round-trips 'any task' via a sentinel", () => {
    expect(DEFAULT_MODEL_FILTERS.hfTask).toBe("text-to-image");
    const def = modelFiltersFromUrl(new URLSearchParams("src=hf"));
    expect(def.hfTask).toBe("text-to-image");
    expect(modelFiltersToUrl(def).task).toBeNull();
    const any = { ...def, hfTask: null };
    const url = modelFiltersToUrl(any);
    expect(url.task).toBe("any");
    expect(modelFiltersFromUrl(new URLSearchParams("src=hf&task=any")).hfTask).toBeNull();
    expect(modelFiltersFromUrl(new URLSearchParams("src=hf&task=bogus")).hfTask).toBe("text-to-image");
  });
});

describe("NSFW safe defaults (F1)", () => {
  it("defaults to SFW, even on Civitai Red", () => {
    expect(DEFAULT_MODEL_FILTERS.nsfw).toBe(false);
    expect(DEFAULT_MODEL_FILTERS.source).toBe("civitai");
  });

  it("a bare ?src=red deep link stays SFW; mature needs nsfw=1", () => {
    const red = modelFiltersFromUrl(new URLSearchParams("src=red"));
    expect(red.source).toBe("civitai-red");
    expect(red.nsfw).toBe(false);
    const q = buildCivitaiModelQuery(red, { query: "", scope: "models" });
    expect(q.get("source")).toBe("red");
    expect(q.get("nsfw")).toBe("false");

    const mature = modelFiltersFromUrl(new URLSearchParams("src=red&nsfw=1"));
    expect(mature.nsfw).toBe(true);
    expect(
      buildCivitaiModelQuery(mature, { query: "", scope: "models" }).get(
        "nsfw",
      ),
    ).toBe("true");
  });

  it("the default feed explicitly requests SFW civitai.com", () => {
    const q = buildCivitaiModelQuery(DEFAULT_MODEL_FILTERS, {
      query: "",
      scope: "models",
    });
    expect(q.get("source")).toBe("com");
    expect(q.get("nsfw")).toBe("false");
  });

  it("removing the Mature chip returns to SFW", () => {
    const f = F({ source: "civitai-red", nsfw: true });
    expect(removeFilterChip(f, "mature").nsfw).toBe(false);
  });
});

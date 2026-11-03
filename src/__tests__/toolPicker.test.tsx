import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { profileFromSystemStats } from "@/lib/models/compat";
import {
  NO_TOOL_PICKS,
  resolveToolRows,
  toolFetchCommand,
  toolSelection,
  visibleToolRows,
  type ToolMapEntry,
} from "@/lib/onboarding/toolPicker";
import { ToolPicker } from "@/components/onboarding/ToolPicker";

const GB = 1e9;
const profile = (gib: number) =>
  profileFromSystemStats({
    system: { os: "linux", ram_total: 64 * 1024 ** 3 },
    devices: [
      { name: "cuda:0 NVIDIA GeForce RTX", type: "cuda", vram_total: gib * 1024 ** 3 },
    ],
  });

const MAP: ToolMapEntry[] = [
  {
    id: "edit",
    kind: "action",
    title: "Edit photo",
    category: "Edit",
    files: ["diffusion_models/small.safetensors", "diffusion_models/huge.safetensors", "vae/v.safetensors"],
  },
  {
    id: "movie",
    kind: "action",
    title: "Movie",
    category: "Video",
    files: ["diffusion_models/huge.safetensors", "vae/v.safetensors"],
  },
  { id: "dub", kind: "action", title: "Dub", category: "Audio", files: ["loras/unlisted.safetensors"], dirs: ["tts/x/"] },
  { id: "describe", kind: "action", title: "Describe", category: "Describe", files: [] },
];
const SIZES = {
  "small.safetensors": { bytes: 4 * GB, set: "full" },
  "huge.safetensors": { bytes: 200 * GB, set: "full", gated: true },
  "v.safetensors": { bytes: 1 * GB, set: "minimal" },
  "unlisted.safetensors": { bytes: 1 * GB, set: null },
};

const rows = (gib: number | null = 24, listings = null as never) =>
  resolveToolRows(MAP, SIZES, gib === null ? null : profile(gib), listings);

describe("tool picker selection", () => {
  it("drops tools with no weights", () => {
    expect(rows().map((r) => r.title)).toEqual(["Edit photo", "Movie", "Dub"]);
  });

  it("a tool fits when any main model does, and the too-big one starts unticked", () => {
    const edit = rows()[0];
    expect(edit.fit).toBe("fits");
    expect(edit.files.find((f) => f.dest.includes("huge"))!.byDefault).toBe(false);
    expect(edit.files.find((f) => f.dest.includes("small"))!.byDefault).toBe(true);
  });

  it("a tool whose only main model is too big keeps it when picked knowingly", () => {
    const movie = rows()[1];
    expect(movie.fit).toBe("too_big");
    expect(movie.files.find((f) => f.dest.includes("huge"))!.byDefault).toBe(true);
  });

  it("builds a command, skipping what fits nothing and costing only what downloads", () => {
    const sel = toolSelection(rows(), { tools: ["action:edit"], files: {} });
    expect(sel.needBytes).toBe(5 * GB);
    expect(sel.skip).toEqual(["diffusion_models/huge.safetensors"]);
    expect(toolFetchCommand(sel, "/c")).toBe(
      "node scripts/fetch-models.mjs --tool edit --skip diffusion_models/huge.safetensors --comfy /c --yes",
    );
  });

  it("a file another chosen tool wants stays in the download", () => {
    const sel = toolSelection(rows(), { tools: ["action:edit", "action:movie"], files: {} });
    expect(sel.skip).toEqual([]);
    expect(sel.needBytes).toBe(205 * GB);
    expect(sel.gated).toBe(true);
    expect(toolFetchCommand(sel, "/c")).toContain("--tool edit,movie --comfy");
  });

  it("a hand tick beats the default, both ways", () => {
    const on = toolSelection(rows(), {
      tools: ["action:edit"],
      files: { "diffusion_models/huge.safetensors": true, "vae/v.safetensors": false },
    });
    expect(on.needBytes).toBe(204 * GB);
    expect(on.skip).toEqual(["vae/v.safetensors"]);
  });

  it("doesn't count what the picked packs fetch anyway", () => {
    const sel = toolSelection(rows(), { tools: ["action:edit"], files: {} }, ["vae/v.safetensors"]);
    expect(sel.needBytes).toBe(4 * GB);
    expect(sel.sharedBytes).toBe(1 * GB);
  });

  it("reports unlisted files as manual and folders as extras", () => {
    const sel = toolSelection(rows(), { tools: ["action:dub"], files: {} });
    expect(sel.manual).toEqual(["loras/unlisted.safetensors"]);
    expect(sel.skip).toEqual([]);
    expect(sel.dirs).toEqual(["tts/x/"]);
    expect(toolFetchCommand(sel, "/c")).toContain("--tool dub");
  });

  it("has no command when everything is installed", () => {
    const listings = {
      diffusion_models: new Set(["small.safetensors", "huge.safetensors"]),
      vae: new Set(["v.safetensors"]),
    };
    const r = resolveToolRows(MAP, SIZES, profile(24), listings);
    expect(r[0].allInstalled).toBe(true);
    expect(toolFetchCommand(toolSelection(r, { tools: ["action:edit"], files: {} }), "/c")).toBeNull();
  });

  it("uses kind:id when two kinds share an id", () => {
    const r = resolveToolRows(
      [
        { id: "a", kind: "action", title: "A", category: "C", files: ["vae/v.safetensors"] },
        { id: "a", kind: "catalog", title: "A2", category: "C", files: ["vae/v.safetensors"] },
      ],
      SIZES,
      null,
      null,
    );
    expect(r.map((x) => x.arg)).toEqual(["action:a", "catalog:a"]);
  });

  it("filters by words and fit, but never hides a picked tool", () => {
    const r = rows();
    expect(visibleToolRows(r, "", true).map((x) => x.title)).toEqual(["Edit photo", "Dub"]);
    expect(visibleToolRows(r, "", true, ["action:movie"]).map((x) => x.title)).toContain("Movie");
    expect(visibleToolRows(r, "video", false).map((x) => x.title)).toEqual(["Movie"]);
  });

  it("without a GPU profile nothing is judged and nothing is hidden", () => {
    const r = rows(null);
    expect(r.every((x) => x.fit === null)).toBe(true);
    expect(visibleToolRows(r, "", true)).toHaveLength(3);
  });

  it("a small card hides more than a big one", () => {
    const six = rows(6);
    expect(six[0].files.find((f) => f.dest.includes("small"))!.verdict).not.toBe("too_big");
    expect(rows(2)[0].fit).toBe("too_big");
  });
});

describe("ToolPicker", () => {
  it("renders closed, without fetching the tool list", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const html = renderToStaticMarkup(
      <ToolPicker
        picks={NO_TOOL_PICKS}
        onPicks={() => {}}
        comfyDir="/c"
        cardName="RTX"
        alreadyFetched={[]}
      />,
    );
    vi.unstubAllGlobals();
    expect(html).toContain("Pick single tools");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Search tools");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

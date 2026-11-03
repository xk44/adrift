import { describe, expect, it } from "vitest";
import { extractWorkflow, WorkflowExtractError } from "@/lib/userTools/extract";
import {
  analyzeWorkflow,
  civitaiModelSearchUrl,
  discoverParams,
  findMissingModels,
  findMissingNodes,
  suggestName,
} from "@/lib/userTools/analyze";
import type { ObjectInfoIndex } from "@/lib/oj/inputSpec";
import {
  editGraph,
  objectInfo,
  pngWithText,
  t2iGraph,
  uiGraph,
} from "./fixtures/userToolsGraphs";
import { makeZip } from "./fixtures/userToolsZip";

const OI = objectInfo() as ObjectInfoIndex;
const json = (v: unknown) => Buffer.from(JSON.stringify(v));

describe("extractWorkflow", () => {
  it("reads an API-format .json", () => {
    const out = extractWorkflow(json(t2iGraph()), "fox.json");
    expect(out.format).toBe("api");
    expect(out.workflow["5"].class_type).toBe("KSampler");
    expect(out.sourceFile).toBe("fox.json");
  });

  it("converts a UI-format .json with the existing converter", () => {
    const out = extractWorkflow(json(uiGraph()), "copy.json");
    expect(out.format).toBe("ui");
    expect(out.workflow["1"]).toMatchObject({
      class_type: "LoadImage",
      inputs: { image: "cat.png" },
    });
    expect(out.workflow["2"].inputs.images).toEqual(["1", 0]);
  });

  it("prefers the API prompt chunk in a PNG", () => {
    const png = pngWithText({
      prompt: JSON.stringify(t2iGraph()),
      workflow: JSON.stringify(uiGraph()),
    });
    const out = extractWorkflow(png, "fox.png");
    expect(out.format).toBe("api");
    expect(out.workflow["5"].class_type).toBe("KSampler");
  });

  it("falls back to the UI workflow chunk in a PNG", () => {
    const out = extractWorkflow(
      pngWithText({ workflow: JSON.stringify(uiGraph()) }),
      "a.png",
    );
    expect(out.format).toBe("ui");
  });

  it("finds the workflow inside a zip and lists the others", () => {
    const zip = makeZip([
      { name: "__MACOSX/._wf.json", data: Buffer.from("junk") },
      { name: "readme.txt", data: Buffer.from("hi") },
      { name: "api/wf_api.json", data: json(t2iGraph()) },
      { name: "wf.json", data: json(uiGraph()) },
      { name: "notes.json", data: json({ hello: 1 }) },
    ]);
    const out = extractWorkflow(zip, "pack.zip");
    expect(out.sourceFile).toBe("wf.json"); // UI file preferred
    expect(out.otherFiles).toEqual(["api/wf_api.json"]);
  });

  it("uses a PNG in a zip when there is no json", () => {
    const zip = makeZip([
      {
        name: "example.png",
        data: pngWithText({ prompt: JSON.stringify(t2iGraph()) }),
        method: 0,
      },
    ]);
    expect(extractWorkflow(zip, "x.zip").sourceFile).toBe("example.png");
  });

  it("gives plain errors for files that are not workflows", () => {
    expect(() => extractWorkflow(Buffer.alloc(0), "e.json")).toThrow(
      WorkflowExtractError,
    );
    expect(() => extractWorkflow(Buffer.from("hello"), "h.txt")).toThrow(
      /not a .json, .png or .zip/,
    );
    expect(() => extractWorkflow(json({ a: 1 }), "a.json")).toThrow(
      /does not look like/,
    );
    expect(() => extractWorkflow(pngWithText({}), "p.png")).toThrow(
      /no ComfyUI workflow/,
    );
    expect(() =>
      extractWorkflow(
        makeZip([{ name: "a.txt", data: Buffer.from("x") }]),
        "z.zip",
      ),
    ).toThrow(/No ComfyUI workflow found/);
  });
});

describe("discoverParams", () => {
  it("finds and auto-selects the common text-to-image params", () => {
    const params = discoverParams(t2iGraph(), OI);
    const byKey = Object.fromEntries(params.map((p) => [p.key, p]));
    expect(byKey["2.text"]).toMatchObject({
      kind: "prompt",
      label: "Prompt",
      exposed: true,
      default: "a red fox",
    });
    expect(byKey["3.text"]).toMatchObject({ kind: "negative", exposed: true });
    expect(byKey["5.seed"]).toMatchObject({ kind: "seed", exposed: true });
    expect(byKey["5.steps"]).toMatchObject({
      kind: "steps",
      exposed: true,
      min: 1,
      max: 10000,
    });
    expect(byKey["5.cfg"]).toMatchObject({ kind: "cfg", exposed: true });
    expect(byKey["4.width"]).toMatchObject({
      kind: "width",
      exposed: true,
      step: 8,
    });
    expect(byKey["4.height"]).toMatchObject({ kind: "height", exposed: true });
    // denoise is not useful without an input image
    expect(byKey["5.denoise"]).toMatchObject({
      kind: "denoise",
      exposed: false,
    });
    // model / sampler names are not params
    expect(byKey["1.ckpt_name"]).toBeUndefined();
    expect(byKey["5.sampler_name"]).toBeUndefined();
  });

  it("finds image inputs, LoRA strength and denoise in an edit graph", () => {
    const params = discoverParams(editGraph(), OI);
    const byKey = Object.fromEntries(params.map((p) => [p.key, p]));
    expect(byKey["10.image"]).toMatchObject({
      kind: "image",
      label: "Your photo",
      exposed: true,
      default: "photo.png",
    });
    expect(byKey["12.strength_model"]).toMatchObject({
      kind: "lora_strength",
      label: "LoRA strength · ink_wash",
      exposed: false,
    });
    expect(byKey["16.denoise"]).toMatchObject({
      kind: "denoise",
      exposed: true,
    });
    expect(byKey["14.text"]).toMatchObject({ kind: "negative" });
    expect(byKey["10.upload"]).toBeUndefined();
  });

  it("works without object_info using input names", () => {
    const params = discoverParams(editGraph(), null);
    expect(params.find((p) => p.key === "10.image")?.kind).toBe("image");
    expect(params.find((p) => p.key === "13.text")?.kind).toBe("prompt");
  });

  it("numbers duplicate labels", () => {
    const g = t2iGraph();
    g["8"] = { class_type: "LoadImage", inputs: { image: "a.png" } };
    g["9"] = { class_type: "LoadImage", inputs: { image: "b.png" } };
    const labels = discoverParams(g, OI)
      .filter((p) => p.kind === "image")
      .map((p) => p.label);
    expect(labels).toEqual(["Image 1", "Image 2"]);
  });
});

describe("missing nodes and models", () => {
  it("lists unknown classes with candidate packs", () => {
    const out = findMissingNodes(editGraph(), OI, {
      FancyColorGrade: [{ id: "comfyui-fancy", label: "Fancy Nodes" }],
    });
    expect(out).toEqual([
      {
        classType: "FancyColorGrade",
        packs: [{ id: "comfyui-fancy", label: "Fancy Nodes" }],
      },
    ]);
  });

  it("lists model files the loaders do not offer, with a Civitai search", () => {
    const out = findMissingModels(editGraph(), OI);
    expect(out).toEqual([
      {
        nodeId: "12",
        classType: "LoraLoader",
        input: "lora_name",
        file: "styles/ink_wash.safetensors",
        searchUrl: "https://civitai.com/search/models?query=ink_wash",
      },
    ]);
    expect(findMissingModels(t2iGraph(), OI)).toEqual([]);
    expect(civitaiModelSearchUrl("a b.gguf")).toBe(
      "https://civitai.com/search/models?query=a%20b",
    );
  });
});

describe("analyzeWorkflow", () => {
  it("suggests name, category and icon", () => {
    const extracted = extractWorkflow(json(editGraph()), "ink_wash_edit.json");
    const a = analyzeWorkflow(extracted, {
      objectInfo: OI,
      source: { type: "file", file: "ink_wash_edit.json" },
    });
    expect(a.workflowType).toBe("i2i");
    expect(a.output).toBe("image");
    expect(a.checked).toBe(true);
    expect(a.suggested).toEqual({
      name: "ink wash edit",
      icon: "Brush",
      category: "Edit",
    });
    expect(a.missingNodes.map((n) => n.classType)).toEqual(["FancyColorGrade"]);
  });

  it("marks results unchecked when ComfyUI is offline", () => {
    const a = analyzeWorkflow(extractWorkflow(json(t2iGraph()), "x.json"), {
      objectInfo: null,
      source: { type: "file" },
      title: "Civitai Fox",
    });
    expect(a.checked).toBe(false);
    expect(a.missingNodes).toEqual([]);
    expect(a.suggested.name).toBe("Civitai Fox");
    expect(a.suggested.category).toBe("Image");
  });

  it("keeps suggested names short", () => {
    expect(
      suggestName("x".repeat(100) + ".zip", "f").length,
    ).toBeLessThanOrEqual(60);
    expect(suggestName("", "Fallback")).toBe("Fallback");
  });
});

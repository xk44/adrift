/**
 * FIBO 2.0 Edit pack + full-res paste-back (CJImagePasteBack + SAM3 masks):
 * graph wiring, toggle / diff-only / pose pruning, Turbo vs Dev, the optional
 * paste-back on the generic edits, and the tool card requests.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { buildActionWorkflow } from "@/lib/oj/engine";
import { buildFiboEditWorkflow } from "@/lib/oj/fiboEdit";
import { actionBuilderFor } from "@/lib/oj/actionBuilders";
import { getPack } from "@/lib/oj/packs";
import {
  PASTEBACK_CLASS,
  addImagePasteBack,
  pasteBackFitFor,
  pasteBackRequest,
} from "@/lib/oj/imagePasteBack";
import registry from "@/lib/oj/registry.json";
import {
  ACTION_TOOLS,
  buildActionRequest,
  defaultSettings,
  type EditLoraListResponse,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import { EDIT_ENGINES } from "@/lib/tools/templates";
import type { ImagineRun, Workflow } from "@/types";

const WORKFLOWS_DIR = path.join(process.cwd(), "public", "workflows");
type Node = { class_type: string; inputs: Record<string, unknown> };
type G = Record<string, Node>;

function load(rel: string): G {
  const g = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, rel), "utf-8"));
  delete g._meta;
  return g;
}

function danglingRefs(graph: G): string[] {
  const ids = new Set(Object.keys(graph));
  const bad: string[] = [];
  for (const [nodeId, node] of Object.entries(graph)) {
    for (const val of Object.values(node.inputs ?? {})) {
      if (Array.isArray(val) && typeof val[0] === "string" && !ids.has(val[0]))
        bad.push(`${nodeId} -> ${val[0]}`);
    }
  }
  return bad;
}

const ids = (g: G, cls: string) =>
  Object.keys(g).filter((id) => g[id].class_type === cls);
const one = (g: G, cls: string) => {
  const found = ids(g, cls);
  expect(found).toHaveLength(1);
  return found[0];
};
const link = (v: unknown) => (v as [string, number])[0];
/** SAM3_Detect feeding `input` of the paste-back node: [image src, text]. */
function samOf(g: G, pb: string, input: string): [string, string] {
  const sam = g[link(g[pb].inputs[input])];
  expect(sam.class_type).toBe("SAM3_Detect");
  const text = g[link(sam.inputs.conditioning)];
  expect(text.class_type).toBe("CLIPTextEncode");
  return [link(sam.inputs.image), text.inputs.text as string];
}

const sourceRun = {
  run_id: "run-f",
  prompt: "portrait",
  parsedPrompt: "portrait",
  width: 1024,
  height: 1024,
  jobs: [
    {
      seed: 1,
      index: 0,
      status: "done",
      progress: 100,
      images: ["/view?filename=portrait.png&subfolder=out&type=output"],
      prompt_id: "p-f",
    },
  ],
  createdAt: new Date().toISOString(),
  status: "done",
  // Source-run params must never trigger a paste-back on a chained edit.
  params: { pasteBack: true, pasteBackArea: "the hat" },
} as unknown as ImagineRun;

const fibo = (rel: string, params: Record<string, unknown>) =>
  buildFiboEditWorkflow(load(rel) as unknown as Workflow, sourceRun, 0, params)
    .workflow as unknown as G;

describe("FIBO 2.0 edit graphs", () => {
  it.each(["packs/fibo2/edit.json", "packs/fibo2/edit_dev.json"])(
    "%s: no dangling refs, full paste-back chain wired",
    (rel) => {
      const g = load(rel);
      expect(danglingRefs(g)).toEqual([]);
      const load_ = one(g, "LoadImage");
      const decode = one(g, "VAEDecode");
      const pb = one(g, PASTEBACK_CLASS);
      expect(g[one(g, "TextEncodeFibo2")].inputs["images.image_1"]).toEqual([
        load_,
        0,
      ]);
      expect(g[pb].inputs.original).toEqual([load_, 0]);
      expect(g[pb].inputs.edited).toEqual([decode, 0]);
      expect(g[pb].inputs.fit).toBe("crop");
      expect(samOf(g, pb, "region")[0]).toBe(load_);
      expect(samOf(g, pb, "protect")).toEqual([load_, "face"]);
      expect(samOf(g, pb, "subject")).toEqual([load_, "person"]);
      expect(samOf(g, pb, "new_content")).toEqual([decode, "person"]);
      expect(g[one(g, "SaveImage")].inputs.images).toEqual([pb, 0]);
      expect(g[one(g, "CheckpointLoaderSimple")].inputs.ckpt_name).toBe(
        "sam3.1_multiplex_fp16.safetensors",
      );
      expect(g[one(g, "CLIPLoader")].inputs.type).toBe("fibo2");
    },
  );

  it("Turbo vs Dev: unet, steps, cfg", () => {
    const t = load("packs/fibo2/edit.json");
    const d = load("packs/fibo2/edit_dev.json");
    const ks = (g: G) => g[one(g, "KSampler")].inputs;
    const unet = (g: G) => g[one(g, "UNETLoader")].inputs.unet_name;
    expect(unet(t)).toBe("fibo2_edit_turbo_bf16.safetensors");
    expect(unet(d)).toBe("fibo2_dev_bf16.safetensors");
    expect([ks(t).steps, ks(t).cfg]).toEqual([4, 1]);
    expect([ks(d).steps, ks(d).cfg]).toEqual([30, 5]);
  });

  it("builder: prompt + source image, default = paste-back on, area → region text", () => {
    const g = fibo("packs/fibo2/edit.json", {
      prompt: "make the jacket red",
      pasteBackArea: "the jacket",
    });
    expect(danglingRefs(g)).toEqual([]);
    const enc = g[one(g, "TextEncodeFibo2")].inputs;
    expect(enc.prompt).toBe("make the jacket red");
    expect(g[one(g, "LoadImage")].inputs.image).toBe(
      "out/portrait.png [output]",
    );
    const pb = one(g, PASTEBACK_CLASS);
    expect(samOf(g, pb, "region")[1]).toBe("the jacket");
    expect(samOf(g, pb, "protect")[1]).toBe("face");
    // pose off by default: subject/new_content pruned
    expect(g[pb].inputs.subject).toBeUndefined();
    expect(g[pb].inputs.new_content).toBeUndefined();
    expect(ids(g, "SAM3_Detect")).toHaveLength(2);
  });

  it("builder: empty area = diff-only (no region), faces still protected", () => {
    const g = fibo("packs/fibo2/edit.json", { prompt: "x" });
    expect(danglingRefs(g)).toEqual([]);
    const pb = one(g, PASTEBACK_CLASS);
    expect(g[pb].inputs.region).toBeUndefined();
    expect(samOf(g, pb, "protect")[1]).toBe("face");
    expect(ids(g, "SAM3_Detect")).toHaveLength(1);
    expect(ids(g, "CLIPTextEncode")).toHaveLength(1);
  });

  it("builder: pose change wires subject (original) + new_content (edit)", () => {
    const g = fibo("packs/fibo2/edit_dev.json", {
      prompt: "lower his arm",
      pasteBackArea: "",
      pasteBackPose: true,
    });
    expect(danglingRefs(g)).toEqual([]);
    const pb = one(g, PASTEBACK_CLASS);
    const load_ = one(g, "LoadImage");
    expect(samOf(g, pb, "subject")).toEqual([load_, "person"]);
    expect(samOf(g, pb, "new_content")).toEqual([
      one(g, "VAEDecode"),
      "person",
    ]);
    expect(g[pb].inputs.region).toBeUndefined();
  });

  it("builder: toggle off removes SAM3 + paste-back, SaveImage ← VAEDecode", () => {
    const g = fibo("packs/fibo2/edit.json", {
      prompt: "x",
      pasteBack: false,
      pasteBackArea: "the jacket",
      pasteBackPose: true,
    });
    expect(danglingRefs(g)).toEqual([]);
    expect(ids(g, PASTEBACK_CLASS)).toEqual([]);
    expect(ids(g, "SAM3_Detect")).toEqual([]);
    expect(ids(g, "CheckpointLoaderSimple")).toEqual([]);
    expect(ids(g, "CLIPTextEncode")).toEqual([]);
    expect(g[one(g, "SaveImage")].inputs.images).toEqual([
      one(g, "VAEDecode"),
      0,
    ]);
  });

  it("builder requires an instruction", () => {
    expect(() => fibo("packs/fibo2/edit.json", {})).toThrow(/instruction/);
  });

  it("registered: actions, templates, pack, builder", () => {
    const r = registry as unknown as {
      actions: Record<string, { template: string }>;
      templates: Record<string, { file: string }>;
    };
    expect(r.actions.edit_fibo.template).toBe("edit_fibo");
    expect(r.actions.edit_fibo_dev.template).toBe("edit_fibo_dev");
    expect(r.templates.edit_fibo.file).toBe("packs/fibo2/edit.json");
    expect(r.templates.edit_fibo_dev.file).toBe("packs/fibo2/edit_dev.json");
    expect(getPack("fibo2")?.workflows).toEqual({
      edit_fibo: "packs/fibo2/edit.json",
      edit_fibo_dev: "packs/fibo2/edit_dev.json",
    });
    expect(actionBuilderFor("edit_fibo")).toBe(buildFiboEditWorkflow);
    expect(actionBuilderFor("edit_fibo_dev")).toBe(buildFiboEditWorkflow);
    expect(EDIT_ENGINES.fibo2.license).toBe("nc");
  });
});

describe("paste-back on generic edits", () => {
  const generic = (
    rel: string,
    action: string,
    params: Record<string, unknown>,
  ) => {
    const { workflow, slots } = buildActionWorkflow(
      load(rel) as unknown as Workflow,
      action,
      sourceRun,
      0,
      params,
    );
    return {
      g: workflow as unknown as G,
      imageInputId: (slots as { imageInputId?: string }).imageInputId!,
    };
  };

  it.each([
    ["packs/flux3/edit.json", "edit_flux3", "stretch"],
    ["packs/qwen-image-21/edit.json", "edit_qwen21", "stretch"],
    ["packs/krea2-edit/edit_v2.json", "edit_instruct", "crop"],
  ])("%s: appended on request (fit %s)", (rel, action, fit) => {
    const { g, imageInputId } = generic(rel, action, {
      prompt: "remove the hat",
      pasteBack: true,
      pasteBackArea: "the hat",
      pasteBackPose: true,
    });
    expect(danglingRefs(g)).toEqual([]);
    const pb = one(g, PASTEBACK_CLASS);
    const save = one(g, "SaveImage");
    expect(g[save].inputs.images).toEqual([pb, 0]);
    expect(g[pb].inputs.original).toEqual([imageInputId, 0]);
    expect(
      g[g[pb].inputs.edited ? link(g[pb].inputs.edited) : ""].class_type,
    ).toBe("VAEDecode");
    expect(g[pb].inputs.fit).toBe(fit);
    expect(samOf(g, pb, "region")).toEqual([imageInputId, "the hat"]);
    expect(samOf(g, pb, "protect")).toEqual([imageInputId, "face"]);
    expect(samOf(g, pb, "subject")).toEqual([imageInputId, "person"]);
    expect(samOf(g, pb, "new_content")[1]).toBe("person");
    expect(samOf(g, pb, "new_content")[0]).toBe(link(g[pb].inputs.edited));
  });

  it("not added without an explicit request (source-run params ignored)", () => {
    const { g } = generic("packs/flux3/edit.json", "edit_flux3", {
      prompt: "x",
    });
    expect(ids(g, PASTEBACK_CLASS)).toEqual([]);
    expect(ids(g, "SAM3_Detect")).toEqual([]);
    expect(danglingRefs(g)).toEqual([]);
  });

  it("diff-only + no pose on a generic edit keeps just protect", () => {
    const { g } = generic("packs/qwen-image-21/edit.json", "edit_qwen21", {
      prompt: "x",
      pasteBack: "on",
    });
    const pb = one(g, PASTEBACK_CLASS);
    expect(
      Object.keys(g[pb].inputs).filter((k) =>
        ["region", "new_content", "protect", "subject"].includes(k),
      ),
    ).toEqual(["protect"]);
    expect(danglingRefs(g)).toEqual([]);
  });

  it("request parsing + fit table", () => {
    expect(pasteBackRequest({}, true)).toEqual({
      enabled: true,
      area: "",
      pose: false,
    });
    expect(pasteBackRequest({}, false).enabled).toBe(false);
    expect(pasteBackRequest({ pasteBack: "off" }, true).enabled).toBe(false);
    expect(
      pasteBackRequest(
        { pasteBackArea: "  x ".repeat(100), pasteBackPose: "on" },
        true,
      ).area.length,
    ).toBeLessThanOrEqual(200);
    expect(pasteBackFitFor("edit_inpaint")).toBe("crop");
    expect(pasteBackFitFor("edit_qwen")).toBe("stretch");
    expect(
      addImagePasteBack({} as Workflow, {
        enabled: false,
        area: "",
        pose: false,
        originalId: "1",
        fit: "crop",
      }),
    ).toBeNull();
  });
});

describe("tool cards", () => {
  const spec = (id: string) => ACTION_TOOLS.find((t) => t.id === id)!;
  const settings = (
    id: string,
    patch: Partial<ToolSettings> & { picks?: Record<string, string> },
  ): ToolSettings => ({ ...defaultSettings(spec(id)), ...patch });

  it("FIBO 2.0 Edit: defaults Turbo + paste-back on, Quality = Dev", () => {
    const s = spec("edit_fibo");
    expect(s.requiredPack).toBe("fibo2");
    expect(s.modelCheck).toEqual({ pack: "fibo2", action: "edit_fibo" });
    expect(s.secondText?.label).toBe("Area to change");
    expect(
      buildActionRequest(
        s,
        settings("edit_fibo", {
          text: "red jacket",
          secondText: " the jacket ",
        }),
        null,
      ),
    ).toEqual({
      action: "edit_fibo",
      params: {
        pack_id: "fibo2",
        prompt: "red jacket",
        pasteBack: true,
        pasteBackArea: "the jacket",
      },
      overrides: {},
    });
    const dev = buildActionRequest(
      s,
      settings("edit_fibo", {
        text: "lower his arm",
        picks: { speed: "edit_fibo_dev", pasteBackPose: "on" },
      }),
      null,
    );
    expect(dev.action).toBe("edit_fibo_dev");
    expect(dev.params).toMatchObject({
      pasteBack: true,
      pasteBackArea: "",
      pasteBackPose: true,
    });
    const off = buildActionRequest(
      s,
      settings("edit_fibo", {
        text: "x",
        picks: { pasteBack: "off", pasteBackPose: "on" },
      }),
      null,
    );
    expect(off.params).toEqual({
      pack_id: "fibo2",
      prompt: "x",
      pasteBack: false,
    });
  });

  it.each(["edit_flux3", "edit_qwen21"])(
    "%s: paste-back only when an area is named",
    (id) => {
      const none = buildActionRequest(
        spec(id),
        settings(id, { text: "x" }),
        null,
      );
      expect(none.params).not.toHaveProperty("pasteBack");
      const area = buildActionRequest(
        spec(id),
        settings(id, { text: "x", secondText: "the sky" }),
        null,
      );
      expect(area.params).toMatchObject({
        pasteBack: true,
        pasteBackArea: "the sky",
      });
      const off = buildActionRequest(
        spec(id),
        settings(id, {
          text: "x",
          secondText: "the sky",
          picks: { pasteBack: "off" },
        }),
        null,
      );
      expect(off.params).not.toHaveProperty("pasteBack");
    },
  );

  it("remove_object: on by default, the removal text is the region", () => {
    const resp: EditLoraListResponse = {
      families: { krea2edit: { label: "Krea 2 edit" } },
      loras: [
        {
          id: "k1",
          name: "K1",
          file: "k1.safetensors",
          family: "krea2edit",
          base: "krea2",
          defaultStrength: 0.9,
          installed: true,
        },
      ] as EditLoraListResponse["loras"],
    };
    const req = buildActionRequest(
      spec("remove_object"),
      settings("remove_object", { text: "the person on the left" }),
      resp,
    );
    expect(req.params).toMatchObject({
      pasteBack: true,
      pasteBackArea: "the person on the left",
    });
    const off = buildActionRequest(
      spec("remove_object"),
      settings("remove_object", { text: "x", picks: { pasteBack: "off" } }),
      resp,
    );
    expect(off.params).not.toHaveProperty("pasteBack");
  });

  it("restyle / replace person / upscale get no paste-back pickers", () => {
    for (const id of ["restyle_locked", "replace_person", "upscale"]) {
      expect(
        spec(id)?.pickers?.some((p) => p.key.startsWith("pasteBack")) ?? false,
      ).toBe(false);
    }
  });
});

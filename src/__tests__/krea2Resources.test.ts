/**
 * Coverage for the krea2 community-resource integration wave:
 *   - fal Krea-2 style-LoRA catalog (lookup / triggers / search)
 *   - krea2-raw (turbo-distill) and krea2-edit workflow packs
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  findStyleLora,
  getStyleLoraTriggers,
  searchStyleLoras,
  getStyleLoraCatalog,
  getStyleLoraCount,
  styleLoraFilename,
} from "@/lib/krea2/styleLoras";
import { getPack, resolveWorkflow } from "@/lib/oj/packs";
import { discoverT2ISlots } from "@/lib/oj/discovery";
import { applyOstrisEditKvCache, buildActionWorkflow } from "@/lib/oj/engine";
import registry from "@/lib/oj/registry.json";
import {
  editActionFor,
  getBuiltinEditLoras,
  getEditFamilies,
  mergeEditLoras,
} from "@/lib/krea2/editLoras";
import type { ImagineRun, Workflow } from "@/types";

const WORKFLOWS_DIR = path.join(process.cwd(), "public", "workflows");

function loadWorkflow(
  rel: string,
): Record<string, { class_type: string; inputs?: Record<string, unknown> }> {
  return JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, rel), "utf-8"));
}

function danglingRefs(
  graph: Record<string, { inputs?: Record<string, unknown> }>,
): string[] {
  const ids = new Set(Object.keys(graph));
  const bad: string[] = [];
  for (const [nodeId, node] of Object.entries(graph)) {
    for (const val of Object.values(node.inputs ?? {})) {
      if (
        Array.isArray(val) &&
        typeof val[0] === "string" &&
        !ids.has(val[0])
      ) {
        bad.push(`${nodeId} -> ${val[0]}`);
      }
    }
  }
  return bad;
}

describe("krea2 style-LoRA catalog", () => {
  it("has a populated catalog", () => {
    expect(getStyleLoraCount()).toBeGreaterThan(1000);
    expect(getStyleLoraCatalog().length).toBe(getStyleLoraCount());
  });

  it("resolves an entry by id, by basename, and by full filename", () => {
    const first = getStyleLoraCatalog()[0];
    expect(findStyleLora(first.id)?.id).toBe(first.id);
    expect(findStyleLora(styleLoraFilename(first.id))?.id).toBe(first.id);
    expect(findStyleLora(`loras/${styleLoraFilename(first.id)}`)?.id).toBe(
      first.id,
    );
  });

  it("returns the trigger phrase for a catalog LoRA and [] for others", () => {
    const first = getStyleLoraCatalog()[0];
    expect(getStyleLoraTriggers(styleLoraFilename(first.id))).toEqual([
      first.trigger,
    ]);
    expect(
      getStyleLoraTriggers("some-random-civitai-lora.safetensors"),
    ).toEqual([]);
  });

  it("searches case-insensitively over id and name", () => {
    const hits = searchStyleLoras("watercolor", 50);
    expect(hits.length).toBeGreaterThan(0);
    expect(
      hits.every(
        (h) =>
          h.id.includes("watercolor") ||
          h.name.toLowerCase().includes("watercolor"),
      ),
    ).toBe(true);
  });
});

describe("krea2-raw (turbo-distill) pack", () => {
  it("is registered and resolves t2i to its own workflow", () => {
    const pack = getPack("krea2-raw");
    expect(pack?.modelFamily).toBe("krea2-raw");
    const resolved = resolveWorkflow({
      templateOrAction: "t2i",
      packId: "krea2-raw",
    });
    expect(resolved.workflowPath).toBe("packs/krea2-raw/t2i.json");
    expect(resolved.pack?.defaultOverrides.cfg).toBe(0);
  });

  it("t2i workflow loads Raw + the distill LoRA and has no dangling refs", () => {
    const wf = loadWorkflow("packs/krea2-raw/t2i.json");
    expect(danglingRefs(wf)).toEqual([]);
    const loras = Object.values(wf).filter(
      (n) => n.class_type === "LoraLoaderModelOnly",
    );
    expect(
      loras.some(
        (n) => n.inputs?.lora_name === "krea2_turbo_distill_r128.safetensors",
      ),
    ).toBe(true);
    const unet = Object.values(wf).find((n) => n.class_type === "UNETLoader");
    expect(unet?.inputs?.unet_name).toBe("krea2_raw_bf16.safetensors");
  });
});

describe("krea2-edit pack", () => {
  it("is registered and resolves the edit action", () => {
    const pack = getPack("krea2-edit");
    expect(pack?.modelFamily).toBe("krea2-edit");
    expect(
      resolveWorkflow({ templateOrAction: "edit", packId: "krea2-edit" })
        .workflowPath,
    ).toBe("packs/krea2-edit/edit_v2.json");
  });

  it("edit workflow wires the krea2edit nodes with no dangling refs", () => {
    const wf = loadWorkflow("packs/krea2-edit/edit.json");
    expect(danglingRefs(wf)).toEqual([]);
    const types = Object.values(wf).map((n) => n.class_type);
    expect(types).toContain("Krea2EditModelPatch");
    expect(types).toContain("Krea2EditGroundedEncode");
  });

  it("resolves edit_structural and stacks edit + depth-control patches", () => {
    expect(
      resolveWorkflow({
        templateOrAction: "edit_structural",
        packId: "krea2-edit",
      }).workflowPath,
    ).toBe("packs/krea2-edit/edit_depth.json");
    const wf = loadWorkflow("packs/krea2-edit/edit_depth.json");
    expect(danglingRefs(wf)).toEqual([]);
    const types = Object.values(wf).map((n) => n.class_type);
    // both model-patch chains present: identity-edit + krea2 depth control
    expect(types).toContain("Krea2EditModelPatch");
    expect(types).toContain("Krea2ControlLoRALoader");
    expect(types).toContain("Krea2ControlApply");
  });

  it("wires instruction + source injection for both edit workflows", () => {
    for (const file of [
      "packs/krea2-edit/edit.json",
      "packs/krea2-edit/edit_depth.json",
    ]) {
      const wf = loadWorkflow(file) as Parameters<typeof discoverT2ISlots>[0];
      const slots = discoverT2ISlots(wf);
      // instruction must land on Krea2EditGroundedEncode.prompt, not .text
      expect(slots.posTextInputName).toBe("prompt");
      expect(
        (wf as Record<string, { class_type: string }>)[slots.posTextId]
          .class_type,
      ).toBe("Krea2EditGroundedEncode");
      // a LoadImage exists for the source-image injection
      expect(
        Object.values(wf as Record<string, { class_type: string }>).some(
          (n) => n.class_type === "LoadImage",
        ),
      ).toBe(true);
    }
  });

  it("buildActionWorkflow points source injection at the edit LoadImage", () => {
    const sourceRun = {
      run_id: "run-x",
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
          images: ["out/portrait.png [output]"],
          prompt_id: "p-x",
        },
      ],
      createdAt: new Date().toISOString(),
      status: "done",
      params: {},
    } as unknown as ImagineRun;
    const wf = loadWorkflow(
      "packs/krea2-edit/edit_depth.json",
    ) as unknown as Workflow;
    const { slots } = buildActionWorkflow(wf, "edit_structural", sourceRun, 0);
    // source image is routed to the LoadImage node (5), instruction to node 8
    expect((slots as { imageInputId?: string }).imageInputId).toBe("5");
    expect(slots.posTextId).toBe("8");
    expect(slots.posTextInputName).toBe("prompt");
  });

  it("stacks an extra --lora onto the stack slot, preserving the edit LoRA and prompt", () => {
    const sourceRun = {
      run_id: "run-y",
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
          images: ["out/portrait.png [output]"],
          prompt_id: "p-y",
        },
      ],
      createdAt: new Date().toISOString(),
      status: "done",
      params: {},
    } as unknown as ImagineRun;
    const wf = loadWorkflow(
      "packs/krea2-edit/edit.json",
    ) as unknown as Workflow;
    const { workflow, slots } = buildActionWorkflow(
      wf,
      "edit_instruct",
      sourceRun,
      0,
      { prompt: "make it snowy --lora extra_style.safetensors::0.8" },
    );
    // Node 2 (edit LoRA, owned by the dropdown) is excluded from the --lora
    // targets; the extra LoRA routes to the stack slot (node 30) instead.
    expect(slots.loraLoaderIds).not.toContain("2");
    expect(slots.loraLoaderIds).toContain("30");
    const w = workflow as unknown as Record<
      string,
      { inputs?: Record<string, unknown> }
    >;
    expect(w["2"].inputs?.lora_name).toBe("krea2_identity_edit_v1.safetensors");
    expect(w["30"].inputs?.lora_name).toBe("extra_style.safetensors");
    expect(w["30"].inputs?.strength_model).toBe(0.8);
    // The clean instruction drives the grounded encode.
    expect(w[slots.posTextId].inputs?.prompt).toBe("make it snowy");
  });

  it("registers edit actions requiring a source image", () => {
    const actions = registry.actions as Record<
      string,
      { requiresImage?: boolean; template?: string }
    >;
    for (const id of [
      "edit_instruct",
      "edit_structural",
      "edit_ostris",
      "edit_qwen",
    ]) {
      expect(actions[id]?.requiresImage).toBe(true);
      expect(actions[id]?.template).toBe(id);
    }
  });
});

describe("edit-LoRA registry + family routing", () => {
  it("decodes registry entries that predate the optional kvCache field", () => {
    const selfie = getBuiltinEditLoras().find((l) => l.id === "selfie");
    expect(selfie?.kvCache).toBeUndefined();
  });

  it("maps each family to the right action, honoring structure-lock", () => {
    expect(editActionFor("krea2edit")).toBe("edit_instruct");
    expect(editActionFor("krea2edit", true)).toBe("edit_structural");
    expect(editActionFor("ostris")).toBe("edit_ostris");
    // ostris has no structural variant -> falls back to its base action
    expect(editActionFor("ostris", true)).toBe("edit_ostris");
  });

  it("seeds builtin edit LoRAs tagged by family", () => {
    const loras = getBuiltinEditLoras();
    expect(loras.find((l) => l.id === "identity-edit")?.family).toBe(
      "krea2edit",
    );
    expect(loras.find((l) => l.id === "selfie")?.family).toBe("ostris");
    // merge keeps builtins and adds custom entries
    const merged = mergeEditLoras([
      {
        id: "x",
        name: "X",
        file: "x.safetensors",
        family: "ostris",
        base: "krea2-raw",
        defaultStrength: 1,
      },
    ]);
    expect(merged.some((l) => l.id === "x" && l.custom)).toBe(true);
    expect(merged.some((l) => l.id === "identity-edit")).toBe(true);
  });

  it("registers the Qwen-Image-Edit pack + family and routes edit_qwen", () => {
    const pack = getPack("qwen-image-edit");
    expect(pack?.modelFamily).toBe("qwen-image-edit");
    expect(
      resolveWorkflow({
        templateOrAction: "edit_qwen",
        packId: "qwen-image-edit",
      }).workflowPath,
    ).toBe("packs/qwen-image-edit/edit.json");
    expect(editActionFor("qwen")).toBe("edit_qwen");
    // family + multi-angle builtin LoRA are seeded
    expect(getEditFamilies().qwen?.action).toBe("edit_qwen");
    expect(
      getBuiltinEditLoras().find((l) => l.id === "qwen-multi-angle")?.family,
    ).toBe("qwen");
  });

  it("qwen edit workflow wires cleanly and lands the instruction on the Qwen encoder", () => {
    const wf = loadWorkflow("packs/qwen-image-edit/edit.json");
    expect(danglingRefs(wf)).toEqual([]);
    const types = Object.values(wf).map((n) => n.class_type);
    expect(types).toContain("TextEncodeQwenImageEditPlus");
    expect(types).toContain("ModelSamplingAuraFlow");
    const slots = discoverT2ISlots(
      wf as Parameters<typeof discoverT2ISlots>[0],
    );
    expect(slots.posTextInputName).toBe("prompt");
    expect(
      (wf as Record<string, { class_type: string }>)[slots.posTextId]
        .class_type,
    ).toBe("TextEncodeQwenImageEditPlus");
  });

  it("routes --lora to the stack slot, preserving the Qwen edit + Lightning LoRAs", () => {
    const sourceRun = {
      run_id: "run-q",
      prompt: "figure",
      parsedPrompt: "figure",
      width: 1024,
      height: 1024,
      jobs: [
        {
          seed: 1,
          index: 0,
          status: "done",
          progress: 100,
          images: ["out/figure.png [output]"],
          prompt_id: "p-q",
        },
      ],
      createdAt: new Date().toISOString(),
      status: "done",
      params: {},
    } as unknown as ImagineRun;
    const wf = loadWorkflow(
      "packs/qwen-image-edit/edit.json",
    ) as unknown as Workflow;
    const { workflow, slots } = buildActionWorkflow(
      wf,
      "edit_qwen",
      sourceRun,
      0,
      { prompt: "turn to a 3/4 view --lora extra.safetensors" },
    );
    // Only the dedicated stack slot (30) receives --lora; the edit LoRA (2) and
    // the fixed Lightning LoRA (3) are left intact.
    expect(slots.loraLoaderIds).toEqual(["30"]);
    const w = workflow as unknown as Record<
      string,
      { inputs?: Record<string, unknown> }
    >;
    expect(w["2"].inputs?.lora_name).toBe(
      "qwen-image-edit-2511-multiple-angles-lora.safetensors",
    );
    expect(w["3"].inputs?.lora_name).toBe(
      "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
    );
    expect(w["30"].inputs?.lora_name).toBe("extra.safetensors");
    expect(w[slots.posTextId].inputs?.prompt).toBe("turn to a 3/4 view");
  });

  it("ostris edit workflow uses shared node ids (2=lora, 5=source, 8=prompt)", () => {
    expect(
      resolveWorkflow({ templateOrAction: "edit_ostris", packId: "krea2-edit" })
        .workflowPath,
    ).toBe("packs/krea2-edit/edit_ostris.json");
    const wf = loadWorkflow("packs/krea2-edit/edit_ostris.json");
    expect(danglingRefs(wf)).toEqual([]);
    expect(wf["2"].class_type).toBe("LoraLoaderModelOnly");
    expect(wf["5"].class_type).toBe("LoadImage");
    expect(wf["8"].class_type).toBe("TextEncodeKrea2OstrisEdit");
    const types = Object.values(wf).map((n) => n.class_type);
    expect(types).toContain("Krea2OstrisEditModelPatch");
    // discovery resolves the prompt field + source injection
    const slots = discoverT2ISlots(
      wf as Parameters<typeof discoverT2ISlots>[0],
    );
    expect(slots.posTextInputName).toBe("prompt");
    expect(slots.posTextId).toBe("8");
  });
});

describe("Ostris edit kv_cache", () => {
  const ostrisPatchGraph = (): Workflow => ({
    "7": {
      class_type: "Krea2OstrisEditModelPatch",
      inputs: { model: ["2", 0] },
    },
    "8": {
      class_type: "KSampler",
      inputs: { model: ["7", 0] },
    },
  });

  it("leaves an older graph unchanged when the registry flag is absent", () => {
    const workflow = ostrisPatchGraph();
    const before = structuredClone(workflow);

    applyOstrisEditKvCache(workflow, false);

    expect(workflow).toEqual(before);
  });

  it("sets kv_cache only on the Ostris edit model-patch node when enabled", () => {
    const workflow = ostrisPatchGraph();

    applyOstrisEditKvCache(workflow, true);

    expect(workflow["7"].inputs.kv_cache).toBe(true);
    expect(workflow["8"].inputs.kv_cache).toBeUndefined();
  });
});

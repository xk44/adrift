/**
 * Optional-node bypass: missing `_meta.optional` nodes are dropped and their
 * consumers rewired to the matching pass-through inputs.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bypassMissingOptionalNodes,
  isOptionalNode,
} from "@/lib/comfy/optionalNodes";
import { findMissingClassTypes } from "@/lib/comfy/validatePrompt";
import {
  analyzeWorkflowGraph,
  computePackNodeAvailability,
} from "@/lib/comfy/packNodeAvailability";
import { applyWorkflowFallback } from "@/lib/comfy/workflows";
import { computeAvailability, getEditTool } from "@/lib/tools/editTools";
import type { WorkflowPack } from "@/lib/oj/packs";

type Spec = { inputs?: Record<string, string>; outputs?: string[] };
/** Minimal object_info: `{ Class: { input: { required }, output } }`. */
function info(defs: Record<string, Spec>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(defs).map(([ct, d]) => [
      ct,
      {
        input: {
          required: Object.fromEntries(
            Object.entries(d.inputs ?? {}).map(([k, t]) => [k, [t]]),
          ),
        },
        output: d.outputs ?? [],
      },
    ]),
  );
}

const BASE = info({
  UNETLoader: { outputs: ["MODEL"] },
  CLIPLoader: { outputs: ["CLIP"] },
  CLIPTextEncode: {
    inputs: { clip: "CLIP", text: "STRING" },
    outputs: ["CONDITIONING"],
  },
  KSampler: {
    inputs: {
      model: "MODEL",
      positive: "CONDITIONING",
      negative: "CONDITIONING",
    },
    outputs: ["LATENT"],
  },
  ModelSamplingAuraFlow: { inputs: { model: "MODEL" }, outputs: ["MODEL"] },
});

const negpip = (
  model: unknown,
  clip: unknown,
  meta: Record<string, unknown> = {},
) => ({
  class_type: "ApplyKrea2NegPiP",
  inputs: { model, clip, value_strength: 1 },
  _meta: { title: "NegPiP", optional: true, ...meta },
});

function graph(
  extra: Record<string, unknown>,
  modelRef: unknown,
  clipRef: unknown,
) : Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  return {
    "1": { class_type: "UNETLoader", inputs: {} },
    "2": { class_type: "CLIPLoader", inputs: {} },
    ...(extra as Record<string, { class_type: string; inputs: Record<string, unknown> }>),
    "6": { class_type: "CLIPTextEncode", inputs: { clip: clipRef, text: "a" } },
    "7": { class_type: "CLIPTextEncode", inputs: { clip: clipRef, text: "b" } },
    "8": {
      class_type: "KSampler",
      inputs: { model: modelRef, positive: ["6", 0], negative: ["7", 0] },
    },
  };
}

describe("bypassMissingOptionalNodes", () => {
  it("rewires MODEL/CLIP consumers to the node's pass-through inputs", () => {
    const g = graph({ "5": negpip(["1", 0], ["2", 0]) }, ["5", 0], ["5", 1]);
    const { prompt, bypassed } = bypassMissingOptionalNodes(g, BASE);
    expect(prompt).not.toHaveProperty("5");
    expect(prompt["8"].inputs.model).toEqual(["1", 0]);
    expect(prompt["6"].inputs.clip).toEqual(["2", 0]);
    expect(prompt["7"].inputs.clip).toEqual(["2", 0]);
    expect(bypassed).toEqual([
      {
        nodeId: "5",
        classType: "ApplyKrea2NegPiP",
        title: "NegPiP",
        warning:
          "NegPiP (ApplyKrea2NegPiP) not installed — skipped; the result runs without it",
      },
    ]);
    expect(findMissingClassTypes(prompt, BASE)).toEqual([]);
    // input untouched
    expect(g["8"].inputs.model).toEqual(["5", 0]);
  });

  it("matches by type even when input order differs from output order", () => {
    const node = {
      class_type: "Swapped",
      inputs: { clip: ["2", 0], model: ["1", 0] },
      _meta: { optional: true },
    };
    const { prompt } = bypassMissingOptionalNodes(
      graph({ "5": node }, ["5", 1], ["5", 0]),
      BASE,
    );
    expect(prompt["8"].inputs.model).toEqual(["1", 0]);
    expect(prompt["6"].inputs.clip).toEqual(["2", 0]);
  });

  it("resolves chained optional nodes", () => {
    const g = graph(
      {
        "4": negpip(["1", 0], ["2", 0], { title: "first" }),
        "5": negpip(["4", 0], ["4", 1], { title: "second" }),
      },
      ["5", 0],
      ["5", 1],
    );
    const { prompt, bypassed } = bypassMissingOptionalNodes(g, BASE);
    expect(Object.keys(prompt).sort()).toEqual(["1", "2", "6", "7", "8"]);
    expect(prompt["8"].inputs.model).toEqual(["1", 0]);
    expect(prompt["6"].inputs.clip).toEqual(["2", 0]);
    expect(bypassed.map((b) => b.nodeId).sort()).toEqual(["4", "5"]);
  });

  it("resolves a chain through an installed node in between", () => {
    const g = graph(
      {
        "3": negpip(["1", 0], ["2", 0]),
        "4": {
          class_type: "ModelSamplingAuraFlow",
          inputs: { model: ["3", 0] },
        },
      },
      ["4", 0],
      ["3", 1],
    );
    const { prompt } = bypassMissingOptionalNodes(g, BASE);
    expect(prompt["4"].inputs.model).toEqual(["1", 0]);
    expect(prompt["6"].inputs.clip).toEqual(["2", 0]);
  });

  it("honours an explicit _meta.passthrough map", () => {
    const node = {
      class_type: "Odd",
      inputs: { a: ["1", 0], b: ["1", 0] },
      _meta: { optional: true, passthrough: { "0": "b" } },
    };
    const g = {
      "1": { class_type: "UNETLoader", inputs: {} },
      "5": node,
      "8": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["5", 0] } },
    };
    const { prompt } = bypassMissingOptionalNodes(g, BASE);
    expect(prompt["8"].inputs.model).toEqual(["1", 0]);
  });

  it("falls back to position when types are unknown", () => {
    const g = {
      "1": { class_type: "UNETLoader", inputs: {} },
      "2": { class_type: "CLIPLoader", inputs: {} },
      "5": {
        class_type: "Opt",
        inputs: { x: ["1", 0], y: ["2", 0] },
        _meta: { optional: true },
      },
      "9": { class_type: "UnknownConsumer", inputs: { p: ["5", 1] } },
    };
    const { prompt } = bypassMissingOptionalNodes(g, BASE);
    expect(prompt["9"].inputs.p).toEqual(["2", 0]);
  });

  it("uses _meta.optional_warning as the user message", () => {
    const g = graph(
      {
        "5": negpip(["1", 0], ["2", 0], {
          optional_warning:
            "NegPiP not installed — negative prompt uses standard CFG",
        }),
      },
      ["5", 0],
      ["5", 1],
    );
    expect(bypassMissingOptionalNodes(g, BASE).bypassed[0].warning).toBe(
      "NegPiP not installed — negative prompt uses standard CFG",
    );
  });

  it("never touches non-optional missing nodes", () => {
    const node = { ...negpip(["1", 0], ["2", 0]), _meta: { title: "NegPiP" } };
    const g = graph({ "5": node }, ["5", 0], ["5", 1]);
    const r = bypassMissingOptionalNodes(g, BASE);
    expect(r.prompt).toBe(g);
    expect(r.bypassed).toEqual([]);
    expect(findMissingClassTypes(r.prompt, BASE)).toEqual(["ApplyKrea2NegPiP"]);
  });

  it("keeps an optional node it cannot bypass (fails loudly downstream)", () => {
    const g = {
      "2": { class_type: "CLIPLoader", inputs: {} },
      "5": {
        class_type: "Opt",
        inputs: { clip: ["2", 0] },
        _meta: { optional: true },
      },
      "8": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["5", 0] } },
    };
    const r = bypassMissingOptionalNodes(g, BASE);
    expect(r.prompt).toBe(g);
    expect(r.bypassed).toEqual([]);
  });

  it("leaves installed optional nodes in place", () => {
    const oi = {
      ...BASE,
      ...info({ ApplyKrea2NegPiP: { outputs: ["MODEL", "CLIP"] } }),
    };
    const g = graph({ "5": negpip(["1", 0], ["2", 0]) }, ["5", 0], ["5", 1]);
    const r = bypassMissingOptionalNodes(g, oi);
    expect(r.prompt).toBe(g);
    expect(r.bypassed).toEqual([]);
  });

  it("isOptionalNode requires _meta.optional === true", () => {
    expect(isOptionalNode({ _meta: { optional: true } })).toBe(true);
    expect(isOptionalNode({ _meta: { optional: "yes" } })).toBe(false);
    expect(isOptionalNode({})).toBe(false);
  });
});

describe("krea2_draft.json NegPiP", () => {
  const draft = JSON.parse(
    readFileSync(
      join(process.cwd(), "public/workflows/krea2_draft.json"),
      "utf8",
    ),
  ) as Record<string, { class_type?: string; inputs: Record<string, unknown> }>;
  const oi = {
    ...BASE,
    ...info({
      UnetLoaderGGUF: { outputs: ["MODEL"] },
      LoraLoaderModelOnly: { inputs: { model: "MODEL" }, outputs: ["MODEL"] },
      "ComfyUI-Krea2T-Enhancer": {
        inputs: { model: "MODEL" },
        outputs: ["MODEL"],
      },
      ConditioningKrea2Rebalance: {
        inputs: { conditioning: "CONDITIONING" },
        outputs: ["CONDITIONING"],
      },
      EmptySD3LatentImage: { outputs: ["LATENT"] },
      KSampler: {
        inputs: {
          model: "MODEL",
          positive: "CONDITIONING",
          negative: "CONDITIONING",
          latent_image: "LATENT",
        },
        outputs: ["LATENT"],
      },
      VAELoader: { outputs: ["VAE"] },
      VAEDecode: {
        inputs: { samples: "LATENT", vae: "VAE" },
        outputs: ["IMAGE"],
      },
      SaveImage: { inputs: { images: "IMAGE" } },
    }),
  };

  it("bypasses to the enhancer MODEL and the CLIPLoader CLIP", () => {
    const { prompt, bypassed } = bypassMissingOptionalNodes(draft, oi);
    expect(prompt).not.toHaveProperty("5");
    expect(prompt["10"].inputs.model).toEqual(["3", 0]);
    expect(prompt["6"].inputs.clip).toEqual(["4", 0]);
    expect(prompt["8"].inputs.clip).toEqual(["4", 0]);
    expect(bypassed[0].warning).toBe(
      "NegPiP not installed — negative prompt uses standard CFG",
    );
    expect(findMissingClassTypes(prompt, oi)).toEqual([]);
    expect(analyzeWorkflowGraph(draft, oi)).toEqual({
      format: "api",
      missing: [],
      optionalMissing: ["ApplyKrea2NegPiP"],
    });
  });
});

describe("krea2 outpaint fallback", () => {
  const OUTPAINT_V2 = [
    "Krea2OutpaintModelPatch",
    "TextEncodeKrea2Outpaint",
    "Krea2OutpaintComposite",
  ];
  const v2 = JSON.parse(
    readFileSync(
      join(process.cwd(), "public/workflows/packs/krea2/outpaintv2.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const v1 = JSON.parse(
    readFileSync(
      join(process.cwd(), "public/workflows/packs/krea2/outpaint.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const classes = (g: Record<string, unknown>) =>
    Object.values(g).flatMap((n) =>
      n && typeof n === "object" && "class_type" in n
        ? [String((n as { class_type: unknown }).class_type)]
        : [],
    );
  /** Every class of both graphs installed, minus `drop`. */
  const oiWithout = (drop: string[]) =>
    info(
      Object.fromEntries(
        [...classes(v1), ...classes(v2)]
          .filter((c) => !drop.includes(c))
          .map((c) => [c, {}]),
      ),
    );

  it("v2 declares the core v1 graph as its fallback", () => {
    expect(v2._fallback).toMatchObject({ file: "packs/krea2/outpaint.json" });
    expect(classes(v1)).toContain("ImagePadForOutpaint");
    for (const c of OUTPAINT_V2) expect(classes(v1)).not.toContain(c);
  });

  it("applyWorkflowFallback swaps in v1 only when outpaint nodes are missing", async () => {
    expect(
      await applyWorkflowFallback(v2, "outpaintv2.json", oiWithout([])),
    ).toBe(v2);
    expect(await applyWorkflowFallback(v2, "outpaintv2.json", null)).toBe(v2);
    const fb = (await applyWorkflowFallback(
      v2,
      "outpaintv2.json",
      oiWithout(OUTPAINT_V2),
    )) as Record<string, unknown>;
    expect(classes(fb)).toEqual(classes(v1));
  });

  it("pack availability reports the fallback instead of missing nodes", async () => {
    const p = {
      id: "krea2",
      workflows: { outpaint: "outpaintv2.json" },
    } as unknown as WorkflowPack;
    const readGraph = async (_id: string, file: string) =>
      file === "outpaintv2.json"
        ? v2
        : file === "packs/krea2/outpaint.json"
          ? v1
          : undefined;
    const r = await computePackNodeAvailability(oiWithout(OUTPAINT_V2), {
      packs: [p],
      readGraph,
    });
    expect(r.packs.krea2.outpaint).toMatchObject({
      file: "outpaintv2.json",
      missing: [],
      fallback: {
        file: "packs/krea2/outpaint.json",
        primaryMissing: [...OUTPAINT_V2].sort(),
      },
    });
    expect(r.missingClassTypes).toEqual([]);
  });

  it("krea2-outpaint tool reports missingNodes and is unavailable", async () => {
    const tool = getEditTool("krea2-outpaint");
    expect(tool).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), "cj-avail-"));
    const missing = await computeAvailability(
      tool!,
      root,
      new Set(),
      undefined,
      oiWithout(OUTPAINT_V2),
    );
    expect(missing.packAvailable).toBe(false);
    expect(missing.missingNodes).toEqual(
      expect.arrayContaining(["Krea2OutpaintModelPatch"]),
    );
    const unknown = await computeAvailability(
      tool!,
      root,
      new Set(),
      undefined,
      null,
    );
    expect(unknown.missingNodes).toBeUndefined();
  });
});

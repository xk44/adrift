/**
 * Subgraph robustness fixtures (hand-built, no custom nodes / GPU needed):
 * nested subgraphs, promoted widgets (legacy instance widgets and the newer
 * properties.proxyWidgets form), one definition used twice, links crossing
 * the boundary in every direction, bypass/mute/reroute/primitive handling,
 * and the loud WorkflowGraphError cases that used to yield silently wrong
 * graphs.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  flattenComposedWorkflow,
  flattenComposedWorkflowDetailed,
  parseWorkflowJson,
  WorkflowGraphError,
} from "@/lib/comfy/workflows";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const FIX = path.join(__dirname, "fixtures", "subgraphs");
const load = (name: string): Any =>
  JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8"));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function expectGraphError(fn: () => unknown, code: string, msg: RegExp) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(WorkflowGraphError);
    expect((err as WorkflowGraphError).code).toBe(code);
    expect((err as Error).message).toMatch(msg);
    return;
  }
  throw new Error(`expected WorkflowGraphError(${code})`);
}

describe("subgraph fixtures", () => {
  it("nested: top → outer → inner subgraph resolves through two boundaries", () => {
    const wf = flattenComposedWorkflow(load("nested.json"))!;
    expect(wf["2/10/20"]).toEqual({
      class_type: "CLIPTextEncode",
      inputs: { text: "a lighthouse at dusk", clip: ["1", 1] },
    });
    expect(wf["3"].inputs.conditioning).toEqual(["2/10/20", 0]);
    // Instances themselves never reach the API graph.
    expect(wf["2"]).toBeUndefined();
    expect(wf["2/10"]).toBeUndefined();
  });

  it("widget promotion: an unlinked promoted widget takes the instance value", () => {
    const wf = flattenComposedWorkflow(load("promotion.json"))!;
    expect(wf["2/20"].inputs.text).toBe("promoted: a red fox");
    expect(wf["2/20"].inputs.clip).toEqual(["1", 1]);
  });

  it("widget promotion: a linked promoted input wins over the instance value", () => {
    const f = load("promotion.json");
    f.nodes.push({
      id: 9,
      type: "PrimitiveNode",
      outputs: [{ name: "STRING", type: "STRING" }],
      widgets_values: ["from primitive"],
    });
    f.links.push([9, 9, 0, 2, 1, "STRING"]);
    f.nodes[1].inputs[1].link = 9;
    const wf = flattenComposedWorkflow(f)!;
    expect(wf["2/20"].inputs.text).toBe("from primitive");
    expect(wf["9"]).toBeUndefined();
  });

  it("used twice: each instance keeps its own inner nodes and values", () => {
    const wf = flattenComposedWorkflow(load("used-twice.json"))!;
    expect(wf["2/20"].inputs.text).toBe("a cat");
    expect(wf["4/20"].inputs.text).toBe("a dog");
    expect(wf["5"].inputs.positive).toEqual(["2/20", 0]);
    expect(wf["6"].inputs.negative).toEqual(["4/20", 0]);
  });

  it("proxyWidgets: per-instance values land on the inner node; $$ entries ignored", () => {
    const wf = flattenComposedWorkflow(load("proxy-widgets.json"))!;
    expect(wf["2/20"].inputs.text).toBe("proxy: a cat");
    expect(wf["4/20"].inputs.text).toBe("proxy: a dog");
    expect(Object.keys(wf["2/20"].inputs)).not.toContain(
      "$$canvas-image-preview",
    );
  });

  it("boundary crossings: passthrough, fan-out inside and outside", () => {
    const wf = flattenComposedWorkflow(load("boundary-crossing.json"))!;
    // input → output passthrough
    expect(wf["3"].inputs.model).toEqual(["1", 0]);
    // one external source feeding two instance inputs
    expect(wf["2/30"].inputs.clip1).toEqual(["1", 1]);
    expect(wf["2/30"].inputs.clip2).toEqual(["1", 1]);
    expect(wf["2/30"].inputs.ratio).toBe(0.25);
    // one inner node behind two outputs; one output used twice outside
    expect(wf["4"].inputs.clip).toEqual(["2/30", 0]);
    expect(wf["5"].inputs.clip).toEqual(["2/30", 0]);
    expect(wf["6"].inputs.clip).toEqual(["2/30", 0]);
  });

  it("parseWorkflowJson flattens fixtures end to end", () => {
    const wf = parseWorkflowJson(load("nested.json"), "nested.json");
    expect(wf["2/10/20"].class_type).toBe("CLIPTextEncode");
  });
});

describe("bypass / mute / reroute inside subgraphs", () => {
  it("bypassed inner node forwards its same-typed input", () => {
    const f = load("nested.json");
    const inner = f.definitions.subgraphs[1];
    inner.nodes.push({
      id: 21,
      type: "ConditioningTweak",
      mode: 4,
      inputs: [{ name: "conditioning", type: "CONDITIONING", link: 32 }],
      outputs: [{ name: "CONDITIONING", type: "CONDITIONING" }],
    });
    inner.links = [
      inner.links[0],
      { id: 32, origin_id: 20, origin_slot: 0, target_id: 21, target_slot: 0 },
      { id: 34, origin_id: 21, origin_slot: 0, target_id: -20, target_slot: 0 },
    ];
    const wf = flattenComposedWorkflow(f)!;
    expect(wf["2/10/21"]).toBeUndefined();
    expect(wf["3"].inputs.conditioning).toEqual(["2/10/20", 0]);
  });

  it("muted node leaves its consumers empty with a warning", () => {
    const f = load("promotion.json");
    f.nodes[0].mode = 2;
    const { workflow, warnings } = flattenComposedWorkflowDetailed(f);
    expect(workflow!["1"]).toBeUndefined();
    expect(workflow!["2/20"].inputs.clip).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/clip/);
  });

  it("reroute between top-level node and instance is collapsed", () => {
    const f = load("promotion.json");
    f.nodes.push({
      id: 7,
      type: "Reroute",
      inputs: [{ name: "", type: "*", link: 1 }],
      outputs: [{ name: "", type: "CLIP" }],
    });
    f.links = [
      [1, 1, 1, 7, 0, "CLIP"],
      [8, 7, 0, 2, 0, "CLIP"],
      [2, 2, 0, 3, 0, "CONDITIONING"],
    ];
    f.nodes[1].inputs[0].link = 8;
    const wf = flattenComposedWorkflow(f)!;
    expect(wf["2/20"].inputs.clip).toEqual(["1", 1]);
    expect(wf["7"]).toBeUndefined();
  });

  it("unconnected optional subgraph input is a warning, not an error", () => {
    const f = load("promotion.json");
    f.nodes[1].inputs[0].link = null;
    f.links = f.links.filter((l: Any) => l[0] !== 1);
    const { workflow, warnings } = flattenComposedWorkflowDetailed(f);
    expect(workflow!["2/20"].inputs.clip).toBeUndefined();
    expect(warnings[0]).toMatch(
      /"prompt encoder" input "clip", which nothing is connected to/,
    );
  });

  it("stale links are reported as warnings", () => {
    const f = load("nested.json");
    f.links.push([99, 1, 0, 404, 0, "MODEL"]);
    const { warnings } = flattenComposedWorkflowDetailed(f);
    expect(warnings.some((w) => /stale link 99/.test(w))).toBe(true);
  });
});

describe("loud subgraph errors", () => {
  it("missing_subgraph: instance of an undefined subgraph", () => {
    const f = load("nested.json");
    f.definitions.subgraphs = [f.definitions.subgraphs[0]]; // drop inner
    expectGraphError(
      () => flattenComposedWorkflow(f),
      "missing_subgraph",
      /22222222-2222-4222-8222-222222222222.*not in definitions\.subgraphs/,
    );
    // parseWorkflowJson must surface it too (not fall back to a wrong graph)
    expect(() => parseWorkflowJson(clone(f), "x.json")).toThrow(
      WorkflowGraphError,
    );
  });

  it("subgraph_cycle: a subgraph containing itself (via another)", () => {
    const f = load("nested.json");
    const inner = f.definitions.subgraphs[1];
    inner.nodes.push({
      id: 25,
      type: "11111111-1111-4111-8111-111111111111",
      inputs: [{ name: "clip", type: "CLIP", link: null }],
      outputs: [],
    });
    expectGraphError(
      () => flattenComposedWorkflow(f),
      "subgraph_cycle",
      /"outer wrapper" → "inner encode" → "outer wrapper"/,
    );
  });

  it("dangling_link: input references a link that does not exist", () => {
    const f = load("nested.json");
    f.nodes[2].inputs[0].link = 77;
    f.links = f.links.filter((l: Any) => l[0] !== 2);
    f.links.push([77, 55, 0, 3, 0, "CONDITIONING"]); // origin node 55 missing
    expectGraphError(
      () => flattenComposedWorkflow(f),
      "dangling_link",
      /node 55, which does not exist/,
    );
  });

  it("dangling_link: subgraph input wired to a missing link id", () => {
    const f = load("nested.json");
    f.nodes[1].inputs[0].link = 404;
    expectGraphError(
      () => flattenComposedWorkflow(f),
      "dangling_link",
      /link 404, which is missing/,
    );
  });

  it("bad_slot: instance input slot beyond the subgraph's declared inputs", () => {
    const f = load("nested.json");
    f.nodes[1].inputs.push({ name: "extra", type: "CLIP", link: null });
    expectGraphError(
      () => flattenComposedWorkflow(f),
      "bad_slot",
      /only declares 1 input/,
    );
  });

  it("bad_slot: link into a non-existent input slot", () => {
    const f = load("nested.json");
    f.links = f.links.map((l: Any) =>
      l[0] === 2 ? [2, 2, 0, 3, 5, "CONDITIONING"] : l,
    );
    expectGraphError(
      () => flattenComposedWorkflow(f),
      "bad_slot",
      /input slot 5/,
    );
  });

  it("unconnected_output: subgraph output used outside but empty inside", () => {
    const f = load("nested.json");
    const inner = f.definitions.subgraphs[1];
    inner.links = inner.links.filter((l: Any) => l.id !== 32);
    expectGraphError(
      () => flattenComposedWorkflow(f),
      "unconnected_output",
      /"inner encode".*output "cond"/,
    );
  });
});
